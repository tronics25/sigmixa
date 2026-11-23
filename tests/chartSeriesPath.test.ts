import test from 'node:test';
import assert from 'node:assert/strict';
import { SeriesPath } from '../src/webview/shared/chartSeries';

function fakeContext(): { context: CanvasRenderingContext2D; calls: string[] } {
  const calls: string[] = [];
  const context = { strokeStyle: '#f00', fillStyle: '', lineWidth: 1.5,
    beginPath: () => calls.push('begin'), moveTo: (x: number, y: number) => calls.push(`move ${x},${y}`), lineTo: (x: number, y: number) => calls.push(`line ${x},${y}`),
    arc: (x: number, y: number) => calls.push(`dot ${x},${y}`), stroke: () => calls.push('stroke'), fill: () => calls.push('fill'),
    save: () => undefined, restore: () => undefined, setLineDash: () => undefined } as unknown as CanvasRenderingContext2D;
  return { context, calls };
}

test('a lone sample between gaps is drawn as a dot; samples on a line are not', () => {
  const { context, calls } = fakeContext(); const path = new SeriesPath(context);
  path.point(0, 0); path.point(1, 1);
  path.point(5, 5, true);
  path.point(9, 9, true); path.point(10, 10);
  path.stroke();
  assert.deepEqual(calls.filter((call) => call.startsWith('dot')), ['dot 5,5']);
  assert.deepEqual(calls.filter((call) => call.startsWith('line')), ['line 1,1', 'line 10,10']);
});

test('a line with no lone samples draws no dots', () => {
  const { context, calls } = fakeContext(); const path = new SeriesPath(context);
  path.point(0, 0); path.point(1, 1); path.end(); path.point(3, 3); path.point(4, 4); path.stroke();
  assert.equal(calls.some((call) => call.startsWith('dot') || call === 'fill'), false);
});
