import test from 'node:test';
import assert from 'node:assert/strict';
import { removeComparisonTarget, reorderComparisonTargets, setComparisonTargetOffset, splitSignalGroupsByTarget, uniqueComparisonTargets, type ComparisonDefinition, snapAnchor, stepAnchor, type FrameTimes } from '../src/core/project/comparison';

const base: ComparisonDefinition = {
  id: 'cmp', name: 'Comparison 1',
  targets: [
    { id: 'a', kind: 'file', sourcePath: 'run-001.asc', offset: 0 },
    { id: 'b', kind: 'clip', clipId: 'clip-1', offset: 1.5 },
    { id: 'c', kind: 'clip', clipId: 'clip-2', offset: -0.25 },
  ],
  graphs: [{ id: 'g', name: 'Graph', signalIds: ['speed'] }],
};

test('files and Clips of the same log are distinct targets, but the same target is kept once', () => {
  const next = uniqueComparisonTargets([...base.targets, { id: 'dup', kind: 'clip', clipId: 'clip-1', offset: 0 }, { id: 'd', kind: 'clip', clipId: 'clip-3', offset: 0 }]);
  assert.deepEqual(next.map((target) => target.id), ['a', 'b', 'c', 'd']);
});

test('targets reorder and are removed without touching the others\' time shift', () => {
  const reordered = reorderComparisonTargets(base, ['c', 'a']);
  assert.deepEqual(reordered.targets.map((target) => [target.id, target.offset]), [['c', -0.25], ['a', 0], ['b', 1.5]]);
  const removed = removeComparisonTarget({ ...base, hiddenTargetIds: ['b'] }, 'b');
  assert.deepEqual(removed.targets.map((target) => [target.id, target.offset]), [['a', 0], ['c', -0.25]]);
  assert.deepEqual(removed.hiddenTargetIds, []);
  assert.equal(setComparisonTargetOffset(base, 'a', 0.5).targets[0].offset, 0.5);
});

test('targets with different Frame definitions list common Signals first, then "only in A" / "only in B"', () => {
  const groups = [{ id: 'frame:common', label: '2A0 Powertrain', signalIds: ['speed', 'rpm'] }, { id: 'frame:a', label: '300 Brake · Group A', signalIds: ['brake-a'] }, { id: 'frame:b', label: '300 Brake · Group B', signalIds: ['brake-b'] }];
  const targets = [
    { id: 'a', name: 'A', signalIds: new Set(['speed', 'rpm', 'brake-a']) },
    { id: 'b', name: 'B', signalIds: new Set(['speed', 'brake-b']) },
  ];
  const split = splitSignalGroupsByTarget(groups, targets, (names) => `${names} only`);
  assert.deepEqual(split.map((group) => [group.label, group.signalIds]), [
    ['2A0 Powertrain', ['speed']],
    ['A only · 2A0 Powertrain', ['rpm']],
    ['A only · 300 Brake · Group A', ['brake-a']],
    ['B only · 300 Brake · Group B', ['brake-b']],
  ]);
  assert.equal(new Set(split.map((group) => group.id)).size, split.length);
  const three = splitSignalGroupsByTarget(groups, [...targets, { id: 'c', name: 'C', signalIds: new Set(['speed', 'rpm']) }], (names) => `${names} only`, (names) => `not in ${names}`);
  assert.equal(three[0].label, '2A0 Powertrain');
  assert.ok(three.some((group) => group.label === 'not in B · 2A0 Powertrain' && group.signalIds.join() === 'rpm'));
});

test('a time shift moves both ways in steps of the target own frames, past either end of the log', () => {
  const frames = [10, 10.5, 11, 12];
  const times: FrameTimes = {
    first: 10, last: 12,
    adjacent: (timestamp, direction) => direction > 0 ? frames.find((frame) => frame > timestamp) : [...frames].reverse().find((frame) => frame < timestamp),
    nearest: (timestamp) => frames.reduce((best, frame) => Math.abs(frame - timestamp) < Math.abs(best - timestamp) ? frame : best),
  };
  const walk = (from: number, direction: -1 | 1, count: number) => { const out: number[] = []; let anchor = from; for (let index = 0; index < count; index++) out.push(anchor = stepAnchor(times, anchor, direction)); return out; };
  assert.deepEqual(walk(10, 1, 3), [10.5, 11, 12], 'inside the log it steps frame by frame');
  assert.deepEqual(walk(10, -1, 3), [9.5, 9, 8], 'before the first frame it keeps going, mirroring the frame steps');
  assert.deepEqual(walk(12, 1, 3), [13, 13.5, 14], 'after the last frame too');
  assert.deepEqual(walk(8, 1, 4), [9, 9.5, 10, 10.5], 'and comes back the same way');
  assert.equal(snapAnchor(times, 10.7), 10.5); assert.equal(snapAnchor(times, 9.3), 9.5, 'a dragged shift before the start is kept, not reset to the start');
  assert.equal(snapAnchor(times, 13.2), 13);
});
