import * as vscode from 'vscode';
import { RawLogDocument } from './rawLogDocument';
import { rawLogHtml } from './rawLogHtml';
import type { LogViewState, ToExtensionMessage, ToWebviewMessage } from './rawLogProtocol';
import type { LogFilesProvider } from '../sidebar/logFilesProvider';
import type { ProjectStore } from '../storage/projectStore';
import type { FrameDefinitionEditor } from '../frame-editor/frameDefinitionEditor';
import { createHash, randomUUID } from 'crypto';
import type { PluginManager } from '../plugins/pluginManager';
import * as path from 'path';
import { readExternalCsvHeader } from '../external/externalCsvLoader';
import { removeExternalCsvSignal, updateClipSignals, type ExternalCsvValueColumn } from '../../core/project/schema';
import { formatCanId } from '../../core/frame/canId';
import { clipIdFromUri, portableClipPath } from '../clips/clipPaths';
import { saveRenderedImage, type RenderedImage } from '../imageExport';

export class RawLogEditorProvider implements vscode.CustomReadonlyEditorProvider<RawLogDocument> {
  private readonly pendingExternalCsv = new Map<string, { readonly uri: vscode.Uri; readonly headers: readonly string[] }>();
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly logFiles: LogFilesProvider,
    private readonly projectStore: ProjectStore,
    private readonly frameEditor: FrameDefinitionEditor,
    private readonly pluginManager: PluginManager
  ) {}

  openCustomDocument(uri: vscode.Uri): RawLogDocument {
    void this.logFiles.add(uri.fsPath);
    const clipId = clipIdFromUri(uri); const clip = clipId ? this.projectStore.current.clips.find((item) => item.id === clipId) : undefined;
    return new RawLogDocument(uri, this.projectStore.current, this.projectStore.analysisRevision, this.pluginManager.registry, clip ? { start: clip.startTimestamp, end: clip.endTimestamp } : undefined);
  }

  resolveCustomEditor(document: RawLogDocument, panel: vscode.WebviewPanel): void {
    panel.webview.options = { enableScripts: true };
    panel.webview.html = rawLogHtml(panel.webview, this.extensionUri, document.fileName, vscode.env.language);
    const send = (message: ToWebviewMessage) => panel.webview.postMessage(message);
    const clipId = clipIdFromUri(document.uri); const clip = clipId ? this.projectStore.current.clips.find((item) => item.id === clipId) : undefined;
    let viewStateSaveErrorShown = false;
    if (clip) panel.title = clip.name;
    const viewStateKey = `log-view:${createHash('sha256').update(document.uri.toString()).digest('hex').slice(0, 20)}`;
    const subscription = document.onDidUpdate((update) => {
      if (update.type === 'progress') void send({
        type: 'progress', frames: update.frames, bytesRead: update.bytesRead, totalBytes: update.totalBytes, channels: document.channelValues,
      });
      else if (update.type === 'diagnostics') void send({ type: 'diagnostics', diagnostics: update.diagnostics, total: update.total });
      else if (update.type === 'analysisProgress') void send({ type: 'analysisProgress', processed: update.processed, total: update.total });
      else if (update.type === 'analysisComplete') void send({ type: 'analysisComplete', processed: update.processed, cancelled: update.cancelled });
      else {
        void send({ type: 'parseComplete', cancelled: update.summary.cancelled, frames: update.summary.framesParsed, diagnostics: update.summary.diagnostics, channels: document.channelValues });
        void send({ type: 'definitionsChanged' });
      }
    });
    let knownAnalysisRevision = this.projectStore.analysisRevision;
    const projectSubscription = this.projectStore.onDidChange(() => {
      if (knownAnalysisRevision === this.projectStore.analysisRevision) return;
      knownAnalysisRevision = this.projectStore.analysisRevision;
      void this.pluginManager.sync().then(() => document.rebuildSignals(this.projectStore.current, knownAnalysisRevision)).then(() => send({ type: 'definitionsChanged' }));
    });
    const runtimeSubscription = this.pluginManager.onDidChangeRuntime(() => {
      void document.rebuildSignals(this.projectStore.current, knownAnalysisRevision, true).then(() => send({ type: 'definitionsChanged' }));
    });
    panel.onDidDispose(() => { subscription.dispose(); projectSubscription.dispose(); runtimeSubscription.dispose(); });
    panel.webview.onDidReceiveMessage((message: ToExtensionMessage) => {
      if (message.type === 'ready') {
        const state = this.projectStore.current.viewStates[viewStateKey] ?? this.projectStore.current.viewStates['log-view-default'];
        const viewState = state && typeof state === 'object' ? state as LogViewState : undefined;
        const initialViewState = clip ? { ...viewState, chartSelectedIds: clip.signalIds } : viewState;
        void send({ type: 'init', fileName: document.fileName, parsing: document.isParsing, frames: document.store.size, diagnostics: document.diagnosticCount, channels: document.channelValues, viewState: initialViewState, clip: clip ? { name: clip.name, startTimestamp: clip.startTimestamp, endTimestamp: clip.endTimestamp } : undefined });
        if (document.diagnostics.length) void send({ type: 'diagnostics', diagnostics: document.diagnostics.slice(-200), total: document.diagnosticCount });
      } else if (message.type === 'pageRequest') {
        const page = document.query({ offset: message.offset, limit: message.limit, filter: message.filter }, this.projectStore.current, this.projectStore.analysisRevision);
        void send({ type: 'page', requestId: message.requestId, ...page });
      } else if (message.type === 'cancelParsing') {
        document.cancel();
      } else if (message.type === 'autoFitSampleRequest') {
        void send({ type: 'autoFitSample', requestId: message.requestId, rows: document.sample({ filter: message.filter }, this.projectStore.current, this.projectStore.analysisRevision) });
      } else if (message.type === 'openFrameDefinition') {
        this.frameEditor.open(message.definitionId);
      } else if (message.type === 'registerFrame') {
        void this.frameEditor.create({ canId: message.canId, extended: message.extended, frameLength: message.frameLength });
      } else if (message.type === 'selectedRowsRequest') {
        void this.transferSelectedRows(document, message, send);
      } else if (message.type === 'signalCatalogRequest') {
        const allDefinitions = document.signalCatalog();
        const definitions = message.view === 'table'
          ? allDefinitions.filter((item) => item.source.type === 'manual-can' || item.source.type === 'plugin')
          : message.view === 'trajectory' ? allDefinitions.filter((item) => item.source.type !== 'external-csv') : allDefinitions;
        const manualGroups = this.projectStore.current.frames.filter((frame) => frame.signals.length || frame.derivedSignals?.length).map((frame) => ({
          id: `frame:${frame.id}`,
          label: `${formatCanId(frame.canId, frame.extended)}${frame.name ? ` ${frame.name}` : ''}`,
          signalIds: [...frame.signals, ...(frame.derivedSignals ?? [])].map((signal) => signal.id),
        }));
        const pluginGroups = this.projectStore.current.pluginBindings.flatMap((binding) => {
          const frame = this.projectStore.current.frames.find((item) => item.id === binding.frameId);
          const byGroup = new Map<string, string[]>();
          for (const definition of allDefinitions.filter((item) => item.source.type === 'plugin' && item.source.bindingId === binding.id)) {
            const list = byGroup.get(definition.group ?? '') ?? []; list.push(definition.id); byGroup.set(definition.group ?? '', list);
          }
          return [...byGroup].map(([group, signalIds]) => ({
            id: `plugin:${binding.id}:${encodeURIComponent(group)}`,
            label: `Plugin ${binding.pluginId}${frame ? ` · ${formatCanId(frame.canId, frame.extended)}` : ''}${group ? ` · ${group}` : ''}`,
            signalIds,
          }));
        }).filter((group) => group.signalIds.length);
        const externalGroups = message.view === 'timeSeries' ? this.projectStore.current.externalCsvSources.map((source) => ({
          id: `external:${source.id}`, label: `External · ${source.fileName}`,
          signalIds: allDefinitions.filter((item) => item.source.type === 'external-csv' && item.source.sourceId === source.id).map((item) => item.id),
          remove: { type: 'external-csv' as const, sourceId: source.id },
        })).filter((group) => group.signalIds.length) : [];
        void send({ type: 'signalCatalog', requestId: message.requestId, definitions, groups: [...manualGroups, ...pluginGroups, ...externalGroups] });
      } else if (message.type === 'signalTablePageRequest') {
        const page = document.signalTablePage(message.selectedIds, message.offset, message.limit);
        void send({
          type: 'signalTablePage', requestId: message.requestId, offset: page.offset, total: page.total, generation: page.generation,
          rows: page.rows.map((row) => ({ id: row.id, timestamp: row.timestamp, values: Object.fromEntries(Array.from(row.values, ([id, sample]) => [id, sample.value])), valueLabels: Object.fromEntries(Array.from(row.values).flatMap(([id, sample]) => sample.valueLabel ? [[id, sample.valueLabel]] : [])), changes: row.changes })),
        });
      } else if (message.type === 'signalTableSampleRequest') {
        const rows = document.signalTableSample(message.selectedIds);
        void send({ type: 'signalTableSample', requestId: message.requestId, rows: rows.map((row) => ({ id: row.id, timestamp: row.timestamp, values: Object.fromEntries(Array.from(row.values, ([id, sample]) => [id, sample.value])), valueLabels: Object.fromEntries(Array.from(row.values).flatMap(([id, sample]) => sample.valueLabel ? [[id, sample.valueLabel]] : [])) })) });
      } else if (message.type === 'signalTableRowsRequest') {
        void this.transferSignalTableRows(document, message, send);
      } else if (message.type === 'measuredSignalsRequest') {
        void send({ type: 'measuredSignals', requestId: message.requestId, samples: document.measuredSignals(message.selectedIds, message.timestamp) });
      } else if (message.type === 'signalSeriesRequest') {
        const result = document.signalSeries(message.selectedIds, message.range, message.maxPoints);
        void send({ type: 'signalSeries', requestId: message.requestId, fullRange: result.range, series: result.series.map((series) => ({ ...series, events: series.events ?? [] })) });
      } else if (message.type === 'cancelAnalysis') {
        document.cancelAnalysis();
      } else if (message.type === 'importExternalCsv') {
        void this.selectExternalCsv(send);
      } else if (message.type === 'commitExternalCsv') {
        void this.commitExternalCsv(message);
      } else if (message.type === 'cancelExternalCsvImport') {
        this.pendingExternalCsv.delete(message.importId);
      } else if (message.type === 'removeExternalCsvSignal') {
        void this.removeExternalCsvSignal(message.sourceId, message.column);
      } else if (message.type === 'exportSignalCsv') {
        void this.exportSignals(document, message.selectedIds);
      } else if (message.type === 'saveTimeSeriesImage') {
        void this.saveTimeSeriesImage(document, message);
      } else if (message.type === 'saveTrajectoryImage') {
        void this.saveTrajectoryImage(document, message);
      } else if (message.type === 'snapTimeRangeRequest') {
        const startTimestamp = document.nearestFrameTimestamp(message.startTimestamp) ?? message.startTimestamp; const endTimestamp = document.nearestFrameTimestamp(message.endTimestamp) ?? message.endTimestamp;
        void send({ type: 'timeRangeAdjusted', requestId: message.requestId, startTimestamp: Math.min(startTimestamp, endTimestamp), endTimestamp: Math.max(startTimestamp, endTimestamp) });
      } else if (message.type === 'adjustTimeRangeRequest') {
        const current = message.edge === 'start' ? message.startTimestamp : message.endTimestamp; const next = document.adjacentFrameTimestamp(current, message.direction);
        const startTimestamp = message.edge === 'start' && next !== undefined ? Math.min(next, message.endTimestamp) : message.startTimestamp; const endTimestamp = message.edge === 'end' && next !== undefined ? Math.max(next, message.startTimestamp) : message.endTimestamp;
        void send({ type: 'timeRangeAdjusted', requestId: message.requestId, startTimestamp, endTimestamp });
      } else if (message.type === 'createClip') {
        void this.createClip(document, message, send);
      } else if (message.type === 'saveLogViewState') {
        void this.projectStore.update((project) => {
          const next = { ...project, viewStates: { ...project.viewStates, [viewStateKey]: message.state } };
          return clip && message.state.chartSelectedIds ? updateClipSignals(next, clip.id, message.state.chartSelectedIds) : next;
        }).then(() => { viewStateSaveErrorShown = false; }).catch((error) => {
          if (viewStateSaveErrorShown) return; viewStateSaveErrorShown = true;
          void vscode.window.showErrorMessage(`Could not save the current SigMixa view settings: ${(error as Error).message}`);
        });
      }
    });
  }

  private async transferSelectedRows(document: RawLogDocument, message: Extract<ToExtensionMessage, { type: 'selectedRowsRequest' }>, send: (message: ToWebviewMessage) => Thenable<boolean>): Promise<void> {
    try {
      const result = document.selectedRowsText(message.ranges, message.filter, this.projectStore.current, this.projectStore.analysisRevision, message.contentMode, message.action === 'open');
      if (message.action === 'copy') { await vscode.env.clipboard.writeText(result.text); void send({ type: 'rowsCopied', count: result.count }); }
      else { const textDocument = await vscode.workspace.openTextDocument({ content: result.text, language: 'plaintext' }); await vscode.window.showTextDocument(textDocument, { viewColumn: vscode.ViewColumn.Beside, preview: false }); }
    } catch (error) { void vscode.window.showErrorMessage(`Could not ${message.action === 'copy' ? 'copy' : 'open'} RAW Log rows: ${(error as Error).message}`); }
  }

  private async transferSignalTableRows(document: RawLogDocument, message: Extract<ToExtensionMessage, { type: 'signalTableRowsRequest' }>, send: (message: ToWebviewMessage) => Thenable<boolean>): Promise<void> {
    try {
      const result = document.selectedSignalRowsText(message.ranges, message.selectedIds, message.action === 'open');
      if (message.action === 'copy') { await vscode.env.clipboard.writeText(result.text); void send({ type: 'signalTableRowsCopied', count: result.count }); }
      else { const textDocument = await vscode.workspace.openTextDocument({ content: result.text, language: 'plaintext' }); await vscode.window.showTextDocument(textDocument, { viewColumn: vscode.ViewColumn.Beside, preview: false }); }
    } catch (error) { void vscode.window.showErrorMessage(`Could not ${message.action === 'copy' ? 'copy' : 'open'} Signal Table rows: ${(error as Error).message}`); }
  }

  private async createClip(document: RawLogDocument, message: Extract<ToExtensionMessage, { type: 'createClip' }>, send: (message: ToWebviewMessage) => Thenable<boolean>): Promise<void> {
    const root = this.projectStore.requireWorkspace(); if (!root) return;
    const startTimestamp = Math.min(message.startTimestamp, message.endTimestamp); const endTimestamp = Math.max(message.startTimestamp, message.endTimestamp);
    if (!Number.isFinite(startTimestamp) || !Number.isFinite(endTimestamp) || endTimestamp <= startTimestamp) return;
    const suggested = `${document.fileName} ${startTimestamp.toFixed(3)}–${endTimestamp.toFixed(3)} s`;
    const name = await vscode.window.showInputBox({ title: 'Create Clip', prompt: 'Clip name', value: suggested, validateInput: (value) => value.trim() ? undefined : 'Clip name is required.' });
    if (!name) return;
    const id = `clip-${randomUUID()}`;
    try {
      await this.projectStore.update((project) => ({ ...project, clips: [...project.clips, {
        id, name: name.trim(), sourcePath: portableClipPath(document.uri.fsPath, root.fsPath), sourceFileName: document.fileName,
        startTimestamp, endTimestamp, signalIds: [...new Set(message.signalIds)],
      }] }));
      void send({ type: 'clipCreated', clipId: id });
      void vscode.window.showInformationMessage(`Clip created: ${name.trim()}`);
    } catch (error) { void vscode.window.showErrorMessage(`Could not create Clip: ${(error as Error).message}`); }
  }

  private async exportSignals(document: RawLogDocument, selectedIds: readonly string[]): Promise<void> {
    if (!selectedIds.length) { void vscode.window.showWarningMessage('Select at least one Signal to export.'); return; }
    const target = await vscode.window.showSaveDialog({ filters: { CSV: ['csv'] }, defaultUri: vscode.Uri.file(`${document.fileName.replace(/\.asc$/i, '')}-signals.csv`) });
    if (!target) return;
    if (target.scheme !== 'file') { void vscode.window.showErrorMessage('Signal CSV export currently requires a local file target.'); return; }
    try { await document.exportSignalCsv(target.fsPath, selectedIds); void vscode.window.showInformationMessage(`Signal CSV exported: ${target.fsPath}`); }
    catch (error) { void vscode.window.showErrorMessage(`Signal CSV export failed: ${(error as Error).message}`); }
  }

  private async saveTimeSeriesImage(document: RawLogDocument, image: RenderedImage): Promise<void> {
    const base = document.fileName.replace(/\.(?:asc|blf)$/i, ''); await saveRenderedImage({ title: 'Save Time Series Image', japaneseTitle: '時系列画像を保存', defaultBasePath: path.join(path.dirname(document.uri.fsPath), `${base}-time-series`), image });
  }

  private async saveTrajectoryImage(document: RawLogDocument, image: RenderedImage): Promise<void> {
    const base = document.fileName.replace(/\.(?:asc|blf)$/i, ''); await saveRenderedImage({ title: 'Save Trajectory Image', japaneseTitle: '軌跡画像を保存', defaultBasePath: path.join(path.dirname(document.uri.fsPath), `${base}-trajectory`), image });
  }

  private async selectExternalCsv(send: (message: ToWebviewMessage) => Thenable<boolean>): Promise<void> {
    const root = this.projectStore.requireWorkspace();
    if (!root) return;
    const selected = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { CSV: ['csv'] }, title: 'Import External CSV' });
    const uri = selected?.[0];
    if (!uri) return;
    if (uri.scheme !== 'file') { void vscode.window.showErrorMessage('External CSV import currently requires a local file.'); return; }
    try {
      const headers = await readExternalCsvHeader(uri.fsPath);
      if (headers.length < 2) { void vscode.window.showErrorMessage('The CSV needs a header row with a Timestamp column and at least one value column.'); return; }
      const importId = randomUUID(); this.pendingExternalCsv.set(importId, { uri, headers });
      const suggestedTimestampColumn = headers.find((header) => /^(?:time|timestamp)(?:\b|[_ (])/i.test(header.trim())) ?? headers[0];
      const normalized = suggestedTimestampColumn.toLowerCase();
      const suggestedTimestampUnit = /(?:^|[_ (])(?:us|µs|μs|microseconds?)(?:\b|[)])/i.test(normalized) ? 'microseconds'
        : /(?:^|[_ (])(?:ms|milliseconds?)(?:\b|[)])/i.test(normalized) ? 'milliseconds' : 'seconds';
      void send({ type: 'externalCsvPreview', importId, fileName: path.basename(uri.fsPath), headers, suggestedTimestampColumn, suggestedTimestampUnit });
    } catch (error) {
      void vscode.window.showErrorMessage(`External CSV import failed: ${(error as Error).message}`);
    }
  }

  private async commitExternalCsv(message: Extract<ToExtensionMessage, { type: 'commitExternalCsv' }>): Promise<void> {
    const root = this.projectStore.requireWorkspace(); const pending = this.pendingExternalCsv.get(message.importId);
    if (!root || !pending) { void vscode.window.showErrorMessage('The selected CSV import has expired. Choose the file again.'); return; }
    const uri = pending.uri; const available = new Set(pending.headers);
    if (!available.has(message.timestampColumn) || !message.valueColumns.length || message.valueColumns.some((column) => !available.has(column.column) || column.column === message.timestampColumn)) {
      void vscode.window.showErrorMessage('Choose one Timestamp column and at least one different value column.'); return;
    }
    const configured: ExternalCsvValueColumn[] = message.valueColumns.map((column) => ({ column: column.column, name: column.name.trim() || column.column, unit: column.unit?.trim() || undefined }));
    try {
      const relative = path.relative(root.fsPath, uri.fsPath);
      const portablePath = !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative) ? relative : uri.fsPath;
      const existing = this.projectStore.current.externalCsvSources.find((source) => {
        const absolute = path.isAbsolute(source.path) ? source.path : path.resolve(root.fsPath, source.path);
        return path.normalize(absolute) === path.normalize(uri.fsPath);
      });
      const id = existing?.id ?? `csv-${createHash('sha256').update(uri.fsPath).digest('hex').slice(0, 16)}`;
      await this.projectStore.update((project) => ({
        ...project,
        externalCsvSources: [...project.externalCsvSources.filter((source) => source.id !== id), {
          id, path: portablePath, fileName: path.basename(uri.fsPath), timestampColumn: message.timestampColumn,
          timestampUnit: message.timestampUnit, valueColumns: configured,
        }],
      }));
      this.pendingExternalCsv.delete(message.importId);
      void vscode.window.showInformationMessage(`External CSV imported: ${path.basename(uri.fsPath)}`);
    } catch (error) {
      void vscode.window.showErrorMessage(`External CSV import failed: ${(error as Error).message}`);
    }
  }

  private async removeExternalCsvSignal(sourceId: string, column: string): Promise<void> {
    const source = this.projectStore.current.externalCsvSources.find((item) => item.id === sourceId);
    const signal = source?.valueColumns.find((item) => item.column === column); if (!source || !signal) return;
    try {
      await this.projectStore.update((project) => removeExternalCsvSignal(project, sourceId, column));
      const sourceRemoved = source.valueColumns.length === 1;
      void vscode.window.showInformationMessage(sourceRemoved
        ? `External CSV Signal removed; no Signals remain, so ${source.fileName} was unregistered.`
        : `External CSV Signal removed: ${signal.name}`);
    } catch (error) {
      void vscode.window.showErrorMessage(`External CSV Signal removal failed: ${(error as Error).message}`);
    }
  }

}
