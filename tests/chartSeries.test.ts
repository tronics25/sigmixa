import test from 'node:test';
import assert from 'node:assert/strict';
import type { SignalSeriesDto } from '../src/extension/editors/rawLogProtocol';
import { crossesSeriesGap, displaySeriesRange, renderedSeriesValueAt } from '../src/webview/shared/chartSeries';

function series(unit: string, values: readonly number[], globalMinimum: number, globalMaximum: number): SignalSeriesDto {
  return {
    definition: { id: unit, name: unit, unit, source: { type: 'calculated', calculationId: unit } },
    samples: values.map((value, timestamp) => ({ timestamp, value, quality: 'valid' })), events: [], totalSamplesInRange: values.length, globalMinimum, globalMaximum, gaps: [],
  };
}

test('chart Y-axis range supports visible, whole-file, manual, zero and unit conversion', () => {
  const item = series('mm', [1000, 2500], -500, 10_000);
  assert.deepEqual(displaySeriesRange([item], { mode: 'visible' }), { minimum: 1, maximum: 2.5 });
  assert.deepEqual(displaySeriesRange([item], { mode: 'visible' }, undefined, 'mm'), { minimum: 1000, maximum: 2500 });
  assert.deepEqual(displaySeriesRange([item], { mode: 'global' }), { minimum: -0.5, maximum: 10 });
  assert.deepEqual(displaySeriesRange([item], { mode: 'manual', minimum: 1.25, maximum: 4.5 }), { minimum: 1.25, maximum: 4.5 });
  assert.deepEqual(displaySeriesRange([item], { mode: 'manual', minimum: 1.25, maximum: 4.5, includeZero: true }), { minimum: 0, maximum: 4.5 });
});

test('visible Y-axis range ignores boundary context samples outside the viewport', () => {
  const item = series('V', [100, 10, 20, 200], 10, 200);
  assert.deepEqual(displaySeriesRange([item], { mode: 'visible' }, { start: 1, end: 2 }), { minimum: 10, maximum: 20 });
  assert.deepEqual(displaySeriesRange([item], { mode: 'visible' }, { start: 4, end: 5 }), { minimum: 10, maximum: 200 });
});

test('chart gap lookup finds only segments that cross a reported discontinuity', () => {
  const gaps = [{ startTimestamp: 2, endTimestamp: 5 }, { startTimestamp: 8, endTimestamp: 9 }];
  assert.equal(crossesSeriesGap(gaps, 1, 3), true);
  assert.equal(crossesSeriesGap(gaps, 5, 7), false);
  assert.equal(crossesSeriesGap(gaps, 7, 10), true);
});

test('hover value follows the rendered line and respects visible gaps', () => {
  const item = series('V', [10, 20, 40], 10, 40);
  assert.equal(renderedSeriesValueAt(item, 1.5, true), 30);
  assert.equal(renderedSeriesValueAt(item, -1, true), undefined);
  const withGap = { ...item, gaps: [{ startTimestamp: 1, endTimestamp: 2 }] };
  assert.equal(renderedSeriesValueAt(withGap, 1.5, false), undefined);
  assert.equal(renderedSeriesValueAt(withGap, 1.5, true), 30);
});
