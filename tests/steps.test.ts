import test from 'node:test';
import assert from 'node:assert/strict';
import { finishSteps, watch, watchedSteps } from '../src/core/storage/steps';

function* count(to: number, seen: number[], change?: () => void): Generator<void, number> {
  for (let index = 0; index < to; index++) { seen.push(index); if (index === 1) change?.(); yield; }
  return to;
}

test('a job done in steps ends with its result when nothing changes between its steps', () => {
  const seen: number[] = [];
  assert.equal(finishSteps(watchedSteps(() => [1], () => count(3, seen), 'drop')), 3);
  assert.deepEqual(seen, [0, 1, 2]);
});

test('a change between steps drops the job or starts it again; a change the job makes itself does not', () => {
  let version = 0; const seen: number[] = [];
  const steps = watchedSteps(() => [version], () => count(3, seen), 'restart');
  steps.next(); version++; // between the first and the second step
  let step = steps.next(); while (!step.done) step = steps.next();
  assert.equal(step.value, 3); assert.deepEqual(seen, [0, 0, 1, 2]);
  const dropped = watchedSteps(() => [version], () => count(3, []), 'drop');
  dropped.next(); version++;
  assert.deepEqual(dropped.next(), { done: true, value: undefined });
  // The job itself changes what is watched during its second step: that is not a change between steps.
  assert.equal(finishSteps(watchedSteps(() => [version], () => count(3, [], () => { version++; }), 'drop')), 3);
});

test('watch compares each value by identity', () => {
  const first = {}; let value: unknown = first;
  const changed = watch(() => [value, 'x']);
  assert.equal(changed(), false); value = {}; assert.equal(changed(), true); value = first; assert.equal(changed(), false);
});
