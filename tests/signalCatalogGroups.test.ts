import test from 'node:test';
import assert from 'node:assert/strict';
import { signalCatalogGroups } from '../src/extension/editors/signalCatalogGroups';
import { emptyProject } from '../src/core/project/schema';

test('imported group Plugin signals appear before promotion to common; the columns of a CSV log are grouped under the file', () => {
  const common = emptyProject();
  const resolved = { ...common, pluginBindings: [{ id: 'binding', pluginId: 'plugin', frameId: 'frame', enabled: true, automatic: false }] };
  const groups = signalCatalogGroups([
    { id: 'csv-column', name: 'Reference', source: { type: 'mdf-channel', group: 'received.csv', channel: 'Reference', format: 'CSV' } },
    { id: 'plugin-signal', name: 'Plugin value', source: { type: 'plugin', pluginId: 'plugin', bindingId: 'binding' } },
  ], resolved, true);
  assert.deepEqual(groups.map(group => [group.label, group.signalIds]), [['Plugin plugin', ['plugin-signal']], ['CSV · received.csv', ['csv-column']]]);
});

test('a CSV log\'s columns (no channel group) form one group with no name of its own; named MF4 channel groups keep theirs', () => {
  const groups = signalCatalogGroups([
    { id: 'speed', name: 'speed', source: { type: 'mdf-channel', group: '', channel: 'speed', format: 'CSV' } },
    { id: 'rpm', name: 'rpm', source: { type: 'mdf-channel', group: 'Engine', channel: 'rpm', format: 'MF4' } },
  ] as any, emptyProject(), true);
  assert.deepEqual(groups.map(group => [group.label, group.unnamed]), [['CSV', true], ['MF4 · Engine', undefined]]);
});
