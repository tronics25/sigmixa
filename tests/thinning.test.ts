import test from 'node:test';
import assert from 'node:assert/strict';
import { downsampleExtremes } from '../src/core/timeline/timeline';
import { InMemorySignalStore, lineBreakSamples } from '../src/core/signal/signalStore';
import { buildTrajectoryPoints } from '../src/core/trajectory/trajectory';
import type { SignalDefinition } from '../src/core/signal/signal';

const axis = (id: string): SignalDefinition => ({ id, name: id, unit: 'm', source: { type: 'manual-can', frameDefinitionId: 'pose' } });

test('thinning for drawing keeps a one-sample peak, the dips, the first and the last sample, unchanged', () => {
  const samples = Array.from({ length: 100_000 }, (_, index) => ({ timestamp: index / 1000, value: index === 54_321 ? 999 : index === 77_777 ? -5 : Math.sin(index / 5000) }));
  const thinned = downsampleExtremes(samples, 4000, (sample) => [sample.value]);
  assert.ok(thinned.length <= 4000);
  assert.ok(thinned.includes(samples[54_321]), 'the peak is kept');
  assert.ok(thinned.includes(samples[77_777]), 'the dip is kept');
  assert.equal(thinned[0], samples[0]); assert.equal(thinned.at(-1), samples.at(-1));
  for (let index = 1; index < thinned.length; index++) assert.ok(thinned[index].timestamp > thinned[index - 1].timestamp, 'in time order, no sample twice');
  // Even spacing could step over the peak: this is what it is kept against.
  assert.ok(samples.length > 4000);
});

test('a sample that breaks the line is kept when thinned', () => {
  const samples = Array.from({ length: 50_000 }, (_, index) => ({ timestamp: index, value: index === 30_001 ? Number.NaN : 1 }));
  const thinned = downsampleExtremes(samples, 2000, (sample) => [sample.value], (sample) => !Number.isFinite(sample.value));
  assert.ok(thinned.includes(samples[30_001]));
});

test('the axes of a trajectory are thinned together, so a peak on one axis keeps its point', () => {
  const store = new InMemorySignalStore(); const x = axis('x'); const y = axis('y'); store.registerDefinitions([x, y]);
  store.appendSeries(x, Array.from({ length: 100_000 }, (_, index) => ({ timestamp: index / 100, value: index / 100, quality: 'valid' as const })));
  store.appendSeries(y, Array.from({ length: 100_000 }, (_, index) => ({ timestamp: index / 100, value: index === 61_234 ? 500 : 0, quality: 'valid' as const })));
  const [xs, ys] = store.seriesSlice(['x', 'y'], undefined, 20_000, undefined, true);
  assert.deepEqual(xs.samples.map((sample) => sample.timestamp), ys.samples.map((sample) => sample.timestamp), 'the same times are kept on both axes');
  const points = buildTrajectoryPoints(xs.samples, ys.samples, undefined, { x: false, y: false, z: false }, 20_000);
  assert.ok(points.some((point) => point.y === 500), 'the peak is still a point of the trajectory');
  assert.ok(points.length > 1000);
});

test('thinning for drawing keeps both ends of a gap in reception, so the line on each side is still drawn', () => {
  const samples = [0, 1, 2, 3, 100, 101, 102, 103].map((timestamp) => ({ timestamp, value: 7, quality: 'valid' as const }));
  assert.deepEqual([...lineBreakSamples(samples)].map((sample) => sample.timestamp), [3, 100]);
  const store = new InMemorySignalStore(); const v = axis('v'); store.registerDefinitions([v]);
  store.appendSeries(v, Array.from({ length: 40_000 }, (_, index) => ({ timestamp: index < 20_000 ? index / 100 : 1000 + index / 100, value: 7, quality: 'valid' as const })));
  const [series] = store.seriesSlice(['v'], undefined, 1000);
  assert.ok(series.samples.some((sample) => sample.timestamp === 199.99) && series.samples.some((sample) => sample.timestamp === 1200), 'both ends of the gap are drawn');
});
