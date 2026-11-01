import test from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { RawLogDocument } from '../src/extension/editors/rawLogDocument';
import { PluginRegistry } from '../src/core/plugin/pluginHost';
import { emptyProject } from '../src/core/project/schema';

test('RAW log shows Plugin values and diagnostics on every frame, not only the most recent ones', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmixa-plugin-display-'));
  (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file(root) }];
  (vscode.workspace as any).getWorkspaceFolder = () => vscode.workspace.workspaceFolders![0];
  const file = path.join(root, 'run.asc');
  const lines = ['base hex timestamps absolute'];
  for (let index = 0; index < 8000; index++) lines.push(`${(index / 1000).toFixed(6)} 1 123 Rx d 1 ${(index % 256).toString(16).padStart(2, '0')}`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const registry = new PluginRegistry();
  registry.register({ id: 'byte', version: '1', getSupportedFrames: () => ({ type: 'any' }), processFrame: (frame) => frame.data[0] === 0
    ? { status: 'error', diagnostics: [{ severity: 'warning', code: 'ZERO', message: 'zero byte' }] }
    : { status: 'handled', samples: [{ signalId: 'b', name: 'Byte', unit: 'cnt', value: frame.data[0] }, { signalId: 'b', name: 'Byte', unit: 'cnt', value: frame.data[0] + 1000 }] } });
  const project = { ...emptyProject(), frames: [{ id: 'def', name: 'Status', canId: 0x123, extended: false, frameLength: 1, signals: [] }],
    plugins: [{ id: 'byte', version: '1', source: 'memory', enabled: true }],
    pluginBindings: [{ id: 'bind', pluginId: 'byte', frameId: 'def', enabled: true, automatic: false }] } as never;
  const doc = new RawLogDocument(vscode.Uri.file(file), file, project, 1, registry);
  try {
    await doc.whenReady();
    const first = doc.query({ offset: 1, limit: 1 }, project, 1).rows[0];
    assert.equal(first.decodedContent, 'Byte=1 cnt  ·  Byte=1001 cnt');
    const last = doc.query({ offset: 7999, limit: 1 }, project, 1).rows[0];
    assert.equal(last.decodedContent, `Byte=${7999 % 256} cnt  ·  Byte=${1000 + 7999 % 256} cnt`);
    // Column autofit sees the same Plugin tags the RAW log shows.
    const widest = await doc.widthRows({}, project, 1);
    assert.equal(Math.max(...widest.map((row) => row.decodedContent.length)), 'Byte=255 cnt  ·  Byte=1255 cnt'.length);
    const zero = doc.query({ offset: 0, limit: 1 }, project, 1).rows[0];
    assert.equal(zero.decodedContent, '');
    assert.ok(zero.diagnostics.length > 0);
  } finally { doc.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
});
