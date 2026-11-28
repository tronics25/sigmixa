// Vertical zoom on time-series graphs, from the mouse to what is drawn, in Visualize and on the comparison screen:
// a vertical drag selects one graph's values (its edges shown on the axis), the button in the span marker zooms to them
// and turns into reset; a horizontal drag still selects time, and either selection replaces the other.
// Usage: node scripts/check-value-zoom-ui.mjs [playwright module path] [browser channel, e.g. chrome] [screenshot folder]
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(process.argv[2] ? pathToFileURL(process.argv[2]).href : 'playwright');
const browser = await chromium.launch({ headless: true, channel: process.argv[3] || undefined });
const shots = process.argv[4];
const definitions = ['speed', 'target'].map((id) => ({ id, name: id, unit: 'km/h', source: { type: 'manual-can', frameDefinitionId: 'f' } }));
const groups = [{ id: 'frame-f', label: 'Motion', signalIds: definitions.map((definition) => definition.id) }];
// Values 10 … 21 over one second: the automatic axis shows 10 to 21.
const series = definitions.map((definition, index) => ({ definition, samples: [{ timestamp: 0, value: 10 + index }, { timestamp: .5, value: 18 + index }, { timestamp: 1, value: 20 + index }], gaps: [], events: [], totalSamplesInRange: 3, globalMinimum: 10, globalMaximum: 21 }));

try {
  for (const comparison of [false, true]) {
    const where = comparison ? 'comparison' : 'Visualize';
    const page = await browser.newPage({ viewport: { width: 1250, height: 900 } }); const errors = []; page.on('pageerror', (error) => errors.push(error.stack ?? error.message));
    await page.setContent('<html lang="ja"><head><style>:root{--vscode-foreground:#ddd;--vscode-editor-background:#1e1e1e;--vscode-font-family:Arial;--vscode-input-background:#313131;--vscode-panel-border:#454545;--vscode-descriptionForeground:#aaa;--vscode-focusBorder:#69b8f0;--vscode-button-foreground:#ffffff}</style></head><body><div id="app"></div></body></html>');
    await page.evaluate(() => {
      window.messages = []; window.texts = []; window.frames = [];
      if (!crypto.randomUUID) { let next = 0; crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`; }
      window.acquireVsCodeApi = () => ({ getState: () => ({}), setState: () => {}, postMessage: (message) => window.messages.push(message) });
      // What the visible canvases draw: their texts (with the fill colour) and the plot frames.
      const fillText = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function(text, ...rest) { if (this.canvas.isConnected) window.texts.push({ text: String(text), color: this.fillStyle }); return fillText.call(this, text, ...rest); };
      const strokeRect = CanvasRenderingContext2D.prototype.strokeRect;
      CanvasRenderingContext2D.prototype.strokeRect = function(x, y, width, height) { if (this.canvas.isConnected) window.frames.push({ x, y, width, height, canvas: this.canvas.getBoundingClientRect().toJSON() }); return strokeRect.call(this, x, y, width, height); };
    });
    // For screenshots, the icon font the webviews load, so the buttons look as they do in VS Code.
    if (shots) { const { readFileSync } = await import('node:fs'); const dist = 'node_modules/@vscode/codicons/dist'; const font = readFileSync(`${dist}/codicon.ttf`).toString('base64'); await page.addStyleTag({ content: readFileSync(`${dist}/codicon.css`, 'utf8').replace(/url\([^)]*codicon\.ttf[^)]*\)/, `url(data:font/ttf;base64,${font})`) }); }
    const bundle = await build({ entryPoints: [comparison ? 'src/webview/comparison/comparison.ts' : 'src/webview/raw/rawLog.ts'], bundle: true, write: false, platform: 'browser', format: 'iife' });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const send = (message) => page.evaluate((data) => window.dispatchEvent(new MessageEvent('message', { data })), message);
    const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    // Time ranges snap to CAN Timestamps on the extension side; here they stay as dragged.
    await page.evaluate(() => { const push = window.messages.push; window.messages.push = function(message) { const result = push.call(this, message); if (message.type === 'snapTimeRangeRequest') queueMicrotask(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'timeRangeAdjusted', requestId: message.requestId, startTimestamp: message.startTimestamp, endTimestamp: message.endTimestamp } }))); return result; }; });
    if (comparison) {
      const ids = ['a', 'b'];
      await send({ type: 'init', comparison: { id: 'c', name: 'c', targets: ids.map((id) => ({ id, kind: 'file', sourcePath: `${id}.asc`, offset: 0 })), graphs: [{ id: 'g1', kind: 'graph', name: 'Graph', signalIds: ['speed', 'target'] }] } });
      await send({ type: 'targets', targets: ids.map((id) => ({ id, kind: 'file', name: id, fileName: `${id}.asc`, filePath: `${id}.asc`, rangeLabel: '', status: 'ready', start: 0, end: 1 })) });
      await send({ type: 'catalog', definitions, groups, availability: Object.fromEntries(ids.map((id) => [id, ['speed', 'target']])), measuredIds: ['speed', 'target'] }); await settle();
      const request = await page.evaluate(() => window.messages.findLast((message) => message.type === 'seriesRequest'));
      assert.ok(request, `${where}: series request missing: ${errors.join(' | ')}`);
      await send({ type: 'series', requestId: request.requestId, graphId: request.graphId, seriesByTarget: ids.map((targetId) => ({ targetId, series: series.map((item) => ({ signalId: item.definition.id, series: item })) })) });
    } else {
      await send({ type: 'init', fileName: 'test.asc', parsing: false, frames: 2, diagnostics: 0, channels: [1], viewState: { chartSelectedIds: ['speed', 'target'], visualizeViews: [{ id: 'g1', kind: 'graph', name: 'Graph', settings: { chartSelectedIds: ['speed', 'target'] } }] } });
      await page.getByRole('button', { name: 'Visualize', exact: true }).click(); await settle();
      const catalog = await page.evaluate(() => window.messages.findLast((message) => message.type === 'signalCatalogRequest'));
      assert.ok(catalog, `${where}: catalog request missing: ${errors.join(' | ')}`);
      await send({ type: 'signalCatalog', requestId: catalog.requestId, definitions, groups }); await settle();
      const request = await page.evaluate(() => window.messages.findLast((message) => message.type === 'signalSeriesRequest'));
      assert.ok(request, `${where}: series request missing: ${errors.join(' | ')}`);
      await send({ type: 'signalSeries', requestId: request.requestId, fullRange: { start: 0, end: 1 }, series });
    }
    await settle(); await settle();

    // The plot: the largest frame drawn on a visible canvas.
    const canvas = page.locator(comparison ? '.visualize-card .chart-canvas-wrap canvas' : '.visualize-card .chart-canvas-wrap canvas').first();
    // Moving over the graph and off it again redraws it, without leaving a hover behind.
    const redraw = async () => { await page.evaluate(() => { window.texts = []; window.frames = []; }); const box = await canvas.boundingBox(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await settle(); await page.mouse.move(1, 1); await settle(); await settle(); };
    await redraw();
    const frame = await page.evaluate(() => window.frames.reduce((best, item) => !best || item.width * item.height > best.width * best.height ? item : best, undefined));
    if (!(frame && frame.height > 100) && shots) await page.screenshot({ path: `${shots}/debug-${where}.png` });
    assert.ok(frame && frame.height > 100, `${where}: plot frame not found: ${errors.join(' | ')}`);
    const plot = { left: frame.canvas.x + frame.x, top: frame.canvas.y + frame.y, width: frame.width, height: frame.height };
    const at = (fx, fy) => ({ x: plot.left + plot.width * fx, y: plot.top + plot.height * fy });
    const drag = async (from, to) => { await page.mouse.move(from.x, from.y); await page.mouse.down(); for (let step = 1; step <= 6; step++) await page.mouse.move(from.x + (to.x - from.x) * step / 6, from.y + (to.y - from.y) * step / 6); await page.mouse.up(); await settle(); await settle(); };
    const button = page.locator('.chart-value-zoom').first();
    const rangeShown = () => page.locator(comparison ? '.comparison-range' : '.visualize-range').first().isVisible();
    const tickTexts = async () => { await redraw(); return page.evaluate(() => window.texts.map((item) => item.text)); };
    const edgeLabels = async () => { await redraw(); return page.evaluate(() => window.texts.filter((item) => item.color === '#ffffff').map((item) => item.text)); };

    assert.equal(await button.isVisible(), false, `${where}: no span marker button before a selection`);
    // 1. A vertical drag selects values on this graph: the edges are shown on the axis, and the span marker has the zoom button.
    await drag(at(.4, .25), at(.42, .6));
    assert.equal(await rangeShown(), false, `${where}: a vertical drag selects no time range`);
    assert.equal(await button.isVisible(), true, `${where}: the zoom button appears in the span marker`);
    assert.equal(await button.getAttribute('data-kind'), 'zoom');
    assert.equal(await button.getAttribute('aria-label'), '選択した値の範囲を拡大');
    // From 25 % to 60 % of the height of an axis drawn from 21 (top) to 10: 18.25 and 14.40, to a hundredth (an axis of 11 over ~200 px).
    const expected = [21 - .25 * 11, 21 - .6 * 11].map((value) => value.toFixed(2));
    const labels = await edgeLabels();
    for (const value of expected) assert.ok(labels.some((label) => Math.abs(Number(label) - Number(value)) <= .06), `${where}: edge value ${value} shown on the axis (shown: ${labels.join(', ')})`);
    const buttonBox = await button.boundingBox(); assert.ok(buttonBox.x > plot.left && buttonBox.x < plot.left + 40, `${where}: the button is beside the value axis, inside the plot`);
    assert.ok(Math.abs(buttonBox.y + buttonBox.height / 2 - (plot.top + plot.height * .425)) < 3, `${where}: the button is in the middle of the selected span`);
    if (shots) await page.screenshot({ path: `${shots}/value-selection-${comparison ? 'comparison' : 'visualize'}.png` });

    // 2. The button zooms this graph to the selected values and turns into reset.
    await button.click(); await settle(); await settle();
    assert.equal(await button.getAttribute('data-kind'), 'reset', `${where}: after zooming the button resets`);
    assert.equal(await button.getAttribute('aria-label'), '縦方向のズームをリセット');
    let ticks = await tickTexts();
    assert.ok(ticks.includes('15') && ticks.includes('18'), `${where}: zoomed ticks span the selection (ticks: ${ticks.join(', ')})`);
    assert.ok(!ticks.includes('10') && !ticks.includes('20'), `${where}: values outside the selection are off the axis`);
    assert.equal((await edgeLabels()).length, 0, `${where}: no selection edges once zoomed`);
    if (shots) await page.screenshot({ path: `${shots}/value-zoomed-${comparison ? 'comparison' : 'visualize'}.png` });
    // A zoomed graph keeps its values while time is zoomed.
    await page.locator('.zoom-all-in').first().click(); await settle(); await settle();
    ticks = await tickTexts(); assert.ok(ticks.includes('15') && !ticks.includes('10'), `${where}: a time zoom keeps the vertical zoom`);
    // The saved image shows what is on screen.
    const image = page.locator(comparison ? '.visualize-card-actions button[aria-label="画像を保存"]' : '.save-chart-image').first();
    if (await image.isVisible()) { await page.evaluate(() => { window.saved = 0; }); await image.click(); await settle(); assert.ok(await page.evaluate(() => window.messages.some((message) => /Image$/.test(message.type) || message.type === 'saveImage')), `${where}: the image is saved while zoomed`); }

    // 3. The span marker's reset button: back to the automatic range; time stays zoomed.
    await button.click(); await settle(); await settle();
    assert.equal(await button.isVisible(), false, `${where}: reset hides the button`);
    // Time is zoomed to its middle, where the samples are 18 and 19: the automatic range of the visible interval.
    ticks = await tickTexts(); assert.ok(ticks.includes('19') && !ticks.includes('15'), `${where}: reset shows the automatic range again (ticks: ${ticks.join(', ')})`);

    // 4. Reset zoom resets time and every graph's vertical zoom at once.
    await drag(at(.5, .2), at(.5, .5)); await button.click(); await settle();
    assert.equal(await button.getAttribute('data-kind'), 'reset');
    const resetAll = page.locator('.zoom-all-reset').first(); assert.equal(await resetAll.isDisabled(), false, `${where}: reset zoom is available while zoomed vertically`);
    await resetAll.click(); await settle(); await settle();
    assert.equal(await button.isVisible(), false, `${where}: reset zoom also resets the vertical zoom`);

    // 5. A horizontal drag still selects time; a vertical drag then replaces it, and the other way round.
    await drag(at(.3, .5), at(.6, .52));
    assert.equal(await rangeShown(), true, `${where}: a horizontal drag selects a time range`);
    assert.equal(await button.isVisible(), false);
    await drag(at(.5, .3), at(.51, .7));
    assert.equal(await rangeShown(), false, `${where}: a vertical selection replaces the time range`);
    assert.equal(await button.getAttribute('data-kind'), 'zoom');
    await drag(at(.3, .5), at(.6, .5));
    assert.equal(await rangeShown(), true, `${where}: a time range replaces the vertical selection`);
    assert.equal(await button.isVisible(), false);
    // A drag that turns from across to up or down ends as a vertical selection: the longer way decides at every move.
    await page.mouse.move(at(.5, .5).x, at(.5, .5).y); await page.mouse.down(); await page.mouse.move(at(.55, .5).x, at(.55, .5).y); await page.mouse.move(at(.52, .85).x, at(.52, .85).y); await page.mouse.up(); await settle(); await settle();
    assert.equal(await rangeShown(), false, `${where}: a drag turned to vertical selects values`);
    assert.equal(await button.getAttribute('data-kind'), 'zoom');

    // 6. Escape, and a click on the graph, clear a vertical selection (the click adds no marker).
    await page.keyboard.press('Escape'); await settle();
    assert.equal(await button.isVisible(), false, `${where}: Escape clears the vertical selection`);
    await drag(at(.5, .3), at(.5, .6)); assert.equal(await button.isVisible(), true);
    const markerClear = page.locator(comparison ? '.visualize-card-actions button[aria-label="マーカーを全解除"]' : '.chart-marker-clear').first();
    await page.mouse.click(at(.7, .5).x, at(.7, .5).y); await settle(); await settle();
    assert.equal(await button.isVisible(), false, `${where}: a click clears the vertical selection`);
    assert.equal(await markerClear.isDisabled(), true, `${where}: the click that clears adds no marker`);

    assert.deepEqual(errors, [], `${where}: page errors`);
    await page.close();
  }
  console.log('value zoom UI check passed');
} finally {
  await browser.close();
}
