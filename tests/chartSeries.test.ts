import test from 'node:test';
import assert from 'node:assert/strict';
import type { SignalSeriesDto } from '../src/extension/editors/rawLogProtocol';
import { crossesSeriesGap, displaySeriesRange, interpolatedSeriesSample } from '../src/webview/shared/chartSeries';

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

test('hover interpolation follows the rendered line without extrapolating', () => {
  const item = series('V', [10, 30, 20], 10, 30);
  assert.deepEqual(interpolatedSeriesSample(item, 0.5, true), { timestamp: 0.5, value: 20, quality: 'valid' });
  assert.strictEqual(interpolatedSeriesSample(item, 1, true), item.samples[1]);
  assert.equal(interpolatedSeriesSample(item, -0.1, true), undefined);
  assert.equal(interpolatedSeriesSample(item, 2.1, true), undefined);
});

test('hover interpolation obeys the same missing-data connection setting as the graph', () => {
  const item: SignalSeriesDto = {
    ...series('V', [10, 99, 30], 10, 99),
    samples: [{ timestamp: 0, value: 10 }, { timestamp: 1, value: 99, quality: 'missing' }, { timestamp: 2, value: 30 }],
    gaps: [{ startTimestamp: 0.75, endTimestamp: 1.25 }],
  };
  assert.equal(interpolatedSeriesSample(item, 1, false), undefined);
  assert.deepEqual(interpolatedSeriesSample(item, 1, true), { timestamp: 1, value: 20, quality: 'valid' });
});
