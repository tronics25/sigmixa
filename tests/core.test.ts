import test from 'node:test';
import assert from 'node:assert/strict';
import { assertCanFrame, type CanFrame } from '../src/core/frame/canFrame';
import { validateSignalDefinition } from '../src/core/signal/signal';
import { emptyProject, migrateProject, removeCalculation, removeExternalCsvSignal, removeExternalCsvSource, serializeProject, upsertCalculation } from '../src/core/project/schema';

const valid: CanFrame = {
  id: 'source:0', sourceId: 'source', timestamp: 12.5, canId: 0x123, extended: false,
  direction: 'Rx', channel: 1, dlcCode: 8, dataLength: 2, data: Uint8Array.from([1, 2]),
};

test('CanFrame validates timestamp, identifier, DLC, and actual payload length independently', () => {
  assert.doesNotThrow(() => assertCanFrame(valid));
  assert.throws(() => assertCanFrame({ ...valid, canId: 0x800 }), /11-bit/);
  assert.throws(() => assertCanFrame({ ...valid, dataLength: 8 }), /match/);
});

test('Signal definitions use stable IDs and source-neutral validation', () => {
  assert.deepEqual(validateSignalDefinition({ id: 's1', name: 'Speed', unit: 'm/s', source: { type: 'manual-can', frameDefinitionId: 'f1' } }), []);
  assert.equal(validateSignalDefinition({ id: '', name: ' ', source: { type: 'calculated', calculationId: 'c1' } }).length, 2);
});

test('project schema has an explicit version and rejects unknown versions', () => {
  assert.equal(migrateProject(emptyProject()).schemaVersion, 2);
  assert.throws(() => migrateProject({ schemaVersion: 3 }), /Unsupported/);
});

test('project persistence stores CAN IDs as strings and migrates numeric v1 IDs', () => {
  const legacy = migrateProject({ schemaVersion: 1, frames: [{ id: 'legacy', canId: 0x1ab, extended: true, name: 'Legacy', frameLength: 8, signals: [] }] });
  assert.deepEqual({ canId: legacy.frames[0].canId, extended: legacy.frames[0].extended }, { canId: 0x1ab, extended: true });
  const persisted = serializeProject(legacy) as { schemaVersion: number; frames: Array<Record<string, unknown>> };
  assert.equal(persisted.schemaVersion, 2);
  assert.equal(persisted.frames[0].canId, '1ABx');
  assert.equal('extended' in persisted.frames[0], false);
  const restored = migrateProject(persisted);
  assert.deepEqual({ canId: restored.frames[0].canId, extended: restored.frames[0].extended }, { canId: 0x1ab, extended: true });
});

test('project schema round-trip restores manual frame and signal definitions', () => {
  const project = migrateProject(JSON.parse(JSON.stringify({
    ...emptyProject(), frames: [{ id: 'f1', canId: 0x123, extended: false, name: 'Frame', frameLength: 8, origin: { type: 'manual' }, signals: [{ id: 's1', name: 'Signal', unit: 'V', byteOffset: 0, bitOffset: 0, lengthBits: 8, signedness: 'signed', byteOrder: 'big', conversion: { type: 'scale-offset', lsb: 0.5, lsbText: '1/2', offset: -1 } }] }],
  })));
  assert.equal(project.frames[0].signals[0].byteOrder, 'big');
  assert.deepEqual(project.frames[0].signals[0].conversion, { type: 'scale-offset', lsb: 0.5, lsbText: '1/2', offset: -1 });
});

test('project schema migrates legacy None conversion to identity Scale + Offset and restores Derived Signals', () => {
  const project = migrateProject({
    ...emptyProject(), frames: [{ id: 'f1', canId: 0x123, extended: false, name: 'Frame', frameLength: 8, signals: [
      { id: 's1', name: 'Signal', unit: '', byteOffset: 0, bitOffset: 0, lengthBits: 8, signedness: 'unsigned', byteOrder: 'little', conversion: { type: 'none' } },
    ], derivedSignals: [{ id: 'd1', name: 'Double', unit: '', expression: '[Signal] * 2' }] }],
  });
  assert.deepEqual(project.frames[0].signals[0].conversion, { type: 'scale-offset', lsb: 1, lsbText: '1', offset: 0 });
  assert.deepEqual(project.frames[0].derivedSignals, [{ id: 'd1', name: 'Double', unit: '', operation: { type: 'expression', expression: '[Signal] * 2' } }]);
});

test('removing an External CSV unregisters only that source and preserves reusable Calculations', () => {
  const project = migrateProject({
    ...emptyProject(),
    externalCsvSources: [
      { id: 'remove', path: 'remove.csv', fileName: 'remove.csv', timestampColumn: 'time', timestampUnit: 'seconds', valueColumns: [{ column: 'value', name: 'Value' }] },
      { id: 'keep', path: 'keep.csv', fileName: 'keep.csv', timestampColumn: 'time', timestampUnit: 'seconds', valueColumns: [{ column: 'value', name: 'Value' }] },
    ],
    calculations: [{ id: 'calculation', name: 'Calculation', enabled: true, inputs: { input: 'external:remove:value' }, timestampSignalId: 'external:remove:value', interpolation: 'exact', operation: { type: 'expression', expression: 'input' } }],
  });
  const result = removeExternalCsvSource(project, 'remove');
  assert.deepEqual(result.externalCsvSources.map((source) => source.id), ['keep']);
  assert.equal(result.calculations.length, 1);
});

test('removing External CSV Signals keeps the source until its final value column is removed', () => {
  const project = migrateProject({ ...emptyProject(), externalCsvSources: [{
    id: 'csv', path: 'values.csv', fileName: 'values.csv', timestampColumn: 'time', timestampUnit: 'seconds',
    valueColumns: [{ column: 'a', name: 'A' }, { column: 'b', name: 'B' }],
  }] });
  const oneLeft = removeExternalCsvSignal(project, 'csv', 'a');
  assert.deepEqual(oneLeft.externalCsvSources[0].valueColumns.map((item) => item.column), ['b']);
  assert.equal(removeExternalCsvSignal(oneLeft, 'csv', 'b').externalCsvSources.length, 0);
});

test('Calculated Signal editor helpers replace by stable ID and remove only the selected definition', () => {
  const first = { id: 'first', name: 'First', enabled: true, inputs: { input: 'signal-a' }, timestampSignalId: 'signal-a', interpolation: 'exact' as const, operation: { type: 'expression' as const, expression: 'input' } };
  const second = { ...first, id: 'second', name: 'Second' };
  const project = { ...emptyProject(), calculations: [first, second] };
  const updated = upsertCalculation(project, { ...first, name: 'Renamed', operation: { type: 'expression', expression: 'input * 2' } });
  assert.deepEqual(updated.calculations.map((item) => [item.id, item.name]), [['second', 'Second'], ['first', 'Renamed']]);
  assert.deepEqual(removeCalculation(updated, 'second').calculations.map((item) => item.id), ['first']);
});
