import test from 'node:test';
import assert from 'node:assert/strict';

// Image export draws every view a second time into the SVG recorder. Any Canvas call the recorder lacks throws there,
// and the Export button then does nothing at all; these paint the views that export with that recorder.
import './support/canvasGlobals';
import { createSvgCanvas } from '../src/webview/shared/svgCanvas';
import { paintFrameTiming, roundRect } from '../src/webview/timing/frameTimingPaint';
import { paintStateTimeline } from '../src/webview/timing/stateTimelinePaint';
import type { FrameTimingRowDto, StateRowDto } from '../src/extension/editors/rawLogProtocol';

const ticks = (start: number, end: number) => [{ timestamp: start, label: String(start) }, { timestamp: end, label: String(end) }];

test('arcTo draws the rounded corner Canvas draws', () => {
  const vector = createSvgCanvas(100, 100); const context = vector.context;
  context.beginPath(); context.moveTo(0, 0); context.arcTo(10, 0, 10, 10, 4); context.stroke();
  assert.match(vector.toSvg(), /d="M0 0 L6 0 A4 4 0 0 1 10 4"/);
});

test('arcTo without a usable corner is a line to its first point', () => {
  const vector = createSvgCanvas(100, 100); const context = vector.context;
  context.beginPath(); context.moveTo(0, 0); context.arcTo(10, 0, 20, 0, 4); context.stroke();
  assert.match(vector.toSvg(), /d="M0 0 L10 0"/);
});

test('rounded boxes and outlined text are written to the SVG', () => {
  const vector = createSvgCanvas(100, 100); const context = vector.context;
  roundRect(context, 10, 10, 40, 20, 4); context.fill();
  context.lineJoin = 'round'; context.lineWidth = 3; context.strokeStyle = '#000'; context.strokeText('label', 5, 5);
  const svg = vector.toSvg();
  assert.equal((svg.match(/ A4 4 /g) ?? []).length, 4);
  assert.match(svg, /<text [^>]*fill="none" stroke="#000" stroke-width="3" stroke-linejoin="round"[^>]*>label<\/text>/);
});

test('frame timing (CAN ID chips, gaps, frames sent on events) exports as SVG', () => {
  const rows: FrameTimingRowDto[] = [
    { key: 's:123', canId: '123', name: 'Engine', total: 4, count: 4, periodMs: 100, estimated: true, mode: 'mixed', modeEstimated: true, times: [0, 0.1, 0.15, 0.6], eventTimes: [0.15], gaps: [{ start: 0.15, end: 0.6 }], gapCount: 1 },
    { key: 's:456', canId: '456', name: '', total: 900, count: 900, estimated: false, bins: [3, 0, 5, 1], gaps: [], gapCount: 0 },
  ];
  const vector = createSvgCanvas(800, 200);
  assert.doesNotThrow(() => paintFrameTiming(vector.context, 800, rows, { start: 0, end: 1 }, undefined, ticks));
  assert.match(vector.toSvg(), /^<\?xml[\s\S]*>123<\/text>[\s\S]*<\/svg>$/);
});

test('state timeline (runs and slices) exports as SVG', () => {
  const rows: StateRowDto[] = [
    { signalId: 'a', name: 'Gear', states: [{ value: 0, label: 'Park' }, { value: 1, label: 'Drive' }], tooMany: false, runs: [{ start: 0, end: 0.5, state: 0 }, { start: 0.5, end: 1, state: 1 }] },
    { signalId: 'b', name: 'Door', states: [{ value: 0 }, { value: 1 }], tooMany: false, bins: [{ state: 0, mixed: false }, null, { state: 1, mixed: true }] },
  ];
  const vector = createSvgCanvas(800, 200);
  assert.doesNotThrow(() => paintStateTimeline(vector.context, 800, rows, { start: 0, end: 1 }, undefined, ticks, 0.5));
  assert.match(vector.toSvg(), />Drive<\/text>/);
});
