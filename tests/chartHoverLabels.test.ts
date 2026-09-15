import assert from 'node:assert/strict';
import test from 'node:test';
import { layoutHoverLabelBoxes, layoutHoverLabels, layoutTimestampMarker, timestampGutter } from '../src/webview/shared/chartHoverLabels';

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

test('Timestamp marker stays below the plot and within both horizontal edges', () => {
  assert.deepEqual(layoutTimestampMarker(10, 64, 18, 10, 210, 100), { x: 12, y: 105, width: 64, height: 18 });
  assert.deepEqual(layoutTimestampMarker(210, 64, 18, 10, 210, 100), { x: 144, y: 105, width: 64, height: 18 });
});

test('nearby fixed Timestamp markers stay in the time axis instead of stacking into the plot', () => {
  const first = layoutTimestampMarker(100, 64, 18, 10, 210, 100);
  const second = layoutTimestampMarker(104, 64, 18, 10, 210, 100, [first], 10);
  assert.deepEqual(first, { x: 68, y: 105, width: 64, height: 18 });
  assert.deepEqual(second, { x: 72, y: 126, width: 64, height: 18 });
});

test('crowded Timestamp badges preserve cursor alignment and only grow downward', () => {
  const occupied = [];
  for (let index = 0; index < 8; index++) {
    const cursor = 100 + index;
    const rect = layoutTimestampMarker(cursor, 64, 18, 10, 210, 100, occupied);
    assert.equal(rect.x + rect.width / 2, cursor);
    assert.equal(rect.y, 105 + index * 21);
    occupied.push(rect);
  }
});

test('time-axis gutter expands only for overlapping Timestamp badges', () => {
  const context = { measureText: () => ({ width: 52 }) } as unknown as CanvasRenderingContext2D;
  assert.equal(timestampGutter(context, [], 10, 310), 0);
  assert.equal(timestampGutter(context, [{ x: 100, text: '1s' }], 10, 310), 0);
  assert.equal(timestampGutter(context, [{ x: 100, text: '1s' }, { x: 220, text: '2s' }], 10, 310), 0);
  assert.equal(timestampGutter(context, [{ x: 100, text: '1s' }, { x: 104, text: '2s' }], 10, 310), 21);
});
