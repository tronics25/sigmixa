import assert from 'node:assert/strict';
import test from 'node:test';
import { graphDisplayPolicy, partitionActualGraphs, signalAxisKey } from '../src/webview/shared/graphDisplayPolicy';

const definitions = [
  { id: 'speed', unit: 'km/h' }, { id: 'speed-ms', unit: 'm/s' },
  { id: 'rpm', unit: 'rpm' }, { id: 'temperature', unit: '°C' },
  { id: 'voltage', unit: 'V' }, { id: 'pressure', unit: 'bar' },
];

test('compatible units share an actual-value axis; a third system requires normalization', () => {
  const selected = ['speed', 'speed-ms', 'rpm'];
  assert.equal(graphDisplayPolicy(selected, definitions, 'raw').mode, 'raw');
  selected.push('temperature');
  assert.equal(graphDisplayPolicy(selected, definitions, 'raw').mode, 'normalized');
  assert.deepEqual(selected, ['speed', 'speed-ms', 'rpm', 'temperature']);
});

test('sequential additions keep all selected Signals and consistently normalize beyond two axes', () => {
  const selected: string[] = [];
  for (const definition of definitions) {
    selected.push(definition.id);
    const before = selected.slice();
    const policy = graphDisplayPolicy(selected, definitions, 'raw');
    assert.deepEqual(selected, before);
    assert.equal(policy.mode, policy.axisKeys.length > 2 ? 'normalized' : 'raw');
  }
});

test('reducing to two axes allows an explicit return to actual values without switching automatically', () => {
  const selected = ['speed', 'rpm'];
  assert.equal(graphDisplayPolicy(selected, definitions, 'normalized').mode, 'normalized');
  assert.equal(graphDisplayPolicy(selected, definitions, 'raw').mode, 'raw');
  assert.equal(graphDisplayPolicy(selected, definitions, 'normalized').requiresNormalization, false);
});

test('catalog updates re-evaluate units; missing Signals do not create phantom axes', () => {
  const selected = ['speed', 'speed-ms', 'rpm', 'missing'];
  assert.equal(graphDisplayPolicy(selected, definitions, 'raw').mode, 'raw');
  const changed = definitions.map((definition) => definition.id === 'speed-ms' ? { ...definition, unit: 'V' } : definition);
  assert.equal(graphDisplayPolicy(selected, changed, 'raw').mode, 'normalized');
  assert.deepEqual(graphDisplayPolicy(['missing'], [], 'raw'), { axisKeys: [], requiresNormalization: false, mode: 'raw' });
});

test('explicit actual switching partitions seven systems into 2+2+2+1 without loss or repeated splits', () => {
  const catalog = [...definitions, { id: 'current', unit: 'A' }, { id: 'distance', unit: 'm' }];
  const selected = catalog.map((definition) => definition.id);
  const before = [...selected];
  const groups = partitionActualGraphs(selected, catalog);
  assert.deepEqual(groups.map((group) => group.axisKeys.length), [2, 2, 2, 1]);
  assert.deepEqual(groups.flatMap((group) => group.selectedIds), selected);
  assert.deepEqual(selected, before);
  for (const group of groups) {
    assert.equal(graphDisplayPolicy(group.selectedIds, catalog, 'raw').mode, 'raw');
    assert.deepEqual(partitionActualGraphs(group.selectedIds, catalog, group.axisKeys), [group]);
  }
});

test('partitioning respects existing axes, compatible units, and missing references', () => {
  const preferred = [signalAxisKey('V'), signalAxisKey('km/h')];
  const selected = ['missing', ...definitions.map((definition) => definition.id), 'speed'];
  const groups = partitionActualGraphs(selected, definitions, preferred);
  assert.deepEqual(groups[0], { axisKeys: preferred, selectedIds: ['missing', 'speed', 'speed-ms', 'voltage'] });
  assert.equal(new Set(groups.flatMap((group) => group.selectedIds)).size, selected.length - 1);
  assert.equal(groups.flatMap((group) => group.selectedIds).length, selected.length - 1);
  assert.deepEqual(partitionActualGraphs(['missing'], [], preferred), [{ axisKeys: [], selectedIds: ['missing'] }]);
});
