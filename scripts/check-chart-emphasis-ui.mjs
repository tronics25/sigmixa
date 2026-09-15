import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(process.argv[2] ? pathToFileURL(process.argv[2]).href : 'playwright');
const browser = await chromium.launch({ headless: true, channel: process.argv[3] });
const definitions = ['speed', 'target'].map((id) => ({ id, name: id, unit: 'km/h', source: { type: 'manual-can', frameDefinitionId: 'f' } }));
const groups = [{ id: 'frame-f', label: 'Motion', signalIds: definitions.map((definition) => definition.id) }];
const series = definitions.map((definition, index) => ({ definition, samples: [{ timestamp: 0, value: 10 + index }, { timestamp: .5, value: 18 + index }, { timestamp: 1, value: 20 + index }], gaps: [], events: [], totalSamplesInRange: 3, globalMinimum: 10, globalMaximum: 21 }));
try {
  for (const comparison of [false, true]) {
    const page = await browser.newPage({ viewport: { width: 1250, height: 850 } }); const errors = []; page.on('pageerror', (error) => errors.push(error.stack ?? error.message));
    await page.setContent('<html lang="ja"><head><style>:root{--vscode-foreground:#ddd;--vscode-editor-background:#1e1e1e;--vscode-font-family:Arial;--vscode-editor-font-family:monospace;--vscode-input-background:#313131;--vscode-panel-border:#454545;--vscode-descriptionForeground:#aaa;--vscode-focusBorder:#69b8f0}</style></head><body><div id="app"></div></body></html>');
    await page.evaluate(() => {
      window.messages = []; window.strokes = []; window.labelBorders = [];
      window.acquireVsCodeApi = () => ({ getState: () => ({}), setState: () => {}, postMessage: (message) => window.messages.push(message) });
      const stroke = CanvasRenderingContext2D.prototype.stroke;
      const segments = new WeakMap(); const begin = CanvasRenderingContext2D.prototype.beginPath; const line = CanvasRenderingContext2D.prototype.lineTo;
      CanvasRenderingContext2D.prototype.beginPath = function(...args) { segments.set(this, 0); return begin.apply(this, args); };
      CanvasRenderingContext2D.prototype.lineTo = function(...args) { segments.set(this, (segments.get(this) ?? 0) + 1); return line.apply(this, args); };
      CanvasRenderingContext2D.prototype.stroke = function(...args) { window.strokes.push({ color: this.strokeStyle, width: this.lineWidth, exported: !this.canvas.isConnected, segments: segments.get(this) }); return stroke.apply(this, args); };
      const strokeRect = CanvasRenderingContext2D.prototype.strokeRect;
      CanvasRenderingContext2D.prototype.strokeRect = function(...args) { window.labelBorders.push({ color: this.strokeStyle, dash: this.getLineDash(), width: this.lineWidth, exported: !this.canvas.isConnected }); return strokeRect.apply(this, args); };
    });
    const bundle = await build({ entryPoints: [comparison ? 'src/webview/clips/clipComparison.ts' : 'src/webview/raw/rawLog.ts'], bundle: true, write: false, platform: 'browser', format: 'iife' });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const send = (message) => page.evaluate((data) => window.dispatchEvent(new MessageEvent('message', { data })), message);
    const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    if (comparison) {
      await send({ type: 'init', definitions, groups, selectedSignalIds: ['speed', 'target'], clips: ['a', 'b'].map((id) => ({ id, name: id, fileName: `${id}.asc`, startTimestamp: 0, endTimestamp: 1, anchorTimestamp: 0, series })) });
    } else {
      await send({ type: 'init', fileName: 'test.asc', parsing: false, frames: 2, diagnostics: 0, channels: [1], viewState: { chartSelectedIds: ['speed', 'target'] } });
      await page.getByRole('button', { name: '時系列', exact: true }).click();
      const catalogRequest = await page.evaluate(() => window.messages.findLast((message) => message.type === 'signalCatalogRequest' && message.view === 'timeSeries'));
      assert.ok(catalogRequest, `Time Series catalog request missing: ${errors.join(' | ')}`); const requestId = catalogRequest.requestId;
      await send({ type: 'signalCatalog', requestId, definitions, groups });
      const seriesId = await page.evaluate(() => window.messages.findLast((message) => message.type === 'signalSeriesRequest').requestId);
      await send({ type: 'signalSeries', requestId: seriesId, fullRange: { start: 0, end: 1 }, series });
    }
    await settle();
    const secondaryActions = page.locator(comparison ? '#app > .toolbar .toolbar-secondary' : '#timeseries-view .toolbar-secondary').first();
    assert.equal(await secondaryActions.locator('button').count(), 3, 'secondary chart actions share one compact icon group');
    const imageAction = secondaryActions.locator(comparison ? '.save-image' : '.save-chart-image'); assert.equal(await imageAction.textContent(), ''); assert.ok(await imageAction.getAttribute('aria-label'), 'icon-only image action retains an accessible name');
    const markerClear = page.locator(comparison ? '.marker-clear' : '.chart-marker-clear');
    assert.equal(await markerClear.isVisible(), true, 'marker clear keeps a stable toolbar position before markers exist');
    assert.equal(await markerClear.isDisabled(), true, 'marker clear is disabled before markers exist');
    assert.ok(Number.parseFloat(await markerClear.evaluate((element) => getComputedStyle(element).opacity)) < .5, 'disabled marker clear is visibly toned down');
    if (comparison) {
      const offset = page.locator('.clip[data-clip-id="a"] .clip-offset'); const next = page.locator('.clip[data-clip-id="a"] .clip-shift').last();
      const shiftCount = () => page.evaluate(() => window.messages.filter((message) => message.type === 'shiftAnchor' && message.clipId === 'a').length);
      const beforeClick = await shiftCount(); await next.click(); assert.equal(await shiftCount(), beforeClick + 1, 'alignment button click advances one CAN Timestamp');
      const nextBox = await next.boundingBox(); await page.mouse.move(nextBox.x + nextBox.width / 2, nextBox.y + nextBox.height / 2); await page.mouse.down(); await page.waitForTimeout(470); await page.mouse.up();
      assert.ok(await shiftCount() >= beforeClick + 4, 'holding an alignment button repeats CAN Timestamp steps');
      await offset.hover(); await page.mouse.wheel(0, 96); await settle();
      assert.ok(await page.evaluate(() => window.messages.some((message) => message.type === 'shiftAnchor' && message.clipId === 'a' && message.steps >= 2)), 'wheel alignment batches CAN Timestamp steps');
      const offsetBox = await offset.boundingBox(); await page.mouse.move(offsetBox.x + offsetBox.width / 2, offsetBox.y + offsetBox.height / 2); await page.mouse.down(); await page.mouse.move(offsetBox.x + offsetBox.width / 2 + 80, offsetBox.y + offsetBox.height / 2); await page.mouse.up(); await settle();
      assert.ok(await page.evaluate(() => window.messages.some((message) => message.type === 'setAnchor' && message.clipId === 'a' && message.timestamp > 0)), 'drag alignment commits an absolute Timestamp for CAN snapping');
      await offset.click(); assert.ok(await page.evaluate(() => window.messages.some((message) => message.type === 'resetAnchor' && message.clipId === 'a')), 'offset click still resets alignment');
    }
    const selectorHost = page.locator(comparison ? '.signal-selector' : '.chart-pane .signal-selector');
    const requestsBeforeGrouping = await page.evaluate(() => window.messages.filter((message) => message.type === 'signalSeriesRequest' || message.type === 'selectionChanged').length);
    await selectorHost.getByRole('button', { name: '単位系', exact: true }).click(); await settle();
    assert.equal(await selectorHost.locator('.selector-group-head>span').textContent(), '速度');
    assert.equal(await selectorHost.locator('.selector-group-count').textContent(), '2/2');
    assert.equal(await selectorHost.locator('.selector-signal input:checked').count(), 2);
    assert.equal(await page.evaluate(() => window.messages.filter((message) => message.type === 'signalSeriesRequest' || message.type === 'selectionChanged').length), requestsBeforeGrouping, 'Grouping must not request or change plotted Signals');
    const search = selectorHost.getByRole('searchbox'); await search.fill('速度'); await settle();
    assert.equal(await selectorHost.locator('.selector-signal').count(), 2, 'Attribute search must show the full matching group');
    await search.fill('Motion'); await settle();
    assert.equal(await selectorHost.locator('.selector-signal').count(), 2, 'Frame source remains searchable in unit mode');
    await search.fill(''); await settle();
    await selectorHost.getByRole('button', { name: 'Frame', exact: true }).click(); await settle();
    assert.equal(await selectorHost.locator('.selector-group-head>span').textContent(), 'Motion');
    assert.equal(await selectorHost.locator('.selector-signal input:checked').count(), 2);
    const legend = page.locator(comparison ? '.legend-entry[data-signal-id="speed"][data-clip-id="a"]' : '.chart-legend-entry[data-signal-id="speed"]');
    assert.equal(await page.locator(comparison ? '.legend .axis-badge' : '.chart-legend .chart-axis-badge').count(), 0, 'chart legends do not show redundant L/R badges');
    await page.evaluate(() => { window.strokes = []; }); await legend.hover(); await settle();
    const hovered = await page.evaluate(() => window.strokes.filter((stroke) => stroke.color === '#2563eb'));
    assert.ok(hovered.some((stroke) => stroke.width === 3), 'legend emphasizes its plotted line');
    if (comparison) assert.ok(hovered.some((stroke) => stroke.width === 1.5), 'other Clip remains at normal width');
    await page.evaluate(() => { window.strokes = []; });
    await legend.click(); await page.mouse.move(1, 1); await settle();
    assert.equal(await legend.evaluate((element) => getComputedStyle(element).backgroundColor), 'rgba(0, 0, 0, 0)', 'mouse exit restores transparent legend background after click');
    assert.equal(await legend.evaluate((element) => getComputedStyle(element).boxShadow), 'none', 'mouse focus does not retain emphasis');
    await legend.hover(); await page.mouse.move(1, 1); await settle();
    assert.equal(await legend.evaluate((element) => getComputedStyle(element).backgroundColor), 'rgba(0, 0, 0, 0)', 'repeated hover restores original background');
    // Focus is kept on the legend while programmatically triggering export.
    await legend.focus();
    await page.locator(comparison ? '.save-image' : '.save-chart-image').evaluate((button) => button.click());
    const renderedImage = await page.evaluate((type) => window.messages.findLast((message) => message.type === type), comparison ? 'saveClipComparisonImage' : 'saveTimeSeriesImage');
    assert.match(renderedImage.pngDataUrl, /^data:image\/png;base64,/);
    assert.match(renderedImage.svg, /^<\?xml[^>]+><svg/); assert.ok(renderedImage.svg.includes('<path ')); assert.ok(renderedImage.svg.includes('<text ')); assert.ok(!renderedImage.svg.includes('<image '), 'SVG export contains vector geometry rather than an embedded PNG');
    assert.ok(!renderedImage.svg.includes('>L ·') && !renderedImage.svg.includes('>R ·'), 'exported legends omit L/R prefixes');
    assert.equal(await page.evaluate((svg) => new DOMParser().parseFromString(svg, 'image/svg+xml').querySelectorAll('parsererror').length, renderedImage.svg), 0, 'SVG export is valid XML');
    const exported = await page.evaluate(() => window.strokes.filter((stroke) => stroke.exported && stroke.color === '#2563eb' && stroke.segments >= 2));
    assert.ok(exported.length > 0); assert.ok(exported.every((stroke) => stroke.width === 1.5), 'temporary emphasis does not enter the saved image');
    await page.evaluate(() => { document.activeElement.blur(); window.strokes = []; });
    await page.locator('.selector-signal[data-signal-id="target"]').hover(); await settle();
    assert.ok(await page.evaluate(() => window.strokes.some((stroke) => stroke.color === '#dc2626' && stroke.width === 3)), 'selector emphasizes the corresponding line');
    // Supply dense measured samples and place nearby fixed cursors on the real canvas.
    await page.evaluate(() => {
      const messages = window.messages; const push = messages.push;
      messages.push = function(message) {
        const result = push.call(this, message);
        if (message.type === 'measuredSignalsRequest') queueMicrotask(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'measuredSignals', requestId: message.requestId, samples: (message.signalIds ?? message.selectedIds).map((signalId) => ({ signalId, sample: { timestamp: message.timestamp, value: 15, valueLabel: '運転' } })) } })));
        if (message.type === 'snapTimeRangeRequest') queueMicrotask(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'timeRangeAdjusted', requestId: message.requestId, startTimestamp: message.startTimestamp, endTimestamp: message.endTimestamp } })));
        return result;
      };
      window.timestampLabels = []; window.stateLabels = [];
      const fill = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function(text, x, y, ...rest) {
        if (String(text).includes('(運転)')) window.stateLabels.push({ text, exported: !this.canvas.isConnected });
        if (/^\+?\d+(?:\.\d+)? s$/.test(text)) window.timestampLabels.push({ text, x, y, exported: !this.canvas.isConnected });
        return fill.call(this, text, x, y, ...rest);
      };
    });
    const chart = page.locator(comparison ? '.canvas-wrap canvas' : '.chart-canvas-wrap canvas').first();
    const box = await chart.boundingBox(); const baselineHeight = box.height;
    await page.evaluate(() => { window.labelBorders = []; }); await page.mouse.move(box.x + box.width / 2, box.y + 160); await settle(); await settle();
    const borders = await page.evaluate(() => window.labelBorders.filter((item) => item.color === '#2563eb' || item.color === '#dc2626'));
    assert.ok(borders.some((item) => item.dash.length === 0), 'solid graph values use solid color-matched borders');
    if (comparison) assert.ok(borders.some((item) => item.dash.join(',') === '8,4'), 'dashed Clip values use the same dashed color-matched borders');
    else assert.ok(borders.every((item) => item.dash.length === 0), 'single-file value borders remain solid');
    for (const delta of [0, 4]) { await page.mouse.click(box.x + box.width / 2 + delta, box.y + 160); await settle(); await settle(); }
    assert.equal(await markerClear.isEnabled(), true, 'marker clear becomes active after a marker is added');
    await page.mouse.move(1, 1); await settle(); await settle();
    assert.equal((await chart.boundingBox()).height, baselineHeight + 21, 'only one extra axis row is reserved for two close markers');
    const badges = await page.evaluate(() => window.timestampLabels.filter((item) => !item.exported).slice(-2));
    assert.equal(badges.length, 2); assert.ok(Math.abs((badges[1].x - badges[0].x) - 4) < .01, 'timestamps keep the cursor horizontal separation');
    assert.equal(badges[1].y - badges[0].y, 21, 'nearby timestamps stack downward');
    await page.evaluate(() => { window.timestampLabels = []; });
    await page.locator(comparison ? '.save-image' : '.save-chart-image').evaluate((button) => button.click());
    const imageBadges = await page.evaluate(() => window.timestampLabels.filter((item) => item.exported));
    assert.ok(await page.evaluate(() => window.stateLabels.some((item) => item.exported)), 'state labels are included in image markers');
    assert.equal(imageBadges.length, 2, 'both fixed timestamps are exported');
    assert.equal(imageBadges[1].y - imageBadges[0].y, 21, 'saved image also stacks close timestamps downward');
    await markerClear.click();
    assert.equal(await markerClear.isDisabled(), true, 'clearing all markers tones the action down again');
    if (!comparison) {
      const navigationTop = (await page.locator('.chart-navigation').boundingBox()).y;
      const rangeBox = await chart.boundingBox();
      await page.mouse.move(rangeBox.x + 220, rangeBox.y + 160); await page.mouse.down();
      await page.mouse.move(rangeBox.x + 620, rangeBox.y + 160); await page.mouse.up(); await settle();
      const rangeControls = page.locator('.range-controls');
      await rangeControls.waitFor({ state: 'visible' });
      assert.equal(await page.locator('.chart-navigation').isHidden(), true, 'range actions replace ordinary navigation instead of adding another toolbar');
      assert.ok(Math.abs((await rangeControls.boundingBox()).y - navigationTop) < 1, 'range actions occupy the navigation row');
      assert.equal(await rangeControls.getByRole('button', { name: '拡大', exact: true }).count(), 1);
      assert.equal(await rangeControls.getByRole('button', { name: 'クリップ作成', exact: true }).count(), 1);
      await rangeControls.getByRole('button', { name: 'クリップ作成', exact: true }).click();
      assert.ok(await page.evaluate(() => window.messages.some((message) => message.type === 'createClip' && message.endTimestamp > message.startTimestamp)), 'selected range creates a Clip');
      await rangeControls.getByRole('button', { name: '拡大', exact: true }).click();
      const zoomRequest = await page.evaluate(() => window.messages.findLast((message) => message.type === 'signalSeriesRequest'));
      assert.ok(zoomRequest.range.end > zoomRequest.range.start && zoomRequest.range.end - zoomRequest.range.start < 1, 'selected range becomes the requested viewport');
      assert.equal(await rangeControls.isHidden(), true, 'range controls close after zooming');
    }
    const zoomIn = page.locator('.chart-navigation .zoom-in'); const zoomBox = await zoomIn.boundingBox();
    if (comparison) {
      const beforeSpan = await page.locator('.view-range').textContent();
      await page.mouse.move(zoomBox.x + zoomBox.width / 2, zoomBox.y + zoomBox.height / 2); await page.mouse.down(); await page.waitForTimeout(620); await page.mouse.up(); await settle();
      assert.notEqual(await page.locator('.view-range').textContent(), beforeSpan, 'holding comparison zoom repeatedly changes the viewport');
    } else {
      const beforeZoom = await page.evaluate(() => window.messages.filter((message) => message.type === 'signalSeriesRequest').length);
      await page.mouse.move(zoomBox.x + zoomBox.width / 2, zoomBox.y + zoomBox.height / 2); await page.mouse.down(); await page.waitForTimeout(620); await page.mouse.up();
      assert.ok(await page.evaluate(() => window.messages.filter((message) => message.type === 'signalSeriesRequest').length) >= beforeZoom + 3, 'holding Time Series zoom repeatedly changes the viewport');
      await page.getByRole('button', { name: '軌跡', exact: true }).click();
      const trajectoryCatalog = await page.evaluate(() => window.messages.findLast((message) => message.type === 'signalCatalogRequest' && message.view === 'trajectory'));
      await send({ type: 'signalCatalog', requestId: trajectoryCatalog.requestId, definitions, groups });
      await page.locator('.axis-x').selectOption('speed'); await page.locator('.axis-y').selectOption('target');
      const trajectoryRequest = await page.evaluate(() => window.messages.findLast((message) => message.type === 'signalSeriesRequest' && message.selectedIds?.length === 2 && message.maxPoints === 10000));
      await send({ type: 'signalSeries', requestId: trajectoryRequest.requestId, fullRange: { start: 0, end: 1 }, series }); await settle();
      await page.locator('.save-trajectory-image').click();
      const trajectorySecondary = page.locator('#trajectory-view .toolbar-secondary'); assert.equal(await trajectorySecondary.locator('button').count(), 2); assert.equal(await page.locator('.save-trajectory-image').textContent(), ''); assert.equal(await page.locator('.preset-reset').textContent(), '');
      const trajectoryImage = await page.evaluate(() => window.messages.findLast((message) => message.type === 'saveTrajectoryImage'));
      assert.match(trajectoryImage.pngDataUrl, /^data:image\/png;base64,/); assert.ok(trajectoryImage.svg.includes('<path ')); assert.ok(trajectoryImage.svg.includes('<text ')); assert.ok(!trajectoryImage.svg.includes('<image '), 'Trajectory SVG remains vector geometry');
      assert.equal(await page.evaluate((svg) => new DOMParser().parseFromString(svg, 'image/svg+xml').querySelectorAll('parsererror').length, trajectoryImage.svg), 0, 'Trajectory SVG is valid XML');
    }
    assert.deepEqual(errors, []); console.log(`${comparison ? 'Comparison' : 'Time Series'}: legend/selector emphasis and clean image export passed.`); await page.close();
  }
} finally { await browser.close(); }
