import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemorySignalStore } from '../src/core/signal/signalStore';
import type { ManualDecodedSignal } from '../src/core/manual/manualDecoder';
import type { SignalDefinition } from '../src/core/signal/signal';
import { downsampleEven, nearestSample, normalizeValue, samplesInRange } from '../src/core/timeline/timeline';

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

test('bounded sampling preserves the true first and last items and exact hover uses original samples', () => {
  const samples = Array.from({ length: 10_001 }, (_, index) => ({ timestamp: index / 10, value: index }));
  const bounded = downsampleEven(samples, 4000);
  assert.equal(bounded.length, 4000);
  assert.strictEqual(bounded[0], samples[0]);
  assert.strictEqual(bounded.at(-1), samples.at(-1));
  assert.equal(nearestSample(samples, 123.44)?.timestamp, 123.4);
  assert.equal(samplesInRange(samples, { start: 100, end: 101 }).length, 11);
  assert.equal(samplesInRange(samples, { start: 2000, end: 3000 }).length, 0);
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
