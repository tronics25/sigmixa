import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseAscFile } from '../src/parsers/asc/parseAscStream';

test('stream adapter imports the ASC showcase in batches with Classic and FD frames', async () => {
  const lengths = new Set<number>(); let batchCount = 0; let frames = 0;
  const summary = await parseAscFile(path.resolve('sample/sigmixa-showcase.asc'), {
    sourceId: 'sample', batchSize: 64,
    onFrames: (batch) => { batchCount++; frames += batch.length; for (const frame of batch) lengths.add(frame.dataLength); },
  });
  assert.equal(summary.cancelled, false);
  assert.equal(summary.diagnostics, 2);
  assert.equal(frames, summary.framesParsed);
  assert.ok(batchCount > 1);
  assert.ok(lengths.has(8));
  assert.ok(lengths.has(64));
});

test('stream adapter cancellation keeps a valid partial result', async () => {
  const controller = new AbortController(); let frames = 0;
  const summary = await parseAscFile(path.resolve('sample/sigmixa-showcase.asc'), {
    sourceId: 'cancel-sample', batchSize: 8, signal: controller.signal,
    onFrames: (batch) => { frames += batch.length; controller.abort(); },
  });
  assert.equal(summary.cancelled, true);
  assert.equal(summary.framesParsed, frames);
  assert.ok(frames > 0);
});
