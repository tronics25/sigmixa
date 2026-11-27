// Every press on the screen of a Clip, opened from the Analysis Groups pane.
import test from 'node:test';
import { pressEverything, start } from './check';
import { rows } from './sidebar';
import { commands } from './vscodeHost';

test('every press on the screen of a Clip does something, without an error', async () => {
  const harness = await start();
  try {
    const clip = (await rows('sigmixa.analysisGroups')).find((row) => row.contextValue === 'sigmixa.clip');
    if (!clip) throw new Error('the sample workspace has no Clip');
    const before = harness.screens.length;
    await commands.executeCommand('sigmixa.openItem', clip.node);
    const screen = await harness.waitFor(() => harness.screens[before], 'the Clip screen');
    await harness.waitFor(() => screen.received.some((message) => message.type === 'ready'), 'the Clip screen to start');
    await harness.settle(600);
    await pressEverything(harness, screen, `clip ${clip.label}`);
  } finally { await harness.close(); }
});
