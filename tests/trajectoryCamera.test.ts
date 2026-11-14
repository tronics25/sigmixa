import test from 'node:test';
import assert from 'node:assert/strict';
import { TRAJECTORY_ZOOM_LIMITS, defaultTrajectoryView, presetTrajectoryView, projectPoint3d } from '../src/core/trajectory/trajectory';
import { TrajectoryCamera, fitTrajectoryScene, trajectorySceneScale } from '../src/core/trajectory/trajectoryCamera';

const options = { pixelsPerUnit: 10, height: 400, coordinateSystem: 'right' as const };

test('any pan movement, also one-pixel steps, takes the camera over; rotating keeps it fitted; a click jitter is not a move', () => {
  const camera = new TrajectoryCamera();
  camera.beginDrag(0, 0, true); camera.dragTo(1, 0, options); camera.dragTo(1, 1, options);
  assert.equal(camera.fitted, false);
  assert.deepEqual(camera.endDrag(), { moved: false, changed: true });
  camera.reset(defaultTrajectoryView()); camera.beginDrag(0, 0, false); camera.dragTo(40, 30, options);
  assert.equal(camera.fitted, true, 'a rotation is refitted at its new angle'); assert.notEqual(camera.view.yaw, defaultTrajectoryView().yaw);
  assert.deepEqual(camera.endDrag(), { moved: true, changed: true });
  camera.reset(defaultTrajectoryView()); camera.beginDrag(0, 0, false); camera.dragTo(0, 0, options);
  assert.equal(camera.fitted, true, 'no movement keeps the fit');
  assert.deepEqual(camera.endDrag(), { moved: false, changed: false });
  camera.beginDrag(0, 0, false); camera.dragTo(5, 0, options);
  assert.equal(camera.endDrag()?.moved, true);
  assert.equal(camera.endDrag(), undefined, 'no drag after it ended');
  assert.equal(camera.dragTo(9, 9, options), false);
});

test('a drag turns the other way in a left-handed scene, so it looks the same; pitch stops at the poles', () => {
  const right = new TrajectoryCamera({ ...defaultTrajectoryView(), yaw: 0 }); const left = new TrajectoryCamera({ ...defaultTrajectoryView(), yaw: 0 });
  right.beginDrag(0, 0, false); right.dragTo(100, 0, options);
  left.beginDrag(0, 0, false); left.dragTo(100, 0, { ...options, coordinateSystem: 'left' });
  assert.ok(Math.abs(right.view.yaw - Math.PI / 2) < 1e-12, 'a quarter of the height turns a quarter around'); assert.equal(left.view.yaw, -right.view.yaw);
  const point = { x: 1, y: 2, z: 0 };
  assert.ok(Math.abs(projectPoint3d(point, right.view, 'right').x - projectPoint3d(point, left.view, 'left').x) < 1e-12, 'the same screen motion');
  right.beginDrag(0, 0, false); right.dragTo(0, 10_000, options); assert.equal(right.view.pitch, Math.PI / 2);
});

test('a pan keeps the scene under the cursor at any zoom', () => {
  const camera = new TrajectoryCamera({ ...defaultTrajectoryView(), zoom: 2 });
  camera.beginDrag(0, 0, true); camera.dragTo(20, 10, options);
  assert.equal(camera.view.panX, 1); assert.equal(camera.view.panY, -.5); assert.equal(camera.view.yaw, defaultTrajectoryView().yaw);
});

test('zoom stays within its limits and keeps the anchored point in place; presets fit again', () => {
  const camera = new TrajectoryCamera({ ...defaultTrajectoryView(), zoom: 1, panX: .3, panY: -.2 });
  const anchor = { dx: 40, dy: -25, pixelsPerUnit: 10 };
  const sceneAt = (view = camera.view) => ({ x: anchor.dx / anchor.pixelsPerUnit / view.zoom - view.panX, y: -anchor.dy / anchor.pixelsPerUnit / view.zoom - view.panY });
  const before = sceneAt(); camera.zoom(1.5, anchor); const after = sceneAt();
  assert.equal(camera.fitted, false); assert.ok(Math.abs(before.x - after.x) < 1e-12 && Math.abs(before.y - after.y) < 1e-12);
  const centred = new TrajectoryCamera({ ...defaultTrajectoryView(), panX: 1, panY: 2 }); centred.zoom(3);
  assert.deepEqual([centred.view.panX, centred.view.panY, centred.view.zoom], [1, 2, 3]);
  centred.zoom(1e9); assert.equal(centred.view.zoom, TRAJECTORY_ZOOM_LIMITS.maximum);
  const broken = new TrajectoryCamera({ ...defaultTrajectoryView(), zoom: 0, panX: 1, panY: 2 }); broken.zoom(1.5);
  assert.deepEqual([broken.view.zoom, broken.view.panX, broken.view.panY], [TRAJECTORY_ZOOM_LIMITS.minimum, 1, 2], 'a saved zero zoom recovers without losing the pan');
  centred.reset(presetTrajectoryView('x')); assert.equal(centred.fitted, true); assert.deepEqual(centred.view, presetTrajectoryView('x'));
});

test('a fitted camera is refitted for each drawing; exports do not replace the on-screen camera', () => {
  const points = [{ x: 1000, y: 0, z: 50 }, { x: 1010, y: 4, z: 51 }]; const center = [1005, 2, 50.5] as const;
  const camera = new TrajectoryCamera(defaultTrajectoryView(), true);
  const fit = (width: number, height: number) => (view: typeof camera.view) => fitTrajectoryScene(view, points, center, trajectorySceneScale(10, width, height), width, height, 'right');
  const screen = camera.frame(fit(800, 400), true); assert.deepEqual(camera.view, screen);
  const exported = camera.frame(fit(1600, 1000), false); assert.notDeepEqual(exported, screen); assert.deepEqual(camera.view, screen);
  camera.zoom(2); const manual = camera.view;
  assert.equal(camera.frame(fit(300, 300), true), manual, 'a camera the user moved is drawn as it is');
  assert.equal(trajectorySceneScale(10, 800, 400), 400 * .68 / 10);
});
