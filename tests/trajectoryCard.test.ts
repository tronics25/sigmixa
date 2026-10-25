import test from 'node:test';
import assert from 'node:assert/strict';
import { TrajectoryCard } from '../src/webview/comparison/trajectoryCard';
import { TRAJECTORY_FIT_MARGIN, defaultTrajectoryView } from '../src/core/trajectory/trajectory';

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
    card.definitionValue.coordinateSystem = 'left'; card.definitionValue.showGrid = true;
    calls.length = 0;
    const mirrored = card.paint(context, 800, 350, 0, tracks3d, undefined);
    assert.ok(Math.abs(normal[0].x + mirrored[0].x - 800) < 1e-6, 'a left-handed graph is drawn mirrored');
    assert.equal(mirrored[0].y, normal[0].y);
    assert.ok(calls.filter(call => call.method === 'stroke').length > withoutGrid, '3D numeric grid follows its visibility setting');
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else Reflect.deleteProperty(globalThis, 'document');
    if (previousStyle) Object.defineProperty(globalThis, 'getComputedStyle', previousStyle); else Reflect.deleteProperty(globalThis, 'getComputedStyle');
  }
});

test('a fitted 3D trajectory refits to every size until the user zooms or drags; a saved camera stays', () => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const previousStyle = Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: {} } });
  Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: () => ({ getPropertyValue: () => '' }) });
  try {
    const context = new Proxy({} as any, { get(target, key) { if (key in target) return target[key]; if (key === 'measureText') return () => ({ width: 10 }); return () => undefined; } });
    const definitions = ['x', 'y', 'z'].map(id => ({ id, name: id.toUpperCase(), unit: 'm' }));
    // Data far from the origin: x 1000..1010, y 0..4, z 50..51.
    const values: Record<string, (index: number) => number> = { x: (i) => 1000 + i / 2, y: (i) => 4 * Math.abs(Math.sin(i)), z: (i) => 50 + (i % 2) };
    const items = definitions.map(definition => ({ signalId: definition.id, series: { definition, gaps: [], samples: Array.from({ length: 21 }, (_, timestamp) => ({ timestamp, value: values[definition.id](timestamp) })) } }));
    const updates: any[] = [];
    const card = Object.assign(Object.create(TrajectoryCard.prototype), {
      definitionValue: { id: 'path', name: 'Path', axes: { x: 'x', y: 'y', z: 'z' } },
      view: { ...defaultTrajectoryView(), yaw: -Math.PI / 2, pitch: Math.PI / 2 }, fitted: true, definitions, series: new Map([['a', items]]),
      host: { targets: () => [{ id: 'a', name: 'A', status: 'ready' }], hidden: () => false, anchor: () => 0, targetIndex: () => 0 },
      draw() { /* no canvas */ }, scheduleDraw() { /* no canvas */ }, update(partial: object) { updates.push(partial); this.definitionValue = { ...this.definitionValue, ...partial }; },
    });
    const tracks = card.tracks(); const m = TRAJECTORY_FIT_MARGIN;
    const fits = (points: { x: number; y: number }[], width: number, height: number) => {
      const xs = points.map(p => p.x); const ys = points.map(p => p.y); const l = Math.min(...xs), r = Math.max(...xs), t = Math.min(...ys), b = Math.max(...ys);
      const inside = l >= m - 1e-6 && r <= width - m + 1e-6 && t >= m - 1e-6 && b <= height - m + 1e-6;
      return inside && (Math.abs(r - l - (width - 2 * m)) < 1e-6 || Math.abs(b - t - (height - 2 * m)) < 1e-6);
    };
    assert.ok(fits(card.paint(context, 800, 350, 0, tracks, undefined), 800, 350), 'wide card');
    assert.ok(fits(card.paint(context, 360, 700, 0, tracks, undefined), 360, 700), 'tall card after a resize');
    assert.ok(fits(card.paint(context, 1600, 930, 70, tracks, undefined).map((p: any) => ({ x: p.x, y: p.y - 70 })), 1600, 930), 'export image is fitted to its own size');
    // Zooming leaves the fitted state: a later resize keeps the camera.
    card.zoom(1.5); assert.equal(card.fitted, false);
    const zoomed = { ...card.view };
    card.paint(context, 800, 350, 0, tracks, undefined); assert.deepEqual(card.view, zoomed);
    // Dragging leaves it too, and the saved definition says so.
    const handlers: Record<string, (event: any) => void> = {};
    card.canvas = { addEventListener: (type: string, fn: (event: any) => void) => { handlers[type] = fn; }, setPointerCapture() {}, hasPointerCapture: () => false, releasePointerCapture() {}, clientHeight: 350 };
    card.bindCanvas(); card.fitted = true;
    handlers.pointerdown({ button: 0, clientX: 0, clientY: 0, pointerId: 1, shiftKey: false }); handlers.pointermove({ clientX: 30, clientY: 0 }); handlers.pointerup({ pointerId: 1 });
    assert.equal(card.fitted, false); assert.equal(updates.at(-1).trajectoryViewFit, false);
    // A slow drag of one-pixel steps is saved too.
    card.fitted = true; updates.length = 0;
    handlers.pointerdown({ button: 0, clientX: 0, clientY: 0, pointerId: 1, shiftKey: false }); handlers.pointermove({ clientX: 1, clientY: 0 }); handlers.pointermove({ clientX: 2, clientY: 0 }); handlers.pointerup({ pointerId: 1 });
    assert.equal(card.fitted, false); assert.equal(updates.at(-1)?.trajectoryViewFit, false);
    clearTimeout(card.viewCommit);
    // A definition with a saved camera and no fit flag (older data) is drawn as saved.
    card.setDefinition.call(Object.assign(card, { title: {}, syncSettings() {}, request() {} }), { ...card.definitionValue, trajectoryView: { yaw: 1, pitch: .2, zoom: 3, panX: 1, panY: 2 }, trajectoryViewFit: undefined });
    assert.equal(card.fitted, false); assert.deepEqual(card.view, { yaw: 1, pitch: .2, zoom: 3, panX: 1, panY: 2 });
    card.setDefinition({ ...card.definitionValue, trajectoryViewFit: true }); assert.equal(card.fitted, true);
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else Reflect.deleteProperty(globalThis, 'document');
    if (previousStyle) Object.defineProperty(globalThis, 'getComputedStyle', previousStyle); else Reflect.deleteProperty(globalThis, 'getComputedStyle');
  }
});
