import test from 'node:test';
import assert from 'node:assert/strict';
import { advancePlayback, buildTrajectoryPoints, defaultTrajectoryView, measureTrajectory, presetTrajectoryView, projectPoint3d, trailAt, trajectoryAxisDisplayValue, trajectoryAxisEndpoints, trajectoryAxisScale, trajectoryViewFrom, fitTrajectoryView, trajectorySceneFrame, type TrajectoryViewTransform } from '../src/core/trajectory/trajectory';

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
  // Bounded, with the turning points of each axis kept (fewer than the limit when runs share their extremes).
  assert.ok(points.length <= 4000 && points.length >= 2000, String(points.length)); assert.equal(points[0].timestamp, 0); assert.equal(points.at(-1)?.timestamp, 9999);
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

test('X/Y/Z buttons look from the + side of each axis in both coordinate systems', () => {
  const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} ≠ ${expected}`);
  // Screen x right, y up; a larger depth is nearer the viewer (the 3D view paints points in ascending depth).
  const axes = (preset: 'x' | 'y' | 'z', system: 'right' | 'left') => {
    const view = presetTrajectoryView(preset); const project = (x: number, y: number, z: number) => projectPoint3d({ x, y, z }, view, system);
    return { x: project(1, 0, 0), y: project(0, 1, 0), z: project(0, 0, 1) };
  };
  const expected = {
    right: { x: { right: 'y', up: 'z', toward: 'x' }, y: { right: '-x', up: 'z', toward: 'y' }, z: { right: 'x', up: 'y', toward: 'z' } },
    left: { x: { right: '-y', up: 'z', toward: 'x' }, y: { right: 'x', up: 'z', toward: 'y' }, z: { right: '-x', up: 'y', toward: 'z' } },
  } as const;
  for (const system of ['right', 'left'] as const) for (const preset of ['x', 'y', 'z'] as const) {
    const projected = axes(preset, system); const { right, up, toward } = expected[system][preset];
    for (const axis of ['x', 'y', 'z'] as const) {
      const point = projected[axis];
      close(point.x, right === axis ? 1 : right === `-${axis}` ? -1 : 0);
      close(point.y, up === axis ? 1 : 0);
      close(point.depth, toward === axis ? 1 : 0);
    }
  }
  assert.deepEqual(presetTrajectoryView('x'), { yaw: 0, pitch: 0, zoom: 1, panX: 0, panY: 0 });
  assert.deepEqual(presetTrajectoryView('y'), { yaw: Math.PI / 2, pitch: 0, zoom: 1, panX: 0, panY: 0 });
  assert.deepEqual(presetTrajectoryView('z'), { yaw: -Math.PI / 2, pitch: Math.PI / 2, zoom: 1, panX: 0, panY: 0 });
});

test('The camera carries no mirror: the coordinate system mirrors every view alike', () => {
  const drag = (view: TrajectoryViewTransform, yaw: number, pitch: number) => ({ ...view, yaw: view.yaw + yaw, pitch: view.pitch + pitch });
  // Reaching the same yaw/pitch through a preset or through reset gives the same picture.
  const fromPreset = drag(presetTrajectoryView('x'), .3, .2);
  const fromReset = drag(presetTrajectoryView('reset'), -Math.PI / 4 + .3, -Math.atan(1 / Math.sqrt(2)) + .2);
  const points = [{ x: 1, y: 2, z: 3 }, { x: -4, y: .5, z: -1 }, { x: 0, y: -2, z: 7 }];
  for (const system of ['right', 'left'] as const) for (const point of points) {
    const a = projectPoint3d(point, fromPreset, system); const b = projectPoint3d(point, fromReset, system);
    for (const key of ['x', 'y', 'depth'] as const) assert.ok(Math.abs(a[key] - b[key]) < 1e-12);
  }
  // Left-handed is the right-handed picture mirrored left to right, for presets, reset and dragged views; pan keeps its direction.
  for (const view of [...(['x', 'y', 'z', 'reset'] as const).map(presetTrajectoryView), fromPreset, { ...fromReset, panX: 2, panY: -1, zoom: 3 }]) for (const point of points) {
    const right = projectPoint3d(point, view, 'right'); const left = projectPoint3d(point, view, 'left');
    assert.ok(Math.abs(left.x - (2 * view.panX * view.zoom - right.x)) < 1e-12); assert.equal(left.y, right.y); assert.equal(left.depth, right.depth);
  }
  assert.deepEqual(projectPoint3d(points[0], fromPreset), projectPoint3d(points[0], fromPreset, 'right'));
});

test('X/Y/Z/Reset fit the projected points to the area, centred on the data, without squeezing data far from the origin', () => {
  // Offset data: x 1000..1010, y -3..5, z 20..22 — a helix-like spread well away from 0.
  const points = Array.from({ length: 41 }, (_, index) => ({ x: 1000 + index / 4, y: -3 + 8 * (.5 + .5 * Math.sin(index)), z: 20 + 2 * (.5 + .5 * Math.cos(index)) }));
  const box = (view: TrajectoryViewTransform, system: 'right' | 'left') => { const projected = points.map((point) => projectPoint3d(point, view, system)); const xs = projected.map((point) => point.x); const ys = projected.map((point) => point.y); return { left: Math.min(...xs), right: Math.max(...xs), bottom: Math.min(...ys), top: Math.max(...ys) }; };
  for (const [width, height] of [[40, 10], [10, 40]]) for (const system of ['right', 'left'] as const) for (const preset of ['x', 'y', 'z', 'reset'] as const) {
    const view = fitTrajectoryView(presetTrajectoryView(preset), points, width, height, system); const b = box(view, system); const near = (a: number, e: number) => Math.abs(a - e) < 1e-9;
    assert.equal(view.yaw, presetTrajectoryView(preset).yaw); assert.equal(view.pitch, presetTrajectoryView(preset).pitch);
    assert.ok(b.left >= -width / 2 - 1e-9 && b.right <= width / 2 + 1e-9 && b.bottom >= -height / 2 - 1e-9 && b.top <= height / 2 + 1e-9, `${preset} ${system} ${width}×${height} inside`);
    assert.ok(near(b.right - b.left, width) || near(b.top - b.bottom, height), `${preset} ${system} ${width}×${height} fills one side`);
    assert.ok(near(b.left + b.right, 0) && near(b.bottom + b.top, 0), 'centred on the data');
  }
  // The scene is framed by the data, not by axis ranges that reach 0.
  const frame = trajectorySceneFrame(points); assert.ok(Math.abs(frame.center[0] - 1005) < 1e-9); assert.ok(Math.abs(frame.span - 10) < 1e-9);
  assert.deepEqual(trajectorySceneFrame([{ x: 2, y: 3 }]), { center: [2, 3, 0], span: 1 });
  // Seen along Z, the 10-unit X spread fills the width of a wide area: the distance from the origin does not shrink it.
  const top = fitTrajectoryView(presetTrajectoryView('z'), points, 40, 40); const b = box(top, 'right');
  assert.ok(Math.abs((b.right - b.left) - 40) < 1e-9);
});

test('Fitting degenerate data keeps the zoom finite', () => {
  const view = presetTrajectoryView('x');
  const single = fitTrajectoryView(view, [{ x: 5, y: 6, z: 7 }], 10, 10);
  assert.equal(single.zoom, view.zoom); assert.deepEqual([single.panX, single.panY], [-6, -7]);
  // Points along X, seen along X: they all project to one spot.
  const endOn = fitTrajectoryView(view, [{ x: 0, y: 1, z: 2 }, { x: 9, y: 1, z: 2 }], 10, 10);
  assert.ok(Number.isFinite(endOn.zoom) && endOn.zoom === view.zoom);
  // A flat line fits along its length only.
  const flat = fitTrajectoryView(view, [{ x: 0, y: 0, z: 0 }, { x: 0, y: 4, z: 0 }], 20, 10);
  assert.equal(flat.zoom, 5);
  // A long, thin path seen end-on still fills the view (the zoom may go past the old 200 cap).
  assert.equal(fitTrajectoryView(view, [{ x: 0, y: 0, z: 0 }, { x: 1000, y: 1, z: 0 }], 400, 400).zoom, 400);
  assert.deepEqual(fitTrajectoryView(view, [], 10, 10), view);
  assert.deepEqual(fitTrajectoryView(view, [{ x: 0, y: 0, z: 0 }, { x: 0, y: 4, z: 0 }], 0, 10), view);
});

test('Saved views keep only the camera; an old mirror flag is ignored', () => {
  const saved = { yaw: 1, pitch: .4, zoom: 2, panX: 3, panY: -4, mirrorHorizontal: true };
  assert.deepEqual(trajectoryViewFrom(saved), { yaw: 1, pitch: .4, zoom: 2, panX: 3, panY: -4 });
  assert.deepEqual(trajectoryViewFrom(undefined), defaultTrajectoryView());
  assert.deepEqual(trajectoryViewFrom({ yaw: Number.NaN, pitch: .4 } as never), { ...defaultTrajectoryView(), pitch: .4 });
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

test('trajectory axis ticks are decimal-exact', () => {
  const scale = trajectoryAxisScale([0.07, 0.29]);
  assert.deepEqual(scale.ticks, [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3]);
  assert.equal(scale.maximum, 0.3);
  assert.ok(trajectoryAxisScale([7e-309]).ticks.every(Number.isFinite));
  assert.ok(Number.isFinite(trajectoryAxisScale([7e-309]).maximum));
  assert.ok(trajectoryAxisScale([0.000030000000000000004]).maximum >= 0.000030000000000000004);
});
