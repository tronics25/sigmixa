import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyProject, migrateProject, serializeProject, clipRange } from '../src/core/project/schema';
import { resolveViewSettings, saveViewSettings, switchViewSettingsScope } from '../src/core/project/viewSettings';

test('Full-file and ranged Clips round-trip without sentinel times, measurements or copied definitions', () => {
  const source = { id: 'full', name: 'Overview', sourcePath: 'log.asc', sourceFileName: 'log.asc' };
  const project = { ...emptyProject(), clips: [source, { ...source, id: 'part', startTimestamp: 1, endTimestamp: 2 }] };
  const stored = serializeProject(project) as { clips: Record<string, unknown>[] };
  assert.equal('range' in stored.clips[0], false); assert.deepEqual(stored.clips[1].range, { start: 1, end: 2 });
  const restored = migrateProject(stored); assert.equal(clipRange(restored.clips[0]), undefined); assert.deepEqual(clipRange(restored.clips[1]), { start: 1, end: 2 });
  const issues: string[] = [];
  const partial = migrateProject({ ...stored, clips: [{ ...source, id: 'half', range: { start: 1 } }, { ...source, id: 'reversed', range: { start: 2, end: 1 } }, stored.clips[1]] }, issues);
  assert.deepEqual(partial.clips.map((clip) => clip.id), ['part']);
  assert.equal(issues.length, 2); assert.ok(issues.every((issue) => /Invalid Clip range/.test(issue)));
  const groups = migrateProject({ ...stored, analysisGroups: [{ name: 'no id' }, { id: 'g', name: 'G' }] });
  assert.deepEqual(groups.analysisGroups?.map((group) => group.id), ['g']);
});
test('Group view changes follow on all opted-in files while file settings stay independent', () => {
  const group = { id: 'g', name: 'G', frames: [], sourcePaths: ['a', 'b'] };
  const layout = { visualizeViews: [{ id: 'v', kind: 'graph', height: 510, settings: { chartSelectedIds: ['s'] } }], traceSettings: { columns: ['count'], widths: { name: 320, multiplexer: 60 }, defaultMode: 'raw', pinnedIds: ['s:291'], sort: 'count', descending: true }, activeTab: 'table-view' };
  let project = switchViewSettingsScope({ ...emptyProject(), analysisGroups: [group] }, 'a', layout, group, 'group');
  const current = () => project.analysisGroups![0];
  project = switchViewSettingsScope(project, 'b', { activeTab: 'raw-view' }, current(), 'group');
  project = saveViewSettings(project, 'a', { ...layout, traceSettings: { columns: ['interval', 'count'] } }, current());
  assert.deepEqual(resolveViewSettings(project, 'b', current()).traceSettings, { columns: ['interval', 'count'] });
  assert.equal(resolveViewSettings(project, 'b', current()).activeTab, 'raw-view');
  // A log without settings of its own does not take a copy of the group's when it switches to "This file".
  project = switchViewSettingsScope(project, 'b', resolveViewSettings(project, 'b', current()), current(), 'file');
  assert.deepEqual(resolveViewSettings(project, 'b', current()), { activeTab: 'raw-view' });
  const restored = migrateProject(serializeProject(project));
  assert.deepEqual(resolveViewSettings(restored, 'b', restored.analysisGroups![0]), resolveViewSettings(project, 'b', current()));
});
test('Per-file settings are kept while the group settings are shown, and come back unchanged', () => {
  const group = { id: 'g', name: 'G', frames: [], sourcePaths: ['a', 'b'], viewState: { traceSettings: { columns: ['count'] } } };
  const own = { traceSettings: { columns: ['interval'] }, chartMode: 'normalized', activeTab: 'table-view' };
  let project = { ...emptyProject(), analysisGroups: [group], viewStates: { a: { ...own, viewStateScope: 'file' } } };
  const current = () => project.analysisGroups![0];
  project = switchViewSettingsScope(project, 'a', own, current(), 'group');
  assert.deepEqual(resolveViewSettings(project, 'a', current()).traceSettings, { columns: ['count'] }, 'the group settings are shown');
  project = saveViewSettings(project, 'a', { traceSettings: { columns: ['dlc'] }, activeTab: 'visualize-view' }, current());
  assert.deepEqual(current().viewState, { traceSettings: { columns: ['dlc'] } }, 'edits while shared go to the group');
  project = switchViewSettingsScope(project, 'a', resolveViewSettings(project, 'a', current()), current(), 'file');
  assert.deepEqual(resolveViewSettings(project, 'a', current()), { ...own, activeTab: 'visualize-view' }, 'the per-file settings come back');
  assert.deepEqual(current().viewState, { traceSettings: { columns: ['dlc'] } }, 'and the group settings stay as they are');
});
test('Edits not saved yet before a switch stay with the settings they were made in', () => {
  const group = { id: 'g', name: 'G', frames: [], sourcePaths: ['a'], viewState: { chartMode: 'raw' } };
  let project = { ...emptyProject(), analysisGroups: [group], viewStates: { a: { chartMode: 'raw', viewStateScope: 'file' } } };
  project = switchViewSettingsScope(project, 'a', { chartMode: 'normalized' }, project.analysisGroups![0], 'group');
  assert.equal(project.viewStates.a && (project.viewStates.a as { chartMode?: string }).chartMode, 'normalized', 'the per-file edit is kept');
  assert.deepEqual(project.analysisGroups![0].viewState, { chartMode: 'raw' }, 'and does not reach the group');
  project = switchViewSettingsScope(project, 'a', { chartMode: 'normalized', activeTab: 'raw-view' }, project.analysisGroups![0], 'file');
  assert.deepEqual(project.analysisGroups![0].viewState, { chartMode: 'normalized' }, 'a group edit is kept in the group');
  assert.equal(resolveViewSettings(project, 'a', project.analysisGroups![0]).chartMode, 'normalized');
  // A second view of the log, still showing the group's settings, switches after the first one already did.
  const before = project.viewStates.a;
  project = switchViewSettingsScope(project, 'a', { chartMode: 'raw' }, project.analysisGroups![0], 'file', 'group');
  assert.deepEqual(project.viewStates.a, before, 'the per-file settings are not overwritten with what that view showed');
  assert.deepEqual(project.analysisGroups![0].viewState, { chartMode: 'normalized' });
});
test('Column widths are not saved and saved ones are ignored', () => {
  const project = saveViewSettings({ ...emptyProject(), viewStates: { a: { viewStateScope: 'file', rawWidths: { time: 300 }, tableWidths: { s: 90 } } } }, 'a', { rawWidths: { time: 200 }, tableWidths: { s: 80 }, chartMode: 'raw' }, undefined);
  assert.deepEqual(project.viewStates.a, { chartMode: 'raw', viewStateScope: 'file' });
  assert.deepEqual(resolveViewSettings({ ...emptyProject(), viewStates: { a: { viewStateScope: 'file', rawWidths: { time: 300 }, chartMode: 'raw' } } }, 'a', undefined), { chartMode: 'raw' });
  const trace = saveViewSettings(emptyProject(), 'a', { traceSettings: { columns: ['count'], widths: { name: 320 } } }, undefined);
  assert.deepEqual(resolveViewSettings(trace, 'a', undefined), { traceSettings: { columns: ['count'] } });
});
test('Logs at the workspace root share view settings like the logs of any other group', () => {
  const layout = { traceSettings: { columns: ['count'] }, activeTab: 'table-view' };
  let project = switchViewSettingsScope(emptyProject(), 'log:a.blf', layout, undefined, 'group');
  assert.deepEqual(project.viewStates['group-view'], { traceSettings: { columns: ['count'] } }, 'the shared part is kept with the root');
  project = switchViewSettingsScope(project, 'log:b.csv', { activeTab: 'raw-view' }, undefined, 'group');
  project = saveViewSettings(project, 'log:a.blf', { ...layout, traceSettings: { columns: ['interval'] } }, undefined);
  assert.deepEqual(resolveViewSettings(project, 'log:b.csv', undefined).traceSettings, { columns: ['interval'] });
  assert.equal(resolveViewSettings(project, 'log:b.csv', undefined).activeTab, 'raw-view');
  // A root log that never chose keeps its own settings, as before.
  assert.deepEqual(resolveViewSettings({ ...emptyProject(), viewStates: { 'log:c.mf4': { viewStateScope: 'file', activeTab: 'raw-view' } } }, 'log:c.mf4', undefined), { activeTab: 'raw-view' });
  const restored = migrateProject(serializeProject(project));
  assert.deepEqual(resolveViewSettings(restored, 'log:b.csv', undefined), resolveViewSettings(project, 'log:b.csv', undefined));
});
