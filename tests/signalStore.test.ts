import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemorySignalStore } from '../src/core/signal/signalStore';
import type { ManualDecodedSignal } from '../src/core/manual/manualDecoder';
import type { SignalDefinition } from '../src/core/signal/signal';
import { downsampleEven, nearestSample, normalizeValue, samplesInRange, samplesInRangeWithContext } from '../src/core/timeline/timeline';

const speed: SignalDefinition = { id: 'frame-a:speed', name: 'Value', unit: 'km/h', source: { type: 'manual-can', frameDefinitionId: 'frame-a' } };
const temperature: SignalDefinition = { id: 'frame-b:temperature', name: 'Value', unit: '°C', source: { type: 'manual-can', frameDefinitionId: 'frame-b' } };

function decoded(definition: SignalDefinition, timestamp: number, value: number): ManualDecodedSignal {
  return {
    definition,
    sample: { timestamp, value, quality: 'valid' },
    raw: BigInt(value),
    signal: { id: definition.id, name: definition.name, unit: definition.unit ?? '', byteOffset: 0, bitOffset: 0, lengthBits: 8, signedness: 'unsigned', byteOrder: 'little', conversion: { type: 'scale-offset', lsb: 1, lsbText: '1', offset: 0 } },
  };
}

test('Signal Store keeps same-name Signals distinct by stable ID and preserves independent timestamps', () => {
  const store = new InMemorySignalStore(); store.registerDefinitions([speed, temperature]);
  store.appendFrame('a:0', 0, [decoded(speed, 0, 10)]);
  store.appendFrame('b:0', 0.25, [decoded(temperature, 0.25, 20)]);
  store.appendFrame('a:1', 1, [decoded(speed, 1, 30)]);
  store.finalize();

  const series = store.seriesSlice([speed.id, temperature.id], undefined, 4000);
  assert.deepEqual(series[0].samples.map((sample) => sample.timestamp), [0, 1]);
  assert.deepEqual(series[1].samples.map((sample) => sample.timestamp), [0.25]);
  assert.equal(series[0].definition.name, series[1].definition.name);
  assert.notEqual(series[0].definition.id, series[1].definition.id);
});

test('Signal Table creates event rows only and never forward-fills unrelated Signals', () => {
  const store = new InMemorySignalStore(); store.registerDefinitions([speed, temperature]);
  store.appendFrame('a:0', 0, [decoded(speed, 0, 10)]);
  store.appendFrame('b:0', 0.5, [decoded(temperature, 0.5, 22)]);
  store.appendFrame('ab:0', 1, [decoded(speed, 1, 12), decoded(temperature, 1, 23)]);
  const page = store.tablePage([speed.id, temperature.id], 0, 100);

  assert.equal(page.total, 3);
  assert.equal(page.rows[0].values.get(speed.id)?.value, 10);
  assert.equal(page.rows[0].values.has(temperature.id), false);
  assert.equal(page.rows[1].values.has(speed.id), false);
  assert.equal(page.rows[2].values.size, 2);
});

test('Signal Table Clip range excludes rows outside its Timestamp boundaries', () => {
  const store = new InMemorySignalStore(); store.registerDefinitions([speed]);
  store.appendFrame('a:0', 0, [decoded(speed, 0, 10)]); store.appendFrame('a:1', 1, [decoded(speed, 1, 20)]); store.appendFrame('a:2', 2, [decoded(speed, 2, 30)]);
  assert.deepEqual(store.tablePage([speed.id], 0, 100, { start: 0.5, end: 1.5 }).rows.map((row) => row.timestamp), [1]);
});

test('active Signal Table Clip cache rejects later frames outside its range', () => {
  const store = new InMemorySignalStore(); store.registerDefinitions([speed]);
  store.appendFrame('a:1', 1, [decoded(speed, 1, 20)]);
  assert.equal(store.tablePage([speed.id], 0, 100, { start: 0.5, end: 1.5 }).total, 1);
  store.appendFrame('a:2', 2, [decoded(speed, 2, 30)]);
  store.appendFrame('a:1.25', 1.25, [decoded(speed, 1.25, 25)]);
  assert.deepEqual(store.tablePage([speed.id], 0, 100, { start: 0.5, end: 1.5 }).rows.map((row) => row.timestamp), [1, 1.25]);
});

test('Clip range also bounds nearest values and exported event rows', () => {
  const store = new InMemorySignalStore(); store.registerDefinitions([speed]);
  store.appendFrame('a:0', 0, [decoded(speed, 0, 10)]); store.appendFrame('a:1', 1, [decoded(speed, 1, 20)]); store.appendFrame('a:2', 2, [decoded(speed, 2, 30)]);
  assert.equal(store.nearest([speed.id], 0, { start: 0.5, end: 1.5 })[0]?.sample.timestamp, 1);
  assert.deepEqual([...store.eventRows([speed.id], { start: 0.5, end: 1.5 })].map((row) => row.timestamp), [1]);
});

test('a Clip gets the nearest sample outside each edge as a separate carried sample', () => {
  const store = new InMemorySignalStore(); store.registerDefinitions([speed]);
  for (let index = 0; index < 6; index++) store.appendFrame(`a:${index}`, index, [decoded(speed, index, index * 10)]);
  const clip = { start: 1.5, end: 4.5 };
  // A viewport in a whole file keeps one real neighbour on each side.
  assert.deepEqual(store.seriesSlice([speed.id], clip, 100)[0].samples.map((sample) => sample.timestamp), [1, 2, 3, 4, 5]);
  // A Clip: the nearest sample outside each edge keeps its own time and value (so the slopes at the edges are true) and is marked carried.
  const clipped = store.seriesSlice([speed.id], clip, 100, clip)[0];
  assert.deepEqual(clipped.samples.map((sample) => [sample.timestamp, sample.value, sample.carried === true]), [[1, 10, true], [2, 20, false], [3, 30, false], [4, 40, false], [5, 50, true]]);
  assert.equal(clipped.totalSamplesInRange, 3);
  // Zooming inside the Clip keeps edge context, still without leaving the Clip.
  assert.deepEqual(store.seriesSlice([speed.id], { start: 2.5, end: 3.5 }, 100, clip)[0].samples.map((sample) => sample.timestamp), [2, 3, 4]);
  // A Clip that starts exactly on a sample, or before any sample, has no carried value.
  // A Clip whose edges fall exactly on samples has no carried samples.
  assert.deepEqual(store.seriesSlice([speed.id], { start: 2, end: 4 }, 100, { start: 2, end: 4 })[0].samples.map((sample) => [sample.timestamp, sample.carried === true]), [[2, false], [3, false], [4, false]]);
  assert.deepEqual(store.seriesSlice([speed.id], { start: -1, end: 1 }, 100, { start: -1, end: 1 })[0].samples.map((sample) => sample.timestamp), [0, 1]);
});

test('bounded sampling preserves the true first and last items and exact hover uses original samples', () => {
  const samples = Array.from({ length: 10_001 }, (_, index) => ({ timestamp: index / 10, value: index }));
  const bounded = downsampleEven(samples, 4000);
  assert.equal(bounded.length, 4000);
  assert.strictEqual(bounded[0], samples[0]);
  assert.strictEqual(bounded.at(-1), samples.at(-1));
  assert.equal(nearestSample(samples, 123.44)?.timestamp, 123.4);
  assert.equal(samplesInRange(samples, { start: 100, end: 101 }).length, 11);
  assert.equal(samplesInRange(samples, { start: 2000, end: 3000 }).length, 0);
  assert.deepEqual(samplesInRangeWithContext(samples, { start: 100, end: 101 }).map((sample) => sample.timestamp), [99.9, ...samples.slice(1000, 1011).map((sample) => sample.timestamp), 101.1]);
});

test('viewport series retains adjacent samples while reporting only samples inside the range', () => {
  const store = new InMemorySignalStore(); store.registerDefinitions([speed]);
  for (let timestamp = 0; timestamp <= 4; timestamp++) store.appendFrame(`a:${timestamp}`, timestamp, [decoded(speed, timestamp, timestamp * 10)]);
  const [series] = store.seriesSlice([speed.id], { start: 1.25, end: 2.75 }, 100);
  assert.equal(series.totalSamplesInRange, 1);
  assert.deepEqual(series.samples.map((sample) => sample.timestamp), [1, 2, 3]);
});

test('normalization uses global extrema and handles constant and invalid series', () => {
  assert.equal(normalizeValue(15, 10, 20), 50);
  assert.equal(normalizeValue(4, 4, 4), 50);
  assert.ok(Number.isNaN(normalizeValue(Number.NaN, 0, 1)));
});

test('Signal events retain source-neutral interval semantics', () => {
  const store = new InMemorySignalStore(); store.registerDefinitions([speed]);
  store.appendFrame('a:0', 0, [decoded(speed, 0, 1)]); store.appendFrame('a:1', 2, [decoded(speed, 2, 2)]);
  store.appendEvents(speed.id, [{ timestamp: 0.5, endTimestamp: 1.5, kind: 'threshold', severity: 'warning', label: 'High' }]);
  const [series] = store.seriesSlice([speed.id], { start: 0, end: 1 }, 100);
  assert.deepEqual(series.events, [{ timestamp: 0.5, endTimestamp: 1.5, kind: 'threshold', severity: 'warning', label: 'High' }]);
});

test('Signal series identifies real gaps before display downsampling', () => {
  const store = new InMemorySignalStore(); store.registerDefinitions([speed]);
  for (let index = 0; index < 100; index++) store.appendFrame(`a:${index}`, index * 0.01, [decoded(speed, index * 0.01, index)]);
  for (let index = 0; index < 100; index++) store.appendFrame(`b:${index}`, 2 + index * 0.01, [decoded(speed, 2 + index * 0.01, index)]);
  const [series] = store.seriesSlice([speed.id], undefined, 12);
  assert.ok(series.samples.length <= 12);
  assert.deepEqual(series.gaps, [{ startTimestamp: 0.99, endTimestamp: 2 }]);
});

test('Signal series treats missing-quality samples as a gap boundary', () => {
  const store = new InMemorySignalStore(); store.registerDefinitions([speed]);
  store.appendSeries(speed, [
    { timestamp: 0, value: 1, quality: 'valid' },
    { timestamp: 1, value: 2, quality: 'missing' },
    { timestamp: 2, value: 3, quality: 'valid' },
  ]);
  const [series] = store.seriesSlice([speed.id], undefined, 10);
  assert.deepEqual(series.gaps, [{ startTimestamp: 0, endTimestamp: 2 }]);
  assert.equal(series.globalMinimum, 1);
  assert.equal(series.globalMaximum, 3);
});

test('incremental replacement preserves unrelated Signals and merges the same Frame row', () => {
  const store = new InMemorySignalStore(); store.registerDefinitions([speed, temperature]);
  store.appendFrame('shared', 1, [decoded(speed, 1, 10), decoded(temperature, 1, 20)]);
  const replacement = new InMemorySignalStore(); const updatedSpeed = { ...speed, name: 'Updated speed' };
  replacement.registerDefinitions([updatedSpeed]); replacement.appendFrame('shared', 1, [decoded(updatedSpeed, 1, 99)]); replacement.finalize();
  store.replaceDefinitions((definition) => definition.source.type === 'manual-can' && definition.source.frameDefinitionId === 'frame-a', replacement);
  const page = store.tablePage([speed.id, temperature.id], 0, 10);
  assert.equal(page.total, 1);
  assert.equal(page.rows[0].values.get(speed.id)?.value, 99);
  assert.equal(page.rows[0].values.get(temperature.id)?.value, 20);
  assert.equal(store.catalog().find((definition) => definition.id === speed.id)?.name, 'Updated speed');
});

test('measuredSignalIds lists only the Signals that have samples', () => {
  const store = new InMemorySignalStore(); store.registerDefinitions([speed, temperature]);
  store.appendFrame('a:0', 0, [decoded(speed, 0, 10)]); store.finalize();
  assert.deepEqual(store.measuredSignalIds(), [speed.id]); assert.equal(store.catalog().length, 2, 'the catalog still has every definition');
});
