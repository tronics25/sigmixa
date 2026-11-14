import test from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'fs';
import * as path from 'path';
import type { CanFrame } from '../src/core/frame/canFrame';
import { parseMdfFile, type MdfSignalSeries } from '../src/parsers/mdf/parseMdf';
import { assertMatchesAsammdf, missingSignals, type AsammdfEntry } from './support/asammdfReference';

// MDF files SigMixa made (the sample logs and files the MDF tests build), with what asammdf read from them in
// tests/fixtures/mdf/reference.json (made with scripts/asammdf-reference.py): SigMixa must read the same.
const folder = path.resolve('tests/fixtures/mdf');
const reference = JSON.parse(readFileSync(path.join(folder, 'reference.json'), 'utf8')) as AsammdfEntry[];

for (const entry of reference) {
  test(`${entry.file} reads as asammdf reads it`, { skip: entry.error ? `asammdf: ${entry.error}` : false }, async () => {
    const frames: CanFrame[] = []; let signals: MdfSignalSeries[] = [];
    try {
      await parseMdfFile(path.join(folder, entry.file), { sourceId: entry.file, onFrames: (items) => frames.push(...items), onDiagnostics: () => undefined, onSignals: (items) => { signals = [...items]; } });
    } catch { /* a file SigMixa refuses has nothing to compare, which the checks below report */ }
    assertMatchesAsammdf(entry, frames, signals);
    assert.deepEqual(missingSignals(entry, signals), [], 'signals asammdf reads');
  });
}
