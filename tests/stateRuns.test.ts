import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildStateRuns, sliceStateRuns } from '../src/core/signal/stateRuns';

const build = (samples: readonly (readonly [number, number, string?])[], limit?: number) => buildStateRuns(samples.length, (index) => samples[index][0], (index) => samples[index][1], (index) => samples[index][2], undefined, limit);

test('a Signal becomes runs of equal values, with its states numbered by value', () => {
  const runs = build([[0, 3, 'Drive'], [1, 3, 'Drive'], [2, 0, 'Off'], [3, 0, 'Off'], [4, 1, 'Ready'], [5, 3, 'Drive'], [6, 3, 'Drive']]);
  assert.deepEqual(runs.states, [{ value: 0, label: 'Off' }, { value: 1, label: 'Ready' }, { value: 3, label: 'Drive' }], 'by value, not by which came first');
  assert.deepEqual(runs.starts, [0, 2, 4, 5]); assert.deepEqual(runs.stateOf, [2, 0, 1, 2]); assert.equal(runs.end, 6); assert.equal(runs.tooMany, false);
  assert.deepEqual(build([[0, 1], [1, 1], [2, 2]]).states, [{ value: 1 }, { value: 2 }], 'a Signal without state names keeps its values');
  assert.deepEqual(build([]).starts, []);
});

test('a Signal that changes too often is not a state Signal', () => {
  const noisy = build(Array.from({ length: 50 }, (_, index) => [index, index % 2] as const), 10);
  assert.equal(noisy.tooMany, true); assert.deepEqual(noisy.starts, []);
  assert.equal(build(Array.from({ length: 100 }, (_, index) => [index, index] as const)).tooMany, true, 'more distinct values than states can be told apart');
});

test('a span gives the runs it overlaps, cut to it; many runs become the longest-lasting state per slice', () => {
  const runs = build([[0, 0], [10, 1], [20, 0], [30, 2], [40, 2]]);
  assert.deepEqual(sliceStateRuns(runs, { start: 5, end: 25 }, 100, 10).runs, [{ start: 5, end: 10, state: 0 }, { start: 10, end: 20, state: 1 }, { start: 20, end: 25, state: 0 }]);
  assert.deepEqual(sliceStateRuns(runs, { start: 0, end: 40 }, 100, 10).runs!.map((run) => [run.start, run.end, run.state]), [[0, 10, 0], [10, 20, 1], [20, 30, 0], [30, 40, 2]]);
  assert.deepEqual(sliceStateRuns(runs, { start: 50, end: 60 }, 100, 10).runs, []); assert.deepEqual(sliceStateRuns(runs, { start: 12, end: 13 }, 100, 10).runs, [{ start: 12, end: 13, state: 1 }], 'inside one run');
  const dense = sliceStateRuns(runs, { start: 0, end: 40 }, 2, 4);
  assert.deepEqual(dense.bins, [{ state: 0, mixed: false }, { state: 1, mixed: false }, { state: 0, mixed: false }, { state: 2, mixed: false }]);
  assert.deepEqual(sliceStateRuns(runs, { start: 0, end: 40 }, 2, 2).bins, [{ state: 0, mixed: true }, { state: 0, mixed: true }], 'a slice with two states says so');
  assert.deepEqual(sliceStateRuns(runs, { start: -40, end: 40 }, 2, 4).bins!.slice(0, 2), [null, null], 'nothing before the first sample');
});

test('the sample log answers the state timeline: Drive Mode goes Off, Ready, Drive by name', async () => {
  const path = await import('path'); const vscode = await import('vscode');
  const { RawLogDocument } = await import('../src/extension/editors/rawLogDocument');
  const { PluginRegistry } = await import('../src/core/plugin/pluginHost');
  const { parseProjectJson } = await import('../src/core/project/schema');
  const file = path.resolve('sample/basic/sigmixa-basic.asc');
  (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file(path.dirname(file)) }];
  (vscode.workspace as any).getWorkspaceFolder = () => vscode.workspace.workspaceFolders![0];
  const doc = new RawLogDocument(vscode.Uri.file(file), file, parseProjectJson(readFileSync('sample/.sigmixa/project.json', 'utf8')), 1, new PluginRegistry());
  try {
    await doc.whenReady();
    const mode = doc.signalCatalog().find((definition) => definition.name === 'Drive Mode')!; const speed = doc.signalCatalog().find((definition) => definition.name === 'Vehicle Speed')!;
    assert.equal(mode.hasValueLabels, true);
    const result = doc.stateTimeline([mode.id, speed.id, 'missing'], undefined, 200, 300);
    assert.deepEqual(result.range, doc.timelineRange); assert.deepEqual(result.rows.map((row) => row.name), ['Drive Mode', 'Vehicle Speed']);
    const row = result.rows[0]; assert.equal(row.tooMany, false); assert.deepEqual(row.states.map((state) => state.label), ['Off', 'Ready', 'Drive']);
    assert.ok(row.runs!.length >= 2 && row.runs!.length < 20); assert.ok(row.runs!.every((run, index) => run.end >= run.start && (index === 0 || run.start === row.runs![index - 1].end)), 'runs follow one another');
    assert.equal(result.rows[1].tooMany, true, 'a speed is not a state');
    const zoomed = doc.stateTimeline([mode.id], { start: 10, end: 11 }, 200, 300).rows[0]; assert.deepEqual(zoomed.runs!.map((run) => [run.start, run.end]), [[10, 11]]);
  } finally { doc.dispose(); }
});

test('a report embeds every run of a state Signal, the default Signals of a new view, and slices when over budget', async () => {
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
    await doc.whenReady(); const range = doc.timelineRange!;
    const mode = doc.signalCatalog().find((definition) => definition.name === 'Drive Mode')!; const speed = doc.signalCatalog().find((definition) => definition.name === 'Vehicle Speed')!;
    const shown = doc.stateTimeline([mode.id], undefined, 200, 5000).rows[0].runs!;
    const [row, fast] = doc.reportStateTimeline([mode.id, speed.id], range);
    assert.deepEqual(row.starts!.map((start, index) => ({ start, end: row.starts![index + 1] ?? row.end, state: row.stateOf![index] })), shown, 'the same runs Visualize shows');
    assert.equal(fast.tooMany, true); assert.equal(fast.starts, undefined);
    assert.ok(doc.reportStateTimeline(undefined, range).some((item) => item.signalId === mode.id), 'a view without chosen Signals shows the ones with state names');
    const part = doc.reportStateTimeline([mode.id], { start: 10, end: 11 })[0]; assert.deepEqual([part.starts, part.end], [[10], 11]);
    const coarse = doc.reportStateTimeline([mode.id], range, 0, 50)[0]; assert.equal(coarse.starts, undefined); assert.equal(coarse.bins!.length, 50);
    const data = { series: [], analysis: { frames: [], intervals: [], states: [row, fast, coarse], distributions: [] } };
    assert.deepEqual(unpackReportData(JSON.parse(JSON.stringify(packReportData(data as never)))).analysis, JSON.parse(JSON.stringify(data.analysis)));
  } finally { doc.dispose(); }
});

test('a thinned slice shows the state that lasts longest in it in all, counting each of its runs', () => {
  // A 3 s, B 4 s, A 3 s in one slice: A lasts 6 s in all.
  const runs = { starts: [0, 3, 7], stateOf: [0, 1, 0], states: [{ value: 0 }, { value: 1 }], end: 10, tooMany: false };
  assert.deepEqual(sliceStateRuns(runs, { start: 0, end: 10 }, 1, 1).bins, [{ state: 0, mixed: true }]);
});


test('a rebuild that changes values but not how many there are shows the new values in the state timeline and the distribution', async () => {
  const path = await import('path'); const vscode = await import('vscode');
  const { RawLogDocument } = await import('../src/extension/editors/rawLogDocument');
  const { PluginRegistry } = await import('../src/core/plugin/pluginHost');
  const { parseProjectJson } = await import('../src/core/project/schema');
  const file = path.resolve('sample/basic/sigmixa-basic.asc');
  (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file(path.dirname(file)) }];
  (vscode.workspace as any).getWorkspaceFolder = () => vscode.workspace.workspaceFolders![0];
  const project = parseProjectJson(readFileSync('sample/.sigmixa/project.json', 'utf8'));
  const doc = new RawLogDocument(vscode.Uri.file(file), file, project, 1, new PluginRegistry());
  try {
    await doc.whenReady();
    const find = (name: string) => doc.signalCatalog().find((definition) => definition.name === name)!;
    const mode = find('Drive Mode'); const speed = find('Vehicle Speed');
    const before = { states: doc.stateTimeline([mode.id], undefined, 200, 300).rows[0].states.map((state) => state.value), speed: doc.distribution([speed.id], undefined, 20).rows[0] };
    // Every value 100 higher: the same samples, the same counts.
    const shifted = { ...project, frames: project.frames.map((frame) => ({ ...frame, signals: frame.signals.map((signal) => [mode.name, speed.name].includes(signal.name) ? { ...signal, conversion: { ...signal.conversion, offset: signal.conversion.offset + 100 } } : signal) })) } as typeof project;
    await doc.rebuildSignals(shifted, 2, true);
    const after = { states: doc.stateTimeline([find('Drive Mode').id], undefined, 200, 300).rows[0].states.map((state) => state.value), speed: doc.distribution([find('Vehicle Speed').id], undefined, 20).rows[0] };
    assert.deepEqual(after.states, before.states.map((value) => value + 100), 'the state timeline is read again');
    assert.ok(Math.abs(after.speed.lo - (before.speed.lo + 100)) < 1e-6 && Math.abs(after.speed.hi - (before.speed.hi + 100)) < 1e-6, 'the distribution bounds are found again');
  } finally { doc.dispose(); }
});
