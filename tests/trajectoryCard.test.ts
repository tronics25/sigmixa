import test from 'node:test';
import assert from 'node:assert/strict';
import { TrajectoryCard } from '../src/webview/comparison/trajectoryCard';
import { TRAJECTORY_FIT_MARGIN, defaultTrajectoryView } from '../src/core/trajectory/trajectory';
import { placeTickLabel, separateTitles } from '../src/webview/shared/trajectoryLabels';
import { TrajectoryView } from '../src/webview/trajectory/trajectoryView';
import { commonDisplayUnit } from '../src/core/units/displayUnit';

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
      view: defaultTrajectoryView(), definitions, samples: new Map([['a', items]]),
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
    card.highlightedKey = 'a'; card.definitionValue.connectGaps = true;
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
      view: { ...defaultTrajectoryView(), yaw: -Math.PI / 2, pitch: Math.PI / 2 }, fitted: true, definitions, samples: new Map([['a', items]]),
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

test('several series share one plot: each has its colour, its own gaps and a common unit', () => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const previousStyle = Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: {} } });
  Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: () => ({ getPropertyValue: () => '' }) });
  try {
    const calls: { method: string; args: unknown[] }[] = [];
    const context = new Proxy({} as any, { get(target, key) { if (key in target) return target[key]; if (key === 'measureText') return () => ({ width: 10 }); return (...args: unknown[]) => calls.push({ method: String(key), args }); }, set(target, key, value) { target[key] = value; return true; } });
    const definitions = [['ax', 'm'], ['ay', 'm'], ['bx', 'km'], ['by', 'km']].map(([id, unit]) => ({ id, name: id, unit }));
    const series = (id: string, scale: number, gaps: object[] = []) => ({ signalId: id, series: { definition: definitions.find((item) => item.id === id), gaps, samples: Array.from({ length: 5 }, (_, timestamp) => ({ timestamp, value: timestamp * scale })) } });
    const card = Object.assign(Object.create(TrajectoryCard.prototype), {
      definitionValue: { id: 'path', name: 'Path', connectGaps: false, showGrid: false, trajectorySeries: [
        { id: 'a', name: 'A', color: '#111111', axes: { x: 'ax', y: 'ay' } }, { id: 'b', name: 'B', color: '#222222', axes: { x: 'bx', y: 'by' } }, { id: 'unfinished', name: 'C', color: '#333333', axes: { x: 'ax' } },
      ] },
      view: defaultTrajectoryView(), fitted: true, definitions,
      samples: new Map([['log', [series('ax', 1, [{ startTimestamp: 1, endTimestamp: 2 }]), series('ay', 1), series('bx', .001), series('by', .001)]]]),
      host: { targets: () => [{ id: 'log', name: 'Log', status: 'ready' }], hidden: () => false, anchor: () => 0, targetIndex: () => 0 },
    });
    const tracks = card.tracks();
    assert.deepEqual(tracks.map((track: any) => [track.key, track.name, track.color]), [['a', 'A', '#111111'], ['b', 'B', '#222222']]);
    assert.deepEqual(tracks[1].points.map((point: any) => point.x), tracks[0].points.map((point: any) => point.x), 'km and m share one scale');
    const points = card.paint(context, 800, 350, 0, tracks, undefined);
    assert.equal(points.length, 10);
    assert.equal(calls.filter((call) => call.method === 'lineTo').length, 3 + 4, "a gap breaks only its own series' path");
    const common = commonDisplayUnit(['m', 'km'])!.unit;
    assert.ok(calls.some((call) => call.method === 'fillText' && call.args[0] === `X: ax (${common})`), 'the axis is named in the common unit');
    assert.equal(card.is3d, false);
    card.definitionValue = { ...card.definitionValue, trajectorySeries: [...card.definitionValue.trajectorySeries.slice(0, 2), { id: 'c', name: 'C', color: '#333333', axes: { x: 'ax', y: 'ay', z: 'ay' } }] };
    assert.equal(card.is3d, true, 'one series with Z makes the plot 3D');
    const changes: any[] = []; card.host.changed = () => changes.push(card.definitionValue);
    card.setAxis(1, 'z', 'ay');
    assert.deepEqual(changes[0].trajectorySeries[1].axes, { x: 'bx', y: 'by', z: 'ay' });
    assert.deepEqual(changes[0].signalIds, ['ax', 'ay', 'bx', 'by']);
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else Reflect.deleteProperty(globalThis, 'document');
    if (previousStyle) Object.defineProperty(globalThis, 'getComputedStyle', previousStyle); else Reflect.deleteProperty(globalThis, 'getComputedStyle');
  }
});

test('a tick value that would touch an axis title is left out', () => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const previousStyle = Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: {} } });
  Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: () => ({ getPropertyValue: () => '' }) });
  try {
    const context = { measureText: () => ({ width: 20 }) };
    const titles = [{ x: 100, y: 50, width: 80, height: 14 }];
    assert.equal(placeTickLabel(context, '10', 110, 60, [...titles]), false, 'on the title');
    assert.equal(placeTickLabel(context, '10', 85, 60, [...titles]), false, 'runs into its left edge');
    assert.equal(placeTickLabel(context, '10', 60, 60, [...titles]), true, 'beside it');
    assert.equal(placeTickLabel(context, '10', 110, 90, [...titles]), true, 'below it');
    const occupied = [...titles];
    assert.equal(placeTickLabel(context, '8', 300, 300, occupied), true); assert.equal(placeTickLabel(context, '6', 305, 302, occupied), false, 'ticks at one spot: the first stays');
    // Titles only move when they meet.
    const box = { x: 4, y: 4, width: 80, height: 14 }; const apart = { x: 200, y: 4, width: 80, height: 14 };
    assert.deepEqual(separateTitles([box, apart], 4, 400), [box, apart]);
    assert.deepEqual(separateTitles([box, box, box], 4, 400).map((title) => title.y), [4, 20, 36]);
    assert.deepEqual(separateTitles([{ ...box, y: 380 }, { ...box, y: 380 }], 4, 396).map((title) => title.y), [380, 364], 'upward at the end of the plot');
    const crowded = separateTitles([{ ...box, y: 382 }, { ...box, y: 356 }, { ...box, y: 381 }], 4, 396);
    assert.deepEqual(separateTitles([{ ...box, y: 20 }, { ...box, y: 46 }, { ...box, y: 33 }], 4, 64).map((title) => title.y), [20, 46, 4], 'a short plot: the only free place is used');
    assert.ok(crowded.every((title, index) => crowded.every((other, otherIndex) => index === otherIndex || Math.abs(title.y - other.y) >= title.height)), `titles crowded at the end of the plot stay apart: ${crowded.map((title) => title.y)}`);
    // The axis's last tick sits where the title of that axis starts, on the plot as drawn.
    const written: string[] = [];
    const paintContext = new Proxy({} as any, { get(target, key) { if (key in target) return target[key]; if (key === 'measureText') return () => ({ width: 10 }); if (key === 'fillText') return (text: string) => written.push(text); return () => undefined; }, set(target, key, value) { target[key] = value; return true; } });
    const card = Object.assign(Object.create(TrajectoryCard.prototype), { definitionValue: { id: 'path', name: 'Path', axes: { x: 'x', y: 'y', z: 'z' } } });
    const scale = { minimum: 0, maximum: 10, ticks: [0, 10] };
    card.paint3dAxes(paintContext, { x: scale, y: scale, z: scale }, (point: any) => ({ x: 100 + point.x * 20 + point.y * 20, y: 300 - point.z * 20 + point.y * 5 }), 'X', 'Y', 'Z', 800, 600, 0);
    assert.deepEqual(written.filter((text) => text === '10'), [], 'the last ticks give way to the titles');
    assert.ok(written.includes('X: X') && written.includes('Y: Y') && written.includes('Z: Z'));
    assert.equal(written.filter((text) => text === '0').length, 1, 'the three axes start at one spot: one value is written there');
    // An axis ending outside the plot keeps its title at the edge, inside the plot.
    const placed: [string, number, number][] = [];
    const edgeContext = new Proxy({} as any, { get(target, key) { if (key in target) return target[key]; if (key === 'measureText') return () => ({ width: 50 }); if (key === 'fillText') return (text: string, x: number, y: number) => placed.push([text, x, y]); return () => undefined; }, set(target, key, value) { target[key] = value; return true; } });
    card.paint3dAxes(edgeContext, { x: scale, y: scale, z: scale }, (point: any) => ({ x: point.x * 500 - point.y * 500, y: 300 - point.z * 500 }), 'X', 'Y', 'Z', 800, 600, 70);
    for (const name of ['X: X', 'Y: Y', 'Z: Z']) { const [, x, y] = placed.find(([text]) => text === name)!; assert.ok(x >= 4 && x + 50 <= 796 && y >= 74 && y <= 666, `${name} at ${x},${y}`); }
    // Visualize draws its own axes and keeps to the same rule. There an axis title sits below the end of the X and Z axes, on the next tick if the axis is short on screen.
    written.length = 0;
    const view = Object.assign(Object.create(TrajectoryView.prototype), { showGrid: true, invert: { x: false, y: false, z: false }, definitions: new Map(), xId: 'x', yId: 'y', zId: 'z' });
    const near = { minimum: 0, maximum: 10, ticks: [5, 10] };
    view.draw3dAxes(paintContext, { x: near, y: near, z: near }, (x: number, y: number, z: number) => ({ x: 300 + x * 20, y: 300 - y * 20 - z * 4, depth: 0, t: 0 }), 800, 600);
    assert.equal(written.filter((text) => text === '10').length, 2, "the X and Z axes' 10 stay; the Y axis's 10 sits under the Y title");
    assert.equal(written.filter((text) => text === '5').length, 2, "the Z axis's 5 sits under the Z title and is left out");
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else Reflect.deleteProperty(globalThis, 'document');
    if (previousStyle) Object.defineProperty(globalThis, 'getComputedStyle', previousStyle); else Reflect.deleteProperty(globalThis, 'getComputedStyle');
  }
});
