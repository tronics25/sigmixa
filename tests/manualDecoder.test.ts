import test from 'node:test';
import assert from 'node:assert/strict';
import type { CanFrame } from '../src/core/frame/canFrame';
import type { ManualFrameDefinition } from '../src/core/manual/manualDefinition';
import { createManualDecodeContext, decodeManualFrame, formatDecodedSignal } from '../src/core/manual/manualDecoder';

function frame(data: number[]): CanFrame { return { id: 'log:1', sourceId: 'log', timestamp: 42.5, canId: 0x123, extended: false, direction: 'Rx', channel: 1, dlcCode: data.length, dataLength: data.length, data: Uint8Array.from(data) }; }
const definition: ManualFrameDefinition = { id: 'frame-1', canId: 0x123, extended: false, name: 'Status', frameLength: 8, origin: { type: 'manual' }, signals: [
  { id: 'speed', name: 'Speed', unit: 'm/s', byteOffset: 0, bitOffset: 0, lengthBits: 8, signedness: 'unsigned', byteOrder: 'little', conversion: { type: 'scale-offset', lsb: 1 / 128, lsbText: '1/128', offset: -1 } },
  { id: 'temperature', name: 'Temperature', unit: 'C', byteOffset: 1, bitOffset: 0, lengthBits: 8, signedness: 'signed', byteOrder: 'little', conversion: { type: 'scale-offset', lsb: 1, lsbText: '1', offset: 0 } },
], derivedSignals: [
  { id: 'speed-kmh', name: 'Speed km/h', unit: 'km/h', operation: { type: 'expression', expression: '[Speed] * 3.6' } },
  { id: 'adjusted', name: 'Adjusted Speed', unit: 'km/h', operation: { type: 'expression', expression: '[Speed km/h] + [Temperature]' } },
] };

test('manual decoder emits source-neutral Signal samples and compact display tags', () => {
  const result = decodeManualFrame(frame([0x80, 0xff]), definition);
  assert.equal(result.diagnostics.length, 0); assert.equal(result.decoded[0].sample.timestamp, 42.5); assert.equal(result.decoded[0].sample.value, 0); assert.equal(result.decoded[1].sample.value, -1);
  assert.equal(result.decoded[2].sample.value, 0); assert.equal(result.decoded[2].sample.timestamp, 42.5); assert.equal(result.decoded[3].sample.value, -1);
  assert.equal(formatDecodedSignal(result.decoded[0]), 'Speed=0 m/s');
});

test('short frames produce diagnostics and never synthesize false values', () => {
  const result = decodeManualFrame(frame([0x80]), definition);
  assert.equal(result.decoded.length, 2); assert.equal(result.diagnostics.length, 2); assert.deepEqual(result.diagnostics.map((item) => item.code), ['FRAME_TOO_SHORT', 'DERIVED_SIGNAL_EVALUATION_ERROR']);
});

test('unmatched CAN frames are ignored without diagnostics', () => {
  const result = decodeManualFrame({ ...frame([1, 2]), canId: 0x124 }, definition);
  assert.deepEqual(result, { decoded: [], diagnostics: [] });
});

test('Lookup Table interpolates linearly and Filter keeps state within an analysis context', () => {
  const derivedDefinition: ManualFrameDefinition = { ...definition, derivedSignals: [
    { id: 'lookup', name: 'Lookup', unit: '', operation: { type: 'lookup', input: 'Speed', outOfRange: 'clamp', points: [{ input: 0, output: 0 }, { input: 10, output: 100 }] } },
    { id: 'filtered', name: 'Filtered', unit: 'm/s', operation: { type: 'filter', input: 'Speed', filter: 'low-pass', timeSeconds: 1 } },
  ] };
  const context = createManualDecodeContext();
  const first = decodeManualFrame({ ...frame([0x80, 0]), timestamp: 0 }, derivedDefinition, context);
  const second = decodeManualFrame({ ...frame([0xff, 0]), timestamp: 1 }, derivedDefinition, context);
  assert.equal(first.decoded.find((item) => item.definition.id === 'lookup')?.sample.value, 0);
  assert.ok(Math.abs(second.decoded.find((item) => item.definition.id === 'lookup')!.sample.value - 9.921875) < 1e-9);
  const filtered = second.decoded.find((item) => item.definition.id === 'filtered')!.sample.value;
  assert.ok(filtered > 0 && filtered < 0.9921875);
});
