// Worker thread entry (out/logWorker.js): reads and decodes pieces of a log for `parallelLoad`.
import { openSync, readSync, closeSync } from 'fs';
import { parentPort } from 'worker_threads';
import type { AscNumericBase } from '../asc/ascLineParser';
import { parseAscRange } from './ascRange';
import { parseBlfRange } from './blfRange';
import { ChunkDecoder, type DecodeSpec } from './chunkDecoder';
import { READ_LIMITS, ReadBudget } from '../readBudget';
import { FramePacker, packedTransfer, signalsTransfer, type PackedFrames } from './packedFrames';
import { parseMdfFile, type MdfSignalSeries } from '../mdf/parseMdf';
import type { Diagnostic } from '../../core/diagnostics/diagnostic';
import type { TimeReference } from '../../core/time/timeFormat';

export type WorkerRequest =
  | { readonly type: 'job'; readonly job: number; readonly spec: DecodeSpec }
  | { readonly type: 'end-job'; readonly job: number }
  | { readonly type: 'asc'; readonly id: number; readonly job: number; readonly file: string; readonly start: number; readonly end: number; readonly last: boolean; readonly base: AscNumericBase }
  | { readonly type: 'blf'; readonly id: number; readonly job: number; readonly file: string; readonly start: number; readonly end: number; readonly objects: Float64Array; readonly startTimestamp: number; readonly tail?: Uint8Array; readonly tailSkip?: number }
  /** Frames read by another thread (MDF), to be decoded here. */
  | { readonly type: 'decode'; readonly id: number; readonly job: number; readonly frames: PackedFrames }
  /**
   * Reads an MDF log's records here, in order, and sends its frames back a piece at a time (`partial` messages, then the
   * summary). At most `credits` pieces are sent ahead of what the main thread has taken (`mdf-credit` gives one more).
   */
  | { readonly type: 'mdf-read'; readonly id: number; readonly job: number; readonly file: string; readonly sourceId: string; readonly pieceFrames: number; readonly credits: number }
  | { readonly type: 'mdf-credit'; readonly read: number }
  | { readonly type: 'mdf-cancel'; readonly read: number };

/** What a piece of an MDF read sends back before its summary. */
export type MdfPartial =
  /** `bytesRead`: how far the file was read when the piece was full. */
  | { readonly frames: PackedFrames; readonly bytesRead: number }
  | { readonly diagnostics: readonly Diagnostic[] }
  | { readonly timeReference: TimeReference }
  | { readonly signals: readonly MdfSignalSeries[] }
  | { readonly progress: { readonly bytesRead: number; readonly totalBytes: number } };

const decoders = new Map<number, ChunkDecoder>();
const reads = new Map<number, { credits: number; wake?: () => void; readonly abort: AbortController }>();

async function readMdf(request: Extract<WorkerRequest, { type: 'mdf-read' }>): Promise<void> {
  const state = { credits: request.credits, abort: new AbortController() } as { credits: number; wake?: () => void; readonly abort: AbortController };
  reads.set(request.id, state);
  const partial = (value: MdfPartial, transfer: ArrayBuffer[] = []) => parentPort!.postMessage({ id: request.id, partial: value }, transfer);
  let packer = new FramePacker(); let pieces = 0; let bytesRead = 0;
  const send = async () => {
    if (!packer.size) return;
    const frames = packer.finish(); packer = new FramePacker(); pieces++;
    state.credits--; partial({ frames, bytesRead }, packedTransfer(frames));
    while (state.credits <= 0 && !state.abort.signal.aborted) await new Promise<void>((resolve) => { state.wake = resolve; });
  };
  try {
    const summary = await parseMdfFile(request.file, {
      sourceId: request.sourceId, signal: state.abort.signal,
      onDiagnostics: (diagnostics) => partial({ diagnostics }),
      onTimeReference: (timeReference) => partial({ timeReference }),
      onSignals: (signals) => partial({ signals }, signals.flatMap((item) => [item.times.buffer as ArrayBuffer, item.values.buffer as ArrayBuffer, ...(item.labels ? [item.labels.indexes.buffer as ArrayBuffer] : [])])),
      onProgress: (progress) => { bytesRead = progress.bytesRead; },
      onFrames: async (frames) => {
        for (const frame of frames) packer.push(frame);
        // The first pieces are smaller, so the first frames show up at once.
        if (packer.size >= (pieces < 3 ? Math.max(1, request.pieceFrames >> (3 - pieces)) : request.pieceFrames)) await send();
      },
    });
    await send();
    parentPort!.postMessage({ id: request.id, result: summary });
  } catch (error) {
    // The frames read before the failure are kept, as reading on one thread keeps them.
    try { await send(); } catch { /* the error below is what is reported */ }
    parentPort!.postMessage({ id: request.id, error: (error as Error).message });
  } finally { reads.delete(request.id); }
}

/** A piece of a log, read whole: never more than one piece may take, whatever the file holds. */
function read(file: string, start: number, end: number): Buffer {
  if (!new ReadBudget().fitsPiece(end - start)) throw new Error(`A piece of the log is larger than ${READ_LIMITS.pieceBytes} bytes.`);
  const buffer = Buffer.allocUnsafe(end - start); const fd = openSync(file, 'r');
  try { let done = 0; while (done < buffer.length) { const count = readSync(fd, buffer, done, buffer.length - done, start + done); if (!count) throw new Error('The log file became shorter while it was read.'); done += count; } }
  finally { closeSync(fd); }
  return buffer;
}

parentPort?.on('message', (request: WorkerRequest) => {
  if (request.type === 'job') { decoders.set(request.job, new ChunkDecoder(request.spec)); return; }
  if (request.type === 'end-job') { decoders.delete(request.job); return; }
  if (request.type === 'mdf-credit' || request.type === 'mdf-cancel') {
    const state = reads.get(request.read); if (!state) return;
    if (request.type === 'mdf-credit') state.credits++; else state.abort.abort();
    const wake = state.wake; state.wake = undefined; wake?.();
    return;
  }
  if (request.type === 'mdf-read') { void readMdf(request); return; }
  try {
    const decoder = decoders.get(request.job);
    if (!decoder) throw new Error('Unknown load job.');
    if (request.type === 'decode') {
      const signals = decoder.decode(request.frames);
      parentPort!.postMessage({ id: request.id, result: { frames: request.frames, signals } }, [...packedTransfer(request.frames), ...signalsTransfer(signals)]);
      return;
    }
    const buffer = read(request.file, request.start, request.end);
    const parsed = request.type === 'asc'
      ? parseAscRange(buffer, request.base, request.last)
      : parseBlfRange(buffer, request.start, request.objects, request.startTimestamp, request.tail, request.tailSkip);
    const signals = decoder.decode(parsed.frames);
    const transfer = [...packedTransfer(parsed.frames), ...signalsTransfer(signals)];
    parentPort!.postMessage({ id: request.id, result: { ...parsed, signals } }, transfer);
  } catch (error) {
    parentPort!.postMessage({ id: request.id, error: (error as Error).message });
  }
});
