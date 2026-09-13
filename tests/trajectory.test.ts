import test from 'node:test';
import assert from 'node:assert/strict';
import { advancePlayback, buildTrajectoryPoints, defaultTrajectoryView, measureTrajectory, presetTrajectoryView, projectPoint3d, trailAt, trajectoryAxisDisplayValue, trajectoryAxisEndpoints, trajectoryAxisScale } from '../src/core/trajectory/trajectory';

const samples = (values: Array<[number, number]>) => values.map(([timestamp, value]) => ({ timestamp, value }));

test('Trajectory switches between synchronized 2D/3D points without mutating source samples', () => {
  const x = samples([[1, 2], [2, 3], [3, 4]]); const y = samples([[1, 5], [2, 6], [3, 7]]); const z = samples([[1, 8], [2, 9], [3, 10]]);
  const original = JSON.stringify([x, y, z]);
  assert.deepEqual(buildTrajectoryPoints(x, y, undefined, { x: true, y: false, z: false }), [{ timestamp: 1, x: -2, y: 5 }, { timestamp: 2, x: -3, y: 6 }, { timestamp: 3, x: -4, y: 7 }]);
  assert.equal(buildTrajectoryPoints(x, y, z, { x: false, y: false, z: true })[0].z, -8); assert.equal(JSON.stringify([x, y, z]), original);
  assert.deepEqual(buildTrajectoryPoints([{ timestamp: 1, value: 2, quality: 'missing' }], samples([[1, 5]]), undefined, { x: false, y: false, z: false }), []);
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

test('Trajectory presets follow X forward, Y right, and Z up', () => {
  const front = presetTrajectoryView('front');
  assert.ok(projectPoint3d({ x: 1, y: 0, z: 0 }, front).depth > 0);
  assert.ok(projectPoint3d({ x: 0, y: 1, z: 0 }, front).x < 0);
  assert.ok(projectPoint3d({ x: 0, y: 0, z: 1 }, front).y > 0);
  const top = presetTrajectoryView('top');
  assert.ok(projectPoint3d({ x: 1, y: 0, z: 0 }, top).y > 0);
  assert.ok(projectPoint3d({ x: 0, y: 1, z: 0 }, top).x > 0);
  assert.ok(projectPoint3d({ x: 0, y: 0, z: 1 }, top).depth > 0);
  const side = presetTrajectoryView('side');
  assert.ok(projectPoint3d({ x: 1, y: 0, z: 0 }, side).x > 0);
  assert.ok(projectPoint3d({ x: 0, y: 1, z: 0 }, side).depth > 0);
  assert.ok(projectPoint3d({ x: 0, y: 0, z: 1 }, side).y > 0);
});

test('Trajectory axes use readable ticks and keep the coordinate origin visible', () => {
  assert.deepEqual(trajectoryAxisScale([1.2, 8.7]), { minimum: 0, maximum: 10, ticks: [0, 2, 4, 6, 8, 10] });
  assert.deepEqual(trajectoryAxisScale([-2.1, 2.1]).ticks, [-3, -2, -1, 0, 1, 2, 3]);
  const empty = trajectoryAxisScale([]); assert.ok(empty.minimum < 0); assert.ok(empty.maximum > 0);
  assert.deepEqual(trajectoryAxisEndpoints(-10, 20, false), { start: -10, end: 20 });
  assert.deepEqual(trajectoryAxisEndpoints(-10, 20, true), { start: 20, end: -10 });
  assert.equal(trajectoryAxisDisplayValue(-10, true), 10);
  assert.equal(trajectoryAxisDisplayValue(10, true), -10);
  assert.equal(Object.is(trajectoryAxisDisplayValue(0, true), -0), false);
});

test('Trajectory measurement reports signed deltas, distance, path length, and average speed', () => {
  const points = [
    { timestamp: 1, x: 0, y: 0, z: 0 },
    { timestamp: 2, x: 3, y: 0, z: 0 },
    { timestamp: 3, x: 3, y: 4, z: 0 },
  ];
  assert.deepEqual(measureTrajectory(points, 1, 3), {
    first: points[0], second: points[2], deltaTime: 2, deltaX: 3, deltaY: 4, deltaZ: 0, straightDistance: 5, pathLength: 7, averageSpeed: 3.5,
  });
  assert.equal(measureTrajectory(points, 1, 99), undefined);
});
