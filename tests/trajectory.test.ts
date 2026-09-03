import test from 'node:test';
import assert from 'node:assert/strict';
import { advancePlayback, buildTrajectoryPoints, defaultTrajectoryView, presetTrajectoryView, projectPoint3d, trailAt } from '../src/core/trajectory/trajectory';

const samples = (values: Array<[number, number]>) => values.map(([timestamp, value]) => ({ timestamp, value }));

test('Trajectory switches between synchronized 2D/3D points without mutating source samples', () => {
  const x = samples([[1, 2], [2, 3], [3, 4]]); const y = samples([[1, 5], [2, 6], [3, 7]]); const z = samples([[1, 8], [2, 9], [3, 10]]);
  const original = JSON.stringify([x, y, z]);
  assert.deepEqual(buildTrajectoryPoints(x, y, undefined, { x: true, y: false, z: false }), [{ timestamp: 1, x: -2, y: 5 }, { timestamp: 2, x: -3, y: 6 }, { timestamp: 3, x: -4, y: 7 }]);
  assert.equal(buildTrajectoryPoints(x, y, z, { x: false, y: false, z: true })[0].z, -8); assert.equal(JSON.stringify([x, y, z]), original);
});

test('Trajectory accepts exact shared timestamps only and bounded reduction preserves endpoints', () => {
  const x = samples(Array.from({ length: 10_000 }, (_, index) => [index, index] as [number, number]));
  const y = samples(Array.from({ length: 10_000 }, (_, index) => [index, index * 2] as [number, number]));
  const points = buildTrajectoryPoints(x, y, undefined, { x: false, y: false, z: false }, 4000);
  assert.equal(points.length, 4000); assert.equal(points[0].timestamp, 0); assert.equal(points.at(-1)?.timestamp, 9999);
  assert.deepEqual(buildTrajectoryPoints(samples([[1, 1], [2, 2]]), samples([[1, 3], [3, 4]]), undefined, { x: false, y: false, z: false }), [{ timestamp: 1, x: 1, y: 3 }]);
});

test('Trajectory trail, reset/presets, continuous rotation, and playback preserve Timestamp semantics', () => {
  const points = [{ timestamp: 0, x: 0, y: 0 }, { timestamp: 5, x: 1, y: 1 }, { timestamp: 10, x: 2, y: 2 }];
  assert.deepEqual(trailAt(points, 7, { type: 'to-current' }).map((point) => point.timestamp), [0, 5]);
  assert.deepEqual(trailAt(points, 10, { type: 'last-seconds', seconds: 6 }).map((point) => point.timestamp), [5, 10]);
  assert.deepEqual(presetTrajectoryView('reset'), defaultTrajectoryView());
  assert.ok(Number.isFinite(projectPoint3d({ x: 1, y: 2, z: 3 }, { ...defaultTrajectoryView(), pitch: Math.PI * 3 }).x));
  assert.deepEqual(advancePlayback(5, 2, 2, { start: 0, end: 10 }), { timestamp: 9, ended: false });
  assert.deepEqual(advancePlayback(9, 2, 5, { start: 0, end: 10 }), { timestamp: 10, ended: true });
});
