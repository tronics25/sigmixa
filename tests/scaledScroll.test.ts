import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SCROLL_HEIGHT, computeScaledVirtualRange, scaledScroll } from '../src/webview/shared/virtualization';

const ROW = 28; const VIEW = 600;

test('small tables keep a one-to-one scroll range', () => {
  const map = scaledScroll(1000, ROW, VIEW);
  assert.equal(map.scrollHeight, 28000); assert.equal(map.contentOffset(500), 500); assert.equal(map.scrollTopFor(500), 500);
  const range = computeScaledVirtualRange(1000, 280, VIEW, ROW);
  assert.equal(range.windowTop, range.start * ROW);
});

test('huge tables cap the scroll height and still reach the last row', () => {
  const rows = 5_000_000; const map = scaledScroll(rows, ROW, VIEW);
  assert.equal(map.scrollHeight, MAX_SCROLL_HEIGHT);
  const bottom = MAX_SCROLL_HEIGHT - VIEW;
  const range = computeScaledVirtualRange(rows, bottom, VIEW, ROW);
  assert.equal(range.end, rows);
  // The last row's bottom edge lands on the viewport's bottom edge.
  const lastRowTop = range.windowTop + (rows - 1 - range.start) * ROW;
  assert.equal(lastRowTop + ROW - bottom, VIEW);
  assert.equal(computeScaledVirtualRange(rows, 0, VIEW, ROW).start, 0);
});

test('scaled scroll positions round-trip to content offsets', () => {
  const map = scaledScroll(5_000_000, ROW, VIEW);
  const offset = 2_500_000 * ROW;
  assert.ok(Math.abs(map.contentOffset(map.scrollTopFor(offset)) - offset) < 1e-6);
  assert.equal(map.contentOffset(MAX_SCROLL_HEIGHT * 2), 5_000_000 * ROW - VIEW);
});
