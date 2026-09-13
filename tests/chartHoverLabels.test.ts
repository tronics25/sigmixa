import assert from 'node:assert/strict';
import test from 'node:test';
import { layoutHoverLabelBoxes, layoutHoverLabels, layoutTimestampMarker } from '../src/webview/shared/chartHoverLabels';

test('hover labels retain isolated intersections and separate overlapping values', () => {
  assert.deepEqual(layoutHoverLabels([{ y: 20 }, { y: 60 }], 10, 90).map((item) => item.labelY), [20, 60]);
  assert.deepEqual(layoutHoverLabels([{ y: 20 }, { y: 22 }, { y: 24 }], 10, 90).map((item) => item.labelY), [20, 38, 56]);
});

test('hover labels remain inside a crowded graph lane', () => {
  const result = layoutHoverLabels([{ y: 88 }, { y: 89 }, { y: 90 }], 10, 90);
  assert.deepEqual(result.map((item) => item.labelY), [54, 72, 90]);
  assert.ok(result.every((item) => item.labelY >= 10 && item.labelY <= 90));
});

test('labels from nearby fixed markers avoid previously occupied boxes', () => {
  const bounds = { left: 0, right: 300, top: 0, bottom: 120 };
  const first = layoutHoverLabelBoxes([{ cursorX: 100, y: 50, width: 70, height: 16 }], bounds);
  const second = layoutHoverLabelBoxes([{ cursorX: 104, y: 50, width: 70, height: 16 }], bounds, first.map((item) => item.rect));
  assert.equal(first.length, 1); assert.equal(second.length, 1);
  const a = first[0].rect; const b = second[0].rect;
  assert.equal(a.y, b.y);
  assert.ok(a.x + a.width + 3 <= b.x || b.x + b.width + 3 <= a.x || a.y + a.height + 3 <= b.y || b.y + b.height + 3 <= a.y);
});

test('Timestamp marker stays inside the plot at both horizontal edges', () => {
  assert.deepEqual(layoutTimestampMarker(10, 64, 18, 10, 210, 100), { x: 12, y: 80, width: 64, height: 18 });
  assert.deepEqual(layoutTimestampMarker(210, 64, 18, 10, 210, 100), { x: 144, y: 80, width: 64, height: 18 });
});

test('nearby fixed Timestamp markers stack upward instead of overlapping', () => {
  const first = layoutTimestampMarker(100, 64, 18, 10, 210, 100);
  const second = layoutTimestampMarker(104, 64, 18, 10, 210, 100, [first], 10);
  assert.deepEqual(first, { x: 68, y: 80, width: 64, height: 18 });
  assert.deepEqual(second, { x: 72, y: 59, width: 64, height: 18 });
});
