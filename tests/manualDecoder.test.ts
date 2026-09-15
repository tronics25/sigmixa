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

test('each Signal Scale automatically selects arithmetic and feeds Derived Signals', () => {
  const direct = definition.signals[0];
  const fractional: ManualFrameDefinition = { ...definition, frameLength: 2, signals: [
    { ...direct, name: 'Speed', conversion: { type: 'scale-offset', lsb: 1/16, lsbText: '1/16', offset: 0 } },
    { ...direct, id: 'percent', name: 'Percent', byteOffset: 1, conversion: { type: 'scale-offset', lsb: .01, lsbText: '1/100', offset: 0 } },
  ], derivedSignals: [{ id: 'derived', name: 'Derived', unit: '', operation: { type: 'expression', expression: '[Speed] + 0.25' } }] };
  assert.deepEqual(decodeManualFrame(frame([36, 225]), fractional).decoded.map((entry) => entry.sample.value), [2, 2.25, 2.25]);
});

test('multiplexed decoder emits only Signals active for the raw Multiplexer value', () => {
  const multiplexed: ManualFrameDefinition = { ...definition, multiplexing: true, derivedSignals: [], signals: [
    { ...definition.signals[0], id: 'mode', name: 'Mode', lengthBits: 4, conversion: { type: 'scale-offset', lsb: 10, lsbText: '10', offset: 100 }, multiplexing: { type: 'multiplexer' } },
    { ...definition.signals[1], id: 'one', name: 'One', byteOffset: 1, multiplexing: { type: 'conditional', ranges: [{ from: 1, to: 1 }] } },
    { ...definition.signals[1], id: 'two-four', name: 'TwoFour', byteOffset: 2, multiplexing: { type: 'conditional', ranges: [{ from: 2, to: 4 }] } },
    { ...definition.signals[1], id: 'always', name: 'Always', byteOffset: 3 },
  ] };
  assert.deepEqual(decodeManualFrame(frame([1, 11, 22, 33]), multiplexed).decoded.map((item) => item.signal.id), ['mode', 'one', 'always']);
  assert.deepEqual(decodeManualFrame(frame([3, 11, 22, 33]), multiplexed).decoded.map((item) => item.signal.id), ['mode', 'two-four', 'always']);
});

test('Lookup Table interpolates linearly and Filter keeps state within an analysis context', () => {
  const derivedDefinition: ManualFrameDefinition = { ...definition, signals: [
    { ...definition.signals[0], conversion: { type: 'scale-offset', lsb: .01, lsbText: '0.01', offset: -1 } },
    definition.signals[1],
  ], derivedSignals: [
    { id: 'lookup', name: 'Lookup', unit: '', operation: { type: 'lookup', input: 'Speed', outOfRange: 'clamp', points: [{ input: 0, output: 0 }, { input: 10, output: 100 }] } },
    { id: 'filtered', name: 'Filtered', unit: 'm/s', operation: { type: 'filter', input: 'Speed', filter: 'low-pass', timeSeconds: 1 } },
  ] };
  const context = createManualDecodeContext();
  const first = decodeManualFrame({ ...frame([0x80, 0]), timestamp: 0 }, derivedDefinition, context);
  const second = decodeManualFrame({ ...frame([0xff, 0]), timestamp: 1 }, derivedDefinition, context);
  assert.ok(Math.abs(first.decoded.find((item) => item.definition.id === 'lookup')!.sample.value - 2.8) < 1e-9);
  assert.equal(second.decoded.find((item) => item.definition.id === 'lookup')!.sample.value, 15.5);
  const filtered = second.decoded.find((item) => item.definition.id === 'filtered')!.sample.value;
  assert.ok(filtered > .28 && filtered < 1.55);
});
