// The Signal list of every screen (graph settings, comparison), on its own in the browser: what search finds and what
// "show this Signal" opens.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { repository } from './check';

const definitions = [
  { id: 'a', name: 'Speed', unit: 'km/h', source: { kind: 'manual' } },
  { id: 'b', name: 'Coolant', unit: '°C', source: { kind: 'manual' } },
  { id: 'c', name: 'Gear', unit: '', source: { kind: 'manual' } },
];
// As the comparison screen lists two logs with different Frame definitions: common Signals, then "Only in …".
const groups = [
  { id: 'g1', label: '0x100 Engine', signalIds: ['a'] },
  { id: 'g2', label: '0x200 Body', signalIds: ['b'], section: { id: 'only-a', label: 'Only in road-test.asc' } },
  { id: 'g3', label: '0x300 Drive', signalIds: ['c'], section: { id: 'only-b', label: 'Not in road-test.asc' } },
];

test('the Signal list finds Signals by the heading they are listed under, and shows a Signal inside a closed heading', async () => {
  const entry = path.join(process.env.SIGMIXA_UI_BUILD!, 'selector-entry.ts');
  fs.writeFileSync(entry, `import { SignalSelector } from ${JSON.stringify(path.join(repository, 'src/webview/shared/signalSelector'))};\n(window as any).SignalSelector = SignalSelector;\n`);
  const bundle = await build({ entryPoints: [entry], bundle: true, write: false, format: 'iife', platform: 'browser', logLevel: 'silent' });
  const browser = await chromium.launch(process.env.SIGMIXA_CHROMIUM ? { executablePath: process.env.SIGMIXA_CHROMIUM } : {});
  try {
    const page = await browser.newPage(); const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.setContent('<div id="host"></div>');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const shown = (grouping: 'frame' | 'unit', search: string) => page.evaluate(({ definitions, groups, grouping, search }) => {
      const host = document.getElementById('host')!; host.innerHTML = '';
      const selector = new (window as any).SignalSelector({ host, selected: new Set(), onSelectionChange: () => undefined, grouping });
      selector.setCatalog(definitions, groups);
      const input = host.querySelector<HTMLInputElement>('input[type=search]')!; input.value = search; input.dispatchEvent(new Event('input', { bubbles: true }));
      return Array.from(document.querySelectorAll<HTMLElement>('.selector-signal')).map((row) => row.dataset.signalId);
    }, { definitions, groups, grouping, search });
    for (const grouping of ['frame', 'unit'] as const) {
      assert.deepEqual(await shown(grouping, 'only in road'), ['b'], `${grouping}: an "Only in" heading finds its Signals`);
      assert.deepEqual(await shown(grouping, 'not in road'), ['c'], `${grouping}: a "Not in" heading finds its Signals`);
    }
    const revealed = await page.evaluate(({ definitions, groups }) => {
      const host = document.getElementById('host')!; host.innerHTML = '';
      const selector = new (window as any).SignalSelector({ host, selected: new Set(), onSelectionChange: () => undefined });
      selector.setCatalog(definitions, groups); selector.reveal('c');
      const row = Array.from(host.querySelectorAll<HTMLElement>('.selector-signal')).find((item) => item.dataset.signalId === 'c');
      return { visible: !!row && row.offsetParent !== null, focused: document.activeElement === row?.querySelector('input') };
    }, { definitions, groups });
    assert.deepEqual(revealed, { visible: true, focused: true }, 'a Signal in a closed heading is shown and focused');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
