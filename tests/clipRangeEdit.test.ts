import test from 'node:test';
import assert from 'node:assert/strict';
import { dragClipEdge, parseClipRangeInput, refuseClipRange, withClipRange } from '../src/core/project/clipRangeEdit';
import type { SigMixaProject } from '../src/core/project/schema';

const project = { clips: [
  { id: 'a', name: 'Stop 1', sourcePath: 'run.asc', sourceFileName: 'run.asc', startTimestamp: 2, endTimestamp: 5 },
  { id: 'b', name: 'Stop 2', sourcePath: 'run.asc', sourceFileName: 'run.asc', startTimestamp: 7, endTimestamp: 9 },
] } as unknown as SigMixaProject;

const A = { id: 'a', sourcePath: 'run.asc' };

test('changing a Clip range changes only that Clip, and only its range', () => {
  const next = withClipRange(project, A, 1.5, 6.25);
  assert.deepEqual(next.clips[0], { id: 'a', name: 'Stop 1', sourcePath: 'run.asc', sourceFileName: 'run.asc', startTimestamp: 1.5, endTimestamp: 6.25 });
  assert.equal(next.clips[1], project.clips[1]);
});

test('a range that is empty, reversed, negative or of an unknown Clip changes nothing', () => {
  assert.equal(withClipRange(project, A, 5, 5), project); assert.equal(withClipRange(project, A, 6, 2), project);
  assert.equal(withClipRange(project, A, -1, 2), project); assert.equal(withClipRange(project, A, Number.NaN, 2), project);
  assert.equal(withClipRange(project, { id: 'missing', sourcePath: 'run.asc' }, 1, 2), project);
  assert.equal(withClipRange(project, { id: 'a', sourcePath: 'other.asc' }, 1, 2), project, 'the same ID in another log is another Clip');
  assert.equal(refuseClipRange(2, 2), 'empty'); assert.equal(refuseClipRange(-1, 2), 'negative'); assert.equal(refuseClipRange(1, Infinity), 'not-a-number');
});

test('edges are kept to the microsecond', () => {
  const next = withClipRange(project, A, 1.23456789, 2.00000049);
  assert.equal(next.clips[0].startTimestamp, 1.234568); assert.equal(next.clips[0].endTimestamp, 2);
});

test('a typed range is read as start and end in seconds', () => {
  assert.deepEqual(parseClipRangeInput('12.5 - 20'), { start: 12.5, end: 20 });
  assert.deepEqual(parseClipRangeInput('12.500–20.000 s'), { start: 12.5, end: 20 });
  assert.deepEqual(parseClipRangeInput('１２．５〜２０'), { start: 12.5, end: 20 }, 'full-width digits');
  assert.deepEqual(parseClipRangeInput('0 3'), { start: 0, end: 3 });
  assert.equal(parseClipRangeInput('20 - 12'), undefined); assert.equal(parseClipRangeInput('abc'), undefined); assert.equal(parseClipRangeInput('5'), undefined);
});

test('a dragged edge stays inside the log and never crosses the other edge', () => {
  const log = { start: 0, end: 10 };
  assert.deepEqual(dragClipEdge({ start: 2, end: 5 }, 'start', 3.2, log, 0.1), { start: 3.2, end: 5 });
  assert.deepEqual(dragClipEdge({ start: 2, end: 5 }, 'start', 8, log, 0.1), { start: 4.9, end: 5 }, 'stops before the end');
  assert.deepEqual(dragClipEdge({ start: 2, end: 5 }, 'start', -4, log, 0.1), { start: 0, end: 5 }, 'stops at the start of the log');
  assert.deepEqual(dragClipEdge({ start: 2, end: 5 }, 'end', 40, log, 0.1), { start: 2, end: 10 }, 'stops at the end of the log');
  assert.deepEqual(dragClipEdge({ start: 2, end: 5 }, 'end', 1, log, 0.1), { start: 2, end: 2.1 }, 'stops after the start');
});
