import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { dbcStartToManual, exportDbc, importDbc, manualStartToDbc } from '../src/core/dbc/dbc';
import { decodeManualFrame } from '../src/core/manual/manualDecoder';
import { parseProjectJson, serializeProject, migrateProject, CURRENT_PROJECT_SCHEMA_VERSION } from '../src/core/project/schema';

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

test('DBC-imported Scale selects shifts or ordinary conversion automatically', () => {
  const result = importDbc('BO_ 291 ScaleTest: 2 ECU\n SG_ Binary : 0|8@1+ (0.0625,0.9) [0|16] "" ECU\n SG_ Decimal : 8|8@1+ (0.01,0) [0|3] "" ECU\n');
  assert.deepEqual(result.diagnostics, []);
  const decoded = decodeManualFrame({ id: 'log:1', sourceId: 'log', timestamp: 1, canId: 291, extended: false, direction: 'Rx', channel: 1, dlcCode: 2, dataLength: 2, data: Uint8Array.from([36, 225]) }, result.frames[0]);
  assert.deepEqual(decoded.diagnostics, []);
  assert.deepEqual(decoded.decoded.map((entry) => entry.sample.value), [2.9, 2.25]);
  assert.deepEqual(exportDbc(result.frames).diagnostics, []);
});

test('negative DBC Scale survives project persistence, decoding and export with correct physical bounds', () => {
  const imported = importDbc('BO_ 291 NegativeScale: 1 ECU\n SG_ Temperature : 0|8@1+ (-0.1,20) [-5.5|20] "degC" ECU\n');
  assert.deepEqual(imported.diagnostics, []);
  const project = migrateProject({ schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION, frames: imported.frames });
  const restored = parseProjectJson(JSON.stringify(serializeProject(project))).frames[0];
  const result = decodeManualFrame({ id: 'negative:1', sourceId: 'negative', timestamp: 1, canId: 291, extended: false, direction: 'Rx', channel: 1, dlcCode: 1, dataLength: 1, data: Uint8Array.of(225) }, restored);
  assert.deepEqual(result.diagnostics, []); assert.equal(result.decoded[0].sample.value, -2.5);
  const withoutBounds = { ...restored, signals: restored.signals.map((signal) => ({ ...signal, minimum: undefined, maximum: undefined })) };
  const exported = exportDbc([withoutBounds]); assert.deepEqual(exported.diagnostics, []);
  assert.match(exported.text, /\(-0\.1,20\) \[-5\.5\|20\]/);
  assert.deepEqual(importDbc(exported.text).frames[0].signals[0].conversion, restored.signals[0].conversion);
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

test('imports and exports multiplexed Signals', () => {
  const result = importDbc(`BO_ 100 Multiplexed: 8 ECU\n SG_ Mode M : 0|4@1+ (1,0) [0|15] "" ECU\n SG_ Value m1 : 8|8@1+ (1,0) [0|255] "" ECU\n SG_ Plain : 16|8@1+ (1,0) [0|255] "" ECU\n`);
  assert.deepEqual(result.diagnostics, []); assert.equal(result.frames[0].multiplexing, true);
  assert.deepEqual(result.frames[0].signals.map((signal) => signal.multiplexing), [{ type: 'multiplexer' }, { type: 'conditional', ranges: [{ from: 1, to: 1 }] }, undefined]);
  const exported = exportDbc(result.frames); assert.match(exported.text, /SG_ Mode M :/); assert.match(exported.text, /SG_ Value m1 :/);
});

test('round-trips extended multiplexing ranges', () => {
  const source = `BO_ 100 Multiplexed: 8 ECU\n SG_ Mode M : 0|4@1+ (1,0) [0|15] "" ECU\n SG_ Value m1 : 8|8@1+ (1,0) [0|255] "" ECU\nSG_MUL_VAL_ 100 Value Mode 1-2, 4-6;\n`;
  const imported = importDbc(source); assert.deepEqual(imported.diagnostics, []);
  assert.deepEqual(imported.frames[0].signals[1].multiplexing, { type: 'conditional', ranges: [{ from: 1, to: 2 }, { from: 4, to: 6 }] });
  assert.match(exportDbc(imported.frames).text, /SG_MUL_VAL_ 100 Value Mode 1-2, 4-6;/);
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
    [0x310, false, 8, 4],
    [0x320, false, 8, 5],
    [0x18ff50e5, true, 12, 3],
  ]);
});
