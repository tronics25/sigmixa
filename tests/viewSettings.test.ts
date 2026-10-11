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
  project = switchViewSettingsScope(project, 'b', resolveViewSettings(project, 'b', current()), current(), 'file');
  project = saveViewSettings(project, 'a', { ...layout, visualizeViews: [] }, current());
  assert.deepEqual(resolveViewSettings(project, 'b', current()).visualizeViews, layout.visualizeViews);
  const restored = migrateProject(serializeProject(project));
  assert.deepEqual(resolveViewSettings(restored, 'b', restored.analysisGroups![0]), resolveViewSettings(project, 'b', current()));
});
