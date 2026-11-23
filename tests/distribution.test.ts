import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { buildDistribution, mergeDistribution, slicesIn, valueExtent } from '../src/core/signal/distribution';

const always = () => true;

test('a distribution counts every sample of the span once, and its statistics are those of the values', () => {
  const values = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10]; const times = values.map((_, index) => index);
  const extent = valueExtent(0, values.length, (index) => values[index], always)!; assert.deepEqual(extent, { lo: 0, hi: 10 });
  const whole = mergeDistribution(buildDistribution(0, values.length, (index) => times[index], (index) => values[index], always, { start: 0, end: 9 }, 1, extent, 5));
  assert.deepEqual(whole.bins, [2, 2, 2, 2, 2], 'the greatest value is in the last bar'); assert.equal(whole.count, 10); assert.equal(whole.min, 0); assert.equal(whole.max, 10); assert.equal(whole.mean, 4.6);
  assert.ok(Math.abs(whole.sd! - Math.sqrt(values.reduce((sum, value) => sum + (value - 4.6) ** 2, 0) / 10)) < 1e-12);
  const part = mergeDistribution(buildDistribution(0, values.length, (index) => times[index], (index) => values[index], always, { start: 2, end: 4 }, 1, extent, 5));
  assert.deepEqual([part.count, part.min, part.max, part.mean, part.bins], [3, 2, 4, 3, [0, 2, 1, 0, 0]], 'bars keep their places when the span narrows');
  const none = mergeDistribution(buildDistribution(0, values.length, (index) => times[index], (index) => values[index], always, { start: 20, end: 30 }, 1, extent, 5));
  assert.deepEqual(none, { count: 0, bins: [0, 0, 0, 0, 0] });
});

test('unusable samples are left out, a constant Signal is one bar, and large values keep their deviation', () => {
  const values = [5, Number.NaN, 5, 5]; const usable = (index: number) => Number.isFinite(values[index]);
  const flat = mergeDistribution(buildDistribution(0, 4, (index) => index, (index) => values[index], usable, { start: 0, end: 3 }, 1, valueExtent(0, 4, (index) => values[index], usable)!, 40));
  assert.deepEqual(flat, { count: 3, min: 5, max: 5, mean: 5, sd: 0, bins: [3] });
  assert.equal(valueExtent(0, 0, () => 0, always), undefined);
  const big = [1e12, 1e12 + 1, 1e12 + 2]; const stats = mergeDistribution(buildDistribution(0, 3, (index) => index, (index) => big[index], always, { start: 0, end: 2 }, 1, { lo: 1e12, hi: 1e12 + 2 }, 2));
  assert.equal(stats.mean, 1e12 + 1); assert.ok(Math.abs(stats.sd! - Math.sqrt(2 / 3)) < 1e-9);
});

test('slices of a span add up to the whole, and a run of slices gives the statistics of its time', () => {
  const count = 1000; const valueAt = (index: number) => Math.sin(index / 37) * 50 + index / 20; const timeAt = (index: number) => index / 10;
  const extent = valueExtent(0, count, valueAt, always)!; const range = { start: 0, end: 99.9 };
  const grid = buildDistribution(0, count, timeAt, valueAt, always, range, 50, extent, 40); const whole = mergeDistribution(buildDistribution(0, count, timeAt, valueAt, always, range, 1, extent, 40));
  const merged = mergeDistribution(grid); assert.deepEqual(merged.bins, whole.bins); assert.equal(merged.count, whole.count); assert.equal(merged.min, whole.min); assert.equal(merged.max, whole.max);
  assert.ok(Math.abs(merged.mean! - whole.mean!) < 1e-9 && Math.abs(merged.sd! - whole.sd!) < 1e-9);
  assert.deepEqual(slicesIn(grid, range), { from: 0, to: 50 });
  const width = 99.9 / 50; const some = slicesIn(grid, { start: width * 10, end: width * 20 }); assert.deepEqual(some, { from: 10, to: 20 });
  const direct = mergeDistribution(buildDistribution(0, count, timeAt, valueAt, (index) => timeAt(index) >= width * 10 && timeAt(index) < width * 20, range, 1, extent, 40));
  assert.deepEqual(mergeDistribution(grid, some.from, some.to).bins, direct.bins);
  assert.deepEqual(slicesIn(grid, { start: 40.01, end: 40.02 }), { from: 20, to: 21 }, 'a span inside one slice shows that slice');
});

test('the sample log answers the distribution view and the report: Vehicle Speed over the log and over a part of it', async () => {
  const path = await import('path'); const vscode = await import('vscode');
  const { RawLogDocument } = await import('../src/extension/editors/rawLogDocument');
  const { PluginRegistry } = await import('../src/core/plugin/pluginHost');
  const { parseProjectJson } = await import('../src/core/project/schema');
  const { packReportData, unpackReportData } = await import('../src/extension/report/reportPacking');
  const file = path.resolve('sample/basic/sigmixa-basic.asc');
  (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file(path.dirname(file)) }];
  (vscode.workspace as any).getWorkspaceFolder = () => vscode.workspace.workspaceFolders![0];
  const doc = new RawLogDocument(vscode.Uri.file(file), file, parseProjectJson(readFileSync('sample/.sigmixa/project.json', 'utf8')), 1, new PluginRegistry());
  try {
    await doc.whenReady(); const range = doc.timelineRange!; const speed = doc.signalCatalog().find((definition) => definition.name === 'Vehicle Speed')!;
    const samples = doc.signalSeries([speed.id], undefined, 10_000_000).series[0].samples.filter((sample) => Number.isFinite(sample.value));
    const whole = doc.distribution([speed.id, 'missing'], undefined, 40); assert.deepEqual(whole.range, range); assert.equal(whole.rows.length, 1);
    const row = whole.rows[0]; const values = samples.map((sample) => sample.value);
    assert.equal(row.count, values.length); assert.equal(row.min, Math.min(...values)); assert.equal(row.max, Math.max(...values)); assert.equal(row.lo, row.min); assert.equal(row.hi, row.max);
    assert.ok(Math.abs(row.mean! - values.reduce((sum, value) => sum + value, 0) / values.length) < 1e-9); assert.equal(row.bins.reduce((sum, value) => sum + value, 0), values.length); assert.equal(row.bins.length, 40);
    const part = doc.distribution([speed.id], { start: 10, end: 20 }, 40).rows[0]; const inside = samples.filter((sample) => sample.timestamp >= 10 && sample.timestamp <= 20).map((sample) => sample.value);
    assert.equal(part.count, inside.length); assert.equal(part.max, Math.max(...inside)); assert.equal(part.lo, row.lo, 'the bars divide the Signal\'s whole value span'); assert.equal(part.hi, row.hi);
    const report = doc.reportDistribution([speed.id], range); assert.equal(report[0].grid.slices, 500);
    const merged = mergeDistribution(report[0].grid); assert.deepEqual(merged.bins, row.bins); assert.equal(merged.count, row.count);
    assert.ok(doc.reportDistribution(undefined, range).length > 0, 'a view without chosen Signals shows measured ones');
    const data = { series: [], analysis: { frames: [], intervals: [], states: [], distributions: report } };
    const packed = JSON.stringify(packReportData(data as never)); assert.deepEqual(unpackReportData(JSON.parse(packed)).analysis, JSON.parse(JSON.stringify(data.analysis)));
    assert.ok(packed.length < JSON.stringify(data).length, `${packed.length} vs ${JSON.stringify(data).length}`);
  } finally { doc.dispose(); }
});

test('a log report has its analysis views in Visualize order, and embeds what a view added in the report needs', async () => {
  const path = await import('path'); const vscode = await import('vscode');
  const { RawLogDocument } = await import('../src/extension/editors/rawLogDocument');
  const { PluginRegistry } = await import('../src/core/plugin/pluginHost');
  const { parseProjectJson } = await import('../src/core/project/schema');
  const { inVisualizeOrder, reportAnalysis } = await import('../src/extension/report/reportAnalysis');
  const file = path.resolve('sample/basic/sigmixa-basic.asc');
  (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file(path.dirname(file)) }];
  (vscode.workspace as any).getWorkspaceFolder = () => vscode.workspace.workspaceFolders![0];
  const doc = new RawLogDocument(vscode.Uri.file(file), file, parseProjectJson(readFileSync('sample/.sigmixa/project.json', 'utf8')), 1, new PluginRegistry());
  try {
    await doc.whenReady(); const range = doc.timelineRange!; const speed = doc.signalCatalog().find((definition) => definition.name === 'Vehicle Speed')!; const mode = doc.signalCatalog().find((definition) => definition.name === 'Drive Mode')!;
    const none = reportAnalysis(doc, { visualizeViews: [{ id: 'g', kind: 'graph', name: 'Graph', settings: { chartSelectedIds: [speed.id] } }] }, range, [speed.id], []);
    assert.deepEqual(none.views, [], 'no such views in Visualize: none in the report');
    assert.ok(none.analysis!.frames.length > 0 && none.analysis!.states.some((row) => row.signalId === mode.id) && none.analysis!.distributions.some((row) => row.signalId === speed.id), 'but they can be added there');
    const state = { visualizeViews: [
      { id: 't', kind: 'frameTiming' as const, name: 'Timing', settings: { frameTimingHiddenKeys: ['s:291'] } }, { id: 'g', kind: 'graph' as const, name: 'Graph', settings: { chartSelectedIds: [speed.id] } },
      { id: 'i', kind: 'frameInterval' as const, name: 'Interval', settings: {} }, { id: 's', kind: 'stateTimeline' as const, name: 'States', settings: {} }, { id: 'd', kind: 'distribution' as const, name: 'Spread', settings: { distributionIds: [mode.id] } },
    ] };
    const notices: string[] = []; const made = reportAnalysis(doc, state, range, [speed.id], notices);
    assert.deepEqual(made.views.map((view) => [view.id, view.kind]), [['t', 'frameTiming'], ['i', 'frameInterval'], ['s', 'stateTimeline'], ['d', 'distribution']]);
    assert.deepEqual(made.views[0].hiddenCanKeys, ['s:291']); assert.deepEqual(made.views[1].canKeys, [doc.frameIntervals(undefined, undefined, 300, 2000).data.key]);
    assert.deepEqual(made.views[2].signalIds, doc.newViewSignals('stateTimeline')); assert.deepEqual(made.views[3].signalIds, [mode.id]);
    assert.ok(made.analysis!.distributions.some((row) => row.signalId === mode.id) && made.analysis!.distributions.some((row) => row.signalId === speed.id));
    assert.deepEqual(notices, [], 'everything of the sample log is embedded whole');
    assert.deepEqual(inVisualizeOrder(state, [{ id: 'g', name: 'Graph', signalIds: [] }, ...made.views]).map((view) => view.id), ['t', 'g', 'i', 's', 'd']);
  } finally { doc.dispose(); }
});

test('the standard deviation of large values with a small spread is exact (no squares of the values)', () => {
  const values = [4e9 - 1, 4e9, 4e9 + 1, 4e9 - 1, 4e9, 4e9 + 1]; const always = () => true;
  for (const slices of [1, 3]) {
    const stats = mergeDistribution(buildDistribution(0, values.length, (index) => index, (index) => values[index], always, { start: 0, end: 5 }, slices, { lo: 0, hi: 5e9 }, 10));
    assert.ok(Math.abs(stats.sd! - Math.sqrt(2 / 3)) < 1e-6, `${slices} slice(s): ${stats.sd}`); assert.equal(stats.mean, 4e9);
  }
});

test('at the moment a state changes, the state timeline shows the new state', async () => {
  const { stateAt } = await import('../src/webview/timing/stateTimelinePaint');
  const row = { signalId: 's', name: 'S', states: [{ value: 0 }, { value: 1 }], tooMany: false, runs: [{ start: 0, end: 5, state: 0 }, { start: 5, end: 9, state: 1 }] };
  assert.equal(stateAt(row as never, 5, undefined)?.state, 1); assert.equal(stateAt(row as never, 4.99, undefined)?.state, 0); assert.equal(stateAt(row as never, 9, undefined)?.state, 1);
});
