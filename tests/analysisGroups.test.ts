import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyProject, migrateProject, serializeProject } from '../src/core/project/schema';
import { groupUnusablePlugins, promoteGroupFrames, resolveGroupProject, resolvePackagePlugins } from '../src/core/project/analysisGroups';
import type { ManualFrameDefinition } from '../src/core/manual/manualDefinition';

const frame = (id: string, canId: number, extended = false): ManualFrameDefinition => ({ id, name: id, canId, extended, frameLength: 8, signals: [], expectedPeriodMs: 10 });
const common = frame('common', 0x123);
const override = frame('override', 0x123);
const unique = frame('unique', 0x456);
const project = { ...emptyProject(), frames: [common, frame('extended', 0x123, true)], analysisGroups: [
  { id: 'a', name: 'A', sourcePaths: ['a.asc'], frames: [override, unique] },
  { id: 'b', name: 'B', sourcePaths: ['b.asc'], frames: [] },
] };

test('two-level Frame resolution isolates groups and preserves standard/extended identity', () => {
  assert.deepEqual(resolveGroupProject(project, 'a').frames.map((item) => item.id), ['override', 'extended', 'unique']);
  assert.deepEqual(resolveGroupProject(project, 'b').frames, project.frames);
  assert.deepEqual(resolveGroupProject(project).frames, project.frames);
  assert.equal(project.frames[0].id, 'common');
});

test('promotion removes only accepted Frames; skipped overrides remain local and moved Frames follow common edits', () => {
  const moved = promoteGroupFrames(project, 'a', ['unique']);
  assert.deepEqual(moved.analysisGroups?.[0].frames.map((item) => item.id), ['override']);
  assert.equal(moved.frames.at(-1)?.id, 'unique');
  const revised = { ...moved, frames: moved.frames.map((item) => item.id === 'unique' ? { ...item, name: 'Updated common' } : item) };
  assert.equal(resolveGroupProject(revised, 'a').frames.find((item) => item.id === 'unique')?.name, 'Updated common');
  assert.equal(project.analysisGroups[0].frames.length, 2);
  const replaced = promoteGroupFrames(project, 'a', ['override']);
  assert.equal(replaced.frames.filter((item) => item.canId === 0x123 && !item.extended).length, 1);
  assert.equal(replaced.frames.find((item) => item.canId === 0x123 && !item.extended)?.id, 'override');
});

test('group paths, definitions and expected period survive project serialization; v2 remains readable', () => {
  const loaded = migrateProject(JSON.parse(JSON.stringify(serializeProject(project))));
  assert.equal(loaded.analysisGroups?.[0].frames[0].canId, 0x123);
  assert.equal(loaded.analysisGroups?.[0].frames[0].expectedPeriodMs, 10);
  assert.deepEqual(loaded.analysisGroups?.[0].sourcePaths, ['a.asc']);
  assert.deepEqual(migrateProject({ schemaVersion: 2, frames: [] }).analysisGroups, []);
});

test('group lookup dependencies override locally and survive promotion without changing skipped Frames', () => {
  const table = { id: 'table', name: 'Local table', points: [{ input: 0, output: 1 }], outOfRange: 'clamp' as const };
  const dependencies = { plugins: [], pluginBindings: [], externalCsvSources: [], lookupTables: [table], calculations: [] };
  const local = { ...project, analysisGroups: [{ ...project.analysisGroups[0], definitionDependencies: dependencies }] };
  const moved = promoteGroupFrames(local, 'a', ['unique']);
  assert.deepEqual(moved.lookupTables, [table]);
  assert.deepEqual(moved.analysisGroups?.[0].frames, [override]);
  const conflict = { ...local, lookupTables: [{ ...table, points: [{ input: 0, output: 2 }] }] };
  assert.deepEqual(resolveGroupProject(conflict, 'a').lookupTables, [table]);
  assert.throws(() => promoteGroupFrames(conflict, 'a', ['unique']), /Dependency.*conflicts/);
  assert.equal(conflict.analysisGroups[0].frames.length, 2);
  assert.deepEqual(promoteGroupFrames(conflict, 'a', []), conflict);
});

test('replacing a common Frame removes bindings to its obsolete identity', () => {
  const bound = { ...project, pluginBindings: [{ id: 'binding', frameId: common.id, pluginId: 'plugin', enabled: true, automatic: false }] };
  assert.equal(promoteGroupFrames(bound, 'a', ['override']).pluginBindings.length, 0);
  assert.equal(bound.pluginBindings.length, 1);
});

test('imported Plugin bindings and CSV remain group-local, then survive selective promotion and reload', () => {
  const plugin = { id: 'decoder', version: '1', source: 'receiver/plugin.js', enabled: true, config: { gain: 2 } };
  const binding = { id: 'local-binding', frameId: unique.id, pluginId: plugin.id, enabled: true, automatic: false };
  const csv = { id: 'csv', path: '.sigmixa/imports/id/csv-0.csv', fileName: 'measurements.csv', timestampColumn: 'Time', timestampUnit: 'seconds' as const, valueColumns: [{ column: 'Value', name: 'Value', unit: undefined }] };
  const local = { ...project, plugins: [plugin], analysisGroups: [{ ...project.analysisGroups[0], definitionDependencies: {
    plugins: [{ ...plugin, source: '/sender/untrusted.js' }], pluginBindings: [binding], externalCsvSources: [csv], lookupTables: [], calculations: [],
  } }, project.analysisGroups[1]] };
  const resolved = resolveGroupProject(local, 'a');
  assert.equal(resolved.plugins[0].source, plugin.source);
  assert.deepEqual(resolved.pluginBindings, [binding]); assert.deepEqual(resolved.externalCsvSources, [csv]);
  assert.deepEqual(resolveGroupProject(local, 'b').externalCsvSources, []);
  const promoted = migrateProject(serializeProject(promoteGroupFrames(local, 'a', [unique.id])));
  assert.deepEqual(promoted.pluginBindings, [binding]); assert.deepEqual(promoted.externalCsvSources, [csv]);
  assert.deepEqual(promoted.analysisGroups?.[0].definitionDependencies?.pluginBindings, []);
  assert.equal(resolveGroupProject(promoted, 'b').pluginBindings[0].frameId, unique.id);
  // A changed Plugin must not make the group's logs unopenable: its group bindings are skipped and it is reported instead.
  const changed = { ...local, plugins: [{ ...plugin, config: { gain: 3 } }] };
  assert.deepEqual(resolveGroupProject(changed, 'a').pluginBindings, []); assert.deepEqual(resolveGroupProject(changed, 'a').plugins, changed.plugins);
  assert.deepEqual(groupUnusablePlugins(changed, 'a').map((item) => item.id), ['decoder']); assert.deepEqual(groupUnusablePlugins(local, 'a'), []);
  assert.throws(() => promoteGroupFrames(changed, 'a', [unique.id]), /same version and configuration/);
  assert.throws(() => promoteGroupFrames({ ...local, externalCsvSources: [{ ...csv, path: 'other.csv' }] }, 'a', [unique.id]), /conflicts/);
});


test('Plugin resolution rejects missing or incompatible registrations and never adopts sender code', () => {
  const required = { id: 'plugin', version: '1', source: '/sender/code.js', enabled: true, config: { b: 2, a: 1 } };
  const local = { ...required, source: '/receiver/code.js', config: { a: 1, b: 2 } };
  assert.equal(resolvePackagePlugins([required], [local])[0].source, local.source);
  for (const installed of [[], [{ ...local, version: '2' }], [{ ...local, enabled: false }]]) assert.throws(() => resolvePackagePlugins([required], installed), /register and enable/);
});
