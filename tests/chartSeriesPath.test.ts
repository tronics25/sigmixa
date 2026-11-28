import test from 'node:test';
import assert from 'node:assert/strict';
import { SeriesPath } from '../src/webview/shared/chartSeries';

function fakeContext(): { context: CanvasRenderingContext2D; calls: string[] } {
  const calls: string[] = [];
  const context = { strokeStyle: '#f00', fillStyle: '', lineWidth: 1.5,
    beginPath: () => calls.push('begin'), moveTo: (x: number, y: number) => calls.push(`move ${x},${y}`), lineTo: (x: number, y: number) => calls.push(`line ${x},${y}`),
    arc: (x: number, y: number, radius: number) => calls.push(`dot ${x},${y}`, `radius ${radius}`), stroke: () => calls.push('stroke'), fill: () => calls.push('fill'),
    save: () => undefined, restore: () => undefined, setLineDash: () => undefined } as unknown as CanvasRenderingContext2D;
  return { context, calls };
}

test('a lone sample between gaps is drawn as a dot; samples on a line are not', () => {
  const { context, calls } = fakeContext(); const path = new SeriesPath(context);
  path.point(0, 0); path.point(1, 1);
  path.point(5, 5, true);
  path.point(9, 9, true); path.point(10, 10);
  path.stroke();
  assert.deepEqual(calls.filter((call) => call.startsWith('dot')), ['dot 5,5']); assert.ok(calls.includes('radius 1.5'), 'zoomed out: a mark as wide as the line, like the line itself');
  assert.deepEqual(calls.filter((call) => call.startsWith('line')), ['line 1,1', 'line 10,10']);
});

test('a line with no lone samples draws no dots', () => {
  const { context, calls } = fakeContext(); const path = new SeriesPath(context);
  path.point(0, 0); path.point(1, 1); path.end(); path.point(3, 3); path.point(4, 4); path.stroke();
  assert.equal(calls.some((call) => call.startsWith('dot') || call === 'fill'), false);
});

test('a Signal received once, or once between its frame\'s dropouts, is drawn as a dot (also a multiplexed one)', async () => {
  const { InMemorySignalStore } = await import('../src/core/signal/signalStore');
  const { crossesSeriesGap } = await import('../src/webview/shared/chartSeries');
  const { dropouts } = await import('../src/core/timing/sendingPattern');
  const definition = { id: 'x', name: 'x', source: { type: 'manual-can', frameDefinitionId: 'f' } } as const;
  const frame = [0, 0.1, 0.2, 5, 9, 9.1];
  for (const [times, dots] of [[[5], 1], [frame, 1], [[0, 5, 9], 3]] as const) {
    const store = new InMemorySignalStore({ frameBreaks: () => ({ limit: Infinity, ...dropouts({ length: frame.length, at: (index) => frame[index] }, 0.16) }) }); store.registerDefinitions([definition]);
    store.appendSeries(definition, times.map((timestamp) => ({ timestamp, value: 1, quality: 'valid' as const })));
    const [series] = store.seriesSlice(['x'], undefined, 4000); const { context, calls } = fakeContext(); const path = new SeriesPath(context); let previous: number | undefined;
    for (const sample of series.samples) { path.point(sample.timestamp * 100, 1, previous !== undefined && crossesSeriesGap(series.gaps, previous, sample.timestamp)); previous = sample.timestamp; }
    path.stroke(); assert.equal(calls.filter((call) => call.startsWith('dot')).length, dots, times.join());
  }
});

test('receive points: a dot at every sample while they stand apart (10 px each), none when too dense or thinned', async () => {
  const { receivePointLimit, seriesReceivePointLimit } = await import('../src/webview/shared/chartSeries');
  const series = (count: number, total = count) => ({ samples: Array.from({ length: count }, (_, index) => ({ timestamp: index, value: 0 })), totalSamplesInRange: total });
  assert.equal(seriesReceivePointLimit(400, series(10), 0, 10), 40);
  assert.equal(seriesReceivePointLimit(400, series(41), 0, 41), 0, 'too many to tell apart');
  assert.equal(seriesReceivePointLimit(400, series(500), 100, 130), 40, 'zoomed in: only the samples in view count');
  assert.equal(seriesReceivePointLimit(400, series(50, 5000), 0, 10), 0, 'thinned for drawing: receive times not all known');
  assert.equal(receivePointLimit(400, false, [1, 2], 0, 10), 0);
});

test('receive points are bigger than the line; a lone sample takes the same dot while they are shown, and only then', () => {
  const shown = fakeContext(); const path = new SeriesPath(shown.context, 3); path.point(0, 0); path.point(1, 1); path.point(5, 5, true); path.stroke();
  assert.deepEqual(shown.calls.filter((call) => call.startsWith('dot')), ['dot 0,0', 'dot 1,1', 'dot 5,5']);
  assert.deepEqual([...new Set(shown.calls.filter((call) => call.startsWith('radius')))], ['radius 3']);
  const dense = fakeContext(); const crowded = new SeriesPath(dense.context, 2); crowded.point(0, 0); crowded.point(1, 1); crowded.point(5, 5, true); crowded.stroke();
  assert.deepEqual(dense.calls.filter((call) => call.startsWith('dot')), ['dot 5,5'], 'over the limit: only the lone sample, so its value stays visible');
  assert.deepEqual(dense.calls.filter((call) => call.startsWith('radius')), ['radius 1.5'], 'as wide as the line, not a receive point');
});

test('receive points count only what is drawn inside the plot, so a report zoomed into its full series still shows them', () => {
  const { context, calls } = fakeContext(); const path = new SeriesPath(context, 2, 10, 20);
  for (const x of [0, 5, 12, 15, 30, 40]) path.point(x, 0); path.stroke();
  assert.deepEqual(calls.filter((call) => call.startsWith('dot')), ['dot 12,0', 'dot 15,0']);
});

test('samples that fall on the same spot, or less than a pixel apart, are drawn as one dot; a visible stretch is not', () => {
  const { context, calls } = fakeContext(); const path = new SeriesPath(context);
  path.point(1, 2); path.point(1, 2);
  path.point(3, 4, true); path.point(3.4, 4.6);
  path.point(8, 8, true); path.point(8.5, 8); path.point(9, 8);
  path.stroke();
  assert.deepEqual(calls.filter((call) => call.startsWith('dot')), ['dot 1,2', 'dot 3,4']);
});

test('a single sample on its own is drawn as a dot', () => {
  const { context, calls } = fakeContext(); const path = new SeriesPath(context); path.point(4, 6); path.stroke();
  assert.deepEqual(calls.filter((call) => call.startsWith('dot')), ['dot 4,6']);
});
