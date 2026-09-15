import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// Pass a locally installed Playwright module path when it is not in node_modules.
const { chromium } = await import(process.argv[2] ? pathToFileURL(process.argv[2]).href : 'playwright');
const bundle = await build({ entryPoints: ['src/webview/frame-editor/frameDefinition.ts'], bundle: true, write: false, platform: 'browser', format: 'iife' });
const iconFont = await readFile('media/codicons/codicon.ttf');
const iconCss = (await readFile('media/codicons/codicon.css', 'utf8')).replace(/url\("\.\/codicon\.ttf[^\"]*"\)/, `url("data:font/ttf;base64,${iconFont.toString('base64')}")`);
const frame = { id: 'ui-frame', name: 'Vehicle Status', canId: 0x123, extended: false, frameLength: 64, signals: Array.from({ length: 20 }, (_, i) => ({ id: `s${i}`, name: `Signal ${i}`, unit: 'm/s', byteOffset: i * 2, bitOffset: 0, lengthBits: 16, byteOrder: i === 1 ? 'big' : 'little', signedness: 'unsigned', conversion: { type: 'scale-offset', lsb: .01, lsbText: '0.01', offset: 0 } })), derivedSignals: [
  { id: 'lookup', name: 'Temperature correction', unit: '°C', operation: { type: 'lookup', input: 'Signal 0', outOfRange: 'clamp', points: [{ input: 0, output: 0 }, { input: 50, output: 42 }, { input: 100, output: 110 }] } },
  { id: 'filter', name: 'Filtered speed', unit: 'm/s', operation: { type: 'filter', input: 'Signal 0', filter: 'low-pass', timeSeconds: 1 } },
] };
const browser = await chromium.launch({ headless: true, channel: process.argv[3] });
try {
  const page = await browser.newPage({ viewport: { width: 1450, height: 850 } });
  const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent(`<html lang="ja"><head><style>:root{--vscode-foreground:#ddd;--vscode-editor-background:#1e1e1e;--vscode-font-family:Arial;--vscode-editor-font-family:monospace;--vscode-input-background:#313131;--vscode-panel-border:#454545;--vscode-descriptionForeground:#aaa;--vscode-button-secondaryBackground:#333;--vscode-focusBorder:#69b8f0;--vscode-charts-blue:#69b8f0;--vscode-list-hoverBackground:#292e36;--vscode-inputValidation-errorBorder:#f66;--vscode-inputValidation-errorBackground:#512a2a}body{background:var(--vscode-editor-background)}</style></head><body><div id="app"></div></body></html>`);
  await page.evaluate(() => { window.messages = []; window.acquireVsCodeApi = () => ({ getState: () => ({}), setState: () => {}, postMessage: (message) => window.messages.push(message) }); });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.addStyleTag({ content: iconCss });
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate((value) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'init', frame: value } })), frame);
  await page.locator('.signal-row').first().waitFor();
  assert.equal(await page.getByRole('button', { name: '自動調整', exact: true }).count(), 0);
  const layoutAt = async (width) => {
    await page.setViewportSize({ width, height: 850 }); await settle();
    return page.evaluate(() => {
      const sizes = (selector) => Array.from(document.querySelector(selector).children).map((cell) => cell.getBoundingClientRect().width);
      const table = document.querySelector('[data-scroll-key="signal-table"]');
      return { signal: sizes('.signal-header'), derived: sizes('.derived-header'), frameName: document.querySelector('.frame-name-field').getBoundingClientRect().width, scrolls: table.scrollWidth > table.clientWidth, pageScrolls: document.documentElement.scrollWidth > innerWidth };
    });
  };
  const wide = await layoutAt(1450); const medium = await layoutAt(1100); const narrow = await layoutAt(760);
  assert.deepEqual(wide.signal.slice(1), medium.signal.slice(1));
  assert.deepEqual(medium.signal.slice(1), narrow.signal.slice(1));
  assert.ok(wide.signal[0] > medium.signal[0], 'Extra space must go to the Signal name');
  assert.ok(wide.derived[3] > medium.derived[3], 'The expression must follow the viewport width');
  assert.ok(wide.frameName > medium.frameName);
  assert.equal(medium.scrolls, false); assert.equal(narrow.scrolls, true); assert.equal(narrow.pageScrolls, false);
  await layoutAt(1450);
  await mkdir('work/ui-check', { recursive: true });
  await page.screenshot({ path: 'work/ui-check/frame-layout-wide.png' });
  const first = page.locator('.signal-row[data-signal-id="s0"]');
  await first.hover();
  assert.equal(await page.locator('.bit.is-hovered').count(), 16);
  const color = await first.evaluate((row) => row.style.getPropertyValue('--signal-color'));
  await first.locator('input').first().focus(); await page.mouse.move(1400, 10);
  assert.equal(await page.locator('.bit.is-editing').count(), 16);
  assert.match(await page.locator('.bit-detail').textContent(), /MSB 1\.7 \/ LSB 0\.0/);
  await page.locator('.bit[data-bit="16"]').click();
  assert.equal(await page.evaluate(() => document.activeElement.closest('[data-signal-id]')?.dataset.signalId), 's1');
  assert.match(await page.locator('.bit-detail').textContent(), /BIG.*MSB 2\.7 \/ LSB 3\.0/);

  // Editing + Tab keeps focus on the next field in the same Signal after redraw.
  const last = page.locator('.signal-row[data-signal-id="s19"]');
  await last.locator('input').first().fill('Renamed final Signal');
  await page.waitForFunction(() => window.messages.some((message) => message.type === 'save' && message.frame.signals.find((signal) => signal.id === 's19')?.name === 'Renamed final Signal'));
  assert.equal(await last.locator('input').first().evaluate((element) => document.activeElement === element), true);
  const scroll = await page.evaluate(() => window.scrollY);
  await page.keyboard.press('Tab');
  await settle();
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-control-key') === JSON.stringify(['s19', 'name', 1]));
  await page.keyboard.press('Tab'); await settle();
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-control-key') === JSON.stringify(['s19', 'unit', 0]));
  const afterScroll = await page.evaluate(() => window.scrollY);
  assert.ok(Math.abs(afterScroll - scroll) < 3, `Tab moved vertical scroll from ${scroll} to ${afterScroll}`);
  assert.equal(await first.evaluate((row) => row.style.getPropertyValue('--signal-color')), color);

  // Column sizing must not change the identity or focus of an input on a later row.
  await page.evaluate(() => { const wrap = document.querySelector('[data-scroll-key="signal-table"]'); wrap.scrollLeft = 260; });
  const offset = last.locator('.cell').nth(8).locator('input');
  await offset.fill('-2.5'); await page.keyboard.press('Tab'); await settle();
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-control-key') === JSON.stringify(['s19', 'minimum', 0]));

  const details = page.locator('details[data-derived-id="lookup"]');
  await details.locator('summary').click();
  await details.locator('.lookup-table input').nth(2).fill('-10');
  await page.keyboard.press('Tab');
  await settle();
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-control-key') === JSON.stringify(['lookup', 'definition', 7]));
  assert.deepEqual(await details.locator('.lookup-table input').evaluateAll((inputs) => inputs.map((input) => input.value)), ['0', '0', '-10', '42', '100', '110']);
  assert.equal(await details.getAttribute('open'), '');
  await details.locator('.preview-point[data-point-index="0"]').click();
  assert.equal(await details.locator('.lookup-table input').nth(1).evaluate((input) => document.activeElement === input), true);
  const filter = page.locator('details[data-derived-id="filter"]'); await filter.locator('summary').click();
  await page.waitForFunction(() => !document.querySelector('details[data-derived-id="lookup"]').open);
  assert.equal(await details.getAttribute('open'), null);
  await filter.locator('input').fill('2'); await page.keyboard.press('Tab'); await settle();
  await page.waitForFunction(() => window.messages.some((message) => message.type === 'save' && message.frame.derivedSignals[1].operation.timeSeconds === 2));
  assert.equal(await filter.locator('.preview-output').count(), 1);
  await page.locator('.derived-row[data-signal-id="filter"]').getByRole('button', { name: 'Signal接続図', exact: true }).click(); await settle();
  assert.equal(await page.locator('.dependency-diagram button[data-node-id="s0"]').count(), 1);
  await page.locator('.dependency-diagram button[data-node-id="s0"]').click();
  assert.equal(await page.evaluate(() => document.activeElement.closest('[data-signal-id]')?.dataset.signalId), 's0');

  const nameWidthBeforeLabels = (await first.locator('input').first().boundingBox()).width;
  await first.getByRole('button', { name: '値ラベル', exact: true }).click(); await settle();
  const labels = page.locator('.value-label-editor');
  await labels.getByRole('button', { name: '+ 値ラベルを追加', exact: true }).click(); await settle();
  await labels.getByRole('textbox', { name: 'ラベル 1', exact: true }).fill('停止');
  await page.waitForFunction(() => window.messages.some((message) => message.type === 'save' && message.frame.signals[0].valueLabels?.['0'] === '停止'));
  await labels.getByRole('button', { name: '+ 値ラベルを追加', exact: true }).click(); await settle();
  await labels.getByRole('textbox', { name: 'ラベル 2', exact: true }).fill('運転');
  await labels.getByRole('textbox', { name: 'RAW 2', exact: true }).fill('0');
  assert.match(await labels.locator('[role=status]').textContent(), /重複/);
  await labels.getByRole('textbox', { name: 'RAW 2', exact: true }).fill('1');
  await page.waitForFunction(() => window.messages.some((message) => message.type === 'save' && message.frame.signals[0].valueLabels?.['1'] === '運転'));
  assert.equal(await labels.locator('[role=status]').textContent(), '');
  await labels.getByRole('button', { name: '値ラベルを削除', exact: true }).last().click(); await settle();
  await page.waitForFunction(() => { const labels = window.messages.findLast((message) => message.type === 'save')?.frame.signals[0].valueLabels; return labels?.['0'] === '停止' && !('1' in labels); });
  const labelToggle = first.getByRole('button', { name: '値ラベル', exact: true });
  assert.equal(await labelToggle.locator('.value-label-indicator').count(), 1);
  assert.equal(await labelToggle.getAttribute('title'), '値ラベル: 1');
  await labelToggle.click(); await settle();
  assert.equal(await labels.count(), 0);
  assert.equal(await labelToggle.locator('.value-label-indicator').count(), 1);
  assert.equal(await labelToggle.textContent(), '');
  assert.equal((await first.locator('input').first().boundingBox()).width, nameWidthBeforeLabels);
  assert.equal((await labelToggle.boundingBox()).width, 24);
  assert.equal(await labelToggle.getAttribute('aria-expanded'), 'false');
  await labelToggle.click(); await settle();
  await labels.getByRole('button', { name: '値ラベルを削除', exact: true }).click(); await settle();
  assert.equal(await labelToggle.textContent(), '');
  assert.equal(await labelToggle.locator('.value-label-indicator').count(), 0);
  await labelToggle.click(); await settle();
  assert.equal(await labelToggle.textContent(), '');
  await page.setViewportSize({ width: 760, height: 850 });
  await filter.locator('summary').scrollIntoViewIfNeeded();
  await mkdir('work/ui-check', { recursive: true });
  await page.screenshot({ path: 'work/ui-check/frame-definition.png' });
  // Saved narrow widths must not hide names when opening another Frame.
  const longFrame = structuredClone(frame);
  longFrame.signals[0].name = 'Front right wheel longitudinal acceleration sensor';
  longFrame.derivedSignals[0].name = 'Corrected front right wheel longitudinal acceleration';
  await page.evaluate((value) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'init', frame: value, widths: { name: 130, derivedName: 150 } } })), longFrame);
  await settle();
  const assertNamesFit = async () => {
    for (const selector of ['.signal-row[data-signal-id="s0"]', '.derived-row[data-signal-id="lookup"]']) {
      const fits = await page.locator(selector).locator('input').first().evaluate((input) => {
        const css = getComputedStyle(input); const ctx = document.createElement('canvas').getContext('2d'); ctx.font = css.font;
        return ctx.measureText(input.value).width <= input.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight);
      });
      assert.ok(fits, `${selector}: name is clipped`);
    }
  };
  await assertNamesFit();
  for (const selector of ['.signal-row[data-signal-id="s0"]', '.derived-row[data-signal-id="lookup"]']) {
    const input = page.locator(selector).locator('input').first();
    await input.focus();
    const before = await page.evaluate(() => window.scrollY);
    const original = await input.inputValue();
    await input.fill(`${original} with an additional very long descriptive Signal name`);
    await assertNamesFit();
    assert.equal(await input.evaluate((element) => document.activeElement === element), true);
    assert.equal(await page.evaluate(() => window.scrollY), before);
    const expandedWidth = (await input.boundingBox()).width;
    await input.fill(original);
    assert.equal((await input.boundingBox()).width, expandedWidth, 'Shortening text must not jitter the column');
    await page.keyboard.press('Tab'); await settle();
    assert.ok((await input.boundingBox()).width < expandedWidth, 'Leaving the name field must fit the longest remaining name');
    await assertNamesFit();
  }
  await page.locator('.signal-header .resize').first().dblclick(); await settle();
  await page.locator('.derived-header .resize').first().dblclick(); await settle();
  await assertNamesFit();
  // Inspect the complete editor in both locales, including real icons and compact details.
  for (const selector of ['.signal-row[data-signal-id="s0"]', '.derived-row[data-signal-id="lookup"]']) {
    const unit = page.locator(selector).locator('.cell').nth(1).locator('input');
    const original = await unit.inputValue();
    await unit.fill('レバー操作指令値（無次元）');
    assert.equal(await unit.evaluate((input) => {
      const css = getComputedStyle(input); const ctx = document.createElement('canvas').getContext('2d'); ctx.font = css.font;
      return ctx.measureText(input.value).width <= input.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight);
    }), true);
    assert.equal(await unit.evaluate((input) => document.activeElement === input), true);
    await unit.fill(original); await page.keyboard.press('Tab'); await settle();
  }
  const html = await page.content();
  for (const lang of ['ja', 'en']) {
    const preview = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
    await preview.setContent(html.replace(/<html lang="ja">/, `<html lang="${lang}">`).replace(/<script[\s\S]*?<\/script>/g, ''));
    await preview.evaluate(() => { window.acquireVsCodeApi = () => ({ getState: () => ({}), setState: () => {}, postMessage: () => {} }); });
    await preview.addScriptTag({ content: bundle.outputFiles[0].text });
    await preview.addStyleTag({ content: iconCss });
    const shortFrame = { ...frame, frameLength: 8, signals: frame.signals.slice(0, 4) };
    await preview.evaluate((value) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'init', frame: value } })), shortFrame);
    await preview.locator('.signal-row').first().waitFor();
    const lengthFits = await preview.locator('.frame-length-field select').evaluate((select) => {
      const css = getComputedStyle(select); const ctx = document.createElement('canvas').getContext('2d'); ctx.font = css.font;
      return ctx.measureText('64 bytes (CAN FD)').width + 24 <= select.clientWidth;
    });
    assert.equal(lengthFits, true);
    await preview.screenshot({ path: `work/ui-check/frame-layout-${lang}.png`, fullPage: true });
    await preview.close();
  }
  assert.deepEqual(errors, []);
  console.log('Frame editor UI passed: linked Bit hover/focus/click, stable color, edit + Tab, scroll, lookup order/point selection, expanded editor, filter preview, narrow viewport.');
} finally { await browser.close(); }
