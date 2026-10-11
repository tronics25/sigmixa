import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyProject, type SigMixaProject } from '../src/core/project/schema';
import { composeWorkspace, levelOf, parentLevelOf, splitWorkspace, type LevelFile, type WorkspaceLog } from '../src/core/project/folderLevels';
import { clipKey, findClip, movedSource } from '../src/core/project/clipIdentity';
import { overrideTemplate, promoteGroupFrames, resolveGroupProject } from '../src/core/project/analysisGroups';
import type { ManualFrameDefinition } from '../src/core/manual/manualDefinition';
import { withClipRange } from '../src/core/project/clipRangeEdit';

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

test('a Clip is its log and its ID together: a copied group has Clips of its own, and no ID is changed', () => {
  const clip = { id: 'clip-1', name: 'Stop 1', sourcePath: 'run.asc', sourceFileName: 'run.asc', startTimestamp: 1, endTimestamp: 2 };
  // B is the original and A its copy, read first. The files hold the same ID twice.
  const files = [level(''), level('A', { clips: [clip] }), level('B', { clips: [clip] })];
  const logs: WorkspaceLog[] = [{ path: 'A/run.asc' }, { path: 'B/run.asc' }];
  const project = composeWorkspace(files, logs);
  assert.deepEqual(project.clips.map((item) => [item.sourcePath, item.id]), [['A/run.asc', 'clip-1'], ['B/run.asc', 'clip-1']], 'both keep the ID they have in their files');
  assert.notEqual(clipKey(project.clips[0]), clipKey(project.clips[1]));
  const ofB = { id: 'clip-1', sourcePath: 'B/run.asc' }; const ofA = { id: 'clip-1', sourcePath: 'A/run.asc' };
  assert.equal(findClip(project.clips, ofB), project.clips[1]); assert.equal(findClip(project.clips, ofA), project.clips[0]);
  // A change to the Clip of B is a change to that Clip only.
  const changed = withClipRange(project, ofB, 5, 6);
  assert.deepEqual(changed.clips.map((item) => [item.sourcePath, item.startTimestamp, item.endTimestamp]), [['A/run.asc', 1, 2], ['B/run.asc', 5, 6]]);
  const split = splitWorkspace(changed, ['', 'A', 'B'], logs);
  assert.deepEqual(split.get('A')!.clips.map((item) => [item.id, item.startTimestamp]), [['clip-1', 1]]); assert.deepEqual(split.get('B')!.clips.map((item) => [item.id, item.startTimestamp]), [['clip-1', 5]]);
  // The Clip of B is deleted. Whoever still holds it finds nothing: the Clip of A is another Clip.
  const deleted = { ...changed, clips: changed.clips.filter((item) => clipKey(item) !== clipKey(ofB)) };
  assert.equal(findClip(deleted.clips, ofB), undefined); assert.equal(findClip(deleted.clips, ofA)?.startTimestamp, 1);
  assert.equal(withClipRange(deleted, ofB, 8, 9), deleted, 'and a change meant for it changes nothing');
  // A log that is not where the holder says has no such Clip either; nothing is guessed from the ID.
  assert.equal(findClip(project.clips, { id: 'clip-1', sourcePath: 'elsewhere/run.asc' }), undefined);
});

test('two Clips of one log with the same ID, from two files of an older version, are told apart', () => {
  const clip = { id: 'clip-1', name: 'Stop 1', sourcePath: 'A/run.asc', sourceFileName: 'run.asc', startTimestamp: 1, endTimestamp: 2 };
  // The root file names the log from the workspace, the group's file from its own folder: the same log, the same ID.
  const project = composeWorkspace([level('', { clips: [clip] }), level('A', { clips: [{ ...clip, sourcePath: 'run.asc', name: 'Again' }] })], [{ path: 'A/run.asc' }]);
  assert.deepEqual(project.clips.map((item) => [item.sourcePath, item.id, item.name]), [['A/run.asc', 'clip-1', 'Stop 1'], ['A/run.asc', 'clip-1-2', 'Again']]);
});

test('a held log path follows a move of the log or of a folder above it; other paths are left alone', () => {
  const moves = [{ from: 'A', to: 'B' }];
  assert.equal(movedSource('A/run.asc', moves), 'B/run.asc'); assert.equal(movedSource('A/sub/run.asc', moves), 'B/sub/run.asc'); assert.equal(movedSource('A', moves), 'B');
  assert.equal(movedSource('AB/run.asc', moves), 'AB/run.asc', 'a folder whose name only starts the same is another folder');
  assert.equal(movedSource('C/run.asc', moves), 'C/run.asc'); assert.equal(movedSource('A/run.asc', []), 'A/run.asc');
});
