import test from 'node:test';
import assert from 'node:assert/strict';
import { estimatePeriodMs, intervalSeries, lowerBound, summarizeTiming, timingSlice, type TimeList } from '../src/core/frame/frameTiming';
import { ChunkedFrameStore } from '../src/core/frame/frameStore';
import type { CanFrame } from '../src/core/frame/canFrame';

const list = (values: readonly number[]): TimeList => ({ length: values.length, at: (index) => values[index] });
const every = (periodSeconds: number, count: number, start = 0) => Array.from({ length: count }, (_, index) => start + index * periodSeconds);

test('the period of a periodic CAN ID is its usual interval; one sent on events has none', () => {
  assert.ok(Math.abs(estimatePeriodMs(list(every(0.1, 500)))! - 100) < 1e-6);
  const jittered = every(0.1, 500).map((time, index) => time + ((index * 7919) % 21 - 10) / 1000);
  const period = estimatePeriodMs(list(jittered))!; assert.ok(period > 90 && period < 110, 'jitter of ±10 ms is still periodic');
  assert.equal(estimatePeriodMs(list([0, 0.4, 0.41, 3, 3.2, 9, 9.05, 20])), undefined);
  assert.equal(estimatePeriodMs(list([0, 0.1])), undefined, 'too few frames to tell');
});

test('gaps are intervals well beyond the period, by the defined period when there is one', () => {
  const times = [...every(0.1, 100), ...every(0.1, 100, 19)];
  const summary = summarizeTiming(list(times));
  assert.equal(summary.count, 200); assert.ok(Math.abs(summary.periodMs! - 100) < 1e-6); assert.equal(summary.estimated, true);
  assert.equal(summary.gapCount, 1); assert.ok(Math.abs(summary.gaps[0].start - 9.9) < 1e-9); assert.equal(summary.gaps[0].end, 19);
  const defined = summarizeTiming(list(every(0.1, 100)), 50);
  assert.equal(defined.periodMs, 50); assert.equal(defined.estimated, false); assert.equal(defined.gapCount, 99, 'every 100 ms interval is late for a 50 ms period');
  assert.equal(summarizeTiming(list([0, 0.4, 0.41, 3, 3.2, 9, 9.05, 20])).gapCount, 0, 'no period, no gaps');
  const clipped = summarizeTiming(list(times), undefined, { start: 0, end: 5 }); assert.equal(clipped.count, 51); assert.equal(clipped.gapCount, 0);
});

test('a span gives every time while they are few, and counts per slice when they are many', () => {
  const times = list(every(0.01, 1001));
  assert.deepEqual(timingSlice(times, { start: 1, end: 1.05 }, 10, 100), { count: 6, times: [1, 1.01, 1.02, 1.03, 1.04, 1.05].map((value) => times.at(lowerBound(times, value - 1e-9))) });
  const dense = timingSlice(times, { start: 0, end: 10 }, 10, 100);
  assert.equal(dense.count, 1001); assert.equal(dense.times, undefined); assert.equal(dense.bins!.length, 10);
  assert.equal(dense.bins!.reduce((sum, value) => sum + value, 0), 1001, 'every frame is counted once'); assert.ok(dense.bins!.every((value) => value >= 99 && value <= 102));
  assert.deepEqual(timingSlice(times, { start: 50, end: 60 }, 10, 100), { count: 0, times: [] });
});

test('the store lists its CAN IDs and reads their times from the frame columns', () => {
  const store = new ChunkedFrameStore(); const frames: CanFrame[] = [];
  for (let index = 0; index < 10_000; index++) frames.push({ id: `f:${index}`, sourceId: 'f', timestamp: index / 1000, canId: index % 4 === 0 ? 0x123 : 0x18FF50E5, extended: index % 4 !== 0, direction: 'Rx', channel: 1, dlcCode: 0, dataLength: 0, data: new Uint8Array() });
  store.append(frames);
  assert.deepEqual(store.canRefs(), [{ canId: 0x123, extended: false }, { canId: 0x18FF50E5, extended: true }]);
  const times = store.canRefTimes(0x123, false)!; assert.equal(times.length, 2500); assert.equal(times.at(0), 0); assert.equal(times.at(2499), 9.996);
  assert.ok(Math.abs(summarizeTiming(times).periodMs! - 4) < 1e-6); assert.equal(store.canRefTimes(0x999, false), undefined);
});

test('the sample log answers frame timing: every CAN ID, the heartbeat\'s dropout, times when zoomed in and slices when not', async () => {
  const path = await import('path'); const vscode = await import('vscode');
  const { RawLogDocument } = await import('../src/extension/editors/rawLogDocument');
  const { PluginRegistry } = await import('../src/core/plugin/pluginHost');
  const { emptyProject } = await import('../src/core/project/schema');
  const file = path.resolve('sample/basic/sigmixa-basic.asc');
  (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file(path.dirname(file)) }];
  (vscode.workspace as any).getWorkspaceFolder = () => vscode.workspace.workspaceFolders![0];
  const doc = new RawLogDocument(vscode.Uri.file(file), file, emptyProject(), 1, new PluginRegistry());
  try {
    await doc.whenReady();
    const whole = doc.frameTiming(undefined, 100, 150);
    assert.deepEqual(whole.range, doc.timelineRange);
    assert.deepEqual(whole.rows.slice(0, 3).map((row) => row.canId), ['123', '182', '184'], 'standard IDs in order');
    assert.ok(whole.rows.at(-1)!.key.startsWith('e:'), 'extended IDs last');
    const fast = whole.rows.find((row) => row.canId === '123')!;
    assert.equal(fast.total, 1201); assert.equal(fast.times, undefined); assert.equal(fast.bins!.length, 100); assert.equal(fast.bins!.reduce((sum, value) => sum + value, 0), 1201);
    assert.ok(Math.abs(fast.periodMs! - 50) < 1e-6); assert.equal(fast.estimated, true); assert.equal(fast.gapCount, 0);
    const heartbeat = whole.rows.find((row) => row.canId === '3C0')!;
    assert.ok(heartbeat.gaps.some((gap) => gap.start > 40 && gap.start < 42 && gap.end > 49 && gap.end < 51), 'the 41–50 s dropout is a gap');
    const request = whole.rows.find((row) => row.canId === '6A0')!; assert.equal(request.periodMs, undefined, 'sent on events'); assert.equal(request.gapCount, 0); assert.equal(request.times!.length, 15);
    const zoomed = doc.frameTiming({ start: 10, end: 11 }, 100, 150).rows.find((row) => row.canId === '123')!;
    assert.equal(zoomed.count, zoomed.times!.length); assert.ok(zoomed.times!.length >= 20 && zoomed.times!.every((time) => time >= 10 && time <= 11));
  } finally { doc.dispose(); }
});

test('a report embeds every receive time while the budget lasts, and the packing gives them back exactly', async () => {
  const path = await import('path'); const vscode = await import('vscode');
  const { RawLogDocument } = await import('../src/extension/editors/rawLogDocument');
  const { PluginRegistry } = await import('../src/core/plugin/pluginHost');
  const { emptyProject } = await import('../src/core/project/schema');
  const { packReportData, unpackReportData } = await import('../src/extension/report/reportPacking');
  const file = path.resolve('sample/basic/sigmixa-basic.asc');
  (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file(path.dirname(file)) }];
  (vscode.workspace as any).getWorkspaceFolder = () => vscode.workspace.workspaceFolders![0];
  const doc = new RawLogDocument(vscode.Uri.file(file), file, emptyProject(), 1, new PluginRegistry());
  try {
    await doc.whenReady(); const range = doc.timelineRange!;
    const rows = doc.reportFrameTiming(range);
    assert.ok(rows.every((row) => row.times && row.times.length === row.total && !row.bins), 'a small log is embedded whole');
    const tight = doc.reportFrameTiming(range, 1000, 50);
    const fast = tight.find((row) => row.canId === '123')!; assert.equal(fast.times, undefined); assert.equal(fast.bins!.length, 50); assert.equal(fast.bins!.reduce((sum, value) => sum + value, 0), 1201);
    assert.ok(tight.find((row) => row.canId === '6A0')!.times, 'the CAN IDs with the fewest frames keep their times');
    const clipped = doc.reportFrameTiming({ start: 10, end: 20 }); assert.ok(clipped.every((row) => row.times!.every((time) => time >= 10 && time <= 20)));
    const data = { series: [], analysis: { frames: rows, intervals: [], states: [], distributions: [] } } as never;
    assert.deepEqual(unpackReportData(JSON.parse(JSON.stringify(packReportData(data)))).analysis!.frames, JSON.parse(JSON.stringify(rows)));
  } finally { doc.dispose(); }
});

test('receive intervals: each one while they are few, the range per slice when they are many, and statistics of the span', () => {
  const times = list([0, 0.1, 0.2, 0.35, 0.45, 1.45]);
  const few = intervalSeries(times, { start: 0, end: 2 }, 10, 100);
  assert.deepEqual(few.times, [0.1, 0.2, 0.35, 0.45, 1.45]); assert.deepEqual(few.intervals!.map((value) => Math.round(value)), [100, 100, 150, 100, 1000]);
  assert.equal(few.stats!.count, 5); assert.ok(Math.abs(few.stats!.meanMs - 290) < 1e-6); assert.ok(Math.abs(few.stats!.minMs - 100) < 1e-6); assert.ok(Math.abs(few.stats!.maxMs - 1000) < 1e-6);
  assert.deepEqual(intervalSeries(times, { start: 0.3, end: 0.5 }, 10, 100).times, [0.35, 0.45], 'only the frames received in the span');
  assert.deepEqual(intervalSeries(times, { start: 0, end: 2 }, 10, 100, 0.2).times, [0.35, 0.45, 1.45], 'the first frame of a Clip has no interval');
  assert.deepEqual(intervalSeries(times, { start: 5, end: 6 }, 10, 100), {});
  const dense = intervalSeries(list(every(0.01, 1001)), { start: 0, end: 10 }, 10, 100);
  assert.equal(dense.times, undefined); assert.equal(dense.stats!.count, 1000); assert.equal(dense.buckets!.meanMs.length, 10);
  assert.ok(dense.buckets!.meanMs.every((value) => value !== null && Math.abs(value - 10) < 1e-6)); assert.ok(dense.stats!.sdMs < 1e-6);
  const sparse = intervalSeries(list([0, 1, 2, 3, 9, 9.5]), { start: 0, end: 10 }, 5, 2);
  assert.deepEqual(sparse.buckets!.meanMs.map((value) => value === null ? null : Math.round(value)), [1000, 1000, null, null, 3250], 'a slice without a frame is empty');
  assert.deepEqual([sparse.buckets!.minMs[4], sparse.buckets!.maxMs[4]].map((value) => Math.round(value!)), [500, 6000]);
});

test('the sample log answers receive intervals: a new view shows the CAN ID with a gap, and any CAN ID can be asked for', async () => {
  const path = await import('path'); const vscode = await import('vscode');
  const { RawLogDocument } = await import('../src/extension/editors/rawLogDocument');
  const { PluginRegistry } = await import('../src/core/plugin/pluginHost');
  const { emptyProject } = await import('../src/core/project/schema');
  const file = path.resolve('sample/basic/sigmixa-basic.asc');
  (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file(path.dirname(file)) }];
  (vscode.workspace as any).getWorkspaceFolder = () => vscode.workspace.workspaceFolders![0];
  const doc = new RawLogDocument(vscode.Uri.file(file), file, emptyProject(), 1, new PluginRegistry());
  try {
    await doc.whenReady();
    const first = doc.frameIntervals(undefined, undefined, 300, 2000);
    assert.deepEqual(first.range, doc.timelineRange); assert.equal(first.data.ids.length, 13); assert.equal(first.data.canId, '3C0', 'the heartbeat with the dropout');
    assert.equal(first.data.intervals!.length, 509); assert.ok(first.data.stats!.maxMs > 9000 && first.data.stats!.maxMs < 9200); assert.ok(first.data.periodMs! > 90 && first.data.periodMs! < 110);
    const fast = doc.frameIntervals('s:291', undefined, 300, 500);
    assert.equal(fast.data.canId, '123'); assert.equal(fast.data.times, undefined); assert.equal(fast.data.buckets!.meanMs.length, 300); assert.equal(fast.data.stats!.count, 1200); assert.ok(Math.abs(fast.data.stats!.meanMs - 50) < 1e-6);
    const zoomed = doc.frameIntervals('s:291', { start: 10, end: 12 }, 300, 500); assert.ok(zoomed.data.times!.length >= 39 && zoomed.data.times!.every((time) => time >= 10 && time <= 12));
    assert.equal(doc.frameIntervals('s:9999', undefined, 300, 500).data.canId, '3C0', 'an unknown CAN ID falls back');
  } finally { doc.dispose(); }
});

test('a report embeds the receive times of an interval view\'s CAN ID, or the range per slice when over budget', async () => {
  const path = await import('path'); const vscode = await import('vscode'); const { readFileSync } = await import('fs');
  const { RawLogDocument } = await import('../src/extension/editors/rawLogDocument');
  const { PluginRegistry } = await import('../src/core/plugin/pluginHost');
  const { parseProjectJson } = await import('../src/core/project/schema');
  const { packReportData, unpackReportData } = await import('../src/extension/report/reportPacking');
  const { intervalSeries } = await import('../src/core/frame/frameTiming');
  const file = path.resolve('sample/basic/sigmixa-basic.asc');
  (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file(path.dirname(file)) }];
  (vscode.workspace as any).getWorkspaceFolder = () => vscode.workspace.workspaceFolders![0];
  const doc = new RawLogDocument(vscode.Uri.file(file), file, parseProjectJson(readFileSync('sample/.sigmixa/project.json', 'utf8')), 1, new PluginRegistry());
  try {
    await doc.whenReady(); const range = doc.timelineRange!;
    const whole = doc.reportFrameIntervals('s:291', range)!; const shown = doc.frameIntervals('s:291', undefined, 300, 1_000_000).data;
    assert.equal(whole.canId, shown.canId); assert.equal(whole.periodMs, shown.periodMs);
    // What the report works out from the embedded times is what Visualize is told by the host.
    const times = whole.times!; const series = intervalSeries({ length: times.length, at: (index) => times[index] }, range, 300, 1_000_000);
    assert.deepEqual(series.times, shown.times); assert.deepEqual(series.intervals, shown.intervals); assert.deepEqual(series.stats, shown.stats);
    assert.equal(doc.reportFrameIntervals(undefined, range)!.key, doc.frameIntervals(undefined, undefined, 300, 2000).data.key, 'a view without a CAN ID shows the same one as in Visualize');
    const coarse = doc.reportFrameIntervals('s:291', range, 10, 40)!; assert.equal(coarse.times, undefined); assert.equal(coarse.buckets!.meanMs.length, 40); assert.deepEqual(coarse.stats, shown.stats);
    const data = { series: [], analysis: { frames: [], intervals: [coarse], states: [], distributions: [] } };
    assert.deepEqual(unpackReportData(JSON.parse(JSON.stringify(packReportData(data as never)))).analysis, JSON.parse(JSON.stringify(data.analysis)));
  } finally { doc.dispose(); }
});

test('a CAN ID whose frames came out of time order gives its receive times sorted, so no interval is negative', () => {
  const store = new ChunkedFrameStore();
  store.append([0, 2, 1, 3].map((timestamp, index): CanFrame => ({ id: `f:${index}`, sourceId: 'f', timestamp, canId: 0x123, extended: false, direction: 'Rx', channel: 1, dlcCode: 0, dataLength: 0, data: new Uint8Array() } as CanFrame)));
  const times = store.canRefTimes(0x123, false)!;
  assert.deepEqual(Array.from({ length: times.length }, (_, index) => times.at(index)), [0, 1, 2, 3]);
  assert.equal(timingSlice(times, { start: 0.5, end: 2.5 }, 10, 100).count, 2);
  store.append([{ id: 'f:4', sourceId: 'f', timestamp: 4, canId: 0x123, extended: false, direction: 'Rx', channel: 1, dlcCode: 0, dataLength: 0, data: new Uint8Array() } as CanFrame]);
  assert.equal(store.canRefTimes(0x123, false)!.at(4), 4, 'frames added later are included');
});

test('a receive interval view with every CAN ID deselected is exported with none, as Visualize shows it', async () => {
  const { reportAnalysis } = await import('../src/extension/report/reportAnalysis');
  const asked: (string | undefined)[] = [];
  const document = {
    reportFrameTiming: () => [], reportStateTimeline: () => [], reportDistribution: () => [], newViewSignals: () => [],
    reportFrameIntervals: (key: string | undefined) => { asked.push(key); return { key: key ?? 's:1', canId: '001', name: '', times: [0, 1] }; },
  };
  const range = { start: 0, end: 1 };
  const none = reportAnalysis(document as never, { visualizeViews: [{ id: 'v', kind: 'frameInterval', name: 'Intervals', settings: { frameIntervalKeys: [] } }] } as never, range, [], []);
  assert.deepEqual(none.views.map((view) => [view.kind, view.canKeys]), [['frameInterval', []]]); assert.deepEqual(asked, []);
  const unset = reportAnalysis(document as never, { visualizeViews: [{ id: 'v', kind: 'frameInterval', name: 'Intervals', settings: {} }] } as never, range, [], []);
  assert.deepEqual(unset.views.map((view) => view.canKeys), [['s:1']], 'a view never set up shows the default CAN ID');
});

test('a send mode set on the Frame is used as it is: on events, no gaps; periodic + events, its event frames are found', async () => {
  const { eventFlags, flaggedTimes } = await import('../src/core/frame/frameTiming');
  const times = [...every(0.1, 100), ...every(0.1, 100, 19)];
  const event = summarizeTiming(list(times), 100, undefined, 'event');
  assert.equal(event.mode, 'event'); assert.equal(event.modeEstimated, false); assert.equal(event.periodMs, undefined); assert.equal(event.gapCount, 0);
  const estimated = summarizeTiming(list(times)); assert.equal(estimated.mode, 'periodic'); assert.equal(estimated.modeEstimated, true);
  const mixed = [...every(0.1, 100), 2.53, 5.07].sort((a, b) => a - b);
  const summary = summarizeTiming(list(mixed), 100, undefined, 'mixed'); assert.equal(summary.gapCount, 0);
  assert.deepEqual(flaggedTimes(list(mixed), eventFlags(list(mixed), 100), { start: 0, end: 10 }), [2.53, 5.07]);
});

test('selecting a gap moves the view only when the gap is not in it, keeping its zoom', async () => {
  const { viewShowing } = await import('../src/webview/timing/frameTimingPaint');
  const full = { start: 0, end: 100 };
  assert.equal(viewShowing({ start: 10, end: 20 }, full, { start: 12, end: 15 }), undefined, 'already shown');
  assert.deepEqual(viewShowing({ start: 10, end: 20 }, full, { start: 50, end: 52 }), { start: 46, end: 56 }, 'moved, same span');
  assert.deepEqual(viewShowing({ start: 10, end: 20 }, full, { start: 95, end: 99 }), { start: 90, end: 100 }, 'kept inside the log');
  assert.deepEqual(viewShowing({ start: 10, end: 20 }, full, { start: 40, end: 60 }), { start: 38, end: 62 }, 'a longer gap: zoomed out just enough');
});

test('a defined expected period keeps a Frame periodic; event frames are classed the same in any span; the hover always names the send mode', async () => {
  const { eventFlags, flaggedTimes } = await import('../src/core/frame/frameTiming');
  const { timingTipLines } = await import('../src/webview/timing/frameTimingPaint');
  const irregular = [0, 0.4, 0.41, 3, 3.2, 9, 9.05, 20];
  const defined = summarizeTiming(list(irregular), 100); assert.equal(defined.mode, 'periodic'); assert.equal(defined.periodMs, 100); assert.ok(defined.gapCount > 0);
  const times = [...every(0.1, 400), ...every(0.1, 400).map((time) => time + 0.03)].sort((a, b) => a - b);
  const flags = eventFlags(list(times), 100); const whole = flaggedTimes(list(times), flags, { start: 0, end: 40 });
  assert.deepEqual(flaggedTimes(list(times), flags, { start: 20.02, end: 20.44 }), whole.filter((time) => time >= 20.02 && time <= 20.44));
  const row = { key: 's:1', canId: '001', name: '', total: 3, count: 3, periodMs: 100, estimated: true, mode: 'mixed' as const, modeEstimated: true, gaps: [{ start: 1, end: 2 }], gapCount: 1, times: [0, 0.1, 0.2] };
  for (const time of [0.1, 1.5]) assert.ok(timingTipLines(row, time, 0.001, String).some((line) => line.includes('Send mode') || line.includes('送信モード')), `at ${time}`);
});
