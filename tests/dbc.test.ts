import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { dbcStartToManual, exportDbc, importDbc, manualStartToDbc } from '../src/core/dbc/dbc';

const sample = `VERSION "1.0"
NS_ :
BS_:
BU_: ECU Dashboard

BO_ 291 VehicleStatus: 8 ECU
 SG_ VehicleSpeed : 0|16@1+ (0.01,0) [0|250] "km/h" Dashboard
 SG_ CoolantTemp : 23|16@0- (1,-40) [-40|150] "degC" Dashboard

BO_ 2566869221 ExtendedFrame: 12 ECU
 SG_ Torque : 0|12@1- (0.1,-200) [-200|209.5] "Nm" Dashboard
`;

test('imports standard/extended Frames and Intel/Motorola Signals', () => {
  const result = importDbc(sample, 'sample.dbc');
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.frames.length, 2);
  const [standard, extended] = result.frames;
  assert.deepEqual([standard.canId, standard.extended, standard.frameLength, standard.name], [0x123, false, 8, 'VehicleStatus']);
  assert.deepEqual(standard.signals.map((signal) => [signal.name, signal.byteOffset, signal.bitOffset, signal.lengthBits, signal.byteOrder, signal.signedness]), [
    ['VehicleSpeed', 0, 0, 16, 'little', 'unsigned'],
    ['CoolantTemp', 2, 0, 16, 'big', 'signed'],
  ]);
  assert.deepEqual([standard.signals[0].conversion.lsb, standard.signals[0].minimum, standard.signals[0].maximum], [0.01, 0, 250]);
  assert.deepEqual([extended.canId, extended.extended, extended.frameLength], [0x18ff50e5, true, 12]);
});

test('converts DBC Motorola sawtooth start bits both ways', () => {
  assert.deepEqual(dbcStartToManual(7, 'big'), { byteOffset: 0, bitOffset: 0 });
  assert.deepEqual(dbcStartToManual(3, 'big'), { byteOffset: 0, bitOffset: 4 });
  assert.equal(manualStartToDbc(0, 0, 'big'), 7);
  assert.equal(manualStartToDbc(2, 0, 'big'), 23);
  assert.equal(manualStartToDbc(1, 3, 'little'), 11);
});

test('exports canonical DBC and round-trips supported Frame fields', () => {
  const imported = importDbc(sample).frames;
  const exported = exportDbc(imported);
  assert.match(exported.text, /BO_ 291 VehicleStatus: 8 Vector__XXX/);
  assert.match(exported.text, /BO_ 2566869221 ExtendedFrame: 12 Vector__XXX/);
  assert.match(exported.text, /SG_ CoolantTemp : 23\|16@0-/);
  const roundTrip = importDbc(exported.text);
  assert.deepEqual(roundTrip.diagnostics, []);
  assert.deepEqual(roundTrip.frames.map((frame) => [frame.canId, frame.extended, frame.frameLength]), imported.map((frame) => [frame.canId, frame.extended, frame.frameLength]));
  assert.deepEqual(roundTrip.frames[0].signals.map((signal) => [signal.name, signal.byteOffset, signal.bitOffset, signal.byteOrder]), imported[0].signals.map((signal) => [signal.name, signal.byteOffset, signal.bitOffset, signal.byteOrder]));
});

test('reports multiplexing and invalid rows without creating broken definitions', () => {
  const result = importDbc(`BO_ 100 Multiplexed: 8 ECU\n SG_ Mode M : 0|4@1+ (1,0) [0|15] "" ECU\n SG_ Value m1 : 8|8@1+ (1,0) [0|255] "" ECU\n SG_ Plain : 16|8@1+ (1,0) [0|255] "" ECU\n`);
  assert.deepEqual(result.frames[0].signals.map((signal) => signal.name), ['Plain']);
  assert.deepEqual(result.diagnostics.map((item) => item.code), ['DBC_MULTIPLEXING_UNSUPPORTED', 'DBC_MULTIPLEXING_UNSUPPORTED']);
});

test('normalizes names on export and reports skipped Derived Signals', () => {
  const frame = importDbc(sample).frames[0];
  const result = exportDbc([{ ...frame, name: 'Vehicle Status', derivedSignals: [{ id: 'derived', name: 'Speed kmh', unit: '', operation: { type: 'expression', expression: '[VehicleSpeed]' } }] }]);
  assert.match(result.text, /BO_ 291 Vehicle_Status:/);
  assert.deepEqual(result.diagnostics.map((item) => item.code), ['DBC_DERIVED_SIGNALS_SKIPPED']);
});

test('bundled DBC showcase imports as valid standard and extended definitions', () => {
  const result = importDbc(readFileSync(path.resolve('sample/sigmixa-showcase.dbc'), 'utf8'), 'sample/sigmixa-showcase.dbc');
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.frames.map((frame) => [frame.canId, frame.extended, frame.frameLength, frame.signals.length]), [
    [0x2a0, false, 8, 4],
    [0x18ff50e5, true, 12, 3],
  ]);
});
