import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyProject, type SigMixaProject } from '../src/core/project/schema';
import { composeWorkspace, levelOf, parentLevelOf, splitWorkspace, type LevelFile, type WorkspaceLog } from '../src/core/project/folderLevels';
import { overrideTemplate, promoteGroupFrames, resolveGroupProject } from '../src/core/project/analysisGroups';
import type { ManualFrameDefinition } from '../src/core/manual/manualDefinition';

const frame = (id: string, canId: number): ManualFrameDefinition => ({ id, name: id, canId, extended: false, frameLength: 8, signals: [] });
const level = (folder: string, change: Partial<SigMixaProject> = {}): LevelFile => ({ folder, project: { ...emptyProject(), ...change } });
const folders = ['', 'A', 'B', 'B/cold'];

test('a log belongs to the nearest level above it; folders without .sigmixa belong to their parent level', () => {
  assert.equal(levelOf(folders, 'A/run01.asc'), 'A');
  assert.equal(levelOf(folders, 'A/september/run02.asc'), 'A');
  assert.equal(levelOf(folders, 'B/cold/run03.asc'), 'B/cold');
  assert.equal(levelOf(folders, 'other/run04.asc'), '');
  assert.equal(levelOf(folders, 'AB/run05.asc'), '', 'a folder name prefix is not a parent folder');
  assert.equal(parentLevelOf(folders, 'B/cold'), 'B');
  assert.equal(parentLevelOf(folders, 'A'), '');
  assert.equal(parentLevelOf(folders, ''), undefined);
});

test('levels compose into one project with workspace paths and split back to the same files with level-relative paths', () => {
  const logs: WorkspaceLog[] = [{ path: 'A/run01.asc' }, { path: 'A/september/run02.asc' }, { path: 'B/cold/run03.asc' }, { path: 'other/run04.asc' },
    { path: '//server/share/remote.asc', level: 'B' }];
  const files: LevelFile[] = [
    level('', { frames: [frame('common', 0x100)], viewStates: { 'log-view-default': { tab: 'raw' }, 'log:other/run04.asc': { tab: 'table' } } }),
    level('A', { frames: [frame('a', 0x100)], clips: [{ id: 'c1', name: 'Brake', sourcePath: 'september/run02.asc', sourceFileName: 'run02.asc', startTimestamp: 1, endTimestamp: 2 }],
      viewStates: { 'log:september/run02.asc': { tab: 'visualize' }, 'clip:c1': { tab: 'table' }, 'group-view': { shared: true } },
      externalCsvSources: [{ id: 'csv', path: 'data/ref.csv', fileName: 'ref.csv', timestampColumn: 'Time', timestampUnit: 'seconds', valueColumns: [] }] }),
    level('B', { addedLogs: ['//server/share/remote.asc'], clips: [{ id: 'c2', name: 'Remote', sourcePath: '//server/share/remote.asc', sourceFileName: 'remote.asc' }], viewStates: { 'log://server/share/remote.asc': { tab: 'raw' } } }),
    level('B/cold', { frames: [frame('cold', 0x200)] }),
  ];
  const project = composeWorkspace(files, logs);
  assert.deepEqual(project.logPaths, ['other/run04.asc']);
  const a = project.analysisGroups!.find((group) => group.id === 'A')!;
  assert.deepEqual([a.name, a.parentId, a.sourcePaths], ['A', undefined, ['A/run01.asc', 'A/september/run02.asc']]);
  assert.deepEqual(a.viewState, { shared: true });
  assert.equal(a.definitionDependencies?.externalCsvSources[0].path, 'A/data/ref.csv');
  assert.equal(project.analysisGroups!.find((group) => group.id === 'B/cold')!.parentId, 'B');
  assert.deepEqual(project.analysisGroups!.find((group) => group.id === 'B')!.sourcePaths, ['//server/share/remote.asc'], 'an added log appears in the level that lists it');
  assert.deepEqual(project.clips.map((clip) => clip.sourcePath), ['A/september/run02.asc', '//server/share/remote.asc']);
  // A Clip has no view settings of its own: the 'clip:c1' entry of an earlier version is not carried over.
  assert.deepEqual(Object.keys(project.viewStates).sort(), ['log-view-default', 'log:A/september/run02.asc', 'log:other/run04.asc', 'log@B://server/share/remote.asc']);

  const split = splitWorkspace(project, folders, logs);
  assert.deepEqual(split.get('A')!.clips[0].sourcePath, 'september/run02.asc');
  assert.deepEqual(split.get('A')!.viewStates, { 'group-view': { shared: true }, 'log:september/run02.asc': { tab: 'visualize' } });
  assert.equal(split.get('A')!.externalCsvSources[0].path, 'data/ref.csv');
  assert.deepEqual(split.get('B')!.clips, [], 'a Clip is stored with its log, not in a group the log was added to');
  assert.equal(split.get('')!.clips[0].sourcePath, '//server/share/remote.asc', 'a Clip of a log outside the workspace is stored in the common level, with its absolute path');
  assert.deepEqual(split.get('B')!.addedLogs, ['//server/share/remote.asc']);
  assert.deepEqual(split.get('B')!.viewStates, { 'log://server/share/remote.asc': { tab: 'raw' } });
  assert.deepEqual(split.get('')!.viewStates, { 'log-view-default': { tab: 'raw' }, 'log:other/run04.asc': { tab: 'table' } });
  assert.deepEqual(split.get('B/cold')!.frames.map((item) => item.id), ['cold']);
  // Composing the split files again gives the same project.
  const again = composeWorkspace(folders.map((folder) => ({ folder, project: split.get(folder)! })), logs);
  assert.deepEqual({ ...again, clips: [...again.clips].sort((a, b) => a.id.localeCompare(b.id)) }, { ...project, clips: [...project.clips].sort((a, b) => a.id.localeCompare(b.id)) });
});

test('definitions overlay level by level, and promotion moves Frames one level up', () => {
  const project = composeWorkspace([level('', { frames: [frame('common', 0x100), frame('only-common', 0x300)] }), level('B', { frames: [frame('b', 0x100)] }), level('B/cold', { frames: [frame('cold', 0x100), frame('cold-only', 0x200)] })], []);
  assert.deepEqual(resolveGroupProject(project, 'B/cold').frames.map((item) => item.id).sort(), ['cold', 'cold-only', 'only-common']);
  assert.deepEqual(resolveGroupProject(project, 'B').frames.map((item) => item.id).sort(), ['b', 'only-common']);
  const promoted = promoteGroupFrames(project, 'B/cold', ['cold-only']);
  assert.deepEqual(promoted.frames.map((item) => item.id), ['common', 'only-common'], 'the common definitions are untouched');
  assert.deepEqual(promoted.analysisGroups!.find((group) => group.id === 'B')!.frames.map((item) => item.id), ['b', 'cold-only']);
  assert.deepEqual(promoted.analysisGroups!.find((group) => group.id === 'B/cold')!.frames.map((item) => item.id), ['cold']);
  assert.deepEqual(promoteGroupFrames(project, 'B', ['b']).frames.map((item) => item.id), ['only-common', 'b'], 'a level directly below the common one promotes into it');
});

test('a new Frame in a group starts from the definition it overrides, found in the nearest level above', () => {
  const signal = { id: 'speed', name: 'Speed', unit: 'km/h', byteOffset: 0, bitOffset: 0, lengthBits: 16, signedness: 'unsigned' as const, byteOrder: 'little' as const, conversion: { type: 'scale-offset' as const, lsb: 0.1, lsbText: '0.1', offset: 0 } };
  const common = { ...frame('common', 0x100), name: 'Engine', frameLength: 8, signals: [signal] };
  const middle = { ...frame('middle', 0x100), name: 'Engine (B)', frameLength: 16, signals: [{ ...signal, lsb: 1 }] };
  const project = composeWorkspace([level('', { frames: [common] }), level('B', { frames: [middle] }), level('B/cold'), level('A')], []);
  const fromB = overrideTemplate(project, 'B/cold', 0x100, false, 'new-id')!;
  assert.deepEqual([fromB.id, fromB.name, fromB.frameLength, fromB.signals.map((item) => item.id)], ['new-id', 'Engine (B)', 16, ['speed']], 'the nearest level above wins');
  assert.equal(overrideTemplate(project, 'A', 0x100, false, 'x')!.name, 'Engine');
  assert.equal(overrideTemplate(project, 'A', 0x200, false, 'x'), undefined, 'a CAN ID not defined above starts empty');
  assert.equal(overrideTemplate(project, 'A', 0x100, true, 'x'), undefined, 'standard and extended IDs are different CAN IDs');
  fromB.signals[0].name = 'changed';
  assert.equal(project.analysisGroups!.find((group) => group.id === 'B')!.frames[0].signals[0].name, 'Speed', 'the copy does not change the definition above');
});
