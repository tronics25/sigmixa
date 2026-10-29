import { createReadStream, promises as fs } from 'fs';
import { createInterface } from 'readline';
import type { CanFrame } from '../../core/frame/canFrame';
import type { Diagnostic } from '../../core/diagnostics/diagnostic';
import type { TimeReference } from '../../core/time/timeFormat';
import { parseAscLine, type AscNumericBase } from './ascLineParser';

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
  const input = createReadStream(filePath, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let base: AscNumericBase = 'hex';
  let timeReference: TimeReference | undefined;
  let lineNumber = 0;
  let sequence = 0;
  let bytesRead = 0;
  let diagnosticCount = 0;
  let cancelled = false;
  let frames: CanFrame[] = [];
  let diagnostics: Diagnostic[] = [];

  const abort = () => {
    cancelled = true;
    lines.close();
    input.destroy();
  };
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

  try {
    for await (const line of lines) {
      if (options.signal?.aborted) { cancelled = true; break; }
      lineNumber++;
      bytesRead = Math.min(totalBytes, bytesRead + Buffer.byteLength(line, 'utf8') + 1);
      const result = parseAscLine(line, { sourceId: options.sourceId, line: lineNumber, sequence, base });
      if (result.type === 'base') base = result.base;
      // ASC timestamps count from the measurement start, so the start is also their offset on the clock. Only a date
      // before the first frame describes them.
      else if (result.type === 'date') { if (!timeReference && !sequence) { timeReference = { start: result.start, offset: result.start }; options.onTimeReference?.(timeReference); } }
      else if (result.type === 'frame') { frames.push(result.frame); sequence++; }
      else if (result.type === 'diagnostic') { diagnostics.push(result.diagnostic); diagnosticCount++; }
      if (frames.length + diagnostics.length >= batchSize) await flush();
    }
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
