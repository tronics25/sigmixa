import test from 'node:test';
import assert from 'node:assert/strict';
import { VisualizeView } from '../src/webview/raw/visualizeView';
import type { ToExtensionMessage } from '../src/extension/editors/rawLogProtocol';

test('export still reaches the format chooser when no view produces an image', () => {
  const messages: ToExtensionMessage[] = [];
  // Exercise the production click handler without creating an unrelated DOM/layout fixture.
  const saveSheet = (VisualizeView.prototype as unknown as { saveSheet(): void }).saveSheet;
  for (const entries of [[], [{ definition: { name: 'Empty graph' }, view: { renderImage: () => undefined } }]]) {
    saveSheet.call({ entries, timeline: { position: 12.5 }, post: (message: ToExtensionMessage) => messages.push(message) });
  }
  assert.deepEqual(messages, [
    { type: 'exportVisualize', trajectoryCurrentTime: 12.5 },
    { type: 'exportVisualize', trajectoryCurrentTime: 12.5 },
  ]);
});
