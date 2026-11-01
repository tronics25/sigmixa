import { decodedExplanation } from '../../core/manual/decodedExplanation';
import { TraceIndex, type TraceSnapshot } from '../../core/frame/traceIndex';
import type { LastFrameDto } from './rawLogProtocol';
import * as path from 'path';
import * as vscode from 'vscode';
import { describeLogReadError, notifyLogReadError } from '../storage/logReadError';
import type { Diagnostic } from '../../core/diagnostics/diagnostic';
import { DiagnosticTally, type DiagnosticGroup } from '../../core/diagnostics/diagnosticTally';
import { runScan } from './widthScan';
import { textCells } from '../../core/frame/widestText';

import { ChunkedFrameStore, type FrameFilter, type FramePageQuery } from '../../core/frame/frameStore';
import { parseAscFile, type AscParseSummary } from '../../parsers/asc/parseAscStream';
import { parseBlfFile, type BlfParseSummary } from '../../parsers/blf/parseBlf';
import type { RawRowDto } from './rawLogProtocol';
import type { ManualFrameDefinition } from '../../core/manual/manualDefinition';
import { createManualDecodeContext, decodeManualFrame, formatDecodedSignal } from '../../core/manual/manualDecoder';
import type { CanFrame } from '../../core/frame/canFrame';
import { formatCanId } from '../../core/frame/canId';
import { InMemorySignalStore, type SignalFrameRef } from '../../core/signal/signalStore';
import { PluginFrameTags } from './pluginFrameTags';
import { signalDefinitionFor } from '../../core/manual/manualDefinition';
import { isSignalActive } from '../../core/manual/manualDefinition';
import { extractBits } from '../../core/manual/bits';
import type { SignalDefinition } from '../../core/signal/signal';
import { once } from 'events';
import { createWriteStream } from 'fs';
import type { SigMixaProject } from '../../core/project/schema';
import { PluginHost, type PluginRegistry } from '../../core/plugin/pluginHost';
import { loadExternalCsv } from '../external/externalCsvLoader';
import { formatCsvSignalValue, formatCsvTimestamp } from '../../core/export/csvNumber';
import { manualAnalysisDelta, type ManualAnalysisDelta } from '../../core/project/analysisDelta';
import { formatExportTime, timeColumnLabel, type TimeDisplayMode, type TimeReference } from '../../core/time/timeFormat';

export type DocumentUpdate =
  | { readonly type: 'progress'; readonly frames: number; readonly bytesRead: number; readonly totalBytes: number }
  | { readonly type: 'sourceDiagnostics'; readonly groups: readonly DiagnosticGroup[]; readonly total: number }
  | { readonly type: 'analysisDiagnostics'; readonly groups: readonly DiagnosticGroup[]; readonly total: number }
  | { readonly type: 'analysisProgress'; readonly processed: number; readonly total: number }
  /** More frames were read for the RAW filter; `complete` once all were. */
  | { readonly type: 'searchProgress'; readonly complete: boolean }
  | { readonly type: 'analysisComplete'; readonly processed: number; readonly cancelled: boolean }
  | { readonly type: 'timeReference'; readonly reference: TimeReference }
  | { readonly type: 'complete'; readonly summary: AscParseSummary | BlfParseSummary };

const LAST_FRAME_REFRESH_MS = 1000;
/** Shortest time between progress updates while a log is read. */
const PROGRESS_MS = 250;
/** One background step of a RAW filter over a large log. */
const SEARCH_STEP_MS = 30;

export class RawLogDocument implements vscode.CustomDocument {
  readonly store = new ChunkedFrameStore();
  readonly fileName: string;
  private readonly abortController = new AbortController();
  private readonly updates = new vscode.EventEmitter<DocumentUpdate>();
  readonly onDidUpdate = this.updates.event;
  private parsing = true;
  /** Parser, External CSV and storage findings, grouped; positions are source lines. */
  private sourceDiagnostics = new DiagnosticTally('line');
  private sourceDiagnosticsPublishedAt = 0;
  /** Decode and Plugin findings for every analysed frame, independent of which rows the RAW view has loaded. */
  private analysisDiagnostics = new DiagnosticTally();
  private analysisDiagnosticsPublishedAt = 0;
  private lastFrameIndex?: TraceIndex;
  private lastSignalGeneration = -1;
  private lastSignalStore?: InMemorySignalStore;
  private lastFrameGeneration = -1;
  private lastFrameBuiltAt = 0;
  /** How long the last Trace index took to build: on a large log it is rebuilt less often while loading, so loading keeps most of the time. */
  private lastFrameBuildMs = 0;
  private traceBuild?: Promise<void>;
  private disposed = false;
  private progressAt = -Infinity; private servedMs = 0; private rowsReserved = false;
  /** Advanced when the project changes, so a Trace index being built for the previous one is dropped. */
  private traceEpoch = 0;
  private searchStep?: NodeJS.Immediate; private searchNotifiedAt = 0;
  private lastSearchTags?: { readonly frame: CanFrame; readonly revision: number; readonly tags: readonly string[] };
  private projectRevision = -1;
  private analysisRevision = -1;
  private currentProject: SigMixaProject;
  private analyzedProject: SigMixaProject;
  private definitions = new Map<string, ManualFrameDefinition>();
  private analysisDefinitions = new Map<string, ManualFrameDefinition>();
  private pluginHost: PluginHost;
  /** What Plugins decoded from each frame they handled, as the RAW log shows it: kept for every frame, so old frames show their values too. */
  private pluginDisplay = new PluginFrameTags();
  private widthCache?: { readonly key: string; readonly frames: Promise<readonly CanFrame[]> };
  private displayCache = new Map<string, ReturnType<RawLogDocument['buildDisplay']>>();
  private displayRevision = 0;
  private readonly channels = new Set<number>();
  private signalStore = this.newSignalStore();
  private manualDecodeContexts = new Map<string, ReturnType<typeof createManualDecodeContext>>();
  private analysisToken = 0;
  private analysisRunning = false;
  private parseTask: Promise<AscParseSummary | BlfParseSummary>;
  private readErrorMessage?: string;
  private reference?: TimeReference;

  /** `filePath`: the log file itself (`uri` names what is opened: the log from some place, or one of its Clips). */
  constructor(readonly uri: vscode.Uri, readonly filePath: string, project: SigMixaProject, revision: number, private readonly pluginRegistry: PluginRegistry, readonly scope?: { readonly start: number; readonly end: number }) {
    this.currentProject = project;
    this.analyzedProject = project;
    this.analysisRevision = revision;
    this.fileName = path.basename(filePath);
    this.pluginHost = new PluginHost(pluginRegistry, [], [], []);
    this.setProject(project, revision);
    this.analysisDefinitions = definitionMap(project.frames);
    this.pluginHost.dispose();
    this.pluginHost = new PluginHost(pluginRegistry, project.frames, project.plugins, project.pluginBindings);
    this.registerSignalDefinitions(this.signalStore, project.frames);
    const sourceId = uri.toString();
    const parseFile = path.extname(filePath).toLowerCase() === '.blf' ? parseBlfFile : parseAscFile;
    this.parseTask = parseFile(filePath, {
      sourceId,
      signal: this.abortController.signal,
      onFrames: (frames) => {
        for (const frame of frames) this.channels.add(frame.channel);
        const first = this.store.size;
        this.store.append(frames);
        this.decodeInto(this.signalStore, frames, first);
        this.publishAnalysisDiagnostics(this.analysisDiagnostics);
      },
      onDiagnostics: (diagnostics) => {
        this.addSourceDiagnostics(diagnostics);
      },
      onTimeReference: (reference) => { this.reference = reference; this.updates.fire({ type: 'timeReference', reference }); },
      onProgress: (progress) => {
        // Once the rate of frames per byte is known, room is made for the whole log's rows at once.
        if (!this.rowsReserved && progress.framesParsed >= 50_000 && progress.bytesRead > 0 && progress.totalBytes > progress.bytesRead) {
          // Never more than one row per frame, and at most 8 Signals per row in advance, so an unusual start of the log
          // cannot make room for far more than the log holds; anything beyond grows as usual.
          this.rowsReserved = true; const scale = progress.totalBytes / progress.bytesRead * 1.02; const store = this.signalStore;
          const rows = Math.min(store.rowCount, this.store.size) * scale;
          store.reserveRows(rows, Math.min(store.refCount * scale, rows * 8));
        }
        // At most every PROGRESS_MS, and no sooner than four times what the screens took to refresh since the last one.
        const now = performance.now();
        if (now - this.progressAt < Math.max(PROGRESS_MS, 4 * this.servedMs)) return;
        this.progressAt = now; this.servedMs = 0;
        this.updates.fire({ type: 'progress', frames: progress.framesParsed, bytesRead: progress.bytesRead, totalBytes: progress.totalBytes });
      },
    }).then(async (summary) => {
      this.parsing = false;
      if (!summary.cancelled) await this.appendExternal(this.signalStore, this.analyzedProject);
      // On a large log, giving back the columns' spare room takes seconds: it is done in steps afterwards.
      const store = this.signalStore; store.finalize({ deferTrim: true }); void runScan(store.trimSteps());
      this.publishAnalysisDiagnostics(this.analysisDiagnostics, true);
      this.publishSourceDiagnostics(true);
      const completeSummary = { ...summary, diagnostics: this.sourceDiagnostics.total };
      this.updates.fire({ type: 'complete', summary: completeSummary });
      return completeSummary;
    }, (error: Error) => {
      this.parsing = false;
      const diagnostic: Diagnostic = {
        id: `${sourceId}:fatal`, source: 'parser', code: 'LOG_READ_FAILED', severity: 'error',
        message: describeLogReadError(error, filePath), location: { sourceId },
      };
      this.readErrorMessage = diagnostic.message;
      notifyLogReadError(error, filePath);
      this.addSourceDiagnostics([diagnostic]); this.publishSourceDiagnostics(true);
      const summary = { bytesRead: 0, totalBytes: 0, linesRead: 0, framesParsed: this.store.size, diagnostics: this.sourceDiagnostics.total, cancelled: false };
      this.updates.fire({ type: 'complete', summary });
      return summary;
    });
  }

  get isParsing(): boolean { return this.parsing; }
  get timelineRange(): { readonly start: number; readonly end: number } | undefined { return this.store.timeRange && intersectRange(this.store.timeRange, this.scope); }
  get diagnosticCount(): number { return this.sourceDiagnostics.total; }
  get sourceDiagnosticGroups(): readonly DiagnosticGroup[] { return this.sourceDiagnostics.snapshot(); }
  get analysisDiagnosticGroups(): readonly DiagnosticGroup[] { return this.labelDiagnosticGroups(this.analysisDiagnostics.snapshot()); }
  private labelDiagnosticGroups(groups: readonly DiagnosticGroup[]): DiagnosticGroup[] {
    const labels = new Map(this.currentProject.frames.map((frame) => [frame.id, `${formatCanId(frame.canId, frame.extended)}${frame.name ? ` ${frame.name}` : ''}`]));
    return groups.map((group) => group.definitionId && labels.has(group.definitionId) ? { ...group, subject: labels.get(group.definitionId) } : group);
  }
  get analysisDiagnosticCount(): number { return this.analysisDiagnostics.total; }
  get channelValues(): readonly number[] { return [...this.channels].sort((left, right) => left - right); }
  get isAnalyzing(): boolean { return this.analysisRunning; }
  whenReady(): Promise<AscParseSummary | BlfParseSummary> { return this.parseTask; }
  /** Where the log's timestamps sit on its recording clock; undefined while unknown or when the file does not say. */
  get timeReference(): TimeReference | undefined { return this.reference; }
  private exportTime(timestamp: number, mode: TimeDisplayMode | undefined, seconds: (value: number) => string): string { return formatExportTime(timestamp, mode ?? 'datetime', this.reference, seconds); }
  /**
   * CSV seconds. Measured on a recording clock (around 1.7e9) they hold about 0.2 µs, so they are written to the µs,
   * without the digits of binary rounding. Logs without a start keep every digit, as before.
   */
  private readonly csvSeconds = (value: number): string => this.reference ? trimmedMicroseconds(value) : formatCsvTimestamp(value);
  private exportTimeLabel(mode: TimeDisplayMode | undefined): string { return timeColumnLabel(mode ?? 'datetime', this.reference); }
  /** Why the log could not be read, when reading failed (explained for the user). */
  get readError(): string | undefined { return this.readErrorMessage; }

  query(query: FramePageQuery, project: SigMixaProject, revision: number): { rows: RawRowDto[]; offset: number; total: number; generation: number } { return this.serving(() => this.queryNow(query, project, revision)); }

  private queryNow(query: FramePageQuery, project: SigMixaProject, revision: number): { rows: RawRowDto[]; offset: number; total: number; generation: number } {
    this.setProject(project, revision);
    const filter = this.scopedFilter(query.filter); const context = this.queryContext(filter);
    const page = this.store.query({ ...query, filter }, context);
    if (page.complete === false) this.continueSearch();
    return { ...page, rows: page.rows.map((frame) => this.toRow(frame)) };
  }

  /** Reads the rest of the log for the RAW filter in short steps, telling the screen as matches are found. */
  private continueSearch(): void {
    if (this.searchStep) return;
    const step = () => {
      this.searchStep = undefined;
      // The Trace waits for its index, so the search lets it finish first.
      if (this.traceBuild) { void this.traceBuild.then(() => { if (!this.disposed && !this.searchStep) this.searchStep = setImmediate(step); }); return; }
      const complete = this.store.continueScan(SEARCH_STEP_MS); const now = Date.now();
      if (complete || now - this.searchNotifiedAt >= 250) { this.searchNotifiedAt = now; this.updates.fire({ type: 'searchProgress', complete }); }
      if (!complete) this.searchStep = setImmediate(step);
    };
    this.searchStep = setImmediate(step);
  }

  /** Rows that together hold the widest text of every column, from all frames the filter shows. Every frame is read; a large log is read in steps so other work keeps running. */
  async widthRows(query: Omit<FramePageQuery, 'offset' | 'limit'>, project: SigMixaProject, revision: number): Promise<RawRowDto[]> {
    this.setProject(project, revision);
    const filter = this.scopedFilter(query.filter);
    const key = JSON.stringify([filter, this.store.generation, this.signalStore.generation, this.displayRevision, this.analysisRevision]);
    if (this.widthCache?.key !== key) {
      const decodedCells = this.signalStore.frameTextCounter();
      const contentCells = (frame: CanFrame, ordinal: number): readonly number[] => {
        const raw = frame.dataLength > 0 ? frame.dataLength * 3 - 1 : 0;
        const decoded = decodedCells(ordinal) + this.pluginDisplay.cells(ordinal, textCells, 7);
        return [raw, decoded || raw];
      };
      this.widthCache = { key, frames: runScan(this.store.widthScan(filter, contentCells, this.queryContext(filter))) };
    }
    return (await this.widthCache.frames).map((frame) => this.toRow(frame));
  }

  async lastFrames(timestamp: number): Promise<LastFrameDto[]> {
    const stale = () => !this.lastFrameIndex || this.lastFrameGeneration !== this.store.generation || this.lastSignalGeneration !== this.signalStore.generation || this.lastSignalStore !== this.signalStore;
    // Generations advance with every parsed/analysed batch; rebuilding the whole index for each Trace
    // request would keep the extension host busy, so refresh it at most once per interval until work settles.
    // While reading, the last index answers at once; otherwise the answer waits for the index being built (again when
    // the project changed meanwhile).
    for (let attempt = 0; attempt < 3; attempt++) {
      const busy = this.parsing || this.analysisRunning;
      if (stale() && !this.traceBuild && (!this.lastFrameIndex || !busy || Date.now() - this.lastFrameBuiltAt >= Math.max(LAST_FRAME_REFRESH_MS, 4 * this.lastFrameBuildMs))) this.startTraceBuild();
      if (!this.traceBuild || (this.lastFrameIndex && busy)) break;
      await this.traceBuild;
      if (this.disposed) return [];
    }
    const index = this.lastFrameIndex; if (!index) return [];
    // The head of the Trace is the moment before the first frame of the log or Clip: no frame has been received yet.
    const head = this.timelineRange?.start; if (head !== undefined && timestamp <= head) timestamp = head - BEFORE_FIRST_FRAME_SECONDS;
    const catalog = new Map(this.signalStore.catalog().map((definition) => [definition.id, definition]));
    const toTraceRow = (item: TraceSnapshot): LastFrameDto => {
      const { canId, extended, channel, direction } = item.identity;
      const definition = this.definitions.get(`${extended ? 'e' : 's'}:${canId}`);
      const row = item.frame ? this.toRow(item.frame) : this.unreceivedRow(canId, extended, channel, direction, definition);
      const selectorId = item.multiplexer ? definition?.signals.find((signal) => signal.multiplexing?.type === 'multiplexer')?.id : undefined;
      const declared = [...(definition?.signals ?? []).filter((signal) => !item.multiplexer || (signal.id !== selectorId && isSignalActive(signal, item.multiplexer.value))),
        ...(definition?.derivedSignals ?? []).filter((signal) => !item.multiplexer || item.signals.has(signal.id))];
      const ids = [...new Set([...declared.map((signal) => signal.id), ...item.signals.keys()])].filter((id) => id !== selectorId);
      const signals = ids.map((id) => { const metadata = catalog.get(id) ?? declared.find((signal) => signal.id === id); const sample = item.signals.get(id); return { id, name: metadata?.name ?? id, unit: metadata?.unit, value: sample?.value, valueLabel: sample?.valueLabel, timestamp: sample?.timestamp, ...(sample?.carried ? { carried: true } : {}) }; });
      // The CAN ID's cycle is not the cycle of an individual MUX branch.
      const expected = item.multiplexer ? undefined : definition?.expectedPeriodMs;
      return { key: item.key, multiplexer: item.multiplexer, row, count: item.count, age: item.age, intervalMs: item.intervalMs, minIntervalMs: item.minIntervalMs, maxIntervalMs: item.maxIntervalMs, lastChangeAt: item.lastChangeAt, expectedPeriodMs: expected, deviationMs: expected !== undefined && item.intervalMs !== undefined ? item.intervalMs - expected : undefined, signals };
    };
    const branches = new Map<string, LastFrameDto[]>();
    for (const item of index.at(timestamp, this.scope?.start, this.scope?.end)) {
      if (!item.multiplexer) continue;
      const parentKey = item.key.split(':mux:')[0]; const group = branches.get(parentKey) ?? [];
      group.push({ ...toTraceRow(item), parentKey }); branches.set(parentKey, group);
    }
    const result = index.at(timestamp, this.scope?.start, this.scope?.end, false).map((item) => ({ ...toTraceRow(item), multiplexerRows: branches.get(item.key) }));
    for (const definition of this.currentProject.frames) {
      if (result.some((item) => item.row.canIdValue === definition.canId && item.row.extended === definition.extended)) continue;
      const selector = definition.multiplexing ? definition.signals.find((signal) => signal.multiplexing?.type === 'multiplexer') : undefined;
      const missing: LastFrameDto = { key: `${definition.extended ? 'e' : 's'}:${definition.canId}:*:*`, row: this.unreceivedRow(definition.canId, definition.extended, -1, 'Rx', definition), count: 0, expectedPeriodMs: definition.expectedPeriodMs,
        signals: [...definition.signals, ...(definition.derivedSignals ?? [])].map((signal) => ({ id: signal.id, name: signal.name, unit: signal.unit })) };
      result.push({ ...missing, multiplexerRows: selector ? [{ ...missing, key: `${missing.key}:mux:?`, parentKey: missing.key, multiplexer: { name: selector.name }, expectedPeriodMs: undefined }] : undefined });
    }
    return result;
  }
  private unreceivedRow(canId: number, extended: boolean, channel: number, direction: 'Rx' | 'Tx', definition?: ManualFrameDefinition): RawRowDto {
    return { id: '', time: 0, canId: formatCanId(canId, extended), canIdValue: canId, extended, channel, direction, name: definition?.name ?? '', definitionId: definition?.id,
      dlc: 0, length: 0, rawContent: '', decodedContent: '', decoded: !!definition, diagnostics: [] };
  }

  cancel(): void { this.abortController.abort(); }
  cancelAnalysis(): void { this.analysisToken++; this.analysisRunning = false; }
  /**
   * Builds the Trace index in the background, a few thousand frames per step, so the extension host stays responsive on a
   * large log. The frames read are those there when it starts.
   */
  private startTraceBuild(): void {
    const store = this.signalStore; const frames = this.store; const count = frames.size;
    const frameGeneration = frames.generation; const signalGeneration = store.generation; const started = Date.now(); const epoch = this.traceEpoch;
    const snapshot: Iterable<CanFrame> = { *[Symbol.iterator]() { for (let ordinal = 0; ordinal < count; ordinal++) yield frames.frame(ordinal)!; } };
    const steps = TraceIndex.fromColumnSteps(snapshot, (_frame, ordinal) => store.samplesForFrame(ordinal), (frame) => {
      const definition = this.definitions.get(`${frame.extended ? 'e' : 's'}:${frame.canId}`);
      const selector = definition?.multiplexing ? definition.signals.find((signal) => signal.multiplexing?.type === 'multiplexer') : undefined;
      if (!selector) return undefined;
      try { return { name: selector.name, value: Number(extractBits(frame.data, selector.byteOffset, selector.bitOffset, selector.lengthBits, selector.byteOrder, 'unsigned')) }; }
      catch { return { name: selector.name }; }
    }, (ordinal) => frames.frame(ordinal), store);
    this.traceBuild = (async () => {
      for (;;) {
        if (this.disposed || epoch !== this.traceEpoch) return;
        const step = steps.next(); const layout = store.layout;
        if (step.done) { this.lastFrameIndex = step.value; break; }
        await new Promise<void>((resolve) => setImmediate(resolve));
        // Samples put in another order meanwhile (a graph sorting a Signal while the log is read): the sample numbers
        // read so far no longer hold, so this index is dropped and the next request builds it again.
        if (store.layout !== layout) return;
      }
      this.lastFrameGeneration = frameGeneration; this.lastSignalGeneration = signalGeneration; this.lastSignalStore = store;
      this.lastFrameBuiltAt = Date.now(); this.lastFrameBuildMs = this.lastFrameBuiltAt - started;
    })().finally(() => { this.traceBuild = undefined; });
  }

  dispose(): void { this.disposed = true; if (this.searchStep) clearImmediate(this.searchStep); this.cancel(); this.cancelAnalysis(); this.pluginHost.dispose(); this.updates.dispose(); void this.parseTask; }

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
    const next = this.newSignalStore();
    this.registerSignalDefinitions(next, project.frames);
    const nextDefinitions = definitionMap(project.frames);
    const nextContexts = new Map<string, ReturnType<typeof createManualDecodeContext>>();
    const nextPluginHost = new PluginHost(this.pluginRegistry, project.frames, project.plugins, project.pluginBindings);
    const nextPluginDisplay = new PluginFrameTags();
    const nextDiagnostics = new DiagnosticTally();
    let processed = 0; let batch: CanFrame[] = [];
    for (const frame of this.store.frames()) {
      if (token !== this.analysisToken) break;
      batch.push(frame); if (batch.length < 1000) continue;
      this.decodeInto(next, batch, undefined, nextDefinitions, nextContexts, nextPluginHost, nextPluginDisplay, nextDiagnostics);
      processed += batch.length; batch = [];
      this.updates.fire({ type: 'analysisProgress', processed, total: this.store.size });
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (batch.length && token === this.analysisToken) { this.decodeInto(next, batch, undefined, nextDefinitions, nextContexts, nextPluginHost, nextPluginDisplay, nextDiagnostics); processed += batch.length; this.updates.fire({ type: 'analysisProgress', processed, total: this.store.size }); }
    // A parser batch may have arrived exactly as the iterator reached its end.
    while (processed < this.store.size && token === this.analysisToken) {
      const page = this.store.query({ offset: processed, limit: 1000 }); if (!page.rows.length) break;
      this.decodeInto(next, page.rows, undefined, nextDefinitions, nextContexts, nextPluginHost, nextPluginDisplay, nextDiagnostics); processed += page.rows.length;
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
      this.analysisDiagnostics = nextDiagnostics;
      this.publishAnalysisDiagnostics(nextDiagnostics, true);
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
    const replacement = this.newSignalStore();
    const changedFrames = project.frames.filter((frame) => delta.frameIds.has(frame.id));
    this.registerSignalDefinitions(replacement, changedFrames);
    const contexts = new Map<string, ReturnType<typeof createManualDecodeContext>>();
    const replacementDiagnostics = new DiagnosticTally();
    let processed = 0; let batch: CanFrame[] = [];
    for (const frame of this.store.framesByCanRefs(delta.canRefs)) {
      if (token !== this.analysisToken) break;
      batch.push(frame); if (batch.length < 1000) continue;
      this.decodeManualInto(replacement, batch, nextDefinitions, contexts, delta.frameIds, replacementDiagnostics);
      processed += batch.length; batch = [];
      this.updates.fire({ type: 'analysisProgress', processed, total: this.store.countByCanRefs(delta.canRefs) });
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (batch.length && token === this.analysisToken) { this.decodeManualInto(replacement, batch, nextDefinitions, contexts, delta.frameIds, replacementDiagnostics); processed += batch.length; this.updates.fire({ type: 'analysisProgress', processed, total: this.store.countByCanRefs(delta.canRefs) }); }
    while (processed < this.store.countByCanRefs(delta.canRefs) && token === this.analysisToken) {
      const page = this.store.queryByCanRefs(delta.canRefs, processed, 1000); if (!page.length) break;
      this.decodeManualInto(replacement, page, nextDefinitions, contexts, delta.frameIds, replacementDiagnostics); processed += page.length;
      this.updates.fire({ type: 'analysisProgress', processed, total: this.store.countByCanRefs(delta.canRefs) }); await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const cancelled = token !== this.analysisToken;
    if (!cancelled) {
      replacement.finalize();
      this.signalStore.replaceDefinitions((definition) => definition.source.type === 'manual-can' && delta.frameIds.has(definition.source.frameDefinitionId), replacement);
      for (const key of this.manualDecodeContexts.keys()) if (delta.frameIds.has(JSON.parse(key)[0])) this.manualDecodeContexts.delete(key);
      for (const [id, context] of contexts) this.manualDecodeContexts.set(id, context);
      contextShortcuts.delete(this.manualDecodeContexts);
      this.analysisDiagnostics.replaceDefinitions(delta.frameIds, replacementDiagnostics);
      this.publishAnalysisDiagnostics(this.analysisDiagnostics, true);
      this.analysisDefinitions = nextDefinitions;
      this.analyzedProject = project;
      this.analysisRevision = revision;
      this.displayCache.clear(); this.displayRevision++;
      this.analysisRunning = false;
    }
    this.updates.fire({ type: 'analysisComplete', processed, cancelled });
  }

  signalCatalog(): readonly SignalDefinition[] { return this.signalStore.catalog(); }
  measuredSignalIds(): string[] { return this.signalStore.measuredSignalIds(); }
  signalTablePage(selectedIds: readonly string[], offset: number, limit: number) { return this.serving(() => this.signalStore.tableDisplayPage(selectedIds, offset, limit, this.scope)); }
  /** Table rows that together hold the widest text of every column, from all rows the Table shows. */
  signalTableWidthRows(selectedIds: readonly string[]) { return runScan(this.signalStore.tableWidthScan(selectedIds, this.scope)); }
  /** For HTML reports: up to `maxPoints` per Signal (no display cap), evenly thinned when there are more. */
  reportSeries(selectedIds: readonly string[], range: { start: number; end: number } | undefined, maxPoints: number) { const bounds = intersectRange(range, this.scope); return this.signalStore.seriesSlice(selectedIds, bounds, Math.max(2, Math.floor(maxPoints)), bounds); }
  /** For HTML reports: table rows evenly thinned to `maxRows`, plus how many rows there are in total. */
  reportTable(selectedIds: readonly string[], maxRows: number) { const total = this.signalStore.tablePage(selectedIds, 0, 1, this.scope).total; return { total, rows: this.signalStore.tableSample(selectedIds, Math.max(1, Math.floor(maxRows)), this.scope) }; }
  /** `joined`: the axes of a trajectory, thinned together (see `seriesSlice`). */
  /** `bounds`: a Clip shown from a whole-file document (the comparison screen): samples outside it come back marked `carried`, as for a Clip document. */
  signalSeries(selectedIds: readonly string[], range: { start: number; end: number } | undefined, maxPoints = 4000, joined = false, bounds?: { start: number; end: number }) { return this.serving(() => this.signalSeriesNow(selectedIds, range, maxPoints, joined, bounds)); }

  /**
   * Runs a request from a screen, timing it while the log is read: screens refresh on each progress update, so progress
   * is sent less often when refreshing costs more (see `onProgress`), keeping most of the time for reading.
   */
  private serving<T>(request: () => T): T {
    if (!this.parsing) return request();
    const started = performance.now();
    try { return request(); } finally { this.servedMs += performance.now() - started; }
  }

  private signalSeriesNow(selectedIds: readonly string[], range: { start: number; end: number } | undefined, maxPoints: number, joined: boolean, bounds?: { start: number; end: number }) {
    const boundedMaxPoints = Math.max(2, Math.min(10_000, Math.floor(maxPoints)));
    // The time axis also covers the whole Trace range (first to last frame), so the Trace position can always be drawn at its true time.
    const extent = this.signalStore.fullRange(selectedIds); const log = this.store.timeRange;
    const fullRange = intersectRange(extent && log ? { start: Math.min(extent.start, log.start), end: Math.max(extent.end, log.end) } : extent, this.scope);
    const requestedRange = intersectRange(range, this.scope);
    if (range && this.scope && !requestedRange) return { range: fullRange, series: [] };
    return { range: fullRange, series: this.signalStore.seriesSlice(selectedIds, requestedRange, boundedMaxPoints, bounds ? intersectRange(bounds, this.scope) : this.scope, joined) };
  }
  nearestSignals(selectedIds: readonly string[], timestamp: number, range = this.scope) { return this.signalStore.nearest(selectedIds, timestamp, range); }

  measuredSignals(selectedIds: readonly string[], timestamp: number, range?: { readonly start: number; readonly end: number }) {
    const bounded = this.scope && range ? { start: Math.max(this.scope.start, range.start), end: Math.min(this.scope.end, range.end) } : this.scope ?? range;
    if (bounded && (bounded.end < bounded.start || timestamp < bounded.start || timestamp > bounded.end)) return [];
    return this.signalStore.measured(selectedIds, timestamp, bounded);
  }
  adjacentFrameTimestamp(timestamp: number, direction: -1 | 1): number | undefined { return this.store.adjacentTimestamp(timestamp, direction, this.scope); }
  nearestFrameTimestamp(timestamp: number): number | undefined { return this.store.nearestTimestamp(timestamp, this.scope); }

  selectedRowsText(ranges: readonly { readonly start: number; readonly end: number }[], filter: FrameFilter | undefined, project: SigMixaProject, revision: number, contentMode: 'raw' | 'decoded', includeHeader: boolean, timeDisplay?: TimeDisplayMode): { readonly text: string; readonly count: number } {
    this.setProject(project, revision); const normalized = normalizeRanges(ranges); const selectedCount = normalized.reduce((sum, range) => sum + range.end - range.start + 1, 0);
    if (selectedCount > 100_000) throw new Error('Select at most 100,000 RAW Log rows at once.');
    const lines: string[] = includeHeader ? [`${this.exportTimeLabel(timeDisplay)}\tTX/RX\tCAN ID\tNAME\tCH\tDLC\tLENGTH\tCONTENT`] : [];
    const scoped = this.scopedFilter(filter); const context = this.queryContext(scoped); let count = 0; let length = lines[0]?.length ?? 0;
    for (const range of normalized) {
      let offset = range.start;
      while (offset <= range.end) {
        const page = this.store.query({ offset, limit: Math.min(2000, range.end - offset + 1), filter: scoped }, context, { wait: true });
        if (!page.rows.length) break;
        for (const frame of page.rows) {
          const row = this.toRow(frame); const content = contentMode === 'raw' ? row.rawContent : row.decodedContent || row.rawContent;
          const line = [this.exportTime(row.time, timeDisplay, (value) => value.toFixed(6)), row.direction, row.canId, row.name, row.channel, row.dlc, row.length, content].map(cleanTsvCell).join('\t');
          length += line.length + 2; if (length > 16_000_000) throw new Error('The selected RAW Log text is too large to copy or open at once.');
          lines.push(line); count++;
        }
        offset += page.rows.length;
      }
    }
    return { text: `${lines.join('\r\n')}\r\n`, count };
  }

  selectedSignalRowsText(ranges: readonly { readonly start: number; readonly end: number }[], selectedIds: readonly string[], includeHeader: boolean, timeDisplay?: TimeDisplayMode): { readonly text: string; readonly count: number } {
    const definitions = new Map(this.signalStore.catalog().map((definition) => [definition.id, definition]));
    const ids = [...new Set(selectedIds)].filter((id) => definitions.has(id));
    const normalized = normalizeRanges(ranges); const selectedCount = normalized.reduce((sum, range) => sum + range.end - range.start + 1, 0);
    if (selectedCount > 100_000) throw new Error('Select at most 100,000 Signal Table rows at once.');
    const headers = [this.exportTimeLabel(timeDisplay), ...ids.map((id) => { const definition = definitions.get(id)!; return `${definition.name}${definition.unit ? ` (${definition.unit})` : ''}`; })];
    const lines: string[] = includeHeader ? [headers.map(cleanTsvCell).join('\t')] : [];
    let count = 0; let length = lines[0]?.length ?? 0;
    for (const range of normalized) {
      let offset = range.start;
      while (offset <= range.end) {
        const page = this.signalStore.tablePage(ids, offset, Math.min(2000, range.end - offset + 1), this.scope);
        if (!page.rows.length) break;
        for (const row of page.rows) {
          const line = [this.exportTime(row.timestamp, timeDisplay, this.csvSeconds), ...ids.map((id) => { const value = row.values.get(id)?.value; return value === undefined ? '' : formatCsvSignalValue(value); })].map(cleanTsvCell).join('\t');
          length += line.length + 2; if (length > 16_000_000) throw new Error('The selected Signal Table text is too large to copy or open at once.');
          lines.push(line); count++;
        }
        offset += page.rows.length;
      }
    }
    return { text: `${lines.join('\r\n')}\r\n`, count };
  }

  async exportSignalCsv(targetPath: string, selectedIds: readonly string[], timeDisplay?: TimeDisplayMode): Promise<void> {
    const definitions = new Map(this.signalStore.catalog().map((definition) => [definition.id, definition]));
    const ids = [...new Set(selectedIds)].filter((id) => definitions.has(id));
    const stream = createWriteStream(targetPath, { encoding: 'utf8' });
    const escape = (value: string) => /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
    const write = async (text: string) => { if (!stream.write(text)) await once(stream, 'drain'); };
    await write([this.exportTimeLabel(timeDisplay), ...ids.map((id) => {
      const definition = definitions.get(id)!;
      return escape(`${definition.name}${definition.unit ? ` (${definition.unit})` : ''}`);
    })].join(',') + '\n');
    for (const row of this.signalStore.eventRows(ids, this.scope)) {
      await write([this.exportTime(row.timestamp, timeDisplay, this.csvSeconds), ...ids.map((id) => {
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
    this.lastFrameIndex = undefined; this.traceEpoch++;
    this.displayCache.clear();
    this.displayRevision++;
  }

  private newSignalStore(): InMemorySignalStore { return new InMemorySignalStore({ frameId: (ordinal) => this.store.idAt(ordinal) }); }

  /** How the Signal store and the Plugin tags name a frame: by its place in the frame store, which keeps no text per frame. */
  private frameRef(frame: CanFrame): SignalFrameRef { return this.store.ordinalOf(frame) ?? frame.id; }

  private registerSignalDefinitions(store: InMemorySignalStore, definitions: readonly ManualFrameDefinition[]): void {
    store.registerDefinitions(definitions.flatMap((frame) => [...frame.signals, ...(frame.derivedSignals ?? [])].map((signal) => signalDefinitionFor(frame, signal))));
  }

  private decodeInto(
    store: InMemorySignalStore,
    frames: readonly CanFrame[],
    /** The ordinal of `frames[0]` when they are not (yet) read from the frame store. */
    firstOrdinal: number | undefined,
    definitions = this.analysisDefinitions,
    contexts = this.manualDecodeContexts,
    pluginHost = this.pluginHost,
    pluginDisplay = this.pluginDisplay,
    analysisDiagnostics = this.analysisDiagnostics,
  ): void {
    for (let index = 0; index < frames.length; index++) {
      const frame = frames[index]; const ref = firstOrdinal === undefined ? this.frameRef(frame) : firstOrdinal + index;
      const definition = definitions.get(canKey(frame.canId, frame.extended));
      const manual = definition ? decodeManualFrame(frame, definition, contextFor(contexts, definition.id, frame)) : { decoded: [], diagnostics: [] };
      if (manual.diagnostics.length) analysisDiagnostics.add(frame.timestamp, manual.diagnostics);
      const plugin = pluginHost.processFrame(frame);
      store.appendFrame(ref, frame.timestamp, plugin.decoded.length ? [...manual.decoded, ...plugin.decoded] : manual.decoded);
      for (const [signalId, events] of plugin.events) store.appendEvents(signalId, events);
      if (plugin.decoded.length || plugin.diagnostics.length) pluginDisplay.set(ref, plugin.decoded.map((item) => ({ name: item.definition.name, unit: item.definition.unit, value: item.sample.value })), plugin.diagnostics);
      if (plugin.diagnostics.length) analysisDiagnostics.add(frame.timestamp, plugin.diagnostics);
    }
  }

  private decodeManualInto(
    store: InMemorySignalStore,
    frames: readonly CanFrame[],
    definitions: ReadonlyMap<string, ManualFrameDefinition>,
    contexts: Map<string, ReturnType<typeof createManualDecodeContext>>,
    eligibleFrameIds: ReadonlySet<string>,
    analysisDiagnostics: DiagnosticTally,
  ): void {
    for (const frame of frames) {
      const definition = definitions.get(canKey(frame.canId, frame.extended));
      if (!definition || !eligibleFrameIds.has(definition.id)) continue;
      const manual = decodeManualFrame(frame, definition, contextFor(contexts, definition.id, frame));
      if (manual.diagnostics.length) analysisDiagnostics.add(frame.timestamp, manual.diagnostics);
      store.appendFrame(this.frameRef(frame), frame.timestamp, manual.decoded);
    }
  }

  private queryContext(filter?: FrameFilter) {
    return {
      cacheKey: `project:${this.projectRevision}:display:${this.displayRevision}`,
      additionalSearchText: (frame: CanFrame) => {
        const definition = this.definitions.get(`${frame.extended ? 'e' : 's'}:${frame.canId}`);
        return `${definition?.name ?? ''} ${filter?.searchContent === 'raw' ? '' : this.searchTags(frame).join(' ')}`;
      },
      isDecoded: (frame: CanFrame) => this.searchTags(frame).length > 0,
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

  /**
   * The tags the RAW log shows for a frame (`display(frame).tags`), without the explanations a row also carries; a search
   * reads every frame, so this skips the work only a shown row needs. The last frame asked is remembered (a search asks twice).
   */
  private searchTags(frame: CanFrame): readonly string[] {
    if (this.lastSearchTags?.frame === frame && this.lastSearchTags.revision === this.displayRevision) return this.lastSearchTags.tags;
    const cached = this.displayCache.get(frame.id);
    let tags: readonly string[];
    if (cached) tags = cached.tags;
    else {
      const definition = this.definitions.get(`${frame.extended ? 'e' : 's'}:${frame.canId}`);
      const ref = this.frameRef(frame); const plugin = this.pluginDisplay.get(ref);
      const decoded = definition ? decodeManualFrame(frame, definition).decoded : [];
      if (!decoded.length) tags = plugin?.tags ?? [];
      else {
        const samples = new Map(this.signalStore.samplesForFrame(ref).map(item => [item.signalId, item.sample]));
        tags = [...decoded.filter(item => !('operation' in item.signal) || samples.has(item.signal.id)).map((item) => formatDecodedSignal({ ...item, sample: samples.get(item.signal.id) ?? item.sample })), ...(plugin?.tags ?? [])];
      }
    }
    this.lastSearchTags = { frame, revision: this.displayRevision, tags };
    return tags;
  }

  private buildDisplay(frame: CanFrame) {
    const definition = this.definitions.get(`${frame.extended ? 'e' : 's'}:${frame.canId}`);
    const result = definition ? decodeManualFrame(frame, definition) : { decoded: [], diagnostics: [] };
    const samples = new Map(this.signalStore.samplesForFrame(this.frameRef(frame)).map(item => [item.signalId, item.sample]));
    const plugin = this.pluginDisplay.get(this.frameRef(frame));
    const decodedSignals = definition ? result.decoded
      .filter(item => !('operation' in item.signal) || samples.has(item.signal.id))
      .map(item => decodedExplanation(item, definition, samples)) : [];
    return { definition, decodedSignals, tags: [...decodedSignals.map((item) => item.tag), ...(plugin?.tags ?? [])], diagnostics: [...result.diagnostics, ...(plugin?.diagnostics ?? [])] };
  }

  /** Throttled while parsing; `force` publishes the settled result. */
  private publishAnalysisDiagnostics(tally: DiagnosticTally, force = false): void {
    const now = Date.now();
    if (!force && now - this.analysisDiagnosticsPublishedAt < 250) return;
    this.analysisDiagnosticsPublishedAt = now;
    this.updates.fire({ type: 'analysisDiagnostics', groups: this.labelDiagnosticGroups(tally.snapshot()), total: tally.total });
  }

  private publishDiagnostics(diagnostics: readonly Diagnostic[]): void {
    this.addSourceDiagnostics(diagnostics); this.publishSourceDiagnostics(true);
  }

  private addSourceDiagnostics(diagnostics: readonly Diagnostic[]): void {
    for (const item of diagnostics) this.sourceDiagnostics.add(item.location?.line, [item]);
    this.publishSourceDiagnostics();
  }

  /** Throttled while parsing; `force` publishes the settled result. */
  private publishSourceDiagnostics(force = false): void {
    const now = Date.now();
    if (!force && now - this.sourceDiagnosticsPublishedAt < 250) return;
    this.sourceDiagnosticsPublishedAt = now;
    this.updates.fire({ type: 'sourceDiagnostics', groups: this.sourceDiagnostics.snapshot(), total: this.sourceDiagnostics.total });
  }

  private async appendExternal(store: InMemorySignalStore, project: SigMixaProject): Promise<void> {
    const workspaceRoot = vscode.workspace.getWorkspaceFolder(this.uri)?.uri.fsPath
      ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
      ?? path.dirname(this.filePath);
    for (const source of project.externalCsvSources) {
      const result = await loadExternalCsv(source, workspaceRoot, this.reference);
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

/** Smaller than any log timestamp resolution: places the Trace head just before the first frame. */
const BEFORE_FIRST_FRAME_SECONDS = 1e-9;
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
type DecodeContexts = Map<string, ReturnType<typeof createManualDecodeContext>>;
/** Contexts by a cheaper key than the JSON one they are stored under, so each frame does not build JSON. */
// Whoever changes a contexts map other than through `contextFor` drops its shortcuts (`contextShortcuts.delete`).
const contextShortcuts = new WeakMap<DecodeContexts, Map<string, Map<string, Map<number, ReturnType<typeof createManualDecodeContext>>>>>();
/** The decode context of a definition on one source, channel and direction; found through nested maps, without building a key per frame. */
function contextFor(contexts: DecodeContexts, definitionId: string, frame: CanFrame): ReturnType<typeof createManualDecodeContext> {
  let byDefinition = contextShortcuts.get(contexts); if (!byDefinition) { byDefinition = new Map(); contextShortcuts.set(contexts, byDefinition); }
  let bySource = byDefinition.get(definitionId); if (!bySource) { bySource = new Map(); byDefinition.set(definitionId, bySource); }
  let byRoute = bySource.get(frame.sourceId); if (!byRoute) { byRoute = new Map(); bySource.set(frame.sourceId, byRoute); }
  const route = frame.channel * 2 + (frame.direction === 'Tx' ? 1 : 0);
  let context = byRoute.get(route);
  if (!context) {
    const key = JSON.stringify([definitionId, frame.sourceId, frame.channel, frame.direction]);
    context = contexts.get(key); if (!context) { context = createManualDecodeContext(); contexts.set(key, context); }
    byRoute.set(route, context);
  }
  return context;
}

function trimmedMicroseconds(value: number): string { const text = value.toFixed(6).replace(/\.?0+$/, ''); return text === '-0' ? '0' : text; }
