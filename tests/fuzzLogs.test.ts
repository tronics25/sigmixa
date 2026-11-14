import test from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { Worker } from 'worker_threads';
import type { FuzzRequest, FuzzResult } from './support/fuzzWorker';

/**
 * Damaged logs: every reader must end on its own, within its memory, and report what it cannot read (an error a reader
 * throws on purpose is such a report; a type error or a read out of range is not). The damage is made from a fixed
 * seed, so a failure comes back on every run; FUZZ_CASES=<n> (and FUZZ_SEED=<n>) runs more.
 */

const CASES = Number(process.env.FUZZ_CASES ?? 40);
const SEED = Number(process.env.FUZZ_SEED ?? 1);
/** A read that takes longer hangs (the files are small: a sound read takes milliseconds). */
const TIME_LIMIT_MS = 10_000;
/** What the process may grow by while a damaged file is read. */
const MEMORY_LIMIT = 1.5 * 2 ** 30;

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32; };
}

const EXTREMES = [0, 1, 0x7f, 0xff, 0xffff, 0x7fffffff, 0xffffffff, 0x80000000, 16, 24, 64];

/** One damaged copy of `base`: bytes changed, size and count fields set to extremes, cut short, or pieces repeated. */
function damage(base: Buffer, format: FuzzRequest['format'], next: () => number): Buffer {
  const at = (size = 1) => Math.floor(next() * Math.max(1, base.length - size));
  const pick = <T>(items: readonly T[]) => items[Math.floor(next() * items.length)];
  let buffer = Buffer.from(base);
  const kind = Math.floor(next() * 6);
  if (kind === 0) for (let i = 1 + Math.floor(next() * 16); i > 0; i--) buffer[at()] = Math.floor(next() * 256);
  else if (kind === 1 || kind === 2) {
    // Size, count and link fields: after a block or object header (MDF ##xx, BLF LOBJ) or anywhere.
    const marker = format === 'mdf' ? '##' : format === 'blf' ? 'LOBJ' : '';
    const starts: number[] = [];
    if (marker) for (let i = buffer.indexOf(marker); i >= 0 && starts.length < 4096; i = buffer.indexOf(marker, i + 1)) starts.push(i);
    for (let i = 1 + Math.floor(next() * 4); i > 0; i--) {
      const offset = starts.length && kind === 1 ? pick(starts) + pick(format === 'mdf' ? [8, 16, 24, 32, 40, 48] : [4, 8, 16, 24, 32, 40]) : at(8);
      const value = pick(EXTREMES) + (next() < 0.3 ? Math.floor(next() * 64) : 0);
      if (offset + 8 <= buffer.length) { buffer.writeUInt32LE(value >>> 0, offset); if (next() < 0.3) buffer.writeUInt32LE(next() < 0.5 ? 0 : 0xffffffff, offset + 4); }
    }
  } else if (kind === 3) buffer = buffer.subarray(0, at());
  else if (kind === 4) { const start = at(); const end = Math.min(buffer.length, start + Math.floor(next() * 4096)); const into = at(); buffer = Buffer.concat([buffer.subarray(0, into), buffer.subarray(start, end), buffer.subarray(into)]); }
  else if (format === 'asc' || format === 'csv') {
    // Text: line breaks, quotes, separators and long runs where they do not belong.
    const pieces = ['\r', '\n', '\r\n', '"', ',', ' ', '\t', 'x'.repeat(5000), '1e309', '-', 'é', '😀'];
    for (let i = 1 + Math.floor(next() * 8); i > 0; i--) { const into = at(); buffer = Buffer.concat([buffer.subarray(0, into), Buffer.from(pick(pieces)), buffer.subarray(into)]); }
  } else for (let i = 1 + Math.floor(next() * 64); i > 0; i--) buffer[at()] ^= 1 << Math.floor(next() * 8);
  return buffer;
}

class Reader {
  private worker?: Worker;
  constructor(private readonly script: string) {}
  /** Reads one file; rejects with what went wrong when the read hangs, runs out of memory or crashes. */
  read(request: FuzzRequest): Promise<FuzzResult> {
    const worker = this.worker ??= new Worker(this.script, { resourceLimits: { maxOldGenerationSizeMb: 768 } });
    const baseline = process.memoryUsage().rss;
    return new Promise<FuzzResult>((resolve, reject) => {
      const stop = (message: string) => { done(); void worker.terminate(); this.worker = undefined; reject(new Error(message)); };
      const memory = setInterval(() => { const grown = process.memoryUsage().rss - baseline; if (grown > MEMORY_LIMIT) stop(`grew by ${Math.round(grown / 2 ** 20)} MiB`); }, 20);
      const timer = setTimeout(() => stop(`did not end within ${TIME_LIMIT_MS} ms`), TIME_LIMIT_MS);
      const onMessage = (result: FuzzResult) => { done(); resolve(result); };
      const onError = (error: Error) => { done(); this.worker = undefined; reject(error); };
      const onExit = (code: number) => { done(); this.worker = undefined; reject(new Error(`the reader ended (exit ${code})`)); };
      const done = () => { clearInterval(memory); clearTimeout(timer); worker.off('message', onMessage); worker.off('error', onError); worker.off('exit', onExit); };
      worker.on('message', onMessage); worker.once('error', onError); worker.once('exit', onExit);
      worker.postMessage(request);
    });
  }
  async close(): Promise<void> { await this.worker?.terminate(); }
}

const ascSample = readFileSync('sample/sigmixa-basic.asc', 'utf8').split('\n').slice(0, 400).join('\n');
const bases: { readonly name: string; readonly format: FuzzRequest['format']; readonly bytes: Buffer }[] = [
  { name: 'sigmixa-basic.asc', format: 'asc', bytes: Buffer.from(ascSample) },
  { name: 'sigmixa-basic.blf', format: 'blf', bytes: readFileSync('sample/sigmixa-basic.blf') },
  { name: 'sigmixa-basic.mf4', format: 'mdf', bytes: readFileSync('sample/sigmixa-basic.mf4') },
  { name: 'asammdf-structures.mf4', format: 'mdf', bytes: readFileSync('tests/fixtures/mdf/asammdf-structures.mf4') },
  { name: 'asammdf-signals-410.mf4', format: 'mdf', bytes: readFileSync('tests/fixtures/mdf/asammdf-signals-410.mf4') },
  { name: 'asammdf-transposed.mf4', format: 'mdf', bytes: readFileSync('tests/fixtures/mdf/asammdf-transposed.mf4') },
  { name: 'sigmixa-basic-decoded.mdf', format: 'mdf', bytes: readFileSync('sample/sigmixa-basic-decoded.mdf') },
  { name: 'asammdf-signals-330.mdf', format: 'mdf', bytes: readFileSync('tests/fixtures/mdf/asammdf-signals-330.mdf') },
  { name: 'sigmixa-basic-decoded.csv', format: 'csv', bytes: readFileSync('sample/sigmixa-basic-decoded.csv') },
];

for (const base of bases) {
  test(`damaged copies of ${base.name} are read to an end, within memory, without unexpected errors`, async () => {
    const folder = mkdtempSync(path.join(tmpdir(), 'sigmixa-fuzz-'));
    const reader = new Reader(path.join(__dirname, 'fuzzWorker.js'));
    const next = random(SEED * 7919 + bases.indexOf(base));
    const failures: string[] = [];
    try {
      // The undamaged file first: it must read without any failure.
      for (let index = 0; index <= CASES; index++) {
        const bytes = index ? damage(base.bytes, base.format, next) : base.bytes;
        const file = path.join(folder, `${index}${path.extname(base.name)}`); writeFileSync(file, bytes);
        try {
          const result = await reader.read({ file, format: base.format });
          if (result.failure) failures.push(`case ${index}: ${result.failure}`);
        } catch (error) { failures.push(`case ${index}: ${(error as Error).message}`); }
        rmSync(file, { force: true });
      }
    } finally { await reader.close(); rmSync(folder, { recursive: true, force: true }); }
    assert.deepEqual(failures, [], `seed ${SEED}`);
  });
}
