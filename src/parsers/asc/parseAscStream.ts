import { createReadStream, promises as fs } from 'fs';
import type { CanFrame } from '../../core/frame/canFrame';
import type { Diagnostic } from '../../core/diagnostics/diagnostic';
import type { TimeReference } from '../../core/time/timeFormat';
import { parseAscFrameBytes, parseAscLine, type AscNumericBase } from './ascLineParser';
import { chunkCut, lastLines, LineCursor } from '../lineBreaks';
import { ByteGather, ReadBudget } from '../readBudget';

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

  // The loop checks for cancellation at every line; the stream is closed when it stops.
  const budget = new ReadBudget(options.signal);
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
    // Lines are cut as `lineBreaks` cuts them; the bytes after a chunk's last whole line wait for the next chunk.
    const carry = new ByteGather(); let consumed = 0;
    reading: for await (const chunk of input as AsyncIterable<Buffer>) {
      // Until a piece brings a line break, no line can end (a \r last kept may end one): the pieces are only gathered,
      // so a long line costs its length, not its length times the pieces it spans.
      if (carry.length && carry.lastByte !== 13 && chunk.indexOf(10) < 0 && chunk.indexOf(13) < 0) {
        carry.append(chunk);
        if (!budget.fitsPiece(carry.length)) throw new Error(`An ASC line is longer than ${budget.limits.pieceBytes} bytes.`);
        continue;
      }
      carry.append(chunk);
      const buffer = carry.take();
      const cut = chunkCut(buffer);
      if (cut < 0) { carry.keep(buffer, 0); continue; }
      carry.keep(buffer.subarray(cut + 1), 0);
      const chunkStart = consumed; consumed += cut + 1;
      // A common frame row is read from the bytes directly; any other line is decoded and read by the full rules.
      const cursor = new LineCursor(buffer, cut);
      while (cursor.next()) {
        if (budget.cancelled) { cancelled = true; break reading; }
        bytesRead = Math.min(totalBytes, chunkStart + cursor.last + 1);
        const frame = cursor.newline ? parseAscFrameBytes(buffer, cursor.start, cursor.end, { sourceId: options.sourceId, line: lineNumber + 1, sequence, base }) : undefined;
        if (frame) { lineNumber++; if (take({ type: 'frame', frame })) await flush(); }
        else for (const line of cursor.lines()) { if (budget.cancelled) { cancelled = true; break reading; } if (handle(line)) await flush(); }
      }
      await budget.pause();
    }
    if (!cancelled && !budget.cancelled && carry.length) {
      for (const line of lastLines(carry.take().toString('utf8'))) { if (budget.cancelled) break; bytesRead = totalBytes; if (handle(line)) await flush(); }
    }
    if (budget.cancelled) cancelled = true;
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
