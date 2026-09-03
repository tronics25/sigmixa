import test from 'node:test';
import assert from 'node:assert/strict';
import { createManualSignal, normalizeFrameDefinition, validateFrameDefinition, type ManualFrameDefinition, type ManualSignalDefinition } from '../src/core/manual/manualDefinition';

function signal(patch: Partial<ManualSignalDefinition> = {}): ManualSignalDefinition {
  return { id: 'signal-1', name: ' Value ', unit: ' V ', byteOffset: 0, bitOffset: 0, lengthBits: 8, signedness: 'unsigned', byteOrder: 'little', conversion: { type: 'scale-offset', lsb: 1 / 128, lsbText: '1/128', offset: 0 }, ...patch };
}
function frame(signals: readonly ManualSignalDefinition[]): ManualFrameDefinition { return { id: 'frame-1', canId: 0x123, extended: false, name: ' Frame ', frameLength: 8, signals, origin: { type: 'manual' } }; }

test('normalization trims display text while preserving explicit byte order', () => {
  const normalized = normalizeFrameDefinition(frame([{ ...signal(), byteOffset: 2, lengthBits: 12, byteOrder: 'big' }]));
  assert.equal(normalized.name, 'Frame'); assert.equal(normalized.signals[0].name, 'Value'); assert.equal(normalized.signals[0].unit, 'V');
  assert.equal(normalized.signals[0].byteOrder, 'big');
});

test('new signals inherit previous byte order and first signal defaults to little endian', () => {
  assert.equal(createManualSignal('first').byteOrder, 'little');
  assert.equal(createManualSignal('next', signal({ byteOrder: 'big' })).byteOrder, 'big');
});

test('validation reports overlap, frame overflow, invalid lengths, and inconsistent LSB text', () => {
  const result = validateFrameDefinition(frame([
    signal(),
    signal({ id: 'signal-2', byteOffset: 0, bitOffset: 4, lengthBits: 64, conversion: { type: 'scale-offset', lsb: 1, lsbText: '1/3', offset: 0 } }),
  ]));
  const codes = new Set(result.diagnostics.map((item) => item.code));
  assert.equal(result.valid, false); assert.ok(codes.has('SIGNAL_OVERLAP')); assert.ok(codes.has('SIGNAL_OUTSIDE_FRAME')); assert.ok(codes.has('SIGNAL_LSB_MISMATCH'));
});

test('frame length accepts Classic and legal CAN FD payload sizes only', () => {
  assert.equal(validateFrameDefinition({ ...frame([]), frameLength: 0 }).valid, true);
  assert.equal(validateFrameDefinition({ ...frame([]), frameLength: 12 }).valid, true);
  assert.ok(validateFrameDefinition({ ...frame([]), frameLength: 9 }).diagnostics.some((item) => item.code === 'FRAME_LENGTH_RANGE'));
});

test('Derived Signals may reference extracted and only earlier Derived Signals', () => {
  const result = validateFrameDefinition({ ...frame([signal({ name: 'Vehicle Speed' })]), derivedSignals: [
    { id: 'derived-1', name: 'Speed m/s', unit: 'm/s', operation: { type: 'expression', expression: '[Vehicle Speed] / 3.6' } },
    { id: 'derived-2', name: 'Distance', unit: 'm', operation: { type: 'expression', expression: '[Speed m/s] * 0.1' } },
  ] });
  assert.equal(result.valid, true);

  const invalid = validateFrameDefinition({ ...frame([signal({ name: 'Vehicle Speed' })]), derivedSignals: [
    { id: 'derived-1', name: 'First', unit: '', operation: { type: 'expression', expression: '[Later] + [Vehicle Speed]' } },
    { id: 'derived-2', name: 'Later', unit: '', operation: { type: 'expression', expression: '[Vehicle Speed] * 2' } },
  ] });
  assert.ok(invalid.diagnostics.some((item) => item.code === 'DERIVED_SIGNAL_FORWARD_REFERENCE' && item.details?.signalId === 'derived-1'));
});
