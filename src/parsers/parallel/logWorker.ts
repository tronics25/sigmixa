// Worker thread entry (out/logWorker.js): reads and decodes pieces of a log for `parallelLoad`.
import { openSync, readSync, closeSync } from 'fs';
import { parentPort } from 'worker_threads';
import type { AscNumericBase } from '../asc/ascLineParser';
import { parseAscRange } from './ascRange';
import { parseBlfRange } from './blfRange';
import { ChunkDecoder, type DecodeSpec } from './chunkDecoder';
import { packedTransfer, signalsTransfer } from './packedFrames';

export type WorkerRequest =
  | { readonly type: 'job'; readonly job: number; readonly spec: DecodeSpec }
  | { readonly type: 'end-job'; readonly job: number }
  | { readonly type: 'asc'; readonly id: number; readonly job: number; readonly file: string; readonly start: number; readonly end: number; readonly last: boolean; readonly base: AscNumericBase }
  | { readonly type: 'blf'; readonly id: number; readonly job: number; readonly file: string; readonly start: number; readonly end: number; readonly objects: Float64Array; readonly startTimestamp: number; readonly tail?: Uint8Array };

const decoders = new Map<number, ChunkDecoder>();

function read(file: string, start: number, end: number): Buffer {
  const buffer = Buffer.allocUnsafe(end - start); const fd = openSync(file, 'r');
  try { let done = 0; while (done < buffer.length) { const count = readSync(fd, buffer, done, buffer.length - done, start + done); if (!count) throw new Error('The log file became shorter while it was read.'); done += count; } }
  finally { closeSync(fd); }
  return buffer;
}

parentPort?.on('message', (request: WorkerRequest) => {
  if (request.type === 'job') { decoders.set(request.job, new ChunkDecoder(request.spec)); return; }
  if (request.type === 'end-job') { decoders.delete(request.job); return; }
  try {
    const decoder = decoders.get(request.job);
    if (!decoder) throw new Error('Unknown load job.');
    const buffer = read(request.file, request.start, request.end);
    const parsed = request.type === 'asc'
      ? parseAscRange(buffer, request.base, request.last)
      : parseBlfRange(buffer, request.start, request.objects, request.startTimestamp, request.tail);
    const signals = decoder.decode(parsed.frames);
    const transfer = [...packedTransfer(parsed.frames), ...signalsTransfer(signals)];
    parentPort!.postMessage({ id: request.id, result: { ...parsed, signals } }, transfer);
  } catch (error) {
    parentPort!.postMessage({ id: request.id, error: (error as Error).message });
  }
});
