// Reads one damaged log with every reader of its format, on a worker thread, so the test can stop a read that hangs and
// see one that runs out of memory. Built next to the tests by scripts/run-tests.mjs.
import { readFileSync } from 'fs';
import { parentPort } from 'worker_threads';
import { parseAscFile } from '../../src/parsers/asc/parseAscStream';
import { parseBlfBuffer, findObjectOffset, readBaseObjectHeader } from '../../src/parsers/blf/parseBlf';
import { parseCsvLogFile } from '../../src/parsers/csv/parseCsvLog';
import { parseMdfFile } from '../../src/parsers/mdf/parseMdf';
import { parseAscRange } from '../../src/parsers/parallel/ascRange';
import { parseBlfRange } from '../../src/parsers/parallel/blfRange';

export interface FuzzRequest { readonly file: string; readonly format: 'asc' | 'blf' | 'mdf' | 'csv' }
/** `failure`: an error that is not a reader's own report of a file it cannot read (a bug: a type error, a read out of range). */
export interface FuzzResult { readonly frames: number; readonly diagnostics: number; readonly failure?: string }

const ignore = () => undefined;

/** An error a reader throws on purpose is an Error with a message of its own; anything else is a bug. */
function unexpected(error: unknown): string | undefined {
  if (!(error instanceof Error)) return `threw ${String(error)}`;
  if (error instanceof TypeError || error instanceof RangeError || error instanceof ReferenceError || (error as { code?: string }).code === 'ERR_OUT_OF_RANGE' || (error as { code?: string }).code === 'ERR_BUFFER_OUT_OF_BOUNDS') return `${error.name}: ${error.message}\n${error.stack?.split('\n').slice(1).filter((line) => !line.includes('node:internal')).slice(0, 4).join('\n')}`;
  return undefined;
}

async function read({ file, format }: FuzzRequest): Promise<FuzzResult> {
  let frames = 0; let diagnostics = 0; let failure: string | undefined;
  const options = { sourceId: 'fuzz', onFrames: (items: readonly unknown[]) => { frames += items.length; }, onDiagnostics: (items: readonly unknown[]) => { diagnostics += items.length; }, onSignals: (items: readonly { times: ArrayLike<number> }[]) => { for (const item of items) frames += item.times.length; } };
  const attempt = async (run: () => unknown) => { try { await run(); } catch (error) { failure ??= unexpected(error); } };
  if (format === 'asc') {
    await attempt(() => parseAscFile(file, options));
    await attempt(() => parseAscRange(readFileSync(file), 'hex', true));
  } else if (format === 'blf') {
    const buffer = readFileSync(file);
    await attempt(() => parseBlfBuffer(buffer, options));
    // The top-level objects as the worker threads get them, all in one piece.
    await attempt(() => {
      const objects: number[] = [];
      if (buffer.length < 8) return;
      for (let offset = findObjectOffset(buffer, buffer.readUInt32LE(4)) ?? buffer.length; offset + 16 <= buffer.length;) {
        const header = readBaseObjectHeader(buffer, offset);
        if (!header || offset + header.objectSize > buffer.length) break;
        objects.push(offset);
        const next = findObjectOffset(buffer, offset + header.objectSize); if (next === undefined) break; offset = next;
      }
      parseBlfRange(buffer, 0, objects, 0, new Uint8Array(0));
      parseBlfRange(buffer, 0, objects, 0, undefined);
    });
  } else if (format === 'mdf') await attempt(() => parseMdfFile(file, options));
  else await attempt(() => parseCsvLogFile(file, options));
  return { frames, diagnostics, ...(failure ? { failure } : {}) };
}

parentPort?.on('message', (request: FuzzRequest) => { void read(request).then((result) => parentPort!.postMessage(result)); });
