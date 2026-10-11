import test from 'node:test';
import assert from 'node:assert/strict';
import { refuseTransfer, type TransferItem } from '../src/core/project/logTransfer';
import type { WorkspaceLog } from '../src/core/project/folderLevels';

const levels = ['', 'A', 'B', 'B/cold'];
const logs: WorkspaceLog[] = [{ path: 'A/run.asc' }, { path: 'plain/other.asc' }, { path: 'A/run.asc', level: 'B' }, { path: '/outside/far.asc', level: 'B' }];
const item = (located: string, change: Partial<TransferItem> = {}): TransferItem => ({ located, listed: false, exists: true, ...change });

test('link: refused only when the destination group already holds or shows the log', () => {
  assert.equal(refuseTransfer('link', item('A/run.asc'), 'B/cold', levels, logs, false), undefined);
  assert.equal(refuseTransfer('link', item('A/run.asc'), 'A', levels, logs, false), 'already-in-group', 'the group it is in');
  assert.equal(refuseTransfer('link', item('A/run.asc'), 'A/sub', levels, logs, false), 'already-in-group', 'a plain folder of that group');
  assert.equal(refuseTransfer('link', item('A/run.asc'), 'B', levels, logs, false), 'already-in-group', 'already added there');
  assert.equal(refuseTransfer('link', item('plain/other.asc'), '', levels, logs, false), 'already-in-group', 'the common level holds it');
  assert.equal(refuseTransfer('link', item('/outside/far.asc', { listed: true }), 'A', levels, logs, false), undefined, 'a reference can be added to another group');
  assert.equal(refuseTransfer('link', item('/outside/far.asc', { listed: true }), 'B', levels, logs, false), 'already-in-group');
});

test('move: only the file where it is (also from outside the workspace), to another folder, never overwriting', () => {
  assert.equal(refuseTransfer('move', item('A/run.asc'), 'B', levels, logs, false), undefined);
  assert.equal(refuseTransfer('move', item('A/run.asc'), '', levels, logs, false), undefined, 'to the workspace root');
  assert.equal(refuseTransfer('move', item('A/run.asc'), 'A', levels, logs, false), 'same-folder');
  assert.equal(refuseTransfer('move', item('A/run.asc'), 'B', levels, logs, true), 'target-exists');
  assert.equal(refuseTransfer('move', item('A/run.asc', { listed: true }), 'B/cold', levels, logs, false), 'link-cannot-move');
  assert.equal(refuseTransfer('move', item('/outside/far.asc'), 'A', levels, logs, false), undefined, 'a log outside the workspace can be moved in');
  assert.equal(refuseTransfer('move', item('C:\\logs\\far.asc'), 'A', levels, logs, false), undefined);
  assert.equal(refuseTransfer('move', item('/outside/far.asc'), 'A', levels, logs, true), 'target-exists');
  assert.equal(refuseTransfer('move', item('/outside/far.asc', { listed: true }), 'A', levels, logs, false), 'link-cannot-move');
});

test('copy: a reference or an outside log can be copied; not into its own folder, never overwriting', () => {
  assert.equal(refuseTransfer('copy', item('A/run.asc'), 'B', levels, logs, false), undefined);
  assert.equal(refuseTransfer('copy', item('A/run.asc', { listed: true }), 'B', levels, logs, false), undefined);
  assert.equal(refuseTransfer('copy', item('/outside/far.asc', { listed: true }), 'A', levels, logs, false), undefined);
  assert.equal(refuseTransfer('copy', item('A/run.asc'), 'A', levels, logs, false), 'same-folder');
  assert.equal(refuseTransfer('copy', item('A/run.asc'), 'B', levels, logs, true), 'target-exists');
});

test('a log that is not found cannot be moved, copied or added', () => {
  for (const mode of ['link', 'move', 'copy'] as const) assert.equal(refuseTransfer(mode, item('A/gone.asc', { exists: false }), 'B', levels, logs, false), 'not-found');
});
