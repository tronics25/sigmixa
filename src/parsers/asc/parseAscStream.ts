import { createReadStream, promises as fs } from 'fs';
import type { CanFrame } from '../../core/frame/canFrame';
import type { Diagnostic } from '../../core/diagnostics/diagnostic';
import type { TimeReference } from '../../core/time/timeFormat';
import { parseAscFrameBytes, parseAscLine, type AscNumericBase } from './ascLineParser';

export interface AscParseProgress {
  readonly bytesRead: number;
  readonly totalBytes: number;
  readonly linesRead: number;
  readonly framesParsed: number;
}

export interface AscStreamOptions {
  readonly sourceId: string;
  readonly signal?: AbortSignal;
  readonly batchSize?: number;
  readonly onFrames: (frames: readonly CanFrame[]) => void | Promise<void>;
  readonly onDiagnostics?: (diagnostics: readonly Diagnostic[]) => void | Promise<void>;
  readonly onProgress?: (progress: AscParseProgress) => void;
  /** Called once, before the first frames, when the header's `date` line gives the measurement start. */
  readonly onTimeReference?: (reference: TimeReference) => void;
}

export interface AscParseSummary extends AscParseProgress {
  readonly diagnostics: number;
  readonly cancelled: boolean;
  /** Undefined when the log has no readable `date` line: its timestamps are then shown as seconds only. */
  readonly timeReference?: TimeReference;
}

export async function parseAscFile(filePath: string, options: AscStreamOptions): Promise<AscParseSummary> {
  const batchSize = Math.max(1, options.batchSize ?? 2048);
  const totalBytes = (await fs.stat(filePath)).size;
  const input = createReadStream(filePath, { highWaterMark: 1 << 20 });
  let base: AscNumericBase = 'hex';
  let timeReference: TimeReference | undefined;
  let lineNumber = 0;
  let sequence = 0;
  let bytesRead = 0;
  let diagnosticCount = 0;
  let cancelled = false;
  let frames: CanFrame[] = [];
  let diagnostics: Diagnostic[] = [];

  // The loop checks the signal for every line; the stream is closed when it stops.
  const abort = () => { cancelled = true; };
  options.signal?.addEventListener('abort', abort, { once: true });

  const flush = async () => {
    if (frames.length) {
      const current = frames;
      frames = [];
      await options.onFrames(current);
    }
    if (diagnostics.length) {
      const current = diagnostics;
      diagnostics = [];
      await options.onDiagnostics?.(current);
    }
    options.onProgress?.({ bytesRead, totalBytes, linesRead: lineNumber, framesParsed: sequence });
  };

  /** Reads one line; true when a batch is full. */
  const handle = (line: string): boolean => {
    lineNumber++;
    return take(parseAscLine(line, { sourceId: options.sourceId, line: lineNumber, sequence, base }));
  };
  const take = (result: ReturnType<typeof parseAscLine>): boolean => {
    if (result.type === 'base') base = result.base;
    // ASC timestamps count from the measurement start, so the start is also their offset on the clock. Only a date
    // before the first frame describes them.
    else if (result.type === 'date') { if (!timeReference && !sequence) { timeReference = { start: result.start, offset: result.start }; options.onTimeReference?.(timeReference); } }
    else if (result.type === 'frame') { frames.push(result.frame); sequence++; }
    else if (result.type === 'diagnostic') { diagnostics.push(result.diagnostic); diagnosticCount++; }
    return frames.length + diagnostics.length >= batchSize;
  };

  try {
    // Lines end at \n, \r\n or a lone \r, as with readline. A chunk is cut after its last \n, which never splits a
    // UTF-8 character; the rest waits for the next chunk.
    let carry: Buffer = Buffer.alloc(0); let consumed = 0;
    reading: for await (const chunk of input as AsyncIterable<Buffer>) {
      const buffer = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      let cut = buffer.lastIndexOf(10);
      // A log with lone \r endings: cut after a \r that is not the last byte (the last one may be half of a \r\n).
      // A \r just before it is used when the last byte is one, so a log whose chunks all end in \r never piles up.
      if (cut < 0 && buffer.length > 1) cut = buffer.lastIndexOf(13, buffer.length - 2);
      if (cut < 0) { carry = buffer; continue; }
      carry = buffer.subarray(cut + 1);
      const chunkStart = consumed; consumed += cut + 1;
      // Line by line on the bytes: a common frame row is read from them directly; any other line is decoded and read by
      // the full rules (split at every line break it holds, so a lone \r inside still ends a line).
      let position = 0;
      while (position <= cut) {
        if (options.signal?.aborted) { cancelled = true; break reading; }
        let next = buffer.indexOf(10, position); if (next < 0 || next > cut) next = cut;
        const lineEnd = buffer[next] === 10 && next > position && buffer[next - 1] === 13 ? next - 1 : next;
        bytesRead = Math.min(totalBytes, chunkStart + next + 1);
        const frame = buffer[next] === 10 ? parseAscFrameBytes(buffer, position, lineEnd, { sourceId: options.sourceId, line: lineNumber + 1, sequence, base }) : undefined;
        if (frame) { lineNumber++; if (take({ type: 'frame', frame })) await flush(); }
        else {
          const lines = buffer.toString('utf8', position, next + 1).split(/\r\n|\n|\r/); lines.pop();
          for (const line of lines) { if (options.signal?.aborted) { cancelled = true; break reading; } if (handle(line)) await flush(); }
        }
        position = next + 1;
      }
    }
    if (!cancelled && !options.signal?.aborted && carry.length) {
      const lines = carry.toString('utf8').split(/\r\n|\n|\r/);
      // A last line ending in a lone \r gives an empty piece after it, which readline does not report as a line.
      if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
      for (const line of lines) { if (options.signal?.aborted) break; bytesRead = totalBytes; if (handle(line)) await flush(); }
    }
    if (options.signal?.aborted) cancelled = true;
    await flush();
  } finally {
    options.signal?.removeEventListener('abort', abort);
    input.destroy();
  }

  return {
    bytesRead: cancelled ? bytesRead : totalBytes,
    totalBytes,
    linesRead: lineNumber,
    framesParsed: sequence,
    diagnostics: diagnosticCount,
    cancelled,
    ...(timeReference ? { timeReference } : {}),
  };
}
