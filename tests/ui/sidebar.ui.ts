// The SigMixa sidebar: every command its title bars and right-click menus offer, run on every kind of row, and every
// screen those commands open (Frame definition, Group definitions, Plugin, comparison) pressed through.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pressEverything, repository, start } from './check';
import { menus, offered, rows, type Row } from './sidebar';
import { commands, host, Uri } from './vscodeHost';

const DESTRUCTIVE = /delete|trash|remove|dissolve|unregister|rename|transfer|paste/i;

test('every sidebar command does something on every kind of row, without an error', async () => {
  const harness = await start();
  const failures: string[] = [];
  try {
    const entries = menus(repository);
    const ordered = [...entries.filter((entry) => !DESTRUCTIVE.test(entry.command)), ...entries.filter((entry) => DESTRUCTIVE.test(entry.command))];
    const ran: string[] = [];
    // A Plugin folder of its own to register (the sample's are registered already).
    const plugin = harness.file('ui-plugin'); fs.cpSync(harness.file('.sigmixa/plugins/byte-scaler'), plugin, { recursive: true });
    fs.writeFileSync(path.join(plugin, 'index.js'), fs.readFileSync(path.join(plugin, 'index.js'), 'utf8').replace("'sample.byte-scaler'", "'ui.byte-scaler'"));
    for (const entry of ordered) {
      // One row of each kind: rows of a kind run the same code. The rows are read again after each command, as a command
      // may have renamed or moved what the others show (a renamed group moves its logs).
      const done = new Set<string>();
      for (;;) {
        const all = entry.onRow ? await rows(entry.view) : [undefined];
        const row = all.find((item) => !done.has(item?.contextValue ?? '')); if (row === undefined && (entry.onRow || done.size)) break;
        done.add(row?.contextValue ?? '');
        if (!offered(entry, row)) continue;
        const name = `${entry.title} on ${row ? `${row.contextValue} "${row.label}"` : `the ${entry.view} title bar`}`;
        host.reset();
        let saved = 0;
        host.answer = (question) => {
          if (question.kind === 'quickPick') return question.items?.[0];
          if (question.kind === 'inputBox') return `${(question.items?.[0] as string | undefined) ?? 'UI test'} 2`;
          if (question.kind === 'saveDialog') return Uri.file(path.join(harness.workspacePath, '.ui-out', `${++saved}-${entry.command}.dbc`));
          if (question.kind === 'openDialog') return entry.command.includes('Dbc') ? [Uri.file(harness.file('basic/sigmixa-basic.dbc'))] : entry.command.includes('Plugin') ? [Uri.file(plugin)] : [Uri.file(harness.file('city-drive/drive.asc'))];
          if (question.kind === 'warning') return question.items?.[0]; // Confirmed: the workspace is a copy.
          return undefined;
        };
        const screens = harness.screens.length;
        try { await commands.executeCommand(entry.command, row?.node, row ? [row.node] : undefined); }
        catch (error) { failures.push(`${name}: threw ${(error as Error).message}`); continue; }
        await harness.settle(150);
        // A refusal that says why ("Not done. …: this group already has it") is an answer; any other error is a failure.
        const errors = host.messages.filter((message) => message.kind === 'error' && !/^(Not done\.|実行できませんでした。)/.test(message.text));
        const did = host.questions.length || host.messages.length || harness.screens.length > screens || host.commandsRun.length > 1 || host.clipboard || host.externalLinks.length;
        if (errors.length) failures.push(`${name}: ${errors.map((message) => message.text).join('; ')}`);
        else if (!did) failures.push(`${name}: did nothing`);
        for (const screen of harness.screens.slice(screens)) if (screen.errors.length) failures.push(`${name}: the screen it opened has errors: ${screen.errors.join('; ')}`);
        ran.push(name);
      }
    }
    assert.ok(ran.length > 20, `only ${ran.length} commands were run`);
    assert.deepEqual(failures, []);
  } finally { host.answer = undefined; await harness.close(); }
});

test('every press on the Frame definition, Group definitions, Plugin and comparison screens does something, without an error', async () => {
  const harness = await start();
  try {
    const open = async (command: string, find: (row: Row) => boolean, view: string, name: string, extra?: (row: Row, all: Row[]) => unknown[], first: (row: Row) => unknown = (row) => row.node) => {
      const all = await rows(view); const row = all.find(find); if (!row) throw new Error(`no row for ${name}`);
      const before = harness.screens.length;
      await commands.executeCommand(command, first(row), ...(extra ? extra(row, all) : [[row.node]]));
      const screen = await harness.waitFor(() => harness.screens[before], `the ${name} screen`);
      await harness.settle(600);
      await pressEverything(harness, screen, name);
    };
    await open('sigmixa.openFrame', (row) => row.contextValue === 'sigmixa.manualFrame', 'sigmixa.frames', 'frame definition', () => [], (row) => (row.node as { id: string }).id);
    await open('sigmixa.openPlugin', (row) => row.contextValue === 'sigmixa.plugin', 'sigmixa.plugins', 'plugin');
    await open('sigmixa.openGroupDefinitions', (row) => row.contextValue === 'sigmixa.analysisGroup' && row.label === 'city-drive', 'sigmixa.analysisGroups', 'group definitions');
    await open('sigmixa.compareClips', (row) => row.contextValue === 'sigmixa.clip', 'sigmixa.analysisGroups', 'comparison', (row, all) => [all.filter((item) => item.contextValue === 'sigmixa.clip').slice(0, 2).map((item) => item.node)]);
  } finally { await harness.close(); }
});
