import assert from 'node:assert/strict';
import test from 'node:test';
import { chartWheelGesture } from '../src/webview/shared/chartWheel';

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
