import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { computeVirtualRange } from '../src/webview/shared/virtualization';
import { autoFitColumns } from '../src/webview/shared/columnSizing';
import { ChunkedFrameStore } from '../src/core/frame/frameStore';
import type { CanFrame } from '../src/core/frame/canFrame';
import { decodeManualFrame } from '../src/core/manual/manualDecoder';
import type { ManualFrameDefinition } from '../src/core/manual/manualDefinition';
import { downsampleEven, nearestSample } from '../src/core/timeline/timeline';
import { PluginHost, PluginRegistry } from '../src/core/plugin/pluginHost';
import { CsvRowParser, ExternalCsvCollector } from '../src/core/external/csv';
import { buildTrajectoryPoints } from '../src/core/trajectory/trajectory';

test('100k-frame paging smoke remains bounded and viewport DOM range stays small', { timeout: 10_000 }, () => {
  const store = new ChunkedFrameStore(); const batch: CanFrame[] = [];
  const started = performance.now();
  for (let index = 0; index < 100_000; index++) batch.push({ id: `p:${index}`, sourceId: 'p', timestamp: index / 1000, canId: index % 2048, extended: false, direction: 'Rx', channel: 1, dlcCode: 8, dataLength: 8, data: new Uint8Array(8) });
  store.append(batch);
  const page = store.query({ offset: 50_000, limit: 240 });
  const range = computeVirtualRange(page.total, 50_000 * 28, 900, 28, 8);
  assert.equal(page.rows.length, 240); assert.ok(range.end - range.start < 60); assert.ok(performance.now() - started < 5000);
});

test('column auto fit clamps measured content to stable limits', () => {
  const result = autoFitColumns([{ id: 'content', label: 'CONTENT', minWidth: 100, maxWidth: 300, value: (row: string) => row }], ['x'.repeat(1000)], (text) => text.length * 8);
  assert.equal(result.content, 300);
});

test('100k-frame manual decode smoke stays within the regression guard', { timeout: 10_000 }, () => {
  const definition: ManualFrameDefinition = { id: 'f', canId: 0x123, extended: false, name: 'Frame', frameLength: 8, signals: [
    { id: 'a', name: 'A', unit: 'V', byteOffset: 0, bitOffset: 0, lengthBits: 16, signedness: 'signed', byteOrder: 'little', conversion: { type: 'scale-offset', lsb: 1 / 128, lsbText: '1/128', offset: 0 } },
    { id: 'b', name: 'B', unit: '', byteOffset: 2, bitOffset: 4, lengthBits: 12, signedness: 'unsigned', byteOrder: 'big', conversion: { type: 'scale-offset', lsb: 1, lsbText: '1', offset: 0 } },
  ], derivedSignals: [
    { id: 'sum', name: 'Sum', unit: '', operation: { type: 'expression', expression: '[A] + [B]' } },
    { id: 'limited', name: 'Limited', unit: '', operation: { type: 'expression', expression: 'clamp([Sum], -100, 100)' } },
  ] };
  const input: CanFrame = { id: 'p:0', sourceId: 'p', timestamp: 0, canId: 0x123, extended: false, direction: 'Rx', channel: 1, dlcCode: 8, dataLength: 8, data: Uint8Array.from([1,2,3,4,5,6,7,8]) };
  const started = performance.now(); let samples = 0;
  for (let index = 0; index < 100_000; index++) samples += decodeManualFrame({ ...input, id: `p:${index}`, timestamp: index / 1000 }, definition).decoded.length;
  assert.equal(samples, 400_000); assert.ok(performance.now() - started < 5000);
});

test('100k-frame Plugin Host smoke stays bounded at the Host boundary', { timeout: 10_000 }, () => {
  const registry = new PluginRegistry();
  registry.register({ id: 'performance', version: '1', getSupportedFrames: () => ({ type: 'any' }), processFrame: (frame) => ({ status: 'handled', samples: [{ signalId: 'byte', name: 'Byte', value: frame.data[0] }] }) });
  const host = new PluginHost(
    registry,
    [{ id: 'definition', canId: 0x123, extended: false }],
    [{ id: 'performance', version: '1', source: 'memory', enabled: true }],
    [{ id: 'binding', pluginId: 'performance', frameId: 'definition', enabled: true, automatic: false }]
  );
  const input: CanFrame = { id: 'p:0', sourceId: 'p', timestamp: 0, canId: 0x123, extended: false, direction: 'Rx', channel: 1, dlcCode: 8, dataLength: 8, data: Uint8Array.from([1,2,3,4,5,6,7,8]) };
  const started = performance.now(); let samples = 0;
  for (let index = 0; index < 100_000; index++) samples += host.processFrame({ ...input, id: `p:${index}`, timestamp: index / 1000 }).decoded.length;
  assert.equal(samples, 100_000); assert.ok(performance.now() - started < 5000);
});

test('million-point time-series reduction remains bounded without losing endpoints or hover precision', { timeout: 10_000 }, () => {
  const samples = Array.from({ length: 1_000_000 }, (_, index) => ({ timestamp: index / 1000, value: Math.sin(index / 1000) }));
  const started = performance.now();
  const rendered = downsampleEven(samples, 4000);
  const hovered = nearestSample(samples, 543.2104);
  assert.equal(rendered.length, 4000);
  assert.strictEqual(rendered[0], samples[0]); assert.strictEqual(rendered.at(-1), samples.at(-1));
  assert.equal(hovered?.timestamp, 543.21);
  assert.ok(performance.now() - started < 1000);
});

test('100k-row External CSV incremental import smoke stays bounded', { timeout: 10_000 }, () => {
  const parser = new CsvRowParser();
  const collector = new ExternalCsvCollector({
    id: 'perf', path: 'perf.csv', fileName: 'perf.csv', timestampColumn: 'Time_us', timestampUnit: 'microseconds',
    valueColumns: [{ column: 'A', name: 'A' }, { column: 'B', name: 'B' }],
  });
  const started = performance.now(); collector.accept(parser.push('Time_us,A,B\n'));
  for (let batch = 0; batch < 100; batch++) {
    let chunk = '';
    for (let row = 0; row < 1000; row++) { const index = batch * 1000 + row; chunk += `${5_000_000 + index * 1000},${index},${index * 2}\n`; }
    collector.accept(parser.push(chunk));
  }
  collector.accept(parser.push('', true)); const result = collector.finish();
  assert.equal(result.rowsRead, 100_000); assert.equal(result.series[0].samples.length, 100_000);
  assert.equal(result.series[0].samples[0].timestamp, 5); assert.ok(performance.now() - started < 5000);
});

test('million-sample synchronized Trajectory remains bounded and retains full-period endpoints', { timeout: 10_000 }, () => {
  const x = Array.from({ length: 1_000_000 }, (_, index) => ({ timestamp: index / 1000, value: Math.sin(index / 1000) }));
  const y = x.map((sample) => ({ timestamp: sample.timestamp, value: Math.cos(sample.timestamp) }));
  const started = performance.now();
  const points = buildTrajectoryPoints(x, y, undefined, { x: false, y: false, z: false }, 4000);
  assert.equal(points.length, 4000); assert.equal(points[0].timestamp, 0); assert.equal(points.at(-1)!.timestamp, 999.999);
  assert.ok(performance.now() - started < 2000);
});
