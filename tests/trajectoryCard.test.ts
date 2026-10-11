import test from 'node:test';
import assert from 'node:assert/strict';
import { TrajectoryCard } from '../src/webview/comparison/trajectoryCard';
import { defaultTrajectoryView } from '../src/core/trajectory/trajectory';

/** Observe the renderer's drawing commands without a browser or pixel-dependent assertions. */
test('report trajectory rendering applies inversion, trail, gaps, grid and legend emphasis', () => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const previousStyle = Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: {} } });
  Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: () => ({ getPropertyValue: () => '' }) });
  try {
    const calls: { method: string; args: unknown[]; width: number }[] = [];
    const context = new Proxy({ lineWidth: 1 } as any, { get(target, key) {
      if (key in target) return target[key];
      if (key === 'measureText') return () => ({ width: 10 });
      return (...args: unknown[]) => calls.push({ method: String(key), args, width: target.lineWidth });
    } });
    const definitions = ['x', 'y'].map(id => ({ id, name: id.toUpperCase(), unit: 'm' }));
    const items = definitions.map(definition => ({ signalId: definition.id, series: {
      definition, samples: Array.from({ length: 21 }, (_, timestamp) => ({ timestamp, value: timestamp })),
      gaps: [{ startTimestamp: 8, endTimestamp: 12 }],
    } }));
    const card = Object.assign(Object.create(TrajectoryCard.prototype), {
      definitionValue: { id: 'path', name: 'Path', axes: { x: 'x', y: 'y' }, invert: { x: true, y: false, z: false },
        trajectoryTrail: { type: 'last-seconds', seconds: 5 }, trajectoryCurrentTime: 13, connectGaps: false, showGrid: false },
      view: defaultTrajectoryView(), definitions, series: new Map([['a', items]]),
      host: { targets: () => [{ id: 'a', name: 'A', status: 'ready' }], hidden: () => false, anchor: () => 0, targetIndex: () => 0 },
    });
    const tracks = card.tracks();
    assert.equal(tracks[0].points[10].x, -10); assert.equal(tracks[0].points[10].y, 10);
    const points = card.paint(context, 800, 350, 0, tracks, undefined);
    assert.deepEqual(points.map((point: { time: number }) => point.time), [8, 9, 10, 11, 12, 13]);
    assert.equal(calls.filter(call => call.method === 'lineTo').length, 1, 'only the 12→13 segment is outside the gap');
    assert.deepEqual(calls.filter(call => call.method === 'fillText').map(call => call.args[0]), ['X: X (m)', 'Y: Y (m)'], 'grid hidden, axis labels retained');
    assert.ok(calls.some(call => call.method === 'stroke' && call.width === 1.8));
    calls.length = 0;
    card.highlightedTargetId = 'a'; card.definitionValue.connectGaps = true;
    card.paint(context, 800, 350, 0, tracks, undefined);
    assert.equal(calls.filter(call => call.method === 'lineTo').length, 5);
    assert.ok(calls.some(call => call.method === 'stroke' && call.width === 3.2));
    card.definitionValue.axes.z = 'y'; card.definitionValue.invert.z = true;
    const tracks3d = card.tracks(); assert.equal(tracks3d[0].points[10].z, -10);
    calls.length = 0;
    const normal = card.paint(context, 800, 350, 0, tracks3d, undefined);
    const withoutGrid = calls.filter(call => call.method === 'stroke').length;
    card.view = { ...card.view, mirrorHorizontal: true }; card.definitionValue.showGrid = true;
    calls.length = 0;
    const mirrored = card.paint(context, 800, 350, 0, tracks3d, undefined);
    assert.ok(Math.abs(normal[0].x + mirrored[0].x - 800) < 1e-6, 'saved camera mirroring is applied by the 3D renderer');
    assert.ok(calls.filter(call => call.method === 'stroke').length > withoutGrid, '3D numeric grid follows its visibility setting');
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else Reflect.deleteProperty(globalThis, 'document');
    if (previousStyle) Object.defineProperty(globalThis, 'getComputedStyle', previousStyle); else Reflect.deleteProperty(globalThis, 'getComputedStyle');
  }
});
