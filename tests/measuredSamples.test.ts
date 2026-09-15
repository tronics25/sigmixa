import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { nearestMeasuredSample } from '../src/core/timeline/timeline';
import { InMemorySignalStore } from '../src/core/signal/signalStore';
import { MeasuredSamples, measuredValueLabel, nearestMeasuredTimestamp, type MeasuredSampleQuery } from '../src/webview/shared/measuredSamples';
import type { SignalDefinition } from '../src/core/signal/signal';
import type { MeasuredSignalDto } from '../src/extension/editors/rawLogProtocol';

const definition: SignalDefinition = { id: 'speed', name: 'Speed', unit: 'km/h', source: { type: 'manual-can', frameDefinitionId: 'frame' } };
const query = (slot: string, timestamp: number, sourceId?: string): MeasuredSampleQuery => ({ slot, timestamp, sourceId, signalIds: ['speed'] });
const result = (timestamp: number, value: number): MeasuredSignalDto[] => [{ signalId: 'speed', sample: { timestamp, value, quality: 'valid' } }];

test('measured lookup selects an original sample, uses earlier ties, and never interpolates or extrapolates', () => {
  const samples = [{ timestamp: 1, value: 10 }, { timestamp: 2, value: 40 }];
  assert.strictEqual(nearestMeasuredSample(samples, 1.5), samples[0]);
  assert.strictEqual(nearestMeasuredSample(samples, 1.6), samples[1]);
  assert.equal(nearestMeasuredSample(samples, 0.9), undefined);
  assert.equal(nearestMeasuredSample(samples, 2.1), undefined);
  assert.equal(nearestMeasuredSample(samples, NaN), undefined);
  assert.equal(nearestMeasuredSample([], 1), undefined);
});

test('invalid or missing measured samples are not replaced by nearby valid values', () => {
  for (const quality of ['invalid', 'missing'] as const) {
    const samples = [{ timestamp: 0, value: 10 }, { timestamp: 1, value: 20, quality }, { timestamp: 2, value: 30 }];
    assert.equal(nearestMeasuredSample(samples, 1), undefined);
    assert.equal(nearestMeasuredSample(samples, 1.1), undefined);
  }
  assert.equal(nearestMeasuredSample([{ timestamp: 1, value: NaN }], 1), undefined);
});

test('measured Signal Store retains peaks omitted from the rendered series and bounds Clip lookup', () => {
  const store = new InMemorySignalStore();
  const samples = Array.from({ length: 10_001 }, (_, i) => ({ timestamp: i / 100, value: i === 1234 ? 999 : 10, quality: 'valid' as const }));
  store.appendSeries(definition, samples);
  assert.ok(!store.seriesSlice(['speed'], undefined, 2)[0].samples.some((sample) => sample.value === 999));
  assert.deepEqual(store.measured(['speed', 'speed', 'unknown'], 12.344), result(12.34, 999));
  assert.deepEqual(store.measured(['speed'], 12.34, { start: 13, end: 14 }), []);
  assert.deepEqual(store.measured(['speed'], 13.004, { start: 13, end: 14 }), result(13, 10));
});

test('cursor requests are coalesced, stale replies never display, and cache follows the current query', () => {
  const sent: { id: number; query: MeasuredSampleQuery }[] = [];
  const lookup = new MeasuredSamples((id, query) => sent.push({ id, query }), () => {});
  lookup.update([query('hover', 1)]);
  for (let i = 2; i <= 1000; i++) lookup.update([query('hover', i)]);
  assert.equal(sent.length, 1);
  lookup.receive(sent[0].id, result(1, 10));
  assert.equal(lookup.sample('hover', 'speed'), undefined);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].query.timestamp, 1000);
  lookup.receive(sent[1].id, result(1000, 40));
  assert.equal(lookup.sample('hover', 'speed')?.value, 40);
  lookup.update([query('hover', 1000)]);
  assert.equal(sent.length, 2);
  lookup.update([]);
  assert.equal(lookup.sample('hover', 'speed'), undefined);
});

test('fixed markers take priority and become exportable only after measured responses arrive', () => {
  const sent: { id: number; query: MeasuredSampleQuery }[] = [];
  const lookup = new MeasuredSamples((id, query) => sent.push({ id, query }), () => {});
  lookup.update([query('hover', 1)]);
  lookup.update([query('hover', 2), query('marker:a', 1.5), query('marker:b', 2.5)]);
  assert.equal(lookup.pendingMarkers(), true);
  lookup.receive(sent[0].id, result(1, 10));
  assert.equal(sent[1].query.slot, 'marker:a');
  lookup.receive(sent[1].id, result(1, 10));
  assert.equal(sent[2].query.slot, 'marker:b');
  lookup.receive(sent[2].id, result(2, 40));
  assert.equal(lookup.pendingMarkers(), false);
  assert.equal(sent[3].query.slot, 'hover');
  assert.equal(lookup.sample('marker:a', 'speed')?.value, 10);
  assert.equal(lookup.sample('marker:b', 'speed')?.value, 40);
});

test('comparison lookup separates files and refetches on alignment or data changes', () => {
  const sent: { id: number; query: MeasuredSampleQuery }[] = [];
  const lookup = new MeasuredSamples((id, query) => sent.push({ id, query }), () => {});
  lookup.update([query('marker:a:clip1', 10, 'clip1'), query('marker:a:clip2', 20, 'clip2')]);
  lookup.receive(sent[0].id, result(10, 11));
  lookup.receive(sent[1].id, result(20, 22));
  assert.equal(lookup.sample('marker:a:clip1', 'speed')?.value, 11);
  assert.equal(lookup.sample('marker:a:clip2', 'speed')?.value, 22);
  lookup.update([query('marker:a:clip1', 10.1, 'clip1'), query('marker:a:clip2', 20, 'clip2')]);
  assert.equal(lookup.sample('marker:a:clip1', 'speed'), undefined);
  lookup.invalidate();
  lookup.receive(sent[2].id, result(10.1, 33));
  assert.equal(lookup.sample('marker:a:clip1', 'speed'), undefined);
  lookup.receive(sent[3].id, result(10.1, 44));
  assert.equal(lookup.sample('marker:a:clip1', 'speed')?.value, 44);
});

test('sample labels omit matching times and show only compact signed time offsets', () => {
  assert.equal(measuredValueLabel('40 km/h', 1.25, 1.25), '40 km/h');
  assert.equal(measuredValueLabel('40 km/h', 1.247, 1.25), '40 km/h @-3ms');
  assert.equal(measuredValueLabel('40 km/h', 1.253, 1.25), '40 km/h @+3ms');
  assert.equal(measuredValueLabel('40 km/h', 1.25, 1.3), '40 km/h @-50ms');
  assert.equal(measuredValueLabel('40 km/h', -0.25, -0.3), '40 km/h @+50ms');
  assert.equal(measuredValueLabel('40 km/h', 1.2501, 1.25), '40 km/h @+100µs');
  assert.equal(measuredValueLabel('40 km/h', 1.2500001, 1.25), '40 km/h @+100ns');
  assert.equal(measuredValueLabel('40 km/h', 3.25, 1.25), '40 km/h @+2s');
  assert.equal(measuredValueLabel('40 km/h', 1.25 + 1e-12, 1.25), '40 km/h');
});

test('reference lines snap to the nearest original measurement with stable earlier ties', () => {
  assert.equal(nearestMeasuredTimestamp(1.55, [1, 1.5, 2]), 1.5);
  assert.equal(nearestMeasuredTimestamp(1.5, [2, 1]), 1);
  assert.equal(nearestMeasuredTimestamp(1.55, []), undefined);
  assert.equal(nearestMeasuredTimestamp(NaN, [1, 2]), undefined);
  const sent: number[] = [];
  const lookup = new MeasuredSamples((id) => sent.push(id), () => {});
  lookup.update([query('hover', 1.55)]);
  assert.equal(lookup.referenceTimestamp('hover'), undefined);
  lookup.receive(sent[0], result(1.5, 99));
  assert.equal(lookup.referenceTimestamp('hover'), 1.5);
  lookup.update([query('hover', 1.56)]);
  assert.equal(lookup.referenceTimestamp('hover'), undefined);
});

test('million-sample measured lookup stays responsive with a one-sample-per-Signal response', () => {
  const store = new InMemorySignalStore();
  store.appendSeries(definition, Array.from({ length: 1_000_000 }, (_, i) => ({ timestamp: i / 1000, value: i })));
  const start = performance.now();
  for (let i = 0; i < 1000; i++) {
    const samples = store.measured(['speed'], (500_000 + i) / 1000 + 0.0001);
    assert.equal(samples.length, 1);
    assert.equal(samples[0].sample.value, 500_000 + i);
  }
  assert.ok(performance.now() - start < 1000);
});
