import test from 'node:test';
import assert from 'node:assert/strict';
import { clipboardFiles, pathsFromClipboardText } from '../src/extension/platform/clipboardFiles';

test('copied paths are read one per line, as plain paths or file URIs', () => {
  assert.deepEqual(pathsFromClipboardText('/logs/a.asc\n/logs/日本 語.blf\n'), ['/logs/a.asc', '/logs/日本 語.blf']);
  assert.deepEqual(pathsFromClipboardText('file:///logs/a%20b.asc'), ['/logs/a b.asc']);
  assert.deepEqual(pathsFromClipboardText('/logs/a.asc\n/logs/a.asc'), ['/logs/a.asc'], 'the same file is listed once');
});

test('ordinary text on the clipboard is not a file list', () => {
  assert.deepEqual(pathsFromClipboardText('Vehicle speed'), []);
  assert.deepEqual(pathsFromClipboardText('/logs/a.asc\nand some words'), []);
  assert.deepEqual(pathsFromClipboardText(''), []);
});

test('without a file manager list, paths copied as text are used', async () => {
  assert.deepEqual(await clipboardFiles(async () => '/logs/a.asc', 'linux'), ['/logs/a.asc']);
});
