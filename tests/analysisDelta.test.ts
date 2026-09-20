import test from 'node:test';
import assert from 'node:assert/strict';
import { manualAnalysisDelta } from '../src/core/project/analysisDelta';
import { emptyProject } from '../src/core/project/schema';
import type { ManualFrameDefinition } from '../src/core/manual/manualDefinition';

const frame: ManualFrameDefinition = {
  id: 'frame-a', canId: 0x123, extended: false, name: 'Frame A', frameLength: 8, signals: [{
    id: 'speed', name: 'Speed', unit: 'km/h', byteOffset: 0, bitOffset: 0, lengthBits: 16,
    signedness: 'unsigned', byteOrder: 'little', conversion: { type: 'scale-offset', lsb: 1, lsbText: '1', offset: 0 },
  }], derivedSignals: [],
};

test('manual definition edits produce an exact incremental CAN subset', () => {
  const before = { ...emptyProject(), frames: [frame] };
  const after = { ...before, frames: [{ ...frame, signals: [{ ...frame.signals[0], conversion: { type: 'scale-offset' as const, lsb: 0.1, lsbText: '0.1', offset: 0 } }] }] };
  const delta = manualAnalysisDelta(before, after);
  assert.deepEqual([...delta!.frameIds], ['frame-a']);
  assert.deepEqual(delta!.canRefs, [{ canId: 0x123, extended: false }]);
});

test('stateful Plugin and External CSV changes require a full rebuild', () => {
  const before = { ...emptyProject(), frames: [frame] };
  assert.equal(manualAnalysisDelta(before, { ...before, plugins: [{ id: 'p', version: '1', source: 'p', enabled: true }] }), undefined);
  assert.equal(manualAnalysisDelta(before, { ...before, externalCsvSources: [{ id: 'c', path: 'a.csv', fileName: 'a.csv', timestampColumn: 't', timestampUnit: 'seconds', valueColumns: [{ column: 'v', name: 'V' }] }] }), undefined);
});

test('changing the CAN route of a Plugin-bound Frame requires a full rebuild', () => {
  const before = { ...emptyProject(), frames: [frame], pluginBindings: [{ id: 'b', pluginId: 'p', frameId: frame.id, enabled: true, automatic: false }] };
  assert.equal(manualAnalysisDelta(before, { ...before, frames: [{ ...frame, canId: 0x124 }] }), undefined);
});
