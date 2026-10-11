import test from 'node:test';
import assert from 'node:assert/strict';
import { signalCatalogGroups } from '../src/extension/editors/signalCatalogGroups';
import { emptyProject } from '../src/core/project/schema';

test('imported group CSV and Plugin signals appear before promotion to common', () => {
  const common = emptyProject();
  const resolved = { ...common,
    pluginBindings: [{ id: 'binding', pluginId: 'plugin', frameId: 'frame', enabled: true, automatic: false }],
    externalCsvSources: [{ id: 'csv', path: 'received.csv', fileName: 'received.csv', timestampColumn: 'Time', timestampUnit: 'seconds' as const, valueColumns: [{ column: 'Value', name: 'Reference' }] }] };
  const groups = signalCatalogGroups([
    { id: 'external', name: 'Reference', source: { type: 'external-csv', sourceId: 'csv', column: 'Value' } },
    { id: 'plugin-signal', name: 'Plugin value', source: { type: 'plugin', pluginId: 'plugin', bindingId: 'binding' } },
  ], resolved, true);
  assert.deepEqual(groups.map(group => group.signalIds), [['plugin-signal'], ['external']]);
});
