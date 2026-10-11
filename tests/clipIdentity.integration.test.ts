import test from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { clipKey, isClip } from '../src/core/project/clipIdentity';
import { withClipRange } from '../src/core/project/clipRangeEdit';
import { ProjectStore } from '../src/extension/storage/projectStore';
import { RawLogEditorProvider } from '../src/extension/editors/rawLogEditor';

test('a restored Clip stays on its log through edits, deletion, restart and a surviving copy being renamed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmixa-clip-identity-'));
  (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file(root) }];
  (vscode.workspace as any).getWorkspaceFolder = () => vscode.workspace.workspaceFolders![0];
  for (const folder of ['A', 'B']) {
    fs.mkdirSync(path.join(root, folder, '.sigmixa'), { recursive: true });
    fs.writeFileSync(path.join(root, folder, 'run.asc'), 'base hex timestamps absolute\n0.000000 1 100 Rx d 1 00\n10.000000 1 100 Rx d 1 01\n');
    fs.writeFileSync(path.join(root, folder, '.sigmixa/project.json'), JSON.stringify({ schemaVersion: 4, frames: [], clips: [
      { id: 'c1', name: `${folder} Clip`, sourcePath: 'run.asc', sourceFileName: 'run.asc', startTimestamp: folder === 'A' ? 5 : 1, endTimestamp: folder === 'A' ? 6 : 2 },
    ] }));
  }
  const store = new ProjectStore(); const restarted = new ProjectStore();
  try {
    await store.load();
    const uri = vscode.Uri.file(path.join(root, 'B/run.asc')).with({ fragment: 'sigmixa-clip=c1' });
    const provider = new RawLogEditorProvider(vscode.Uri.file(root), {} as never, store, {} as never, { registry: new Map() } as never);
    const doc = provider.openCustomDocument(uri);
    try { await doc.whenReady(); assert.deepEqual(doc.scope, { start: 1, end: 2 }); } finally { doc.dispose(); }
    const survivor = store.findClip('c1', path.join(root, 'A/run.asc'))!;
    // A range message from the restored tab carries the old ID and its own log path.
    await store.update((project) => withClipRange(project, store.clipRef('c1', uri.fsPath), 2, 3));
    assert.equal(store.findClip('c1', uri.fsPath)?.startTimestamp, 2);
    assert.deepEqual(store.findClip('c1', path.join(root, 'A/run.asc')), survivor);
    assert.equal(survivor.id, 'c1', 'neither Clip was given another ID');
    const deleted = store.findClip('c1', uri.fsPath)!;
    await store.update((project) => ({ ...project, clips: project.clips.filter((clip) => clipKey(clip) !== clipKey(deleted)) }));
    assert.equal(store.findClip('c1', uri.fsPath), undefined);
    assert.throws(() => provider.openCustomDocument(uri), /Clip no longer exists/);
    // Late range, rename and delete operations cannot touch the surviving copy.
    const gone = store.clipRef('c1', uri.fsPath);
    await store.update((project) => withClipRange(project, gone, 8, 9));
    await store.update((project) => ({ ...project, clips: project.clips.map((clip) => isClip(clip, gone) ? { ...clip, name: 'wrong' } : clip).filter((clip) => !isClip(clip, gone)) }));
    assert.deepEqual(store.current.clips, [survivor]);
    await restarted.load();
    assert.equal(restarted.findClip('c1', uri.fsPath), undefined, 'a restart cannot restore the deleted Clip through its copy');
    const from = path.join(root, 'A/run.asc'); const to = path.join(root, 'A/renamed.asc');
    fs.renameSync(from, to); await restarted.followRenames([{ from, to }]);
    assert.equal(restarted.findClip('c1', from), undefined, 'an outdated path cannot guess a rename');
    assert.equal(restarted.findClip('c1', to)?.sourcePath, 'A/renamed.asc', 'the updated path still resolves the same Clip');
  } finally { store.dispose(); restarted.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
});
