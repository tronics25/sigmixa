// Sidebar flows that Codex reviews found broken once: each is run as a user does it, and its result looked at.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { start } from './check';
import { rows } from './sidebar';
import { commands, host } from './vscodeHost';
import { isOpenableLogFileName } from '../../src/core/project/folderLevels';

test('every kind of log the sidebar opens is watched, so a log restored on disk can be opened again without Refresh', async () => {
  const harness = await start();
  try {
    for (const extension of ['asc', 'blf', 'mf4', 'mdf', 'csv']) for (const name of [`log.${extension}`, `LOG.${extension.toUpperCase()}`]) {
      assert.ok(isOpenableLogFileName(name));
      assert.ok(host.watched.some((pattern) => path.matchesGlob(`group/${name}`, pattern)), `${name} is not watched`);
    }
  } finally { await harness.close(); }
});

test('a CSV log copied into another group is listed there, and opens', async () => {
  const harness = await start();
  try {
    const all = await rows('sigmixa.analysisGroups');
    const csv = all.find((row) => /file/i.test(row.contextValue) && row.label.endsWith('.csv')); assert.ok(csv, 'a CSV row');
    const listedBefore = all.filter((row) => row.label === csv.label).length;
    host.answer = (question) => {
      if (question.kind !== 'quickPick') return undefined;
      const items = question.items as { label: string; folder?: string; mode?: string }[];
      // To another analysis group, as a copy.
      return items.find((item) => item.folder !== undefined && item.folder !== '' && !item.folder.startsWith('basic')) ?? items.find((item) => item.mode === 'copy');
    };
    await commands.executeCommand('sigmixa.transferLogs', csv.node, [csv.node]);
    await harness.settle(300);
    assert.deepEqual(host.messages.filter((message) => message.kind === 'error'), []);
    const after = await rows('sigmixa.analysisGroups');
    const copies = after.filter((row) => row.label === csv.label);
    assert.equal(copies.length, listedBefore + 1, 'the copy is listed in the group it was copied to');
    const copy = copies.find((row) => row.node !== csv.node && !all.some((before) => before.node === row.node)) ?? copies[copies.length - 1];
    const screens = harness.screens.length;
    await commands.executeCommand('sigmixa.openItem', copy.node);
    const screen = await harness.waitFor(() => harness.screens[screens], 'the copied log to open');
    await harness.waitFor(() => screen.received.some((message) => message.type === 'ready'), 'its screen to start');
    assert.deepEqual(screen.errors, []);
  } finally { host.answer = undefined; await harness.close(); }
});

test('changing how RAW shows times keeps the time filter on the same span, also right after typing it', async () => {
  const harness = await start();
  try {
    const screen = await harness.openLog('basic/sigmixa-basic.asc');
    const page = screen.page;
    await page.locator('[data-view="raw-view"]').first().click();
    await harness.settle(300);
    const status = () => page.locator('#result-status').innerText();
    const showAs = async (label: string) => {
      await page.locator('#grid .head[data-column-index]').filter({ hasText: /TIME|時刻/ }).first().click({ button: 'right' });
      await page.locator('[role=menu] [role=menuitem], [role=menu] button').filter({ hasText: label }).first().click();
    };
    const seconds = async () => [await page.locator('#time-start').inputValue(), await page.locator('#time-end').inputValue()].map(Number);
    await page.locator('#time-start').fill('10'); await page.locator('#time-end').fill('20');
    await harness.settle(400);
    const filtered = await status(); assert.ok(filtered, 'the filter shows how many rows it keeps');
    await showAs('Show as date and time'); await harness.settle(400);
    assert.equal(await status(), filtered, 'the same rows are kept when shown as date and time');
    await showAs('Show as seconds from start'); await harness.settle(400);
    assert.deepEqual(await seconds(), [10, 20], 'and the filter reads the same seconds again');
    // Typed and switched at once, before the filter is applied.
    await page.locator('#time-start').fill('12'); await page.locator('#time-end').fill('18');
    await showAs('Show as date and time'); await harness.settle(400);
    await showAs('Show as seconds from start'); await harness.settle(400);
    assert.deepEqual(await seconds(), [12, 18], 'what was just typed keeps its meaning');
    assert.deepEqual(screen.errors, []);
  } finally { await harness.close(); }
});
