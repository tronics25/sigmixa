import test from 'node:test';
import assert from 'node:assert/strict';
import { TraceIndex } from '../src/core/frame/traceIndex';
import type { CanFrame } from '../src/core/frame/canFrame';
import { createManualDecodeContext, decodeManualFrame } from '../src/core/manual/manualDecoder';
import type { ManualFrameDefinition } from '../src/core/manual/manualDefinition';
const frame = (id: string, timestamp: number, mux = 0, channel = 1, direction: 'Rx' | 'Tx' = 'Rx'): CanFrame => ({ id, sourceId: 'a', timestamp, channel, direction, canId: 0x123, extended: false, dlcCode: 2, dataLength: 2, data: new Uint8Array([mux, timestamp * 10]) });
test('Signal histories retain each MUX value without future lookups, including backwards seeks and Clip boundaries', () => {
  const definition: ManualFrameDefinition = { id: 'f', canId: 0x123, extended: false, name: 'Mux', frameLength: 2, multiplexing: true, signals: [
    { id: 'mux', name: 'mux', unit: '', byteOffset: 0, bitOffset: 0, lengthBits: 8, byteOrder: 'little', signedness: 'unsigned', conversion: { type: 'scale-offset', lsb: 1, lsbText: '1', offset: 0 }, multiplexing: { type: 'multiplexer' } },
    ...[0, 1].map((mux) => ({ id: `s${mux}`, name: `s${mux}`, unit: 'm/s', byteOffset: 1, bitOffset: 0, lengthBits: 8, byteOrder: 'little' as const, signedness: 'unsigned' as const, conversion: { type: 'scale-offset' as const, lsb: 1, lsbText: '1', offset: 0 }, multiplexing: { type: 'conditional' as const, ranges: [{ from: mux, to: mux }] } })),
  ] };
  const context = createManualDecodeContext();
  const frames = [frame('a', 1, 0), frame('b', 2, 1), frame('c', 3, 0)];
  const index = new TraceIndex(frames, (value) => decodeManualFrame(value, definition, context).decoded.map((item) => ({ signalId: item.definition.id, sample: item.sample })));
  const at2 = index.at(2.5)[0]; assert.equal(at2.count, 2); assert.equal(at2.intervalMs, 1000); assert.equal(at2.signals.get('s0')?.value, 10); assert.equal(at2.signals.get('s0')?.timestamp, 1); assert.equal(at2.signals.get('s1')?.value, 20);
  assert.equal(index.at(1.5)[0].signals.get('s1'), undefined); assert.equal(index.at(.5)[0].frame, undefined); assert.equal(index.at(.5)[0].count, 0);
  const scoped = index.at(2.5, 2, 3)[0]; assert.equal(scoped.count, 1); assert.equal(scoped.intervalMs, undefined); assert.equal(scoped.signals.get('s0')?.value, 10); assert.equal(scoped.signals.get('s0')?.timestamp, 1); assert.equal(scoped.signals.get('s0')?.carried, true); assert.equal(scoped.signals.get('s1')?.carried, undefined);
  assert.equal(index.at(3)[0].signals.get('s0')?.value, 30);
  // The Trace head is just before the first frame: nothing is received yet, in a file and in a Clip.
  assert.equal(index.at(1 - 1e-9)[0].count, 0); assert.equal(index.at(1)[0].count, 1);
  assert.equal(index.at(2 - 1e-9, 2, 3)[0].count, 0); assert.equal(index.at(2 - 1e-9, 2, 3)[0].frame, undefined); assert.equal(index.at(3, 2, 3)[0].count, 2);
  // At the head of a Clip nothing is received yet, but the values from before it are shown, marked as carried, with their own times.
  const head = index.at(2 - 1e-9, 2, 3); const s0AtHead = head.map((item) => item.signals.get('s0')).find(Boolean);
  assert.deepEqual([s0AtHead?.value, s0AtHead?.timestamp, s0AtHead?.carried], [10, 1, true]);
  // Once the Clip receives the Signal itself, the value is no longer carried.
  const later = index.at(3, 2, 3).map((item) => item.signals.get('s0')).find(Boolean);
  assert.deepEqual([later?.value, later?.timestamp, later?.carried], [30, 3, undefined]);
});
test('Trace separates source, CAN format, channel and direction and counts equal timestamps', () => {
  const frames = [frame('a', 1), frame('b', 1), frame('c', 2, 0, 2), frame('d', 2, 0, 1, 'Tx'), { ...frame('e', 2), extended: true }, { ...frame('f', 2), sourceId: 'b' }];
  const index = new TraceIndex(frames, (value) => [{ signalId: 's', sample: { timestamp: value.timestamp, value: value.channel * 10 } }]);
  const values = index.at(1); assert.equal(values.length, 5); assert.equal(values[0].count, 2); assert.equal(values[0].intervalMs, 0); assert.equal(values[1].count, 0); assert.equal(values[1].signals.get('s'), undefined);
  assert.equal(index.at(2)[1].signals.get('s')?.value, 20);
  const keys = index.at(2).map((item) => item.key); assert.equal(new Set(keys).size, keys.length);
});

test('MUX partitions own receive timestamps, payloads, intervals and common values, including clip boundaries', () => {
  const frames = [frame('a', 1, 0), frame('b', 2, 1), frame('c', 3, 0), frame('d', 4, 1), frame('e', 5, 0, 2)];
  const index = new TraceIndex(frames, (value) => [{ signalId: 'common', sample: { timestamp: value.timestamp, value: value.data[1] } }], (value) => ({ name: 'Mode', value: value.data[0] }));
  const rows = index.at(3.5); assert.equal(rows.length, 3);
  assert.equal(rows[0].key, 'a:s:291:1:Rx:mux:0'); assert.equal(rows[0].count, 2); assert.equal(rows[0].intervalMs, 2000); assert.equal(rows[0].frame?.timestamp, 3); assert.equal(rows[0].signals.get('common')?.value, 30);
  assert.equal(rows[1].key, 'a:s:291:1:Rx:mux:1'); assert.equal(rows[1].count, 1); assert.equal(rows[1].intervalMs, undefined); assert.equal(rows[1].frame?.timestamp, 2); assert.equal(rows[1].signals.get('common')?.value, 20); assert.deepEqual(rows[1].frame?.data, new Uint8Array([1, 20]));
  assert.equal(rows[2].count, 0); assert.equal(rows[2].frame, undefined);
  assert.equal(index.at(1.5)[1].count, 0); assert.equal(index.at(1.5)[1].signals.get('common'), undefined);
  const aggregate = index.at(3.5, -Infinity, Infinity, false); assert.equal(aggregate.length, 2); assert.equal(aggregate[0].key, 'a:s:291:1:Rx'); assert.equal(aggregate[0].count, 3); assert.equal(aggregate[0].intervalMs, 1000); assert.equal(aggregate[0].multiplexer, undefined);
  const clip = index.at(3.5, 2, 4); assert.equal(clip[0].count, 1); assert.equal(clip[0].intervalMs, undefined); assert.equal(clip[1].frame?.timestamp, 2);
});

test('Trace reports interval extremes and the last payload change up to the seek time', () => {
  const at = (id: string, timestamp: number, byte: number): CanFrame => ({ ...frame(id, timestamp), data: new Uint8Array([byte, 0]) });
  const frames = [at('a', 0, 1), at('b', 0.1, 1), at('c', 0.35, 2), at('d', 0.4, 2), at('e', 1, 2)];
  const index = new TraceIndex(frames, () => []);
  const [middle] = index.at(0.45);
  assert.equal(middle.minIntervalMs?.toFixed(3), '50.000'); assert.equal(middle.maxIntervalMs?.toFixed(3), '250.000'); assert.equal(middle.lastChangeAt, 0.35);
  const [end] = index.at(2); assert.equal(end.maxIntervalMs?.toFixed(3), '600.000'); assert.equal(end.lastChangeAt, 0.35);
  const [clip] = index.at(0.45, 0.3); assert.equal(clip.count, 2); assert.equal(clip.minIntervalMs?.toFixed(3), '50.000'); assert.equal(clip.lastChangeAt, 0.35);
  const [single] = index.at(0.05); assert.equal(single.minIntervalMs, undefined); assert.equal(single.lastChangeAt, 0);
});
