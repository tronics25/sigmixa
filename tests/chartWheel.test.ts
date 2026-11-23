import assert from 'node:assert/strict';
import test from 'node:test';
import { chartWheelGesture, wheelPanRange, wheelZoomFactor } from '../src/webview/shared/chartWheel';

const wheel = (overrides: Partial<Parameters<typeof chartWheelGesture>[0]> = {}) => ({
  deltaX: 0,
  deltaY: 0,
  deltaMode: 0,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...overrides,
});

test('ordinary vertical wheel remains available for graph-list scrolling', () => {
  assert.deepEqual(chartWheelGesture(wheel({ deltaY: 80 }), 800), { kind: 'scroll' });
  assert.deepEqual(chartWheelGesture(wheel({ deltaX: 2, deltaY: 30 }), 800), { kind: 'scroll' });
});

test('horizontal trackpad and Shift-wheel gestures pan the time axis', () => {
  assert.deepEqual(chartWheelGesture(wheel({ deltaX: 40, deltaY: 2 }), 800), { kind: 'pan', delta: 40 });
  assert.deepEqual(chartWheelGesture(wheel({ deltaY: 3, deltaMode: 1, shiftKey: true }), 800), { kind: 'pan', delta: 48 });
});

test('modifier-wheel gestures remain dedicated to zooming', () => {
  assert.deepEqual(chartWheelGesture(wheel({ deltaY: -20, ctrlKey: true }), 800), { kind: 'zoom', delta: -20 });
  assert.deepEqual(chartWheelGesture(wheel({ deltaY: 1, deltaMode: 2, metaKey: true }), 800), { kind: 'zoom', delta: 800 });
});

test('a wheel pan moves the graph by the wheel\'s pixels and stops at the ends', () => {
  const full = { start: 0, end: 100 }; const view = { start: 40, end: 60 };
  assert.deepEqual(wheelPanRange(view, full, 50, 500), { start: 42, end: 62 }, '50 px of a 500 px plot showing 20 s is 2 s');
  assert.deepEqual(wheelPanRange(view, full, -5, 500), { start: 39.8, end: 59.8 }, 'a small turn moves a little: no fixed step');
  assert.deepEqual(wheelPanRange(view, full, 1e6, 500), { start: 80, end: 100 }); assert.deepEqual(wheelPanRange(view, full, -1e6, 500), { start: 0, end: 20 });
  assert.deepEqual(wheelPanRange(full, full, 50, 500), full);
});

test('wheel zoom follows the amount turned: a notch is one step, a pinch adds up smoothly', () => {
  assert.ok(wheelZoomFactor(100) > 1.35 && wheelZoomFactor(100) < 1.5); assert.ok(Math.abs(wheelZoomFactor(100) * wheelZoomFactor(-100) - 1) < 1e-12);
  assert.ok(wheelZoomFactor(-2) < 1 && wheelZoomFactor(-2) > 0.97, 'a small pinch delta zooms in a little');
  assert.ok(wheelZoomFactor(1e9) < 2.4, 'one event never zooms without bound');
});
