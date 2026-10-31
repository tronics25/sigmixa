import type { SignalSample } from '../../core/signal/signal';
import { crossesSeriesGap } from './chartSeries';
import { paintValueBoxes, type HoverLabelRect } from './chartHoverLabels';
import { t } from './i18n';

/**
 * Lanes under a time-series graph: one per Signal, on the graph's time axis. A lane shows only the shape. Each is scaled to
 * its own minimum and maximum in the shown span and filled from that minimum, so a bulge stands out even in a short lane;
 * the value is read on the graph above. Visualize, the comparison and its report, and their saved images all draw lanes here.
 */
export const LANE_HEIGHT = 46;
/** Space between the graph and the first lane. */
export const LANE_TOP_GAP = 8;
const LANE_BOTTOM_GAP = 8;

export interface LanePoint { readonly time: number; readonly value: number }
/** One line in a lane: runs of drawable points (a gap or an invalid sample ends a run, as on the graph). */
export interface LaneLine { readonly runs: readonly (readonly LanePoint[])[]; readonly dash?: readonly number[] }
/** A Signal's measured value at a marker: drawn in its lane as on the graph, a box beside the marker line pointing at the sample. */
export interface LaneMarkerValue { readonly time: number; readonly sampleTime: number; readonly value: number; readonly text: string; readonly dash?: readonly number[] }
export interface ChartLane { readonly name: string; readonly color: string; readonly lines: readonly LaneLine[]; readonly value?: string; readonly emphasized?: boolean; readonly markers?: readonly LaneMarkerValue[] }
export interface LaneOverlays {
  readonly cursor?: number;
  readonly markers?: readonly number[];
  readonly trace?: { readonly time: number; readonly color: string };
  readonly selection?: { readonly start: number; readonly end: number };
}

/** The button that opens and closes the lanes: a plain button, like every other, with the disclosure chevron. */
export const CHART_LANES_STYLES = `
button.chart-lanes-toggle{position:absolute;z-index:3;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:var(--sm-control-height);height:var(--sm-control-height);min-width:0;min-height:0;margin:0;padding:0;border-radius:50%}
button.chart-lanes-toggle[hidden]{display:none}
button.chart-lanes-toggle .codicon{font-size:var(--sm-font-heading);line-height:16px;width:16px;height:16px}
`;

export function createLaneToggle(onToggle: () => void): HTMLButtonElement {
  const button = document.createElement('button'); button.type = 'button'; button.className = 'chart-lanes-toggle'; button.hidden = true;
  const glyph = document.createElement('span'); glyph.setAttribute('aria-hidden', 'true'); button.appendChild(glyph);
  button.title = t('Lanes', 'レーン'); button.setAttribute('aria-label', t('Lanes', 'レーン'));
  button.addEventListener('click', (event) => { event.stopPropagation(); onToggle(); });
  return button;
}

/**
 * Shows the button for `count` lanes at the graph's lower left, where the graph draws nothing: as far from the card's left
 * edge as from the graph's bottom (the card's bottom while the lanes are closed). `graphBottom` is in the button's parent.
 */
export function placeLaneToggle(button: HTMLButtonElement, count: number, open: boolean, graphBottom: number): void {
  button.hidden = !count; if (!count) return;
  button.setAttribute('aria-expanded', String(open)); button.firstElementChild!.className = `codicon codicon-chevron-${open ? 'down' : 'right'}`;
  const parent = button.offsetParent as HTMLElement | null; const card = button.closest<HTMLElement>('.visualize-card'); if (!parent) return;
  const margin = parseFloat(getComputedStyle(button).getPropertyValue('--sm-space-lg')) || 12;
  const cardLeft = card ? card.getBoundingClientRect().left + card.clientLeft : parent.getBoundingClientRect().left;
  button.style.left = `${cardLeft + margin - parent.getBoundingClientRect().left - parent.clientLeft}px`; button.style.top = `${graphBottom - margin - button.offsetHeight}px`;
}

/** The height the lanes add under the graph; none while there are none. */
export function lanesHeight(count: number): number { return count > 0 ? LANE_TOP_GAP + count * LANE_HEIGHT + LANE_BOTTOM_GAP : 0; }

/** Index of the lane at `offset` pixels below the lanes' top, if any. */
export function laneIndexAt(offset: number, count: number): number | undefined {
  const index = Math.floor((offset - LANE_TOP_GAP) / LANE_HEIGHT);
  return offset >= LANE_TOP_GAP && index < count ? index : undefined;
}

/** A Signal's samples as lane runs. `toValue` gives the value as drawn; `offset` moves sample times onto the axis. */
export function laneRuns(series: { readonly samples: readonly SignalSample[]; readonly gaps: Parameters<typeof crossesSeriesGap>[0] }, toValue: (value: number) => number, connectGaps: boolean, offset = 0): LanePoint[][] {
  const runs: LanePoint[][] = []; let run: LanePoint[] = []; let previous: number | undefined;
  for (const sample of series.samples) {
    const value = toValue(sample.value); const usable = Number.isFinite(value) && (sample.quality === undefined || sample.quality === 'valid');
    if (!usable) { if (!connectGaps && run.length) { runs.push(run); run = []; } continue; }
    if (!connectGaps && previous !== undefined && crossesSeriesGap(series.gaps, previous, sample.timestamp) && run.length) { runs.push(run); run = []; }
    run.push({ time: sample.timestamp - offset, value }); previous = sample.timestamp;
  }
  if (run.length) runs.push(run);
  return runs;
}

/** The drawn value at `time`, interpolated along the run that spans it. */
function valueAt(runs: readonly (readonly LanePoint[])[], time: number): number | undefined {
  for (const run of runs) {
    if (!run.length || time < run[0].time || time > run[run.length - 1].time) continue;
    let low = 0; let high = run.length - 1;
    while (high - low > 1) { const middle = (low + high) >> 1; if (run[middle].time <= time) low = middle; else high = middle; }
    const a = run[low]; const b = run[high]; const span = b.time - a.time;
    return span > 0 ? a.value + (b.value - a.value) * (time - a.time) / span : a.value;
  }
  return undefined;
}

export function paintChartLanes(context: CanvasRenderingContext2D, lanes: readonly ChartLane[], area: { readonly left: number; readonly width: number; readonly top: number }, view: { readonly start: number; readonly end: number }, overlays: LaneOverlays = {}): void {
  if (!lanes.length) return;
  const { left, width: plotWidth, top } = area; const right = left + plotWidth; const span = view.end - view.start || 1; const x = (time: number) => left + (time - view.start) / span * plotWidth;
  const border = css('--vscode-panel-border', '#777');
  context.save(); context.strokeStyle = border; context.lineWidth = 1; context.setLineDash([]); context.beginPath(); context.moveTo(0, top + .5); context.lineTo(right, top + .5); context.stroke(); context.restore();
  const lanesTop = top + LANE_TOP_GAP; const lanesBottom = lanesTop + lanes.length * LANE_HEIGHT;
  const cursor = overlays.cursor !== undefined && overlays.cursor >= view.start && overlays.cursor <= view.end ? overlays.cursor : undefined;
  const vertical = (time: number, color: string, dash: number[] = []) => { if (time < view.start || time > view.end) return; const px = x(time); context.save(); context.strokeStyle = color; context.lineWidth = 1; context.setLineDash(dash); context.beginPath(); context.moveTo(px, lanesTop); context.lineTo(px, lanesBottom); context.stroke(); context.restore(); };
  if (overlays.selection) { const start = x(Math.max(view.start, overlays.selection.start)); const end = x(Math.min(view.end, overlays.selection.end)); if (end >= start) { context.save(); context.fillStyle = css('--vscode-focusBorder', '#007acc'); context.globalAlpha = .16; context.fillRect(start, lanesTop, end - start, lanesBottom - lanesTop); context.restore(); } }
  const dots: { x: number; y: number; color: string }[] = []; const scales: ((value: number) => number)[] = [];
  lanes.forEach((lane, index) => {
    const laneTop = lanesTop + index * LANE_HEIGHT; const bandTop = laneTop + 20; const bandBottom = laneTop + LANE_HEIGHT - 5;
    if (index) { context.save(); context.strokeStyle = border; context.globalAlpha = .35; context.beginPath(); context.moveTo(left, laneTop + .5); context.lineTo(right, laneTop + .5); context.stroke(); context.restore(); }
    // The scale is the shown span's extremes. The lines run on to the span's edges, so the values there count too:
    // zoomed in between two samples, a lane still shows the slope.
    let minimum = Infinity; let maximum = -Infinity; const include = (value: number | undefined) => { if (value !== undefined && Number.isFinite(value)) { minimum = Math.min(minimum, value); maximum = Math.max(maximum, value); } };
    for (const line of lane.lines) { for (const run of line.runs) for (const point of run) if (point.time >= view.start && point.time <= view.end) include(point.value); include(valueAt(line.runs, view.start)); include(valueAt(line.runs, view.end)); }
    // A Signal that does not change in the shown span is a flat line at the lane's bottom: no rounding noise is magnified.
    const range = maximum - minimum; const flat = !(range > Math.max(Math.abs(maximum), Math.abs(minimum)) * 1e-12);
    const y = (value: number) => flat ? bandBottom : bandBottom - (value - minimum) / range * (bandBottom - bandTop); scales.push(y);
    context.save(); context.beginPath(); context.rect(left, laneTop, plotWidth, LANE_HEIGHT); context.clip();
    const fill = context.createLinearGradient(0, bandTop, 0, bandBottom); fill.addColorStop(0, colorWithAlpha(lane.color, .55)); fill.addColorStop(1, colorWithAlpha(lane.color, 0));
    for (const line of lane.lines) {
      context.fillStyle = fill; context.setLineDash([]);
      for (const points of line.runs) { if (points.length < 2) continue; context.beginPath(); context.moveTo(x(points[0].time), bandBottom); for (const point of points) context.lineTo(x(point.time), y(point.value)); context.lineTo(x(points[points.length - 1].time), bandBottom); context.closePath(); context.fill(); }
      context.strokeStyle = lane.color; context.lineWidth = lane.emphasized ? 3 : 1.5; context.setLineDash([...(line.dash ?? [])]);
      for (const points of line.runs) { context.beginPath(); points.forEach((point, pointIndex) => pointIndex ? context.lineTo(x(point.time), y(point.value)) : context.moveTo(x(point.time), y(point.value))); context.stroke(); }
      const value = cursor === undefined ? undefined : valueAt(line.runs, cursor);
      if (value !== undefined) dots.push({ x: x(cursor!), y: Math.max(bandTop, Math.min(bandBottom, y(value))), color: lane.color });
    }
    context.restore();
  });
  const focus = css('--vscode-focusBorder', '#007acc');
  for (const marker of overlays.markers ?? []) vertical(marker, focus);
  if (overlays.trace) vertical(overlays.trace.time, overlays.trace.color);
  if (cursor !== undefined) vertical(cursor, css('--vscode-editorCursor-foreground', '#fff'), [3, 3]);
  context.save(); for (const dot of dots) { context.fillStyle = dot.color; context.beginPath(); context.arc(dot.x, dot.y, 2.5, 0, Math.PI * 2); context.fill(); } context.restore();
  // Names and values first take their place, so the marker boxes keep clear of them; the names are drawn last, on top.
  const labels = lanes.map((lane, index) => {
    const baseline = lanesTop + index * LANE_HEIGHT + 15; context.save(); context.font = '600 12px sans-serif';
    const name = ellipsize(context, lane.name, Math.max(1, plotWidth - 24)); const nameWidth = context.measureText(name).width; const valueLeft = left + 12 + nameWidth + 10;
    context.font = '12px sans-serif'; const value = lane.value && valueLeft < right - 12 ? ellipsize(context, lane.value, right - 12 - valueLeft) : undefined;
    const end = value ? valueLeft + context.measureText(value).width : left + 12 + nameWidth; context.restore();
    return { baseline, name, value, valueLeft, rect: { x: left + 8, y: baseline - 13, width: end - left - 4, height: 17 } };
  });
  const fonts = { family: css('--vscode-editor-font-family', 'monospace'), background: css('--vscode-editorHoverWidget-background', '#252526') };
  lanes.forEach((lane, index) => {
    const laneTop = lanesTop + index * LANE_HEIGHT; const y = scales[index]; const occupied: HoverLabelRect[] = [labels[index].rect];
    for (const marker of lane.markers ?? []) {
      if (marker.time < view.start || marker.time > view.end) continue;
      paintValueBoxes(context, x(marker.time), [{ y: y(marker.value), sampleX: x(marker.sampleTime), sampleY: y(marker.value), text: marker.text, color: lane.color, lineDash: marker.dash ? [...marker.dash] : undefined, emphasized: lane.emphasized }], { left, right, top: laneTop + 2, bottom: laneTop + LANE_HEIGHT - 2 }, occupied, fonts);
    }
  });
  context.save(); context.textAlign = 'start'; context.textBaseline = 'alphabetic'; context.setLineDash([]);
  lanes.forEach((lane, index) => {
    const label = labels[index]; context.font = '600 12px sans-serif'; context.fillStyle = css('--vscode-editor-foreground', '#ddd'); context.fillText(label.name, left + 12, label.baseline);
    if (!label.value) return;
    context.font = '12px sans-serif'; context.fillStyle = lane.color; context.fillText(label.value, label.valueLeft, label.baseline);
  });
  context.restore();
}

/** `color` with its alpha set, for a gradient that fades it out. Any CSS color the canvas understands works. */
function colorWithAlpha(color: string, alpha: number): string {
  const context = colorProbe ??= document.createElement('canvas').getContext('2d')!; context.fillStyle = '#000'; context.fillStyle = color; const normalized = String(context.fillStyle);
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(normalized); if (hex) return `rgba(${parseInt(hex[1], 16)}, ${parseInt(hex[2], 16)}, ${parseInt(hex[3], 16)}, ${alpha})`;
  const rgb = /^rgba?\(([^,]+),([^,]+),([^,)]+)/.exec(normalized); return rgb ? `rgba(${rgb[1].trim()}, ${rgb[2].trim()}, ${rgb[3].trim()}, ${alpha})` : normalized;
}
let colorProbe: CanvasRenderingContext2D | undefined;
function ellipsize(context: CanvasRenderingContext2D, text: string, maxWidth: number): string { if (context.measureText(text).width <= maxWidth) return text; let low = 0; let high = text.length; while (low < high) { const middle = Math.ceil((low + high) / 2); if (context.measureText(`${text.slice(0, middle)}…`).width <= maxWidth) low = middle; else high = middle - 1; } return `${text.slice(0, low)}…`; }
function css(name: string, fallback: string): string { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback; }
