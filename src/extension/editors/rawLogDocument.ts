import * as path from 'path';
import * as vscode from 'vscode';
import type { Diagnostic } from '../../core/diagnostics/diagnostic';
import { ChunkedFrameStore, type FramePageQuery } from '../../core/frame/frameStore';
import { parseAscFile, type AscParseSummary } from '../../parsers/asc/parseAscStream';
import { parseBlfFile, type BlfParseSummary } from '../../parsers/blf/parseBlf';
import type { RawRowDto } from './rawLogProtocol';
import type { ManualFrameDefinition } from '../../core/manual/manualDefinition';
import { createManualDecodeContext, decodeManualFrame, formatDecodedSignal } from '../../core/manual/manualDecoder';
import type { CanFrame } from '../../core/frame/canFrame';
import { formatCanId } from '../../core/frame/canId';
import { InMemorySignalStore } from '../../core/signal/signalStore';
import { signalDefinitionFor } from '../../core/manual/manualDefinition';
import type { SignalDefinition } from '../../core/signal/signal';
import { once } from 'events';
import { createWriteStream } from 'fs';
import type { SigMixaProject } from '../../core/project/schema';
import { PluginHost, type PluginRegistry } from '../../core/plugin/pluginHost';
import { loadExternalCsv } from '../external/externalCsvLoader';

export type DocumentUpdate =
  | { readonly type: 'progress'; readonly frames: number; readonly bytesRead: number; readonly totalBytes: number }
  | { readonly type: 'diagnostics'; readonly diagnostics: readonly Diagnostic[]; readonly total: number }
  | { readonly type: 'analysisProgress'; readonly processed: number; readonly total: number }
  | { readonly type: 'analysisComplete'; readonly processed: number; readonly cancelled: boolean }
  | { readonly type: 'complete'; readonly summary: AscParseSummary | BlfParseSummary };

export class RawLogDocument implements vscode.CustomDocument {
  readonly store = new ChunkedFrameStore();
  readonly diagnostics: Diagnostic[] = [];
  readonly fileName: string;
  private readonly abortController = new AbortController();
  private readonly updates = new vscode.EventEmitter<DocumentUpdate>();
  readonly onDidUpdate = this.updates.event;
  private parsing = true;
  private totalDiagnostics = 0;
  private projectRevision = -1;
  private currentProject: SigMixaProject;
  private definitions = new Map<string, ManualFrameDefinition>();
  private pluginHost: PluginHost;
  private pluginDisplay = new Map<string, { readonly tags: readonly string[]; readonly diagnostics: readonly Diagnostic[] }>();
  private pluginDiagnosticOccurrences = new Map<string, number>();
  private displayCache = new Map<string, ReturnType<RawLogDocument['buildDisplay']>>();
  private signalStore = new InMemorySignalStore();
  private manualDecodeContext = createManualDecodeContext();
  private analysisToken = 0;
  private analysisRunning = false;
  private parseTask: Promise<AscParseSummary | BlfParseSummary>;

  constructor(readonly uri: vscode.Uri, project: SigMixaProject, revision: number, private readonly pluginRegistry: PluginRegistry) {
    this.currentProject = project;
    this.fileName = path.basename(uri.fsPath);
    this.pluginHost = new PluginHost(pluginRegistry, [], [], []);
    this.setProject(project, revision);
    this.registerSignalDefinitions(this.signalStore, project.frames);
    const sourceId = uri.toString();
    const parseFile = path.extname(uri.fsPath).toLowerCase() === '.blf' ? parseBlfFile : parseAscFile;
    this.parseTask = parseFile(uri.fsPath, {
      sourceId,
      signal: this.abortController.signal,
      onFrames: (frames) => {
        this.store.append(frames);
        this.decodeInto(this.signalStore, frames);
      },
      onDiagnostics: (diagnostics) => {
        this.totalDiagnostics += diagnostics.length;
        this.diagnostics.push(...diagnostics);
        if (this.diagnostics.length > 2000) this.diagnostics.splice(0, this.diagnostics.length - 2000);
        this.updates.fire({ type: 'diagnostics', diagnostics, total: this.totalDiagnostics });
      },
      onProgress: (progress) => this.updates.fire({
        type: 'progress', frames: progress.framesParsed, bytesRead: progress.bytesRead, totalBytes: progress.totalBytes,
      }),
    }).then(async (summary) => {
      this.parsing = false;
      if (!summary.cancelled) await this.appendExternal(this.signalStore, this.currentProject);
      this.signalStore.finalize();
      const completeSummary = { ...summary, diagnostics: this.totalDiagnostics };
      this.updates.fire({ type: 'complete', summary: completeSummary });
      return completeSummary;
    }, (error: Error) => {
      this.parsing = false;
      const diagnostic: Diagnostic = {
        id: `${sourceId}:fatal`, source: 'parser', code: 'LOG_READ_FAILED', severity: 'error',
        message: error.message, location: { sourceId },
      };
      this.diagnostics.push(diagnostic);
      this.totalDiagnostics++;
      this.updates.fire({ type: 'diagnostics', diagnostics: [diagnostic], total: this.totalDiagnostics });
      const summary = { bytesRead: 0, totalBytes: 0, linesRead: 0, framesParsed: this.store.size, diagnostics: this.totalDiagnostics, cancelled: false };
      this.updates.fire({ type: 'complete', summary });
      return summary;
    });
  }

  get isParsing(): boolean { return this.parsing; }
  get diagnosticCount(): number { return this.totalDiagnostics; }
  get isAnalyzing(): boolean { return this.analysisRunning; }

  query(query: FramePageQuery, project: SigMixaProject, revision: number): { rows: RawRowDto[]; offset: number; total: number; generation: number } {
    this.setProject(project, revision);
    const context = this.queryContext();
    const page = this.store.query(query, context);
    return { ...page, rows: page.rows.map((frame) => this.toRow(frame)) };
  }

  sample(query: Omit<FramePageQuery, 'offset' | 'limit'>, project: SigMixaProject, revision: number, maxRows = 300): RawRowDto[] {
    this.setProject(project, revision);
    return this.store.representativeSample(query.filter, maxRows, this.queryContext()).map((frame) => this.toRow(frame));
  }

  cancel(): void { this.abortController.abort(); }
  cancelAnalysis(): void { this.analysisToken++; this.analysisRunning = false; }
  dispose(): void { this.cancel(); this.cancelAnalysis(); this.pluginHost.dispose(); this.updates.dispose(); void this.parseTask; }

  async rebuildSignals(project: SigMixaProject, revision: number, force = false): Promise<void> {
    if (!force && revision === this.projectRevision) return;
    this.setProject(project, revision, force);
    const token = ++this.analysisToken;
    const next = new InMemorySignalStore();
    this.registerSignalDefinitions(next, project.frames);
    this.pluginDisplay.clear();
    this.pluginDiagnosticOccurrences.clear();
    this.signalStore = next;
    this.manualDecodeContext = createManualDecodeContext();
    this.analysisRunning = true;
    const total = this.store.size;
    let processed = 0;
    while (processed < total && token === this.analysisToken) {
      const page = this.store.query({ offset: processed, limit: 1000 });
      this.decodeInto(next, page.rows);
      processed += page.rows.length;
      this.updates.fire({ type: 'analysisProgress', processed, total });
      if (!page.rows.length) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const cancelled = token !== this.analysisToken;
    if (!cancelled) {
      await this.appendExternal(next, project);
      if (token !== this.analysisToken) { this.updates.fire({ type: 'analysisComplete', processed, cancelled: true }); return; }
      next.finalize();
      this.analysisRunning = false;
    }
    this.updates.fire({ type: 'analysisComplete', processed, cancelled });
  }

  signalCatalog(): readonly SignalDefinition[] { return this.signalStore.catalog(); }
  signalTablePage(selectedIds: readonly string[], offset: number, limit: number) { return this.signalStore.tablePage(selectedIds, offset, limit); }
  signalTableSample(selectedIds: readonly string[], limit = 300) { return this.signalStore.tableSample(selectedIds, limit); }
  signalSeries(selectedIds: readonly string[], range: { start: number; end: number } | undefined, maxPoints = 4000) {
    const boundedMaxPoints = Math.max(2, Math.min(10_000, Math.floor(maxPoints)));
    return { range: this.signalStore.fullRange(selectedIds), series: this.signalStore.seriesSlice(selectedIds, range, boundedMaxPoints) };
  }
  nearestSignals(selectedIds: readonly string[], timestamp: number) { return this.signalStore.nearest(selectedIds, timestamp); }

  async exportSignalCsv(targetPath: string, selectedIds: readonly string[]): Promise<void> {
    const definitions = new Map(this.signalStore.catalog().map((definition) => [definition.id, definition]));
    const ids = [...new Set(selectedIds)].filter((id) => definitions.has(id));
    const stream = createWriteStream(targetPath, { encoding: 'utf8' });
    const escape = (value: string) => /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
    const write = async (text: string) => { if (!stream.write(text)) await once(stream, 'drain'); };
    await write(['TIME(S)', ...ids.map((id) => {
      const definition = definitions.get(id)!;
      return escape(`${definition.name}${definition.unit ? ` (${definition.unit})` : ''}`);
    })].join(',') + '\n');
    for (const row of this.signalStore.eventRows(ids)) {
      await write([String(row.timestamp), ...ids.map((id) => row.values.get(id)?.value ?? '')].join(',') + '\n');
    }
    stream.end();
    await once(stream, 'close');
  }

  private setProject(project: SigMixaProject, revision: number, force = false): void {
    if (!force && revision === this.projectRevision) return;
    this.currentProject = project;
    this.projectRevision = revision;
    this.definitions = new Map(project.frames.map((definition) => [`${definition.extended ? 'e' : 's'}:${definition.canId}`, definition]));
    this.pluginHost.dispose();
    this.pluginHost = new PluginHost(this.pluginRegistry, project.frames, project.plugins, project.pluginBindings);
    this.displayCache.clear();
  }

  private registerSignalDefinitions(store: InMemorySignalStore, definitions: readonly ManualFrameDefinition[]): void {
    store.registerDefinitions(definitions.flatMap((frame) => [...frame.signals, ...(frame.derivedSignals ?? [])].map((signal) => signalDefinitionFor(frame, signal))));
  }

  private decodeInto(store: InMemorySignalStore, frames: readonly CanFrame[]): void {
    for (const frame of frames) {
      const definition = this.definitions.get(`${frame.extended ? 'e' : 's'}:${frame.canId}`);
      const manual = definition ? decodeManualFrame(frame, definition, this.manualDecodeContext) : { decoded: [], diagnostics: [] };
      const plugin = this.pluginHost.processFrame(frame);
      store.appendFrame(frame.id, frame.timestamp, [...manual.decoded, ...plugin.decoded]);
      for (const [signalId, events] of plugin.events) store.appendEvents(signalId, events);
      if (plugin.handled || plugin.diagnostics.length) {
        this.pluginDisplay.set(frame.id, { tags: plugin.decoded.map((item) => `${item.definition.name}=${item.sample.value}${item.definition.unit ? ` ${item.definition.unit}` : ''}`), diagnostics: plugin.diagnostics });
        if (this.pluginDisplay.size > 5000) { const oldest = this.pluginDisplay.keys().next().value as string | undefined; if (oldest) this.pluginDisplay.delete(oldest); }
      }
      if (plugin.diagnostics.length) this.publishDiagnostics(plugin.diagnostics);
    }
  }

  private queryContext() {
    return {
      cacheKey: `project:${this.projectRevision}`,
      additionalSearchText: (frame: CanFrame) => {
        const display = this.display(frame);
        return `${display.definition?.name ?? ''} ${display.tags.join(' ')}`;
      },
      isDecoded: (frame: CanFrame) => this.display(frame).tags.length > 0,
    };
  }

  private display(frame: CanFrame): ReturnType<RawLogDocument['buildDisplay']> {
    let result = this.displayCache.get(frame.id);
    if (!result) {
      result = this.buildDisplay(frame);
      this.displayCache.set(frame.id, result);
      if (this.displayCache.size > 5000) {
        const oldest = this.displayCache.keys().next().value as string | undefined;
        if (oldest) this.displayCache.delete(oldest);
      }
    }
    return result;
  }

  private buildDisplay(frame: CanFrame) {
    const definition = this.definitions.get(`${frame.extended ? 'e' : 's'}:${frame.canId}`);
    const result = definition ? decodeManualFrame(frame, definition) : { decoded: [], diagnostics: [] };
    const filterIds = (definition?.derivedSignals ?? []).filter((signal) => signal.operation.type === 'filter').map((signal) => signal.id);
    const filteredAtFrame = new Map(this.signalStore.nearest(filterIds, frame.timestamp).filter((item) => item.sample.timestamp === frame.timestamp).map((item) => [item.definition.id, item.sample]));
    const plugin = this.pluginDisplay.get(frame.id);
    return { definition, tags: [...result.decoded.map((item) => formatDecodedSignal(filteredAtFrame.has(item.definition.id) ? { ...item, sample: filteredAtFrame.get(item.definition.id)! } : item)), ...(plugin?.tags ?? [])], diagnostics: [...result.diagnostics, ...(plugin?.diagnostics ?? [])] };
  }

  private publishDiagnostics(diagnostics: readonly Diagnostic[]): void {
    const visible = diagnostics.filter((item) => {
      const owner = item.details?.pluginId ?? item.details?.externalSourceId ?? item.details?.calculationId ?? item.source;
      const key = `${String(owner)}:${item.code}:${item.message}`; const count = this.pluginDiagnosticOccurrences.get(key) ?? 0;
      this.pluginDiagnosticOccurrences.set(key, count + 1); return count < 20;
    });
    if (!visible.length) return;
    this.totalDiagnostics += visible.length; this.diagnostics.push(...visible);
    if (this.diagnostics.length > 2000) this.diagnostics.splice(0, this.diagnostics.length - 2000);
    this.updates.fire({ type: 'diagnostics', diagnostics: visible, total: this.totalDiagnostics });
  }

  private async appendExternal(store: InMemorySignalStore, project: SigMixaProject): Promise<void> {
    const workspaceRoot = vscode.workspace.getWorkspaceFolder(this.uri)?.uri.fsPath
      ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
      ?? path.dirname(this.uri.fsPath);
    for (const source of project.externalCsvSources) {
      const result = await loadExternalCsv(source, workspaceRoot);
      for (const series of result.series) store.appendSeries(series.definition, series.samples);
      this.publishDiagnostics(result.diagnostics);
    }
  }

  private toRow(frame: CanFrame): RawRowDto {
    const display = this.display(frame);
    const raw = Array.from(frame.data, (value) => value.toString(16).padStart(2, '0').toUpperCase()).join(' ');
    return {
      id: frame.id,
      time: frame.timestamp,
      direction: frame.direction,
      canId: formatCanId(frame.canId, frame.extended),
      canIdValue: frame.canId,
      extended: frame.extended,
      definitionId: display.definition?.id,
      decoded: display.tags.length > 0,
      name: display.definition?.name ?? '',
      channel: frame.channel,
      dlc: frame.dlcCode,
      length: frame.dataLength,
      content: display.tags.length ? display.tags.join('  ·  ') : raw,
      diagnostics: display.diagnostics.map((item) => ({ code: item.code, message: item.message })),
    };
  }
}
