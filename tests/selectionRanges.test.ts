import test from 'node:test';
import assert from 'node:assert/strict';
import { addSelectionRange, normalizeSelectionRanges, removeSelectionIndex, selectionContains, selectionCount } from '../src/webview/raw/selectionRanges';

test('RAW Log selection ranges merge, split and count unloaded rows', () => {
  let ranges = normalizeSelectionRanges([{ start: 9, end: 5 }, { start: 10, end: 12 }, { start: 20, end: 20 }]);
  assert.deepEqual(ranges, [{ start: 5, end: 12 }, { start: 20, end: 20 }]);
  ranges = removeSelectionIndex(ranges, 8);
  assert.deepEqual(ranges, [{ start: 5, end: 7 }, { start: 9, end: 12 }, { start: 20, end: 20 }]);
  ranges = addSelectionRange(ranges, 8);
  assert.deepEqual(ranges, [{ start: 5, end: 12 }, { start: 20, end: 20 }]);
  assert.equal(selectionCount(ranges), 9);
  assert.equal(selectionContains(ranges, 11), true);
  assert.equal(selectionContains(ranges, 13), false);
});
