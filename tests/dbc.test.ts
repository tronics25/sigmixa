import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { dbcStartToManual, decodeDbcBytes, exportDbc, importDbc, manualStartToDbc } from '../src/core/dbc/dbc';
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

test('bundled basic DBC imports as valid standard and extended definitions', () => {
  const result = importDbc(readFileSync(path.resolve('sample/basic/sigmixa-basic.dbc'), 'utf8'), 'sample/basic/sigmixa-basic.dbc');
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.frames.map((frame) => [frame.canId, frame.extended, frame.frameLength, frame.signals.length]), [
    [0x2a0, false, 8, 4],
    [0x310, false, 8, 4],
    [0x320, false, 8, 5],
    [0x18ff50e5, true, 12, 3],
  ]);
});

test('DBC Float (SIG_VALTYPE_ 1) and Double (2) Signals decode as IEEE 754 values and survive persistence and export', () => {
  const imported = importDbc('BO_ 512 Floats: 16 ECU\n SG_ Speed : 0|32@1- (1,0) [0|0] "m/s" ECU\n SG_ Big : 39|64@0- (2,1) [0|0] "" ECU\n\nSIG_VALTYPE_ 512 Speed : 1;\nSIG_VALTYPE_ 512 Big : 2;\n');
  assert.deepEqual(imported.diagnostics, []);
  assert.deepEqual(imported.frames[0].signals.map((signal) => signal.signedness), ['float', 'float']);
  const project = migrateProject({ schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION, frames: imported.frames });
  const restored = parseProjectJson(JSON.stringify(serializeProject(project))).frames[0];
  const data = new Uint8Array(16); const view = new DataView(data.buffer); view.setFloat32(0, 12.5, true); view.setFloat64(4, -3.25, false);
  const result = decodeManualFrame({ id: 'f:1', sourceId: 'f', timestamp: 1, canId: 512, extended: false, direction: 'Rx', channel: 1, dlcCode: 10, dataLength: 16, data }, restored);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.decoded.map((item) => [item.signal.name, item.sample.value, item.raw]), [['Speed', 12.5, 12.5], ['Big', -5.5, -3.25]]);
  const exported = exportDbc([restored]); assert.deepEqual(exported.diagnostics, []);
  assert.match(exported.text, /SIG_VALTYPE_ 512 Speed : 1;/); assert.match(exported.text, /SIG_VALTYPE_ 512 Big : 2;/);
  assert.deepEqual(importDbc(exported.text).frames[0].signals.map((signal) => signal.signedness), ['float', 'float']);
});

test('a SIG_VALTYPE_ that does not match the Signal length is reported and the Signal is not read as a float', () => {
  const imported = importDbc('BO_ 513 Wrong: 8 ECU\n SG_ Short : 0|16@1+ (1,0) [0|0] "" ECU\nSIG_VALTYPE_ 513 Short : 1;\n');
  assert.deepEqual(imported.diagnostics.map((item) => item.code), ['DBC_VALUE_TYPE_INVALID']);
  assert.equal(imported.frames[0].signals[0].signedness, 'unsigned');
});

test('a Shift_JIS DBC is read without garbling its units and value labels', () => {
  // "SG_ ... "℃"" and VAL_ 0 "停止" 1 "走行" written in Shift_JIS.
  const head = Buffer.from('BO_ 100 Status: 8 ECU\n SG_ Temp : 0|8@1+ (1,0) [0|255] "', 'latin1');
  const unit = Buffer.from([0x81, 0x8e]);
  const middle = Buffer.from('" ECU\nVAL_ 100 Temp 0 "', 'latin1');
  const stop = Buffer.from([0x92, 0xe2, 0x8e, 0x7e]); const run = Buffer.from([0x91, 0x96, 0x8d, 0x73]);
  const bytes = Buffer.concat([head, unit, middle, stop, Buffer.from('" 1 "', 'latin1'), run, Buffer.from('";\n', 'latin1')]);
  const result = importDbc(decodeDbcBytes(bytes));
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.frames[0].signals[0].unit, '℃');
  assert.deepEqual(result.frames[0].signals[0].valueLabels, { 0: '停止', 1: '走行' });
  assert.equal(decodeDbcBytes(Buffer.from('"℃ 停止"', 'utf8')), '"℃ 停止"');
});

test('a DBC with CR-only line breaks imports the same as with LF', () => {
  const withLf = importDbc(sample + 'VAL_ 291 VehicleSpeed 0 "Stop" 1 "Go";\n');
  const withCr = importDbc((sample + 'VAL_ 291 VehicleSpeed 0 "Stop" 1 "Go";\n').replace(/\n/g, '\r'));
  assert.equal(withCr.frames.length, 2); assert.deepEqual(withCr.frames, withLf.frames); assert.deepEqual(withCr.diagnostics, withLf.diagnostics);
});

test('GenMsgCycleTime becomes the expected period and round-trips', () => {
  const source = `${sample}BA_DEF_ BO_  "GenMsgCycleTime" INT 0 65535;\nBA_DEF_DEF_  "GenMsgCycleTime" 0;\nBA_ "GenMsgCycleTime" BO_ 291 20;\n`;
  const imported = importDbc(source); assert.deepEqual(imported.diagnostics, []);
  assert.equal(imported.frames[0].expectedPeriodMs, 20); assert.equal(imported.frames[1].expectedPeriodMs, undefined);
  const exported = exportDbc(imported.frames).text;
  assert.match(exported, /BA_DEF_ BO_ {2}"GenMsgCycleTime" INT 0 2147483647;/); assert.match(exported, /BA_ "GenMsgCycleTime" BO_ 291 20;/);
  assert.equal(importDbc(exported).frames[0].expectedPeriodMs, 20);
  const defaulted = importDbc(`${sample}BA_DEF_DEF_  "GenMsgCycleTime" 100;\nBA_ "GenMsgCycleTime" BO_ 291 20;\n`);
  assert.deepEqual(defaulted.frames.map((frame) => frame.expectedPeriodMs), [20, 100]);
});

test('GenMsgSendType becomes the send mode (by ENUM index or name, with its default) and round-trips', () => {
  const source = `${sample}BA_DEF_ BO_  "GenMsgSendType" ENUM  "Cyclic","NotUsed","IfActive","CyclicIfActive","CyclicAndSpontaneous","Spontaneous","NoMsgSendType";\nBA_DEF_DEF_  "GenMsgSendType" "NoMsgSendType";\nBA_ "GenMsgSendType" BO_ 291 4;\n`;
  const imported = importDbc(source); assert.deepEqual(imported.diagnostics, []);
  assert.deepEqual(imported.frames.map((frame) => frame.sendMode), ['mixed', undefined]);
  const exported = exportDbc(imported.frames).text; assert.match(exported, /BA_ "GenMsgSendType" BO_ 291 2;/);
  assert.deepEqual(importDbc(exported).frames.map((frame) => frame.sendMode), ['mixed', undefined]);
  assert.deepEqual(importDbc(`${sample}BA_DEF_ BO_  "GenMsgSendType" ENUM  "Cyclic","NotUsed",\n  "CyclicAndSpontaneous";\nBA_ "GenMsgSendType" BO_ 291 2;\n`).frames.map((frame) => frame.sendMode), ['mixed', undefined], 'an ENUM continued on the next line');
  assert.deepEqual(importDbc(`${sample}BA_DEF_ BO_  "GenMsgSendType" ENUM  "Cyclic","Spontaneous";\nBA_DEF_DEF_  "GenMsgSendType" "Cyclic";\nBA_ "GenMsgSendType" BO_ 291 1;\n`).frames.map((frame) => frame.sendMode), ['event', 'periodic']);
});

test('export marks CAN FD Frames with BusType and VFrameFormat', () => {
  const exported = exportDbc(importDbc(sample).frames).text;
  assert.match(exported, /BA_ "BusType" "CAN FD";/);
  assert.match(exported, /BA_ "VFrameFormat" BO_ 291 0;/); assert.match(exported, /BA_ "VFrameFormat" BO_ 2566869221 15;/);
  const classic = exportDbc(importDbc(sample).frames.slice(0, 1)).text; assert.doesNotMatch(classic, /BA_/);
  assert.deepEqual(importDbc(exported).frames, importDbc(sample).frames);
});

test('nested multiplexing keeps the Frame and leaves out only second-level Signals', () => {
  const source = `BO_ 100 Nested: 8 ECU\n SG_ Root M : 0|4@1+ (1,0) [0|15] "" ECU\n SG_ Inner m1M : 4|4@1+ (1,0) [0|15] "" ECU\n SG_ Leaf m2 : 8|8@1+ (1,0) [0|255] "" ECU\n SG_ Direct m3 : 8|8@1+ (1,0) [0|255] "" ECU\n SG_ Plain : 16|8@1+ (1,0) [0|255] "" ECU\nSG_MUL_VAL_ 100 Inner Root 1-1;\nSG_MUL_VAL_ 100 Leaf Inner 2-2;\nSG_MUL_VAL_ 100 Direct Root 3-3;\n`;
  const result = importDbc(source);
  assert.deepEqual(result.diagnostics.map((item) => item.code), ['DBC_NESTED_MULTIPLEXING']);
  assert.equal(result.frames.length, 1);
  assert.deepEqual(result.frames[0].signals.map((signal) => [signal.name, signal.multiplexing]), [
    ['Root', { type: 'multiplexer' }], ['Inner', { type: 'conditional', ranges: [{ from: 1, to: 1 }] }], ['Direct', { type: 'conditional', ranges: [{ from: 3, to: 3 }] }], ['Plain', undefined],
  ]);
});

test('three-level nested multiplexing leaves out every Signal below a nested Multiplexer, in any line order', () => {
  // Leaf's selector Mid is itself left out, so Leaf must not fall back to Root.
  const head = `BO_ 100 Deep: 8 ECU\n SG_ Root M : 0|4@1+ (1,0) [0|15] "" ECU\n SG_ Inner m1M : 4|4@1+ (1,0) [0|15] "" ECU\n SG_ Mid m2M : 8|4@1+ (1,0) [0|15] "" ECU\n SG_ Leaf m3 : 16|8@1+ (1,0) [0|255] "" ECU\n`;
  const mux = ['SG_MUL_VAL_ 100 Inner Root 1-1;', 'SG_MUL_VAL_ 100 Mid Inner 2-2;', 'SG_MUL_VAL_ 100 Leaf Mid 3-3;'];
  for (const order of [mux, [...mux].reverse()]) {
    const result = importDbc(`${head}${order.join('\n')}\n`);
    assert.deepEqual(result.diagnostics.map((item) => item.code), ['DBC_NESTED_MULTIPLEXING', 'DBC_NESTED_MULTIPLEXING']);
    assert.deepEqual(result.frames[0].signals.map((signal) => [signal.name, signal.multiplexing]), [
      ['Root', { type: 'multiplexer' }], ['Inner', { type: 'conditional', ranges: [{ from: 1, to: 1 }] }],
    ]);
  }
});

test('a Windows-1252 DBC is not mistaken for Shift_JIS', () => {
  // "°C" (B0 43) and "Länge" (E4 6E) are also valid Shift_JIS, as "ｰC" and a kanji.
  const bytes = Buffer.from('BO_ 100 Status: 8 ECU\n SG_ Temp : 0|8@1+ (1,0) [0|255] "°C" ECU\nVAL_ 100 Temp 0 "Länge" 1 "Größe";\n', 'latin1');
  const result = importDbc(decodeDbcBytes(bytes));
  assert.equal(result.frames[0].signals[0].unit, '°C');
  assert.deepEqual(result.frames[0].signals[0].valueLabels, { 0: 'Länge', 1: 'Größe' });
  // Japanese written in half-width katakana stays Shift_JIS.
  assert.equal(decodeDbcBytes(Buffer.from([0x22, 0xb4, 0xdd, 0xbc, 0xde, 0xdd, 0x22])), '"ｴﾝｼﾞﾝ"');
});

test('a Shift_JIS DBC whose only Japanese is a single kanji unit is read as Shift_JIS', () => {
  // "秒" is 95 62 in Shift_JIS; read as Windows-1252 it would be "•b".
  const bytes = Buffer.concat([Buffer.from('BO_ 100 Status: 8 ECU\n SG_ Time : 0|8@1+ (1,0) [0|255] "', 'latin1'), Buffer.from([0x95, 0x62]), Buffer.from('" ECU\n', 'latin1')]);
  assert.equal(importDbc(decodeDbcBytes(bytes)).frames[0].signals[0].unit, '秒');
  // Windows-1252 letters and symbols still read as Windows-1252.
  assert.equal(decodeDbcBytes(Buffer.from('"°C" "Länge" "Größe"', 'latin1')), '"°C" "Länge" "Größe"');
});
