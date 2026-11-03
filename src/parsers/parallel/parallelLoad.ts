import { closeSync, existsSync, openSync, readSync, statSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Worker } from 'worker_threads';
import type { Diagnostic } from '../../core/diagnostics/diagnostic';
import type { TimeReference } from '../../core/time/timeFormat';
import { parseAscLine, type AscNumericBase } from '../asc/ascLineParser';
import type { AscParseSummary } from '../asc/parseAscStream';
import { fileStartTimestamp, findObjectOffset, parseBlfObjects, readBaseObjectHeader, type BlfParseSummary } from '../blf/parseBlf';
import type { AscLineEvent, AscRangeResult } from './ascRange';
import type { BlfEvent, BlfRangeResult } from './blfRange';
import type { DecodeSpec } from './chunkDecoder';
import { FramePacker, type PackedFrames, type PackedSignals } from './packedFrames';
import type { WorkerRequest } from './logWorker';

/** A piece of a log, in file order: its frames are numbered `firstSequence`, … after `idPrefix`. */
export interface LoadedChunk {
  readonly frames: PackedFrames;
  /** What a worker decoded, with the decode spec `decodedWith` stands for; undefined: decode every frame here. */
  readonly signals?: PackedSignals;
  readonly decodedWith?: object;
  readonly idPrefix: string;
  readonly firstSequence: number;
}

export interface ParallelLoadOptions {
  readonly sourceId: string;
  readonly signal?: AbortSignal;
  /** What workers decode now; `owner` stands for it, so a piece decoded with an older one is decoded again here. */
  decodeSpec(): { readonly owner: object; readonly spec: DecodeSpec };
  onChunk(chunk: LoadedChunk): void;
  onDiagnostics(diagnostics: readonly Diagnostic[]): void;
  onProgress?(progress: { readonly framesParsed: number; readonly bytesRead: number; readonly totalBytes: number }): void;
  onTimeReference?(reference: TimeReference): void;
}

/** When and how logs are read on worker threads (tests make the pieces small). */
export const parallelLoadSettings = {
  /** Smaller logs are read on the main thread as before. */
  minBytes: 16 << 20,
  ascRangeBytes: 4 << 20,
  // About as many frames per piece as an ASC piece (compressed BLF holds several times more per byte).
  blfRangeBytes: 512 << 10,
  workers: Math.max(1, Math.min(8, (typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length) - 1)),
  workerScript: path.join(__dirname, 'logWorker.js'),
};

export function canLoadInParallel(filePath: string): boolean {
  try {
    if (parallelLoadSettings.workers < 1 || statSync(filePath).size < parallelLoadSettings.minBytes || !existsSync(parallelLoadSettings.workerScript)) return false;
    // An ASC log is cut at \n: one with other line breaks only (lone \r) is read in one go as before.
    if (path.extname(filePath).toLowerCase() === '.blf') return true;
    const fd = openSync(filePath, 'r');
    try { return readAt(fd, 0, 1 << 16).includes(10); } finally { closeSync(fd); }
  } catch { return false; }
}

// ---- workers ----

interface Slot { readonly worker: Worker; busy: number; readonly jobs: Set<number> }
interface Pending { readonly slot: Slot; resolve(value: unknown): void; reject(error: Error): void }

type PieceRequest = Extract<WorkerRequest, { id: number }> extends infer R ? R extends unknown ? Omit<R, 'id' | 'job'> : never : never;

/** Worker threads shared by every log being read; they end after a while unused. */
class LogWorkerPool {
  private slots: Slot[] = [];
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private idleTimer?: NodeJS.Timeout;

  run<T>(job: { readonly id: number; readonly spec: DecodeSpec }, request: PieceRequest, transfer: ArrayBuffer[] = []): Promise<T> {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = undefined; }
    while (this.slots.length < parallelLoadSettings.workers) this.slots.push(this.spawn());
    const slot = this.slots.reduce((best, item) => item.busy < best.busy ? item : best);
    if (!slot.jobs.has(job.id)) { slot.jobs.add(job.id); slot.worker.postMessage({ type: 'job', job: job.id, spec: job.spec } satisfies WorkerRequest); }
    const id = this.nextId++;
    if (slot.busy++ === 0) slot.worker.ref();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { slot, resolve: resolve as (value: unknown) => void, reject });
      slot.worker.postMessage({ ...request, id, job: job.id }, transfer);
    });
  }

  endJob(job: number): void {
    for (const slot of this.slots) if (slot.jobs.delete(job)) slot.worker.postMessage({ type: 'end-job', job } satisfies WorkerRequest);
  }

  private spawn(): Slot {
    const worker = new Worker(parallelLoadSettings.workerScript);
    const slot: Slot = { worker, busy: 0, jobs: new Set() };
    worker.unref();
    worker.on('message', (message: { id: number; result?: unknown; error?: string }) => {
      const pending = this.pending.get(message.id); if (!pending) return;
      this.pending.delete(message.id); this.release(slot);
      if (message.error !== undefined) pending.reject(new Error(message.error)); else pending.resolve(message.result);
    });
    const fail = (error: Error) => {
      this.slots = this.slots.filter((item) => item !== slot);
      for (const [id, pending] of this.pending) if (pending.slot === slot) { this.pending.delete(id); pending.reject(error); }
    };
    worker.on('error', fail);
    worker.on('exit', (code) => { if (this.slots.includes(slot)) fail(new Error(`A log reader thread stopped (${code}).`)); });
    return slot;
  }

  private release(slot: Slot): void {
    if (--slot.busy === 0) slot.worker.unref();
    if (this.slots.every((item) => item.busy === 0)) {
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => { const slots = this.slots; this.slots = []; for (const item of slots) void item.worker.terminate(); }, 30_000);
      this.idleTimer.unref();
    }
  }
}

const pool = new LogWorkerPool();
let nextJob = 1;

/** Gives each decode spec its own job number, so workers keep it once instead of receiving it with every piece. */
class Jobs {
  private current?: { readonly owner: object; readonly id: number; readonly spec: DecodeSpec };
  private readonly ids: number[] = [];
  constructor(private readonly options: ParallelLoadOptions) {}
  get(): { readonly owner: object; readonly id: number; readonly spec: DecodeSpec } {
    const { owner, spec } = this.options.decodeSpec();
    if (this.current?.owner !== owner) { this.current = { owner, id: nextJob++, spec }; this.ids.push(this.current.id); }
    return this.current;
  }
  end(): void { for (const id of this.ids) pool.endJob(id); }
}

/**
 * Runs `tasks` on the workers, a few ahead, and hands each result to `merge` in task order; `merge` may run a task again
 * (`rerun`). Stops early when the load is cancelled.
 */
async function ordered<T, R>(tasks: Iterator<T>, run: (task: T) => Promise<R>, merge: (task: T, result: R) => Promise<void> | void, signal: AbortSignal | undefined): Promise<boolean> {
  const ahead = parallelLoadSettings.workers * 2 + 1;
  const queue: { readonly task: T; readonly result: Promise<R> }[] = [];
  let done = false;
  const fill = () => {
    while (!done && queue.length < ahead) {
      const next = tasks.next(); if (next.done) { done = true; break; }
      const result = run(next.value); result.catch(() => undefined); queue.push({ task: next.value, result });
    }
  };
  fill();
  while (queue.length) {
    if (signal?.aborted) return false;
    const { task, result } = queue.shift()!;
    const value = await result;
    if (signal?.aborted) return false;
    fill();
    await merge(task, value);
    // Between pieces, the screens are served.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return !signal?.aborted;
}

/** The first pieces are smaller, so the first frames show up at once while the code that reads them is still cold. */
function rampedSize(size: number, index: number): number { return index < 3 ? Math.max(1, size >> (3 - index)) : size; }

function readAt(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.alloc(length); let done = 0;
  while (done < length) { const count = readSync(fd, buffer, done, length - done, position + done); if (!count) break; done += count; }
  return done < length ? buffer.subarray(0, done) : buffer;
}

// ---- ASC ----

interface AscTask { readonly start: number; readonly end: number; readonly last: boolean; readonly base: AscNumericBase }
type AscResult = AscRangeResult & { readonly signals: PackedSignals; readonly owner: object };

/** `parseAscFile` on worker threads: the same frames, diagnostics and summary. */
export async function loadAscInParallel(filePath: string, options: ParallelLoadOptions): Promise<AscParseSummary> {
  const totalBytes = statSync(filePath).size;
  const fd = openSync(filePath, 'r');
  const jobs = new Jobs(options);
  let lineNumber = 0; let sequence = 0; let bytesRead = 0; let diagnosticCount = 0; let base: AscNumericBase = 'hex';
  let timeReference: TimeReference | undefined;
  try {
    // Pieces after the first are read with the base the header sets; a piece read with another one is read again.
    const assumed = headerBase(readAt(fd, 0, Math.min(totalBytes, 1 << 16)));
    /** Where the first line starting at or after `position` starts. */
    const lineStart = (position: number): number => {
      if (position <= 0) return 0;
      for (let at = position - 1; at < totalBytes; at += 1 << 16) {
        const found = readAt(fd, at, Math.min(1 << 16, totalBytes - at)).indexOf(10);
        if (found >= 0) return at + found + 1;
      }
      return totalBytes;
    };
    function* tasks(): Iterator<AscTask> {
      for (let start = 0, index = 0; start < totalBytes; index++) {
        const end = lineStart(start + rampedSize(parallelLoadSettings.ascRangeBytes, index));
        yield { start, end, last: end >= totalBytes, base: start === 0 ? 'hex' : assumed };
        start = end;
      }
    }
    const run = async (task: AscTask): Promise<AscResult> => { const job = jobs.get(); return { ...await pool.run<AscRangeResult & { signals: PackedSignals }>(job, { type: 'asc', file: filePath, ...task }), owner: job.owner }; };
    const completed = await ordered(tasks(), run, async (task, first) => {
      const result = task.base === base ? first : await run({ ...task, base });
      if (options.signal?.aborted) return;
      const diagnostics: Diagnostic[] = [];
      for (const event of result.events) {
        const line = parseAscLine(event.text, { sourceId: options.sourceId, line: lineNumber + event.line, sequence: sequence + event.frames, base });
        if (line.type === 'base') base = line.base;
        else if (line.type === 'date') { if (!timeReference && !(sequence + event.frames)) { timeReference = { start: line.start, offset: line.start }; options.onTimeReference?.(timeReference); } }
        else if (line.type === 'diagnostic') diagnostics.push(line.diagnostic);
      }
      if (diagnostics.length) { diagnosticCount += diagnostics.length; options.onDiagnostics(diagnostics); }
      options.onChunk({ frames: result.frames, signals: result.signals, decodedWith: result.owner, idPrefix: `${options.sourceId}:`, firstSequence: sequence });
      sequence += result.frames.count; lineNumber += result.lines; bytesRead = task.end;
      options.onProgress?.({ framesParsed: sequence, bytesRead, totalBytes });
    }, options.signal);
    return { bytesRead: completed ? totalBytes : bytesRead, totalBytes, linesRead: lineNumber, framesParsed: sequence, diagnostics: diagnosticCount, cancelled: !completed, ...(timeReference ? { timeReference } : {}) };
  } finally { closeSync(fd); jobs.end(); }
}

/** The base set before the first frame of a log's start (`hex` when none is). */
function headerBase(head: Buffer): AscNumericBase {
  const lines = head.toString('utf8').split(/\r\n|\n|\r/); lines.pop();
  let base: AscNumericBase = 'hex';
  for (const [index, line] of lines.entries()) {
    const result = parseAscLine(line, { sourceId: '', line: index + 1, sequence: 0, base });
    if (result.type === 'base') base = result.base; else if (result.type === 'frame') break;
  }
  return base;
}

// ---- BLF ----

interface BlfTask { readonly start: number; readonly end: number; readonly objects: Float64Array; readonly first: boolean }
type BlfResult = BlfRangeResult & { readonly signals: PackedSignals; readonly owner: object };
interface Report { readonly code: string; readonly severity: Diagnostic['severity']; readonly message: string; readonly offset?: number; readonly details?: Diagnostic['details'] }

/** `parseBlfFile` on worker threads: the same frames, diagnostics and summary, without holding the whole file. */
export async function loadBlfInParallel(filePath: string, options: ParallelLoadOptions): Promise<BlfParseSummary> {
  const summary = (totalBytes: number, bytesRead: number, framesParsed: number, diagnostics: number, cancelled: boolean, timeReference?: TimeReference): BlfParseSummary =>
    ({ totalBytes, bytesRead, linesRead: 0, framesParsed, diagnostics, cancelled, ...(timeReference ? { timeReference } : {}) });
  if (options.signal?.aborted) return summary(0, 0, 0, 0, true);
  const totalBytes = statSync(filePath).size;
  const fd = openSync(filePath, 'r');
  const jobs = new Jobs(options);
  let diagnosticCount = 0; let sequence = 0; let bytesRead = 0;
  // As `parseBlfBuffer` numbers what it reports.
  const report = ({ code, severity, message, offset, details }: Report): Diagnostic => {
    diagnosticCount++;
    return { id: `${options.sourceId}:blf:${code}:${offset ?? diagnosticCount}`, source: 'parser', code, severity, message, location: { sourceId: options.sourceId }, details: { ...(offset === undefined ? {} : { byteOffset: offset }), ...details } };
  };
  const emit = (reports: readonly Report[]) => { if (reports.length) options.onDiagnostics(reports.map(report)); };
  try {
    const head = readAt(fd, 0, Math.min(totalBytes, 4096));
    // As `parseBlfBuffer`: the start time is read from the header before the header is checked.
    const startTimestamp = totalBytes < 72 ? 0 : fileStartTimestamp(head);
    const timeReference: TimeReference | undefined = startTimestamp ? { start: startTimestamp, offset: 0 } : undefined;
    if (timeReference) options.onTimeReference?.(timeReference);
    if (totalBytes < 8 || head.toString('ascii', 0, 4) !== 'LOGG') {
      emit([{ code: 'BLF_SIGNATURE', severity: 'error', message: 'The file does not contain a Vector BLF LOGG signature.', offset: 0 }]);
      return summary(totalBytes, 0, 0, diagnosticCount, false);
    }
    const fileHeaderSize = head.readUInt32LE(4);
    if (fileHeaderSize < 8 || fileHeaderSize > totalBytes) {
      emit([{ code: 'BLF_FILE_HEADER', severity: 'error', message: 'The BLF file header size is invalid.', offset: 4, details: { fileHeaderSize } }]);
      return summary(totalBytes, 0, 0, diagnosticCount, false);
    }

    // The top-level objects are found by their headers alone; what follows an object is read only to find the next.
    const nextObject = (position: number): number | undefined => { const found = findObjectOffset(readAt(fd, position, 11), 0); return found === undefined ? undefined : position + found; };
    let offset = nextObject(fileHeaderSize) ?? fileHeaderSize;
    /** What ended the walk over the top-level objects, reported after everything before it. */
    let stop: Report | undefined;
    function* tasks(): Iterator<BlfTask> {
      let objects: number[] = []; let first = true; let index = 0;
      const take = (end: number): BlfTask => { const start = objects[0]; const task = { start, end, objects: Float64Array.from(objects, (item) => item - start), first }; first = false; objects = []; return task; };
      let end = 0;
      while (offset + 16 <= totalBytes) {
        const header = readBaseObjectHeader(readAt(fd, offset, 16), 0);
        if (!header) { stop = { code: 'BLF_OBJECT_HEADER', severity: 'error', message: 'A BLF object header is invalid; parsing stopped to avoid misreading later bytes.', offset }; break; }
        if (offset + header.objectSize > totalBytes) { stop = { code: 'BLF_OBJECT_TRUNCATED', severity: 'error', message: 'A BLF object extends beyond the end of the file; parsing stopped.', offset, details: { objectType: header.objectType } }; break; }
        objects.push(offset); end = offset + header.objectSize;
        if (end - objects[0] >= rampedSize(parallelLoadSettings.blfRangeBytes, index)) { index++; yield take(end); }
        const next = nextObject(end);
        if (next === undefined) { offset = end; break; }
        offset = next;
      }
      if (objects.length) yield take(end);
    }
    let tail: Uint8Array = new Uint8Array(0);
    const run = async (task: BlfTask, known?: Uint8Array): Promise<BlfResult> => {
      const job = jobs.get();
      const tailOption = known ?? (task.first ? new Uint8Array(0) : undefined);
      return { ...await pool.run<BlfRangeResult & { signals: PackedSignals }>(job, { type: 'blf', file: filePath, start: task.start, end: task.end, objects: task.objects, startTimestamp, ...(tailOption ? { tail: tailOption } : {}) }), owner: job.owner };
    };
    const completed = await ordered(tasks(), (task) => run(task), async (task, first) => {
      // A piece read without what came before it holds when those bytes, followed by the worker's `anchorPrefix`, end
      // exactly where the worker started; they are then read here, as the start of the piece.
      let result = first; let exact = task.first; let lead: { readonly frames: PackedFrames; readonly reports: readonly Report[] } | undefined;
      if (!exact && !result.unsure && result.anchorPrefix) {
        const packer = new FramePacker(); const reports: Report[] = [];
        const read = parseBlfObjects(Buffer.concat([tail, result.anchorPrefix]), startTimestamp, undefined, (code, severity, message, at, details) => reports.push({ code, severity, message, offset: at, details }), (frame) => packer.push(frame));
        if (!read.stopped && !read.rest.length) lead = { frames: packer.finish(), reports };
      }
      if (!exact && (result.unsure || (result.anchorPrefix && !lead))) { result = await run(task, tail); exact = true; lead = undefined; if (options.signal?.aborted) return; }
      const anchor = !exact && result.anchorPrefix ? result.anchorEvents! : result.events.length;
      const shift = (event: BlfEvent): Report => ({ ...event, offset: event.offset === undefined ? undefined : event.offset + (event.shifted ? tail.length : 0) });
      emit([...result.events.slice(0, anchor).map(shift), ...lead?.reports ?? [], ...result.events.slice(anchor).map(shift)]);
      if (lead?.frames.count) { options.onChunk({ frames: lead.frames, idPrefix: `${options.sourceId}:blf:`, firstSequence: sequence }); sequence += lead.frames.count; }
      options.onChunk({ frames: result.frames, signals: result.signals, decodedWith: result.owner, idPrefix: `${options.sourceId}:blf:`, firstSequence: sequence });
      sequence += result.frames.count;
      // A piece with no container read from where it lined up left what came before it as it was.
      if (exact || result.anchorPrefix) tail = result.tail;
      bytesRead = task.end;
      options.onProgress?.({ framesParsed: sequence, bytesRead, totalBytes });
    }, options.signal);
    if (!completed) return summary(totalBytes, bytesRead, sequence, diagnosticCount, true, timeReference);
    const finals: Report[] = [];
    if (stop) finals.push(stop);
    if (tail.some((byte) => byte !== 0)) finals.push({ code: 'BLF_INNER_OBJECT_TRUNCATED', severity: 'error', message: 'The final LogContainer ends with an incomplete BLF object.', details: { remainingBytes: tail.length } });
    if (offset < totalBytes && hasNonZero(fd, offset, totalBytes)) finals.push({ code: 'BLF_TRAILING_BYTES', severity: 'warning', message: 'Non-padding bytes remain after the last complete BLF object.', offset });
    emit(finals);
    return summary(totalBytes, bytesRead, sequence, diagnosticCount, false, timeReference);
  } finally { closeSync(fd); jobs.end(); }
}

function hasNonZero(fd: number, from: number, to: number): boolean {
  for (let at = from; at < to; at += 1 << 20) if (readAt(fd, at, Math.min(1 << 20, to - at)).some((byte) => byte !== 0)) return true;
  return false;
}
