import { resolveViewSettings, saveViewSettings, switchViewSettingsScope, viewSettingsScope } from '../../core/project/viewSettings';
import { clipRange, clipRangeLabel, type ClipDefinition } from '../../core/project/schema';
import * as vscode from 'vscode';
import { t } from '../i18n';
import { RawLogDocument } from './rawLogDocument';
import { rawLogHtml } from './rawLogHtml';
import type { LogViewState, ToExtensionMessage, ToWebviewMessage } from './rawLogProtocol';
import { sourceProject, sourceGroup, type AnalysisGroupsProvider } from '../sidebar/analysisGroupsProvider';
import type { ProjectStore } from '../storage/projectStore';
import type { FrameDefinitionEditor } from '../frame-editor/frameDefinitionEditor';
import { createHash, randomUUID } from 'crypto';
import type { PluginManager } from '../plugins/pluginManager';
import * as path from 'path';
import { readExternalCsvHeader } from '../external/externalCsvLoader';
import { removeExternalCsvSignal, type ExternalCsvValueColumn } from '../../core/project/schema';
import { signalCatalogGroups } from './signalCatalogGroups';
import { chooseReportDetail, reportCatalog, reportGraphs, reportSeries, reportTable, saveReport } from '../report/reportExporter';
import { REPORT_FORMAT_VERSION } from '../report/reportData';
import { extensionVersion } from '../report/extensionVersion';
import { groupUnusablePlugins, updateGroup } from '../../core/project/analysisGroups';
import { clipIdFromUri, portableClipPath, resolveClipPath } from '../clips/clipPaths';
import { withClipRange } from '../../core/project/clipRangeEdit';
import { chooseExportFormat, requireRenderedImage, saveRenderedImage, type RenderedImage } from '../imageExport';

export class RawLogEditorProvider implements vscode.CustomReadonlyEditorProvider<RawLogDocument> {
  private readonly warnedPlugins = new Set<string>();
  private readonly pendingExternalCsv = new Map<string, { readonly uri: vscode.Uri; readonly headers: readonly string[] }>();
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly logFiles: AnalysisGroupsProvider,
    private readonly projectStore: ProjectStore,
    private readonly frameEditor: FrameDefinitionEditor,
    private readonly pluginManager: PluginManager
  ) {}

  /** Said once per group and Plugin set: the log still opens, without the group's decoding by those Plugins. */
  private warnUnusablePlugins(uri: vscode.Uri): void {
    const group = sourceGroup(this.projectStore, uri); const plugins = groupUnusablePlugins(this.projectStore.current, group?.id);
    const key = `${group?.id}:${plugins.map((plugin) => `${plugin.id}@${plugin.version}`).join(',')}`;
    if (!group || !plugins.length || this.warnedPlugins.has(key)) return;
    this.warnedPlugins.add(key); const names = plugins.map((plugin) => `${plugin.id} (${plugin.version})`).join(', ');
    void vscode.window.showWarningMessage(t(`Analysis group “${group.name}” needs Plugins that cannot be used: ${names}`, `解析グループ「${group.name}」に必要なプラグインが使えません: ${names}`));
  }

  openCustomDocument(uri: vscode.Uri): RawLogDocument {
    const clipId = clipIdFromUri(uri); const clip = clipId ? this.projectStore.current.clips.find((item) => item.id === clipId) : undefined;
    this.warnUnusablePlugins(uri);
    return new RawLogDocument(uri, sourceProject(this.projectStore, uri), this.projectStore.analysisRevision, this.pluginManager.registry, clip ? clipRange(clip) : undefined);
  }

  resolveCustomEditor(document: RawLogDocument, panel: vscode.WebviewPanel): void {
    panel.webview.options = { enableScripts: true };
    panel.webview.html = rawLogHtml(panel.webview, this.extensionUri, document.fileName, vscode.env.language);
    const send = (message: ToWebviewMessage) => panel.webview.postMessage(message);
    const clipId = clipIdFromUri(document.uri); const clip = clipId ? this.projectStore.current.clips.find((item) => item.id === clipId) : undefined;
    let viewStateSaveErrorShown = false;
    if (clip) panel.title = clip.name;
    // A Clip has no view settings of its own: it uses those of its log in the place it was opened from.
    const viewStateKey = this.projectStore.viewKey(document.uri);
    const subscription = document.onDidUpdate((update) => {
      if (update.type === 'progress') void send({
        type: 'progress', frames: update.frames, bytesRead: update.bytesRead, totalBytes: update.totalBytes, channels: document.channelValues,
      });
      else if (update.type === 'sourceDiagnostics') void send({ type: 'sourceDiagnostics', groups: update.groups, total: update.total });
      else if (update.type === 'analysisDiagnostics') void send({ type: 'analysisDiagnostics', groups: update.groups, total: update.total });
      else if (update.type === 'analysisProgress') void send({ type: 'analysisProgress', processed: update.processed, total: update.total });
      else if (update.type === 'analysisComplete') void send({ type: 'analysisComplete', processed: update.processed, cancelled: update.cancelled });
      else {
        void send({ type: 'parseComplete', cancelled: update.summary.cancelled, frames: update.summary.framesParsed, diagnostics: update.summary.diagnostics, channels: document.channelValues });
        void send({ type: 'definitionsChanged' });
      }
    });
    const currentGroup = () => sourceGroup(this.projectStore, document.uri);
    const currentSettings = () => resolveViewSettings(this.projectStore.current, viewStateKey, currentGroup());
    const settingsFingerprint = () => JSON.stringify([currentSettings(), currentGroup()?.name, viewSettingsScope(this.projectStore.current, viewStateKey, currentGroup())]);
    let knownSettings = settingsFingerprint(); let ownViewSave = 0;
    // The Webview saves full snapshots. Once this view's settings changed on disk, its snapshot is out of date:
    // it is not saved again until the Webview has reloaded with the settings from disk.
    let staleSettings = false;
    // Settings shared through a group are applied by reloading the Webview. Hidden panels reload
    // when shown and visible ones after edits settle, so a sibling panel is not reset on every save.
    let reloadPending = false; let reloadTimer: ReturnType<typeof setTimeout> | undefined;
    const reload = () => {
      if (reloadTimer !== undefined) clearTimeout(reloadTimer); reloadTimer = undefined;
      if (!reloadPending) return; reloadPending = false;
      panel.webview.html = rawLogHtml(panel.webview, this.extensionUri, document.fileName, vscode.env.language);
    };
    const scheduleReload = () => {
      reloadPending = true;
      if (!panel.visible) return;
      if (reloadTimer !== undefined) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(reload, 1500);
    };
    const visibilitySubscription = panel.onDidChangeViewState(() => { if (panel.visible && reloadPending) reload(); });
    let knownAnalysisRevision = this.projectStore.analysisRevision;
    // The log's Clips, marked on its graphs. A Clip's own view is that range already, so it gets none.
    const clipRanges = () => clip ? [] : this.clipRangesOf(document);
    let knownClipRanges = JSON.stringify(clipRanges());
    // An open Clip shows the range it was opened with. When its range is changed, it is opened again with the new one.
    const openedClipRange = clip ? JSON.stringify(clipRange(clip)) : undefined;
    const projectSubscription = this.projectStore.onDidChange(() => {
      if (clip) {
        const current = this.projectStore.current.clips.find((item) => item.id === clip.id);
        if (current && JSON.stringify(clipRange(current)) !== openedClipRange) {
          const uri = document.uri; const column = panel.viewColumn; const active = panel.active; panel.dispose();
          setTimeout(() => void vscode.commands.executeCommand('vscode.openWith', uri, 'sigmixa.rawLog', { viewColumn: column, preserveFocus: !active }), 200);
          return;
        }
      }
      const nextClipRanges = JSON.stringify(clipRanges()); if (nextClipRanges !== knownClipRanges) { knownClipRanges = nextClipRanges; void send({ type: 'clipRanges', clips: clipRanges() }); }
      const nextSettings = settingsFingerprint();
      if (nextSettings !== knownSettings) {
        knownSettings = nextSettings;
        if (this.projectStore.changeIsFromDisk) { staleSettings = true; scheduleReload(); }
        else if (!ownViewSave) scheduleReload();
      }
      if (knownAnalysisRevision === this.projectStore.analysisRevision) return;
      knownAnalysisRevision = this.projectStore.analysisRevision;
      void this.pluginManager.sync().then(() => document.rebuildSignals(sourceProject(this.projectStore, document.uri), knownAnalysisRevision)).then(() => send({ type: 'definitionsChanged' }));
    });
    const runtimeSubscription = this.pluginManager.onDidChangeRuntime(() => {
      void document.rebuildSignals(sourceProject(this.projectStore, document.uri), knownAnalysisRevision, true).then(() => send({ type: 'definitionsChanged' }));
    });
    panel.onDidDispose(() => { if (reloadTimer !== undefined) clearTimeout(reloadTimer); subscription.dispose(); projectSubscription.dispose(); runtimeSubscription.dispose(); visibilitySubscription.dispose(); });
    panel.webview.onDidReceiveMessage((message: ToExtensionMessage) => {
      if (message.type === 'ready') {
        staleSettings = false;
        const state = currentSettings();
        const viewState = state && typeof state === 'object' ? state as LogViewState : undefined;
        void send({ type: 'init', viewSettingsScope: viewSettingsScope(this.projectStore.current, viewStateKey, currentGroup()), place: this.projectStore.placeLabel(this.projectStore.levelOfUri(document.uri)), groupName: sourceGroup(this.projectStore, document.uri)?.name, fileName: document.fileName, parsing: document.isParsing, frames: document.store.size, diagnostics: document.diagnosticCount, channels: document.channelValues, viewState, clip: clip ? { name: clip.name, startTimestamp: clip.startTimestamp, endTimestamp: clip.endTimestamp } : undefined });
        void send({ type: 'clipRanges', clips: clipRanges() });
        void send({ type: 'sourceDiagnostics', groups: document.sourceDiagnosticGroups, total: document.diagnosticCount });
        void send({ type: 'analysisDiagnostics', groups: document.analysisDiagnosticGroups, total: document.analysisDiagnosticCount });
      } else if (message.type === 'setViewSettingsScope') {
        const group = currentGroup(); if (!group) return;
        ownViewSave++;
        void this.projectStore.update((project) => staleSettings ? project : switchViewSettingsScope(project, viewStateKey, message.state as Record<string, unknown>, group, message.scope)).then(() => { panel.webview.html = rawLogHtml(panel.webview, this.extensionUri, document.fileName, vscode.env.language); }).catch((error) => vscode.window.showErrorMessage(`${t('Could not switch where view settings are saved', '表示設定の切り替えに失敗しました')}: ${(error as Error).message}`)).finally(() => { ownViewSave--; });
      } else if (message.type === 'updateClipRange') {
        // The graphs already show the dragged range; whatever happens, they are told what is saved.
        void this.projectStore.update((project) => withClipRange(project, message.clipId, message.startTimestamp, message.endTimestamp))
          .catch((error) => vscode.window.showErrorMessage(t(`Could not change the Clip: ${(error as Error).message}`, `クリップを変更できませんでした: ${(error as Error).message}`)))
          .then(() => { knownClipRanges = JSON.stringify(clipRanges()); return send({ type: 'clipRanges', clips: clipRanges() }); });
      } else if (message.type === 'openClip') {
        // Opened from this log's graph, the Clip opens in the same place (group) as the log.
        const target = this.projectStore.current.clips.find((item) => item.id === message.clipId);
        if (target) void vscode.commands.executeCommand('sigmixa.openClip', target, { level: this.projectStore.levelOfUri(document.uri) });
      } else if (message.type === 'openText') {
        void vscode.workspace.openTextDocument({ content: message.text, language: 'plaintext' }).then((textDocument) => vscode.window.showTextDocument(textDocument, { viewColumn: vscode.ViewColumn.Beside, preview: false }));
      } else if (message.type === 'lastFramesRequest') {
        void send({ type: 'lastFrames', requestId: message.requestId, timestamp: message.timestamp, values: document.lastFrames(message.timestamp) });
      } else if (message.type === 'pageRequest') {
        const page = document.query({ offset: message.offset, limit: message.limit, filter: message.filter }, sourceProject(this.projectStore, document.uri), this.projectStore.analysisRevision);
        void send({ type: 'page', requestId: message.requestId, ...page });
      } else if (message.type === 'cancelParsing') {
        document.cancel();
      } else if (message.type === 'autoFitSampleRequest') {
        void send({ type: 'autoFitSample', requestId: message.requestId, rows: document.sample({ filter: message.filter }, sourceProject(this.projectStore, document.uri), this.projectStore.analysisRevision) });
      } else if (message.type === 'openFrameDefinition') {
        this.frameEditor.open(message.definitionId, undefined, sourceGroup(this.projectStore, document.uri)?.frames.some((frame) => frame.id === message.definitionId) ? sourceGroup(this.projectStore, document.uri)?.id : undefined);
      } else if (message.type === 'registerFrame') {
        void this.frameEditor.create({ canId: message.canId, extended: message.extended, frameLength: message.frameLength, groupId: sourceGroup(this.projectStore, document.uri)?.id });
      } else if (message.type === 'selectedRowsRequest') {
        void this.transferSelectedRows(document, message, send);
      } else if (message.type === 'signalCatalogRequest') {
        const allDefinitions = document.signalCatalog();
        const definitions = message.view === 'table'
          ? allDefinitions.filter((item) => item.source.type === 'manual-can' || item.source.type === 'plugin')
          : message.view === 'trajectory' ? allDefinitions.filter((item) => item.source.type !== 'external-csv') : allDefinitions;
        void send({ type: 'signalCatalog', requestId: message.requestId, definitions, groups: signalCatalogGroups(allDefinitions, sourceProject(this.projectStore, document.uri), message.view === 'timeSeries'), measuredIds: document.measuredSignalIds(), unmeasuredOption: Boolean(currentGroup()) && viewSettingsScope(this.projectStore.current, viewStateKey, currentGroup()) === 'group' });
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
      } else if (message.type === 'timelineRangeRequest') {
        void send({ type: 'timelineRange', requestId: message.requestId, range: document.timelineRange });
      } else if (message.type === 'signalSeriesRequest') {
        const result = document.signalSeries(message.selectedIds, message.range, message.maxPoints);
        void send({ type: 'signalSeries', requestId: message.requestId, fullRange: result.range, series: result.series.map((series) => ({ ...series, events: series.events ?? [] })) });
      } else if (message.type === 'cancelAnalysis') {
        document.cancelAnalysis();
      } else if (message.type === 'importExternalCsv') {
        void this.selectExternalCsv(send);
      } else if (message.type === 'commitExternalCsv') {
        void this.commitExternalCsv(message, sourceGroup(this.projectStore, document.uri)?.id);
      } else if (message.type === 'cancelExternalCsvImport') {
        this.pendingExternalCsv.delete(message.importId);
      } else if (message.type === 'removeExternalCsvSignal') {
        void this.removeExternalCsvSignal(message.sourceId, message.column, sourceGroup(this.projectStore, document.uri)?.id);
      } else if (message.type === 'exportSignalCsv') {
        void this.exportSignals(document, message.selectedIds);
      } else if (message.type === 'saveTimeSeriesImage') {
        void this.saveTimeSeriesImage(document, message);
      } else if (message.type === 'exportVisualize') {
        void (async () => {
          const format = await chooseExportFormat('Export', 'エクスポート'); if (!format) return;
          if (format === 'html') { await this.exportReport(document, currentSettings() as LogViewState, clip, message.trajectoryCurrentTime); return; }
          if (!requireRenderedImage(message)) return;
          const base = document.fileName.replace(/\.(?:asc|blf)$/i, '');
          await saveRenderedImage({ title: 'Save All Graphs Image', japaneseTitle: '全グラフの画像を保存', defaultBasePath: path.join(path.dirname(document.uri.fsPath), `${clip?.name ?? base}-graphs`), image: message, format });
        })();
      } else if (message.type === 'saveTrajectoryImage') {
        void this.saveTrajectoryImage(document, message);
      } else if (message.type === 'snapTimeRangeRequest') {
        const startTimestamp = document.nearestFrameTimestamp(message.startTimestamp) ?? message.startTimestamp; const endTimestamp = document.nearestFrameTimestamp(message.endTimestamp) ?? message.endTimestamp;
        void send({ type: 'timeRangeAdjusted', requestId: message.requestId, startTimestamp: Math.min(startTimestamp, endTimestamp), endTimestamp: Math.max(startTimestamp, endTimestamp) });
      } else if (message.type === 'adjustTimeRangeRequest') {
        const current = message.edge === 'start' ? message.startTimestamp : message.endTimestamp; const next = document.adjacentFrameTimestamp(current, message.direction);
        const startTimestamp = message.edge === 'start' && next !== undefined ? Math.min(next, message.endTimestamp) : message.startTimestamp; const endTimestamp = message.edge === 'end' && next !== undefined ? Math.max(next, message.startTimestamp) : message.endTimestamp;
        void send({ type: 'timeRangeAdjusted', requestId: message.requestId, startTimestamp, endTimestamp });
      } else if (message.type === 'createTableClip') {
        if (document.isParsing || document.isAnalyzing || !Number.isInteger(message.startRow) || !Number.isInteger(message.endRow) || message.startRow < 0 || message.endRow <= message.startRow) return;
        const first = document.signalTablePage(message.signalIds, message.startRow, 1); const last = document.signalTablePage(message.signalIds, message.endRow, 1);
        if (first.generation !== message.generation || last.generation !== message.generation || !first.rows[0] || !last.rows[0]) { void vscode.window.showWarningMessage(t('Analysis results changed. Select the range again.', '解析結果が変わりました。範囲を選択し直してください。')); return; }
        void this.createClip(document, { type: 'createClip', startTimestamp: first.rows[0].timestamp, endTimestamp: last.rows[0].timestamp, signalIds: message.signalIds }, send);
      } else if (message.type === 'createClip') {
        void this.createClip(document, message, send);
      } else if (message.type === 'saveLogViewState') {
        ownViewSave++;
        void this.projectStore.update((project) => {
          if (staleSettings) return project;
          return saveViewSettings(project, viewStateKey, message.state as Record<string, unknown>, currentGroup());
        }).then(() => { viewStateSaveErrorShown = false; }).catch((error) => {
          if (viewStateSaveErrorShown) return; viewStateSaveErrorShown = true;
          void vscode.window.showErrorMessage(`Could not save the current SigMixa view settings: ${(error as Error).message}`);
        }).finally(() => { ownViewSave--; });
      }
    });
  }

  private async transferSelectedRows(document: RawLogDocument, message: Extract<ToExtensionMessage, { type: 'selectedRowsRequest' }>, send: (message: ToWebviewMessage) => Thenable<boolean>): Promise<void> {
    try {
      const result = document.selectedRowsText(message.ranges, message.filter, sourceProject(this.projectStore, document.uri), this.projectStore.analysisRevision, message.contentMode, message.action === 'open');
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

  /** The Clips of a log, as time ranges of it. */
  private clipRangesOf(document: RawLogDocument): { id: string; name: string; start: number; end: number }[] {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return this.projectStore.current.clips.flatMap((item) => { const range = clipRange(item); return range && path.resolve(resolveClipPath(item, root)) === path.resolve(document.uri.fsPath) ? [{ id: item.id, name: item.name, start: range.start, end: range.end }] : []; });
  }

  /** A standalone HTML report of what this log/Clip shows: its Visualize graphs and its table Signals. */
  private async exportReport(document: RawLogDocument, state: LogViewState, clip?: ClipDefinition, trajectoryCurrentTime?: number): Promise<void> {
    const detail = await chooseReportDetail(); if (!detail) return;
    const range = (clip ? clipRange(clip) : undefined) ?? document.timelineRange;
    if (!range) { void vscode.window.showWarningMessage(t('The log has no frames to report yet.', 'レポートに出力できるフレームがまだありません。')); return; }
    const graphs = reportGraphs(state, trajectoryCurrentTime); const tableIds = [...(state.tableSelectedIds ?? [])];
    const included = new Set([...graphs.flatMap((graph) => graph.signalIds), ...tableIds]);
    const notices: string[] = []; const name = clip?.name ?? document.fileName; const groupName = sourceGroup(this.projectStore, document.uri)?.name;
    const series = reportSeries(document, [...included], clip ? clipRange(clip) : undefined, detail, notices);
    const catalog = reportCatalog(document.signalCatalog(), signalCatalogGroups(document.signalCatalog(), sourceProject(this.projectStore, document.uri), true), included);
    const rangeLabel = clip ? clipRangeLabel(clip, t('Whole file', 'ファイル全体')) : t('Whole file', 'ファイル全体');
    await saveReport(this.extensionUri, {
      formatVersion: REPORT_FORMAT_VERSION, kind: 'log', title: name, generatedAt: new Date().toISOString(), appVersion: extensionVersion(this.extensionUri),
      source: [clip ? `${document.fileName} · ${rangeLabel}` : document.fileName, ...(groupName ? [groupName] : [])], notices,
      comparison: { id: 'report', name, targets: [{ id: 'log', kind: clip ? 'clip' : 'file', offset: 0 }], graphs, colors: { ...Object.assign({}, ...(state.visualizeViews ?? []).map((view) => view.settings?.chartColors ?? {})), ...(state.chartColors ?? {}) } },
      targets: [{ id: 'log', kind: clip ? 'clip' : 'file', name, fileName: document.fileName, filePath: document.fileName, groupName, rangeLabel, status: 'ready', start: range.start, end: range.end }],
      definitions: catalog.definitions, groups: catalog.groups, availability: { log: [...included] },
      series: [{ targetId: 'log', items: series }], table: reportTable(document, tableIds, detail, notices),
      clipSpans: clip ? undefined : this.clipRangesOf(document),
    }, name);
  }

  private async createClip(document: RawLogDocument, message: Extract<ToExtensionMessage, { type: 'createClip' }>, send: (message: ToWebviewMessage) => Thenable<boolean>): Promise<void> {
    const root = this.projectStore.requireWorkspace(); if (!root) return;
    // A Clip is always a time range; a whole log is compared or opened as the file itself.
    const range = { start: Math.min(message.startTimestamp, message.endTimestamp), end: Math.max(message.startTimestamp, message.endTimestamp) };
    if (!Number.isFinite(range.start) || !Number.isFinite(range.end) || range.end <= range.start) return;
    const suggested = `${document.fileName} ${range.start.toFixed(3)}–${range.end.toFixed(3)} s`;
    const name = await vscode.window.showInputBox({ title: t('Create Clip', 'クリップを作成'), prompt: t('Clip name', 'クリップ名'), value: suggested, validateInput: (value) => value.trim() ? undefined : t('Clip name is required.', 'クリップ名を入力してください') });
    if (!name) return;
    const id = `clip-${randomUUID()}`;
    try {
      // A Clip is only a name and a time range of the log. It is listed wherever the log is shown.
      await this.projectStore.update((project) => ({ ...project, clips: [...project.clips, {
        id, name: name.trim(), sourcePath: portableClipPath(document.uri.fsPath, root.fsPath), sourceFileName: document.fileName, startTimestamp: range.start, endTimestamp: range.end,
      }] }));
      void send({ type: 'clipCreated', clipId: id });
    } catch (error) { void vscode.window.showErrorMessage(t(`Could not create Clip: ${(error as Error).message}`, `クリップを作成できませんでした: ${(error as Error).message}`)); }
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

  /** An External CSV belongs to the level of the log it was added from, so it travels with that folder. */
  private async commitExternalCsv(message: Extract<ToExtensionMessage, { type: 'commitExternalCsv' }>, groupId?: string): Promise<void> {
    const root = this.projectStore.requireWorkspace(); const pending = this.pendingExternalCsv.get(message.importId);
    if (!root || !pending) { void vscode.window.showErrorMessage('The selected CSV import has expired. Choose the file again.'); return; }
    const uri = pending.uri; const available = new Set(pending.headers);
    if (!available.has(message.timestampColumn) || !message.valueColumns.length || message.valueColumns.some((column) => !available.has(column.column) || column.column === message.timestampColumn)) {
      void vscode.window.showErrorMessage('Choose one Timestamp column and at least one different value column.'); return;
    }
    const configured: ExternalCsvValueColumn[] = message.valueColumns.map((column) => ({ column: column.column, name: column.name.trim() || column.column, unit: column.unit?.trim() || undefined }));
    try {
      const portablePath = portableClipPath(uri.fsPath, root.fsPath);
      const group = this.projectStore.current.analysisGroups?.find((item) => item.id === groupId);
      const sources = group ? group.definitionDependencies?.externalCsvSources ?? [] : this.projectStore.current.externalCsvSources;
      const existing = sources.find((source) => {
        const absolute = path.isAbsolute(source.path) ? source.path : path.resolve(root.fsPath, source.path);
        return path.normalize(absolute) === path.normalize(uri.fsPath);
      });
      const id = existing?.id ?? `csv-${createHash('sha256').update(uri.fsPath).digest('hex').slice(0, 16)}`;
      const added = { id, path: portablePath, fileName: path.basename(uri.fsPath), timestampColumn: message.timestampColumn, timestampUnit: message.timestampUnit, valueColumns: configured };
      await this.projectStore.update((project) => group ? updateGroup(project, group.id, (item) => ({ ...item, definitionDependencies: {
        plugins: [], pluginBindings: [], lookupTables: [], calculations: [], ...item.definitionDependencies,
        externalCsvSources: [...(item.definitionDependencies?.externalCsvSources ?? []).filter((source) => source.id !== id), added] } }))
        : { ...project, externalCsvSources: [...project.externalCsvSources.filter((source) => source.id !== id), added] });
      this.pendingExternalCsv.delete(message.importId);
    } catch (error) {
      void vscode.window.showErrorMessage(`External CSV import failed: ${(error as Error).message}`);
    }
  }

  private async removeExternalCsvSignal(sourceId: string, column: string, groupId?: string): Promise<void> {
    const group = this.projectStore.current.analysisGroups?.find(item => item.id === groupId);
    const local = group?.definitionDependencies?.externalCsvSources.some(item => item.id === sourceId);
    const source = (local ? group!.definitionDependencies!.externalCsvSources : this.projectStore.current.externalCsvSources).find(item => item.id === sourceId);
    const signal = source?.valueColumns.find((item) => item.column === column); if (!source || !signal) return;
    try {
      await this.projectStore.update((project) => local ? { ...project, analysisGroups: project.analysisGroups?.map(item => item.id === groupId && item.definitionDependencies ? { ...item, definitionDependencies: { ...item.definitionDependencies,
        externalCsvSources: removeExternalCsvSignal({ ...project, externalCsvSources: item.definitionDependencies.externalCsvSources }, sourceId, column).externalCsvSources,
      } } : item) } : removeExternalCsvSignal(project, sourceId, column));
    } catch (error) {
      void vscode.window.showErrorMessage(`External CSV Signal removal failed: ${(error as Error).message}`);
    }
  }

}
