import * as path from 'path';
import * as vscode from 'vscode';
import type { Diagnostic } from '../../core/diagnostics/diagnostic';
import { ChunkedFrameStore, type FrameFilter, type FramePageQuery } from '../../core/frame/frameStore';
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
import { formatCsvSignalValue, formatCsvTimestamp } from '../../core/export/csvNumber';
import { manualAnalysisDelta, type ManualAnalysisDelta } from '../../core/project/analysisDelta';

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
  private analysisRevision = -1;
  private currentProject: SigMixaProject;
  private analyzedProject: SigMixaProject;
  private definitions = new Map<string, ManualFrameDefinition>();
  private analysisDefinitions = new Map<string, ManualFrameDefinition>();
  private pluginHost: PluginHost;
  private pluginDisplay = new Map<string, { readonly tags: readonly string[]; readonly diagnostics: readonly Diagnostic[] }>();
  private pluginDiagnosticOccurrences = new Map<string, number>();
  private displayCache = new Map<string, ReturnType<RawLogDocument['buildDisplay']>>();
  private displayRevision = 0;
  private readonly channels = new Set<number>();
  private signalStore = new InMemorySignalStore();
  private manualDecodeContexts = new Map<string, ReturnType<typeof createManualDecodeContext>>();
  private analysisToken = 0;
  private analysisRunning = false;
  private parseTask: Promise<AscParseSummary | BlfParseSummary>;

  constructor(readonly uri: vscode.Uri, project: SigMixaProject, revision: number, private readonly pluginRegistry: PluginRegistry, readonly scope?: { readonly start: number; readonly end: number }) {
    this.currentProject = project;
    this.analyzedProject = project;
    this.analysisRevision = revision;
    this.fileName = path.basename(uri.fsPath);
    this.pluginHost = new PluginHost(pluginRegistry, [], [], []);
    this.setProject(project, revision);
    this.analysisDefinitions = definitionMap(project.frames);
    this.pluginHost.dispose();
    this.pluginHost = new PluginHost(pluginRegistry, project.frames, project.plugins, project.pluginBindings);
    this.registerSignalDefinitions(this.signalStore, project.frames);
    const sourceId = uri.toString();
    const parseFile = path.extname(uri.fsPath).toLowerCase() === '.blf' ? parseBlfFile : parseAscFile;
    this.parseTask = parseFile(uri.fsPath, {
      sourceId,
      signal: this.abortController.signal,
      onFrames: (frames) => {
        for (const frame of frames) this.channels.add(frame.channel);
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
      if (!summary.cancelled) await this.appendExternal(this.signalStore, this.analyzedProject);
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
  get channelValues(): readonly number[] { return [...this.channels].sort((left, right) => left - right); }
  get isAnalyzing(): boolean { return this.analysisRunning; }
  whenReady(): Promise<AscParseSummary | BlfParseSummary> { return this.parseTask; }

  query(query: FramePageQuery, project: SigMixaProject, revision: number): { rows: RawRowDto[]; offset: number; total: number; generation: number } {
    this.setProject(project, revision);
    const filter = this.scopedFilter(query.filter); const context = this.queryContext(filter);
    const page = this.store.query({ ...query, filter }, context);
    return { ...page, rows: page.rows.map((frame) => this.toRow(frame)) };
  }

  sample(query: Omit<FramePageQuery, 'offset' | 'limit'>, project: SigMixaProject, revision: number, maxRows = 300): RawRowDto[] {
    this.setProject(project, revision);
    const filter = this.scopedFilter(query.filter);
    return this.store.representativeSample(filter, maxRows, this.queryContext(filter)).map((frame) => this.toRow(frame));
  }

  cancel(): void { this.abortController.abort(); }
  cancelAnalysis(): void { this.analysisToken++; this.analysisRunning = false; }
  dispose(): void { this.cancel(); this.cancelAnalysis(); this.pluginHost.dispose(); this.updates.dispose(); void this.parseTask; }

  async rebuildSignals(project: SigMixaProject, revision: number, force = false): Promise<void> {
    if (!force && revision === this.analysisRevision) { this.setProject(project, revision); return; }
    const delta = force ? undefined : manualAnalysisDelta(this.analyzedProject, project);
    this.setProject(project, revision);
    const token = ++this.analysisToken;
    this.analysisRunning = true;
    if (delta) {
      await this.rebuildManualDelta(project, revision, delta, token);
      return;
    }
    const next = new InMemorySignalStore();
    this.registerSignalDefinitions(next, project.frames);
    const nextDefinitions = definitionMap(project.frames);
    const nextContexts = new Map<string, ReturnType<typeof createManualDecodeContext>>();
    const nextPluginHost = new PluginHost(this.pluginRegistry, project.frames, project.plugins, project.pluginBindings);
    const nextPluginDisplay = new Map<string, { readonly tags: readonly string[]; readonly diagnostics: readonly Diagnostic[] }>();
    let processed = 0; let batch: CanFrame[] = [];
    for (const frame of this.store.frames()) {
      if (token !== this.analysisToken) break;
      batch.push(frame); if (batch.length < 1000) continue;
      this.decodeInto(next, batch, nextDefinitions, nextContexts, nextPluginHost, nextPluginDisplay);
      processed += batch.length; batch = [];
      this.updates.fire({ type: 'analysisProgress', processed, total: this.store.size });
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (batch.length && token === this.analysisToken) { this.decodeInto(next, batch, nextDefinitions, nextContexts, nextPluginHost, nextPluginDisplay); processed += batch.length; this.updates.fire({ type: 'analysisProgress', processed, total: this.store.size }); }
    // A parser batch may have arrived exactly as the iterator reached its end.
    while (processed < this.store.size && token === this.analysisToken) {
      const page = this.store.query({ offset: processed, limit: 1000 }); if (!page.rows.length) break;
      this.decodeInto(next, page.rows, nextDefinitions, nextContexts, nextPluginHost, nextPluginDisplay); processed += page.rows.length;
      this.updates.fire({ type: 'analysisProgress', processed, total: this.store.size }); await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const cancelled = token !== this.analysisToken;
    if (!cancelled) {
      // While parsing, the completion path appends External CSV to whichever
      // store is current after this atomic swap. Avoid importing it twice.
      if (!this.parsing) await this.appendExternal(next, project);
      if (token !== this.analysisToken) { nextPluginHost.dispose(); this.updates.fire({ type: 'analysisComplete', processed, cancelled: true }); return; }
      next.finalize();
      this.pluginHost.dispose();
      this.pluginHost = nextPluginHost;
      this.pluginDisplay = nextPluginDisplay;
      this.pluginDiagnosticOccurrences.clear();
      this.signalStore = next;
      this.analysisDefinitions = nextDefinitions;
      this.manualDecodeContexts = nextContexts;
      this.analyzedProject = project;
      this.analysisRevision = revision;
      this.displayCache.clear(); this.displayRevision++;
      this.analysisRunning = false;
    } else nextPluginHost.dispose();
    this.updates.fire({ type: 'analysisComplete', processed, cancelled });
  }

  private async rebuildManualDelta(project: SigMixaProject, revision: number, delta: ManualAnalysisDelta, token: number): Promise<void> {
    const nextDefinitions = definitionMap(project.frames);
    const replacement = new InMemorySignalStore();
    const changedFrames = project.frames.filter((frame) => delta.frameIds.has(frame.id));
    this.registerSignalDefinitions(replacement, changedFrames);
    const contexts = new Map<string, ReturnType<typeof createManualDecodeContext>>();
    let processed = 0; let batch: CanFrame[] = [];
    for (const frame of this.store.framesByCanRefs(delta.canRefs)) {
      if (token !== this.analysisToken) break;
      batch.push(frame); if (batch.length < 1000) continue;
      this.decodeManualInto(replacement, batch, nextDefinitions, contexts, delta.frameIds);
      processed += batch.length; batch = [];
      this.updates.fire({ type: 'analysisProgress', processed, total: this.store.countByCanRefs(delta.canRefs) });
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (batch.length && token === this.analysisToken) { this.decodeManualInto(replacement, batch, nextDefinitions, contexts, delta.frameIds); processed += batch.length; this.updates.fire({ type: 'analysisProgress', processed, total: this.store.countByCanRefs(delta.canRefs) }); }
    while (processed < this.store.countByCanRefs(delta.canRefs) && token === this.analysisToken) {
      const page = this.store.queryByCanRefs(delta.canRefs, processed, 1000); if (!page.length) break;
      this.decodeManualInto(replacement, page, nextDefinitions, contexts, delta.frameIds); processed += page.length;
      this.updates.fire({ type: 'analysisProgress', processed, total: this.store.countByCanRefs(delta.canRefs) }); await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const cancelled = token !== this.analysisToken;
    if (!cancelled) {
      replacement.finalize();
      this.signalStore.replaceDefinitions((definition) => definition.source.type === 'manual-can' && delta.frameIds.has(definition.source.frameDefinitionId), replacement);
      for (const id of delta.frameIds) this.manualDecodeContexts.delete(id);
      for (const [id, context] of contexts) this.manualDecodeContexts.set(id, context);
      this.analysisDefinitions = nextDefinitions;
      this.analyzedProject = project;
      this.analysisRevision = revision;
      this.displayCache.clear(); this.displayRevision++;
      this.analysisRunning = false;
    }
    this.updates.fire({ type: 'analysisComplete', processed, cancelled });
  }

  signalCatalog(): readonly SignalDefinition[] { return this.signalStore.catalog(); }
  signalTablePage(selectedIds: readonly string[], offset: number, limit: number) { return this.signalStore.tableDisplayPage(selectedIds, offset, limit, this.scope); }
  signalTableSample(selectedIds: readonly string[], limit = 300) { return this.signalStore.tableSample(selectedIds, limit, this.scope); }
  signalSeries(selectedIds: readonly string[], range: { start: number; end: number } | undefined, maxPoints = 4000) {
    const boundedMaxPoints = Math.max(2, Math.min(10_000, Math.floor(maxPoints)));
    const fullRange = intersectRange(this.signalStore.fullRange(selectedIds), this.scope);
    const requestedRange = intersectRange(range, this.scope);
    if (range && this.scope && !requestedRange) return { range: fullRange, series: [] };
    return { range: fullRange, series: this.signalStore.seriesSlice(selectedIds, requestedRange, boundedMaxPoints) };
  }
  nearestSignals(selectedIds: readonly string[], timestamp: number, range = this.scope) { return this.signalStore.nearest(selectedIds, timestamp, range); }

  measuredSignals(selectedIds: readonly string[], timestamp: number, range?: { readonly start: number; readonly end: number }) {
    const bounded = this.scope && range ? { start: Math.max(this.scope.start, range.start), end: Math.min(this.scope.end, range.end) } : this.scope ?? range;
    if (bounded && (bounded.end < bounded.start || timestamp < bounded.start || timestamp > bounded.end)) return [];
    return this.signalStore.measured(selectedIds, timestamp, bounded);
  }
  adjacentFrameTimestamp(timestamp: number, direction: -1 | 1): number | undefined { return this.store.adjacentTimestamp(timestamp, direction, this.scope); }
  nearestFrameTimestamp(timestamp: number): number | undefined { return this.store.nearestTimestamp(timestamp, this.scope); }

  selectedRowsText(ranges: readonly { readonly start: number; readonly end: number }[], filter: FrameFilter | undefined, project: SigMixaProject, revision: number, contentMode: 'raw' | 'decoded', includeHeader: boolean): { readonly text: string; readonly count: number } {
    this.setProject(project, revision); const normalized = normalizeRanges(ranges); const selectedCount = normalized.reduce((sum, range) => sum + range.end - range.start + 1, 0);
    if (selectedCount > 100_000) throw new Error('Select at most 100,000 RAW Log rows at once.');
    const lines: string[] = includeHeader ? ['TIME(S)\tTX/RX\tCAN ID\tNAME\tCH\tDLC\tLENGTH\tCONTENT'] : [];
    const scoped = this.scopedFilter(filter); const context = this.queryContext(scoped); let count = 0; let length = lines[0]?.length ?? 0;
    for (const range of normalized) {
      let offset = range.start;
      while (offset <= range.end) {
        const page = this.store.query({ offset, limit: Math.min(2000, range.end - offset + 1), filter: scoped }, context);
        if (!page.rows.length) break;
        for (const frame of page.rows) {
          const row = this.toRow(frame); const content = contentMode === 'raw' ? row.rawContent : row.decodedContent || row.rawContent;
          const line = [row.time.toFixed(6), row.direction, row.canId, row.name, row.channel, row.dlc, row.length, content].map(cleanTsvCell).join('\t');
          length += line.length + 2; if (length > 16_000_000) throw new Error('The selected RAW Log text is too large to copy or open at once.');
          lines.push(line); count++;
        }
        offset += page.rows.length;
      }
    }
    return { text: `${lines.join('\r\n')}\r\n`, count };
  }

  selectedSignalRowsText(ranges: readonly { readonly start: number; readonly end: number }[], selectedIds: readonly string[], includeHeader: boolean): { readonly text: string; readonly count: number } {
    const definitions = new Map(this.signalStore.catalog().map((definition) => [definition.id, definition]));
    const ids = [...new Set(selectedIds)].filter((id) => definitions.has(id));
    const normalized = normalizeRanges(ranges); const selectedCount = normalized.reduce((sum, range) => sum + range.end - range.start + 1, 0);
    if (selectedCount > 100_000) throw new Error('Select at most 100,000 Signal Table rows at once.');
    const headers = ['TIME(S)', ...ids.map((id) => { const definition = definitions.get(id)!; return `${definition.name}${definition.unit ? ` (${definition.unit})` : ''}`; })];
    const lines: string[] = includeHeader ? [headers.map(cleanTsvCell).join('\t')] : [];
    let count = 0; let length = lines[0]?.length ?? 0;
    for (const range of normalized) {
      let offset = range.start;
      while (offset <= range.end) {
        const page = this.signalStore.tablePage(ids, offset, Math.min(2000, range.end - offset + 1), this.scope);
        if (!page.rows.length) break;
        for (const row of page.rows) {
          const line = [formatCsvTimestamp(row.timestamp), ...ids.map((id) => { const value = row.values.get(id)?.value; return value === undefined ? '' : formatCsvSignalValue(value); })].map(cleanTsvCell).join('\t');
          length += line.length + 2; if (length > 16_000_000) throw new Error('The selected Signal Table text is too large to copy or open at once.');
          lines.push(line); count++;
        }
        offset += page.rows.length;
      }
    }
    return { text: `${lines.join('\r\n')}\r\n`, count };
  }

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
    for (const row of this.signalStore.eventRows(ids, this.scope)) {
      await write([formatCsvTimestamp(row.timestamp), ...ids.map((id) => {
        const value = row.values.get(id)?.value;
        return value === undefined ? '' : formatCsvSignalValue(value);
      })].join(',') + '\n');
    }
    stream.end();
    await once(stream, 'close');
  }

  private setProject(project: SigMixaProject, revision: number): void {
    if (revision === this.projectRevision) return;
    this.currentProject = project;
    this.projectRevision = revision;
    this.definitions = definitionMap(project.frames);
    this.displayCache.clear();
    this.displayRevision++;
  }

  private registerSignalDefinitions(store: InMemorySignalStore, definitions: readonly ManualFrameDefinition[]): void {
    store.registerDefinitions(definitions.flatMap((frame) => [...frame.signals, ...(frame.derivedSignals ?? [])].map((signal) => signalDefinitionFor(frame, signal))));
  }

  private decodeInto(
    store: InMemorySignalStore,
    frames: readonly CanFrame[],
    definitions = this.analysisDefinitions,
    contexts = this.manualDecodeContexts,
    pluginHost = this.pluginHost,
    pluginDisplay = this.pluginDisplay,
  ): void {
    for (const frame of frames) {
      const definition = definitions.get(canKey(frame.canId, frame.extended));
      const manual = definition ? decodeManualFrame(frame, definition, contextFor(contexts, definition.id)) : { decoded: [], diagnostics: [] };
      const plugin = pluginHost.processFrame(frame);
      store.appendFrame(frame.id, frame.timestamp, [...manual.decoded, ...plugin.decoded]);
      for (const [signalId, events] of plugin.events) store.appendEvents(signalId, events);
      if (plugin.handled || plugin.diagnostics.length) {
        pluginDisplay.set(frame.id, { tags: plugin.decoded.map((item) => `${item.definition.name}=${item.sample.value}${item.definition.unit ? ` ${item.definition.unit}` : ''}`), diagnostics: plugin.diagnostics });
        if (pluginDisplay.size > 5000) { const oldest = pluginDisplay.keys().next().value as string | undefined; if (oldest) pluginDisplay.delete(oldest); }
      }
      if (plugin.diagnostics.length) this.publishDiagnostics(plugin.diagnostics);
    }
  }

  private decodeManualInto(
    store: InMemorySignalStore,
    frames: readonly CanFrame[],
    definitions: ReadonlyMap<string, ManualFrameDefinition>,
    contexts: Map<string, ReturnType<typeof createManualDecodeContext>>,
    eligibleFrameIds: ReadonlySet<string>,
  ): void {
    for (const frame of frames) {
      const definition = definitions.get(canKey(frame.canId, frame.extended));
      if (!definition || !eligibleFrameIds.has(definition.id)) continue;
      const manual = decodeManualFrame(frame, definition, contextFor(contexts, definition.id));
      store.appendFrame(frame.id, frame.timestamp, manual.decoded);
    }
  }

  private queryContext(filter?: FrameFilter) {
    return {
      cacheKey: `project:${this.projectRevision}:display:${this.displayRevision}`,
      additionalSearchText: (frame: CanFrame) => {
        const display = this.display(frame);
        return `${display.definition?.name ?? ''} ${filter?.searchContent === 'raw' ? '' : display.tags.join(' ')}`;
      },
      isDecoded: (frame: CanFrame) => this.display(frame).tags.length > 0,
    };
  }

  private scopedFilter(filter: FramePageQuery['filter']): FramePageQuery['filter'] {
    if (!this.scope) return filter;
    return {
      ...filter,
      timeStart: Math.max(filter?.timeStart ?? -Infinity, this.scope.start),
      timeEnd: Math.min(filter?.timeEnd ?? Infinity, this.scope.end),
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
    const decodedSignals = result.decoded.map((item) => ({
      tag: formatDecodedSignal(filteredAtFrame.has(item.definition.id) ? { ...item, sample: filteredAtFrame.get(item.definition.id)! } : item),
      ...('byteOffset' in item.signal ? { raw: item.raw?.toString(), byteOffset: item.signal.byteOffset, bitOffset: item.signal.bitOffset, lengthBits: item.signal.lengthBits, byteOrder: item.signal.byteOrder } : {}),
    }));
    return { definition, decodedSignals, tags: [...decodedSignals.map((item) => item.tag), ...(plugin?.tags ?? [])], diagnostics: [...result.diagnostics, ...(plugin?.diagnostics ?? [])] };
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
      rawContent: raw,
      decodedContent: display.tags.join('  ·  '),
      decodedSignals: display.decodedSignals,
      diagnostics: display.diagnostics.map((item) => ({ code: item.code, message: item.message })),
    };
  }
}

function intersectRange(left: { readonly start: number; readonly end: number } | undefined, right: { readonly start: number; readonly end: number } | undefined): { start: number; end: number } | undefined {
  if (!left) return right ? { ...right } : undefined;
  if (!right) return { ...left };
  const start = Math.max(left.start, right.start); const end = Math.min(left.end, right.end);
  return start <= end ? { start, end } : undefined;
}

function cleanTsvCell(value: string | number): string { return String(value).replace(/[\t\r\n]+/g, ' '); }
function normalizeRanges(ranges: readonly { readonly start: number; readonly end: number }[]): readonly { readonly start: number; readonly end: number }[] {
  const sorted = ranges.filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end)).map((range) => ({ start: Math.max(0, Math.floor(Math.min(range.start, range.end))), end: Math.max(0, Math.floor(Math.max(range.start, range.end))) })).sort((left, right) => left.start - right.start || left.end - right.end);
  const result: { start: number; end: number }[] = [];
  for (const range of sorted) { const previous = result[result.length - 1]; if (previous && range.start <= previous.end + 1) previous.end = Math.max(previous.end, range.end); else result.push({ ...range }); }
  return result;
}

function definitionMap(frames: readonly ManualFrameDefinition[]): Map<string, ManualFrameDefinition> {
  return new Map(frames.map((definition) => [canKey(definition.canId, definition.extended), definition]));
}
function canKey(canId: number, extended: boolean): string { return `${extended ? 'e' : 's'}:${canId}`; }
function contextFor(contexts: Map<string, ReturnType<typeof createManualDecodeContext>>, definitionId: string): ReturnType<typeof createManualDecodeContext> {
  let context = contexts.get(definitionId); if (!context) { context = createManualDecodeContext(); contexts.set(definitionId, context); } return context;
}
