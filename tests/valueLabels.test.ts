import test from 'node:test';
import assert from 'node:assert/strict';
import { importDbc, exportDbc } from '../src/core/dbc/dbc';
import { decodeManualFrame, formatDecodedSignal } from '../src/core/manual/manualDecoder';
import { validateFrameDefinition } from '../src/core/manual/manualDefinition';
import { emptyProject, serializeProject, parseProjectJson } from '../src/core/project/schema';
import { InMemorySignalStore } from '../src/core/signal/signalStore';

const dbc = `BO_ 256 Status: 8 Node
 SG_ Mode : 0|8@1+ (0.0625,0) [0|16] "" Node
 SG_ Signed : 8|8@1- (-1,2) [-125|130] "" Node
VAL_ 256 Mode 32 "停止" 33 "運転; \\"Ready\\"";
VAL_ 256 Signed
 -1 "負数" 0 "Zero";
`;

test('DBC VAL_ round trips signed values, multiline records, semicolons and quotes', () => {
  const imported = importDbc(dbc); assert.deepEqual(imported.diagnostics, []);
  assert.equal(imported.frames[0].signals[0].valueLabels?.['33'], '運転; "Ready"');
  const exported = exportDbc(imported.frames); assert.deepEqual(exported.diagnostics, []);
  const again = importDbc(exported.text); assert.deepEqual(again.diagnostics, []);
  assert.deepEqual(again.frames[0].signals.map((signal) => signal.valueLabels), imported.frames[0].signals.map((signal) => signal.valueLabels));
  const project = { ...emptyProject(), frames: imported.frames };
  assert.deepEqual(parseProjectJson(JSON.stringify(serializeProject(project))).frames[0].signals[0].valueLabels, imported.frames[0].signals[0].valueLabels);
});

test('state labels follow RAW integers even when integer shifting collapses physical values', () => {
  const definition = importDbc(dbc).frames[0]; const store = new InMemorySignalStore();
  const decoded = [32, 33].map((value, index) => {
    const result = decodeManualFrame({ id: `f${index}`, sourceId: 'test', canId: 256, extended: false, channel: 1, direction: 'Rx', timestamp: index, data: Uint8Array.of(value, 255, 0, 0, 0, 0, 0, 0), dlcCode: 8, dataLength: 8 }, definition);
    store.appendFrame(`f${index}`, index, result.decoded); return result.decoded;
  });
  assert.equal(decoded[0][0].sample.value, 2); assert.equal(decoded[1][0].sample.value, 2);
  assert.equal(decoded[0][0].sample.valueLabel, '停止'); assert.equal(decoded[1][0].sample.valueLabel, '運転; "Ready"');
  assert.equal(decoded[0][1].sample.valueLabel, '負数'); assert.equal(decoded[0][1].sample.value, 3);
  assert.match(formatDecodedSignal(decoded[0][0]), /2 \(停止\)/);
  const id = definition.signals[0].id;
  assert.equal(store.measured([id], 1)[0].sample.valueLabel, '運転; "Ready"');
  assert.equal(store.seriesSlice([id], undefined, 100)[0].samples[0].valueLabel, '停止');
});

test('large RAW keys and extended CAN IDs survive DBC and project serialization', () => {
  const text = 'BO_ 2147483904 Large: 8 Node\n SG_ Count : 0|64@1+ (1,0) [0|1] "" Node\nVAL_ 2147483904 Count 18446744073709551615 "Maximum";';
  const imported = importDbc(text); assert.deepEqual(imported.diagnostics, []);
  assert.equal(importDbc(exportDbc(imported.frames).text).frames[0].signals[0].valueLabels?.['18446744073709551615'], 'Maximum');
});

test('invalid label references and duplicate RAW values are diagnosed', () => {
  const duplicate = importDbc(dbc + '\nVAL_ 256 Mode 32 "Duplicate";');
  assert.ok(duplicate.diagnostics.some((item) => item.code === 'DBC_VALUE_LABEL_SYNTAX'));
  assert.ok(importDbc(dbc + '\nVAL_ 256 Unknown 0 "Missing";').diagnostics.some((item) => item.code === 'DBC_VALUE_LABEL_REFERENCE'));
  assert.ok(importDbc(dbc + '\nVAL_ 256 Mode 9 "Unclosed').diagnostics.some((item) => item.code === 'DBC_VALUE_LABEL_SYNTAX'));
  const frame = importDbc(dbc).frames[0];
  const invalid = { ...frame, signals: [{ ...frame.signals[0], valueLabels: { '256': 'Too large', '0.5': 'Not integer' } }] };
  const errors = validateFrameDefinition(invalid).diagnostics;
  assert.ok(errors.some((item) => item.code === 'SIGNAL_VALUE_LABEL_RANGE'));
  assert.ok(errors.some((item) => item.code === 'SIGNAL_VALUE_LABEL_INVALID'));
});
