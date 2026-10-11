import test from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path'; import { createHash } from 'crypto';
import * as vscode from 'vscode';
import { ProjectStore } from '../src/extension/storage/projectStore';
const w = (root: string, rel: string, text: string) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const r = (root: string, rel: string) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
const frame = (id: string, canId: string) => ({ id, name: id, canId, frameLength: 8, signals: [] });
test('folder levels: load, save each level with level-relative paths, follow moves, and convert hashed view keys', async () => {
  // 1. Folder levels: load, compose, write a Clip into the right level, follow a move.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmixa-levels-'));
  (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file(root) }];
  w(root, '.sigmixa/project.json', JSON.stringify({ schemaVersion: 4, frames: [frame('common', '0x100')] }));
  w(root, 'A/.sigmixa/project.json', JSON.stringify({ schemaVersion: 4, frames: [frame('a', '0x100')] }));
  w(root, 'A/run01.asc', 'x'); w(root, 'A/sep/run02.asc', 'x'); w(root, 'B/cold/.sigmixa/project.json', JSON.stringify({ schemaVersion: 4, frames: [] }));
  w(root, 'B/.sigmixa/project.json', JSON.stringify({ schemaVersion: 4, frames: [] })); w(root, 'B/cold/run03.asc', 'x'); w(root, 'other/run04.asc', 'x');
  w(root, '.git/ignored.asc', 'x'); w(root, 'node_modules/x/ignored.asc', 'x');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmixa-outside-')); fs.writeFileSync(path.join(outside, 'remote.asc'), 'x');
  const store = new ProjectStore(); await store.load();
  // Logs added to level B also appear in it, like shortcuts: one outside the workspace and two in other folders.
  await store.addLogs('B', [path.join(outside, 'remote.asc'), path.join(root, 'other/run04.asc'), path.join(root, 'B/cold/run03.asc')]);
  assert.deepEqual(r(root, 'B/.sigmixa/project.json').addedLogs, [path.join(outside, 'remote.asc'), '../other/run04.asc', '../B/cold/run03.asc'].slice(0, 2).concat(['cold/run03.asc']));
  // They stay where they are, and use B's definitions only when opened from B.
  const run04 = path.join(root, 'other/run04.asc');
  assert.deepEqual(store.logs.filter((log) => log.path === 'other/run04.asc'), [{ path: 'other/run04.asc' }, { path: 'other/run04.asc', level: 'B' }]);
  assert.equal(store.levelOfFile(run04), ''); assert.equal(store.levelOfUri(vscode.Uri.file(run04)), ''); assert.equal(store.levelOfUri(store.logUri(run04, 'B')), 'B');
  assert.equal(store.logUri(run04, '').fragment, '', 'opened where it is, a log is the plain file');
  assert.notEqual(store.viewKey(store.logUri(run04, 'B')), store.viewKey(vscode.Uri.file(run04)), 'each place keeps its own view settings');
  // Adding it again, or adding a log to the level it is already in, changes nothing.
  await store.addLogs('B', [run04]); await store.addLogs('A', [path.join(root, 'A/run01.asc')]);
  assert.equal(r(root, 'B/.sigmixa/project.json').addedLogs.length, 3); assert.equal(r(root, 'A/.sigmixa/project.json').addedLogs, undefined);
  // Taking a log off the list leaves the file and its own place untouched.
  await store.removeAddedLog(path.join(root, 'B/cold/run03.asc'), 'B'); assert.deepEqual(store.logs.filter((log) => log.path === 'B/cold/run03.asc'), [{ path: 'B/cold/run03.asc' }]);
  assert.deepEqual(r(root, 'B/.sigmixa/project.json').addedLogs, [path.join(outside, 'remote.asc'), '../other/run04.asc']);
  assert.ok(!fs.readdirSync(path.join(root, 'B')).some((name) => name.includes('remote')), 'nothing is created next to the logs');
  assert.deepEqual([...store.levels].sort(), ['', 'A', 'B', 'B/cold']);
  assert.deepEqual(store.logs.map((log) => log.path).sort(), [path.join(outside, 'remote.asc'), 'A/run01.asc', 'A/sep/run02.asc', 'B/cold/run03.asc', 'other/run04.asc', 'other/run04.asc'].sort());
  assert.equal(store.current.analysisGroups!.find((g) => g.id === 'B/cold')!.parentId, 'B');
  assert.equal(store.levelOfUri(store.logUri(path.join(outside, 'remote.asc'), 'B')), 'B'); assert.equal(store.levelOfFile(path.join(root, 'A/sep/run02.asc')), 'A');
  await store.update((p) => ({ ...p, clips: [...p.clips, { id: 'c1', name: 'Clip', sourcePath: 'A/sep/run02.asc', sourceFileName: 'run02.asc', startTimestamp: 1, endTimestamp: 2 },
    { id: 'c2', name: 'Remote', sourcePath: path.join(outside, 'remote.asc'), sourceFileName: 'remote.asc' }],
    viewStates: { ...p.viewStates, [store.viewKey(path.join(root, 'A/sep/run02.asc'))]: { tab: 'raw' } } }));
  assert.deepEqual(r(root, 'A/.sigmixa/project.json').clips.map((c: any) => c.sourcePath), ['sep/run02.asc']);
  assert.deepEqual(Object.keys(r(root, 'A/.sigmixa/project.json').viewStates).sort(), ['log:sep/run02.asc']);
  // A Clip is stored with its log: one of a log outside the workspace goes to the common level, not to the group that added the log.
  assert.deepEqual(r(root, 'B/.sigmixa/project.json').clips, []);
  assert.deepEqual(r(root, '.sigmixa/project.json').clips.map((c: any) => c.sourcePath), [path.join(outside, 'remote.asc')]);
  assert.equal(store.levelOfUri(store.clipUri(store.current.clips.find((c) => c.id === 'c2')!, 'B')), 'B', 'a Clip opens with the definitions of the place it is opened from');
  assert.equal(store.viewKey(store.clipUri(store.current.clips.find((c) => c.id === 'c1')!)), store.viewKey(path.join(root, 'A/sep/run02.asc')), 'a Clip uses the view settings of its log');
  assert.ok(!fs.existsSync(path.join(root, 'other/.sigmixa')), 'no level file is created for a plain folder');
  // Move run02 from level A to level B/cold, as VS Code would report it.
  fs.mkdirSync(path.join(root, 'B/cold/moved'), { recursive: true }); fs.renameSync(path.join(root, 'A/sep/run02.asc'), path.join(root, 'B/cold/moved/run02.asc'));
  await store.followRenames([{ from: path.join(root, 'A/sep/run02.asc'), to: path.join(root, 'B/cold/moved/run02.asc') }]);
  assert.equal(r(root, 'A/.sigmixa/project.json').clips.length, 0);
  assert.deepEqual(r(root, 'B/cold/.sigmixa/project.json').clips.map((c: any) => c.sourcePath), ['moved/run02.asc']);
  assert.deepEqual(Object.keys(r(root, 'B/cold/.sigmixa/project.json').viewStates).sort(), ['log:moved/run02.asc']);
  // Rename a level folder: nothing inside it needs to change.
  const before = fs.readFileSync(path.join(root, 'B/cold/.sigmixa/project.json'), 'utf8');
  fs.renameSync(path.join(root, 'B/cold'), path.join(root, 'B/warm')); await store.followRenames([{ from: path.join(root, 'B/cold'), to: path.join(root, 'B/warm') }]);
  assert.equal(fs.readFileSync(path.join(root, 'B/warm/.sigmixa/project.json'), 'utf8'), before);
  assert.ok(!fs.existsSync(path.join(root, 'B/cold')), 'the old folder is not recreated');
  assert.equal(store.current.clips.find((c) => c.id === 'c1')!.sourcePath, 'B/warm/moved/run02.asc');

  // 2. Hashed view keys of a single-file workspace are converted on load; its groups are kept in the file, unused.
  const legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmixa-legacy-'));
  (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file(legacy) }];
  w(legacy, 'logs/run.asc', 'x'); w(legacy, 'logs/other.asc', 'x');
  const legacyOutside = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmixa-legacy-outside-')); const legacyExternal = path.join(legacyOutside, 'far.asc'); fs.writeFileSync(legacyExternal, 'x');
  const hash = (u: vscode.Uri) => `log-view:${createHash('sha256').update(u.toString()).digest('hex').slice(0, 20)}`;
  const runUri = vscode.Uri.file(path.join(legacy, 'logs/run.asc'));
  w(legacy, '.sigmixa/project.json', JSON.stringify({ schemaVersion: 4, frames: [frame('common', '0x100')], logPaths: ['logs/run.asc', 'logs/other.asc'],
    analysisGroups: [{ id: 'g1', name: 'Test/1', sourcePaths: ['logs/run.asc', legacyExternal], frames: [frame('g', '0x100')], viewState: { shared: 1 } }],
    clips: [{ id: 'k1', name: 'Clip', sourcePath: 'logs/run.asc', sourceFileName: 'run.asc', signalIds: [] }, { id: 'k2', name: 'Far', sourcePath: legacyExternal, sourceFileName: 'far.asc', startTimestamp: 5, endTimestamp: 6, signalIds: [] }],
    viewStates: { [hash(runUri)]: { tab: 'visualize' }, [hash(runUri.with({ fragment: 'sigmixa-clip=k1' }))]: { tab: 'raw' }, [hash(vscode.Uri.file(path.join(legacy, 'logs/other.asc')))]: { tab: 'table' }, [hash(vscode.Uri.file(legacyExternal))]: { tab: 'far' }, [hash(vscode.Uri.file(legacyExternal).with({ fragment: 'sigmixa-clip=k2' }))]: { tab: 'farclip' } } }));
  const old = new ProjectStore(); await old.load();
  assert.equal(old.legacyGroupCount, 1);
  assert.deepEqual(Object.keys(old.current.viewStates).sort(), [`log:${legacyExternal}`, 'log:logs/other.asc', 'log:logs/run.asc'].sort(), 'hashed keys are converted on load; Clips keep no settings of their own');
  for (const folder of [root, outside, legacy, legacyOutside]) fs.rmSync(folder, { recursive: true, force: true });
});

test('a 1.0.1 workspace loads as the common level without losing Clips, CSV sources or view settings, and is backed up before its first save', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmixa-101-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmixa-101-outside-'));
  (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file(root) }];
  w(root, 'logs/run.asc', 'x'); const external = path.join(outside, 'far.asc'); fs.writeFileSync(external, 'x'); const recent = path.join(outside, 'recent.asc');
  const hash = (u: vscode.Uri) => `log-view:${createHash('sha256').update(u.toString()).digest('hex').slice(0, 20)}`;
  const original = { schemaVersion: 2, frames: [frame('common', '0x100')], plugins: [], pluginBindings: [],
    externalCsvSources: [{ id: 'csv', path: 'data/ref.csv', fileName: 'ref.csv', timestampColumn: 'Time', timestampUnit: 'seconds', valueColumns: [{ column: 'V', name: 'V' }] }],
    clips: [{ id: 'in', name: 'Inside', sourcePath: 'logs/run.asc', sourceFileName: 'run.asc', startTimestamp: 1.25, endTimestamp: 2.5, signalIds: ['s1'] },
      { id: 'out', name: 'Outside', sourcePath: external, sourceFileName: 'far.asc', startTimestamp: 3, endTimestamp: 4, signalIds: [] }],
    lookupTables: [], calculations: [],
    viewStates: { 'log-view-default': { tab: 'raw' }, [hash(vscode.Uri.file(path.join(root, 'logs/run.asc')))]: { tab: 'table' }, [hash(vscode.Uri.file(external))]: { tab: 'visualize' },
      [hash(vscode.Uri.file(recent))]: { tab: 'recent' }, [hash(vscode.Uri.file(path.join(root, 'logs/run.asc')).with({ fragment: 'sigmixa-clip=in' }))]: { tab: 'clip' } } };
  w(root, '.sigmixa/project.json', JSON.stringify(original));
  const store = new ProjectStore(); store.setExternalLogHints([recent]); await store.load();
  assert.equal(store.legacyGroupCount, 0);
  assert.deepEqual(store.current.frames.map((item) => item.id), ['common']);
  assert.deepEqual(store.current.clips.map((clip) => [clip.id, clip.sourcePath, clip.startTimestamp, clip.endTimestamp]), [['in', 'logs/run.asc', 1.25, 2.5], ['out', external, 3, 4]], 'Clip ranges are unchanged');
  assert.equal(store.current.externalCsvSources[0].path, 'data/ref.csv');
  assert.deepEqual(store.current.viewStates[store.viewKey(path.join(root, 'logs/run.asc'))], { tab: 'table' });
  assert.deepEqual(store.current.viewStates[store.viewKey(external)], { tab: 'visualize' });
  assert.deepEqual(store.current.viewStates[store.viewKey(recent)], { tab: 'recent' });
  assert.deepEqual(store.current.viewStates['log-view-default'], { tab: 'raw' });
  await store.update((project) => project);
  const backups = fs.readdirSync(path.join(root, '.sigmixa')).filter((name) => name.endsWith('.bak'));
  assert.equal(backups.length, 1);
  // A key of a log that no longer exists stays unconverted; it must not cause a new backup on every later load and save.
  const leftover = r(root, '.sigmixa/project.json'); leftover.viewStates['log-view:0123456789abcdef0123'] = { tab: 'gone' }; w(root, '.sigmixa/project.json', JSON.stringify(leftover));
  for (let round = 0; round < 2; round++) { const again = new ProjectStore(); await again.load(); await again.update((project) => ({ ...project, viewStates: { ...project.viewStates, [`round-${round}`]: round } })); }
  assert.equal(fs.readdirSync(path.join(root, '.sigmixa')).filter((name) => name.endsWith('.bak')).length, 1, 'no further backups');
  assert.deepEqual(r(root, '.sigmixa/project.json').viewStates['log-view:0123456789abcdef0123'], { tab: 'gone' }, 'the leftover setting is kept'); assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, '.sigmixa', backups[0]), 'utf8')), original, 'the backup is the untouched 1.0.1 file');
  const saved = r(root, '.sigmixa/project.json');
  assert.deepEqual(saved.clips.map((clip: any) => [clip.sourcePath, clip.range]), [['logs/run.asc', { start: 1.25, end: 2.5 }], [external, { start: 3, end: 4 }]]);
  assert.equal(saved.externalCsvSources[0].path, 'data/ref.csv');
  for (const folder of [root, outside]) fs.rmSync(folder, { recursive: true, force: true });
});

test('a level file changed on disk is read again before a save, so the change is not overwritten', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmixa-external-'));
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root) }] as any;
  w(root, '.sigmixa/project.json', JSON.stringify({ schemaVersion: 4, frames: [frame('a', '0x100')] }));
  w(root, 'G/.sigmixa/project.json', JSON.stringify({ schemaVersion: 4, frames: [] }));
  const store = new ProjectStore(); await store.load();
  // Another window (or git, or a script) changes both files; this window then saves a view setting.
  w(root, '.sigmixa/project.json', JSON.stringify({ schemaVersion: 4, frames: [frame('a', '0x100'), frame('b', '0x200')] }));
  w(root, 'G/.sigmixa/project.json', JSON.stringify({ schemaVersion: 4, frames: [frame('g', '0x300')] }));
  await store.update((project) => ({ ...project, viewStates: { ...project.viewStates, 'log-view-default': { activeTab: 'table-view' } } }));
  assert.deepEqual(r(root, '.sigmixa/project.json').frames.map((item: any) => item.id), ['a', 'b']);
  assert.deepEqual(r(root, '.sigmixa/project.json').viewStates['log-view-default'], { activeTab: 'table-view' });
  assert.deepEqual(r(root, 'G/.sigmixa/project.json').frames.map((item: any) => item.id), ['g']);
});

test('a change read from disk is told apart from an edit made here', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmixa-disk-'));
  (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file(root) }];
  w(root, '.sigmixa/project.json', JSON.stringify({ schemaVersion: 4, frames: [], viewStates: { 'log:a.asc': { tab: 'raw' } } })); w(root, 'a.asc', 'x');
  const store = new ProjectStore(); await store.load();
  const seen: Array<[boolean, unknown]> = []; store.onDidChange((project) => seen.push([store.changeIsFromDisk, (project.viewStates[store.viewKey(path.join(root, 'a.asc'))] as any)?.tab]));
  await store.update((p) => ({ ...p, viewStates: { ...p.viewStates, [store.viewKey(path.join(root, 'a.asc'))]: { tab: 'table' } } }));
  assert.deepEqual(seen, [[false, 'table']]);
  // Another window saves the file. The next save here first reads it, and reports that as a change from disk.
  const onDisk = r(root, '.sigmixa/project.json'); onDisk.viewStates['log:a.asc'].tab = 'visualize'; w(root, '.sigmixa/project.json', JSON.stringify(onDisk));
  seen.length = 0; await store.update((p) => p);
  assert.deepEqual(seen[0], [true, 'visualize']); assert.equal(store.changeIsFromDisk, false);
  assert.equal(r(root, '.sigmixa/project.json').viewStates['log:a.asc'].tab, 'visualize', 'the change on disk is kept');
});

test('renaming a group follows references made in another group without moving that groups settings', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmixa-group-rename-'));
  try {
    (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file(root) }];
    w(root, 'A/run.asc', 'x');
    w(root, 'A/.sigmixa/project.json', JSON.stringify({ schemaVersion: 4, frames: [] }));
    w(root, 'B/.sigmixa/project.json', JSON.stringify({ schemaVersion: 4, frames: [], addedLogs: ['../A/run.asc'],
      clips: [{ id: 'b-clip', name: 'B clip', sourcePath: '../A/run.asc', sourceFileName: 'run.asc', startTimestamp: 1, endTimestamp: 2 }],
      viewStates: { 'log:../A/run.asc': { activeTab: 'visualize' }, 'clip:b-clip': { activeTab: 'table-view' } } }));
    const store = new ProjectStore(); await store.load();
    const from = vscode.Uri.file(path.join(root, 'A')); const to = vscode.Uri.file(path.join(root, 'Renamed'));
    // The group menu renames through workspace.fs; it must explicitly follow references, since that API does not emit onDidRenameFiles.
    await vscode.workspace.fs.rename(from, to, { overwrite: false });
    await store.followRenames([{ from: from.fsPath, to: to.fsPath }]);
    const saved = r(root, 'B/.sigmixa/project.json');
    assert.deepEqual(saved.addedLogs, ['../Renamed/run.asc']);
    // The Clip made in B belongs to the log, so it is stored with the log in the renamed group.
    assert.deepEqual(saved.clips, []); assert.deepEqual(r(root, 'Renamed/.sigmixa/project.json').clips.map((clip: any) => [clip.id, clip.sourcePath]), [['b-clip', 'run.asc']]);
    assert.deepEqual(saved.viewStates['log:../Renamed/run.asc'], { activeTab: 'visualize' });
    assert.equal(store.levelOfUri(store.logUri(path.join(root, 'Renamed/run.asc'), 'B')), 'B');
    assert.ok(!fs.existsSync(path.join(root, 'A')));
    store.dispose();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a deleted log takes its Clips, view settings and added references with it; other logs are untouched', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmixa-forget-'));
  try {
    (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file(root) }];
    w(root, 'A/run.asc', 'x'); w(root, 'A/keep.asc', 'x');
    w(root, 'A/.sigmixa/project.json', JSON.stringify({ schemaVersion: 4, frames: [],
      clips: [{ id: 'a1', name: 'Run', sourcePath: 'run.asc', sourceFileName: 'run.asc', signalIds: [], startTimestamp: 1, endTimestamp: 2 }, { id: 'a2', name: 'Keep', sourcePath: 'keep.asc', sourceFileName: 'keep.asc', signalIds: [] }],
      viewStates: { 'log:run.asc': { tab: 'raw' }, 'log:keep.asc': { tab: 'table' }, 'clip:a1': { tab: 'visualize' }, 'clip:a2': { tab: 'raw' } } }));
    w(root, 'B/.sigmixa/project.json', JSON.stringify({ schemaVersion: 4, frames: [], addedLogs: ['../A/run.asc', '../A/keep.asc'],
      clips: [{ id: 'b1', name: 'In B', sourcePath: '../A/run.asc', sourceFileName: 'run.asc', signalIds: [] }], viewStates: { 'log:../A/run.asc': { tab: 'raw' }, 'clip:b1': { tab: 'raw' } } }));
    const store = new ProjectStore(); await store.load();
    const file = path.join(root, 'A/run.asc');
    await vscode.workspace.fs.delete(vscode.Uri.file(file), { useTrash: true });
    await store.forgetLogs([file]);
    const a = r(root, 'A/.sigmixa/project.json'); const b = r(root, 'B/.sigmixa/project.json');
    assert.deepEqual(a.clips.map((clip: any) => clip.id), ['a2']); assert.deepEqual(Object.keys(a.viewStates).sort(), ['log:keep.asc']);
    assert.deepEqual(b.addedLogs, ['../A/keep.asc']); assert.deepEqual(b.clips, []); assert.deepEqual(Object.keys(b.viewStates), []);
    assert.deepEqual(store.logs.map((log) => log.path).sort(), ['A/keep.asc', 'A/keep.asc']);
    assert.deepEqual(store.current.clips.map((clip) => clip.id), ['a2']);
    store.dispose();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('removing a group keeps its folder and logs, which then use the level above', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmixa-dissolve-'));
  try {
    (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file(root) }];
    w(root, '.sigmixa/project.json', JSON.stringify({ schemaVersion: 4, frames: [frame('common', '0x100')] }));
    w(root, 'A/run.asc', 'x'); w(root, 'A/.sigmixa/project.json', JSON.stringify({ schemaVersion: 4, frames: [frame('a', '0x200')] }));
    w(root, 'A/inner/.sigmixa/project.json', JSON.stringify({ schemaVersion: 4, frames: [] })); w(root, 'A/inner/deep.asc', 'x');
    const store = new ProjectStore(); await store.load();
    assert.equal(store.levelOfFile(path.join(root, 'A/run.asc')), 'A');
    await store.removeLevel('A');
    assert.ok(!fs.existsSync(path.join(root, 'A/.sigmixa')) && fs.existsSync(path.join(root, 'A/run.asc')), 'only the group settings are removed');
    assert.deepEqual([...store.levels].sort(), ['', 'A/inner']); assert.equal(store.levelOfFile(path.join(root, 'A/run.asc')), '');
    assert.equal(store.levelOfFile(path.join(root, 'A/inner/deep.asc')), 'A/inner', 'a group inside it stays a group');
    // A later save does not bring the removed level file back.
    await store.update((project) => ({ ...project, frames: [...project.frames, frame('more', '0x300')] }));
    assert.ok(!fs.existsSync(path.join(root, 'A/.sigmixa')));
    await store.removeLevel(''); assert.ok(fs.existsSync(path.join(root, '.sigmixa/project.json')), 'the common level cannot be removed');
    store.dispose();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('moving a log into a group that had it as a link leaves one entry, with the Clips and settings of both places', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmixa-move-'));
  try {
    (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file(root) }];
    w(root, 'A/run.asc', 'x');
    w(root, 'A/.sigmixa/project.json', JSON.stringify({ schemaVersion: 4, frames: [], clips: [{ id: 'a1', name: 'Made in A', sourcePath: 'run.asc', sourceFileName: 'run.asc', signalIds: [] }], viewStates: { 'log:run.asc': { tab: 'raw' } } }));
    w(root, 'B/.sigmixa/project.json', JSON.stringify({ schemaVersion: 4, frames: [], addedLogs: ['../A/run.asc'], clips: [{ id: 'b1', name: 'Made in B', sourcePath: '../A/run.asc', sourceFileName: 'run.asc', signalIds: [] }] }));
    const store = new ProjectStore(); await store.load();
    const from = vscode.Uri.file(path.join(root, 'A/run.asc')); const to = vscode.Uri.file(path.join(root, 'B/run.asc'));
    await vscode.workspace.fs.rename(from, to, { overwrite: false }); await store.followRenames([{ from: from.fsPath, to: to.fsPath }]);
    await store.load();
    assert.deepEqual(store.logs.filter((log) => log.path === 'B/run.asc'), [{ path: 'B/run.asc' }], 'the log is listed once, where it now is');
    const b = r(root, 'B/.sigmixa/project.json');
    assert.deepEqual(b.clips.map((clip: any) => [clip.id, clip.sourcePath]).sort(), [['a1', 'run.asc'], ['b1', 'run.asc']]);
    assert.ok(!(b.addedLogs ?? []).length, 'the link is no longer needed');
    assert.deepEqual(r(root, 'A/.sigmixa/project.json').clips, []);
    store.dispose();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Clips belong to the log: every place shows them, a copy of the log gets them too, and each place opens them with its own settings', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmixa-clips-'));
  try {
    (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file(root) }];
    w(root, 'A/run.asc', 'x');
    w(root, 'A/.sigmixa/project.json', JSON.stringify({ schemaVersion: 4, frames: [], clips: [{ id: 'a1', name: 'Stop', sourcePath: 'run.asc', sourceFileName: 'run.asc', range: { start: 1, end: 2 } }] }));
    // A file of an earlier version: a Clip made in B through a link, with settings and a Signal selection of its own.
    w(root, 'B/.sigmixa/project.json', JSON.stringify({ schemaVersion: 4, frames: [], addedLogs: ['../A/run.asc'],
      clips: [{ id: 'b1', name: 'Made in B', sourcePath: '../A/run.asc', sourceFileName: 'run.asc', signalIds: ['s'], range: { start: 3, end: 4 } }], viewStates: { 'clip:b1': { tab: 'raw' } } }));
    const store = new ProjectStore(); await store.load();
    const file = path.join(root, 'A/run.asc');
    assert.deepEqual(store.current.clips.map((clip) => [clip.id, clip.sourcePath]).sort(), [['a1', 'A/run.asc'], ['b1', 'A/run.asc']], 'both Clips are Clips of the one log');
    const a1 = store.current.clips.find((clip) => clip.id === 'a1')!;
    assert.equal(store.levelOfUri(store.clipUri(a1)), 'A'); assert.equal(store.levelOfUri(store.clipUri(a1, 'B')), 'B');
    assert.equal(store.viewKey(store.clipUri(a1, 'B')), store.viewKey(store.logUri(file, 'B')), 'opened from B, the Clip uses the settings of the log in B');
    assert.notEqual(store.viewKey(store.clipUri(a1, 'B')), store.viewKey(store.clipUri(a1)));
    // Copy the log into B: the copy gets the same Clips under new IDs; nothing else is copied.
    const copy = path.join(root, 'B/run.asc'); fs.copyFileSync(file, copy); let next = 0;
    assert.equal(await store.copyClips(file, copy, () => `copy-${++next}`), 2);
    const a = r(root, 'A/.sigmixa/project.json'); const b = r(root, 'B/.sigmixa/project.json');
    assert.deepEqual(a.clips.map((clip: any) => [clip.id, clip.sourcePath, clip.range]).sort(), [['a1', 'run.asc', { start: 1, end: 2 }], ['b1', 'run.asc', { start: 3, end: 4 }]], 'Clips are stored with their log');
    assert.deepEqual(b.clips.map((clip: any) => [clip.id, clip.name, clip.sourcePath, clip.range]).sort(), [['copy-1', 'Stop', 'run.asc', { start: 1, end: 2 }], ['copy-2', 'Made in B', 'run.asc', { start: 3, end: 4 }]]);
    assert.ok(a.clips.concat(b.clips).every((clip: any) => !('signalIds' in clip) && !('level' in clip)), 'a Clip is only a name and a time range');
    assert.deepEqual(Object.keys(b.viewStates ?? {}).filter((key) => key.startsWith('clip:')), [], 'Clips keep no settings of their own');
    store.dispose();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a log moved in from outside the workspace keeps its Clips, and the settings made in the group it is moved into', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmixa-movein-')); const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmixa-movein-outside-'));
  try {
    (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file(root) }];
    const far = path.join(outside, 'far.asc'); fs.writeFileSync(far, 'x');
    // The outside log is linked in the workspace level and in group B; each place has settings for it, and it has one Clip.
    w(root, '.sigmixa/project.json', JSON.stringify({ schemaVersion: 4, frames: [], addedLogs: [far], clips: [{ id: 'c', name: 'Part', sourcePath: far, sourceFileName: 'far.asc', range: { start: 1, end: 2 } }], viewStates: { [`log:${far}`]: { tab: 'root' } } }));
    w(root, 'B/.sigmixa/project.json', JSON.stringify({ schemaVersion: 4, frames: [], addedLogs: [far], viewStates: { [`log:${far}`]: { tab: 'in B' } } }));
    const store = new ProjectStore(); await store.load();
    const to = path.join(root, 'B/far.asc'); fs.renameSync(far, to);
    await store.followRenames([{ from: far, to }]); await store.load();
    const rootFile = r(root, '.sigmixa/project.json'); const b = r(root, 'B/.sigmixa/project.json');
    assert.deepEqual(store.logs.filter((log) => log.path === 'B/far.asc'), [{ path: 'B/far.asc' }, { path: 'B/far.asc', level: '' }], 'it is in B, and still linked in the workspace level');
    assert.deepEqual(rootFile.addedLogs, ['B/far.asc']); assert.ok(!(b.addedLogs ?? []).length, 'the link in B is no longer needed');
    assert.deepEqual(b.clips.map((clip: any) => [clip.id, clip.sourcePath]), [['c', 'far.asc']]); assert.deepEqual(rootFile.clips, []);
    assert.deepEqual(b.viewStates['log:far.asc'], { tab: 'in B' }, 'the settings made in B are the ones kept there');
    store.dispose();
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
});
