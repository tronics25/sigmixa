import { GAP_FACTOR } from '../../core/frame/frameTiming';
import type { FrameIntervalsDto } from '../../extension/editors/rawLogProtocol';
import { chartTicks } from '../shared/chartAxes';
import { t } from '../shared/i18n';
import { AXIS_HEIGHT, css, ellipsize, milliseconds, timingGeometry, type TimingGutters, type TimingSpan } from './frameTimingPaint';
import type { ChartContext } from '../shared/svgCanvas';

export const INTERVAL_PLOT_HEIGHT = 132;
export const INTERVAL_TOP = 16;
/** One slice of a dense span is this wide. */
export const INTERVAL_SLICE_WIDTH = 3;
export const INTERVAL_HEIGHT = INTERVAL_TOP + INTERVAL_PLOT_HEIGHT + AXIS_HEIGHT;
/** The expected period is drawn with a band of this share on each side. */
const BAND = 0.1;

/** What is drawn of one CAN ID's receive intervals. */
export type IntervalData = Pick<FrameIntervalsDto, 'canId' | 'name' | 'periodMs' | 'estimated' | 'stats' | 'times' | 'intervals' | 'buckets'>;

/**
 * Draws the receive intervals on the span `view`. `readFor` is the span the points or slices were read for: while the view
 * moves on before new ones arrive, they are drawn where that span now is. `lines` are marks across the plot.
 */
/** Where one CAN ID is drawn in a view that shows several, one below another: its plot, and what belongs to the lane. */
export interface IntervalLane { readonly top: number; readonly height: number; readonly index: number; readonly axis: boolean; readonly heading?: string }
const SINGLE_LANE: IntervalLane = { top: INTERVAL_TOP, height: INTERVAL_PLOT_HEIGHT, index: 0, axis: true };
const LANE_COLORS = [['--vscode-charts-blue', '#3794ff'], ['--vscode-charts-green', '#89d185'], ['--vscode-charts-orange', '#d18616'], ['--vscode-charts-purple', '#b180d7'], ['--vscode-charts-yellow', '#cca700']] as const;
/** A lane's line with the CAN ID's name and statistics, the room for marks above its plot, and its plot, in a view of several. */
const LANE_HEADING = 18;
const LANE_PLOT = 88;
const LANE_GAP = 6;

/**
 * The lanes of a view with `count` CAN IDs and its height. One CAN ID has the whole plot, and its summary is the view's
 * legend; several are drawn one below another, each with a line for its name and summary, and share the time axis below.
 */
export function intervalLanes(count: number, headings: readonly string[] = []): { lanes: IntervalLane[]; height: number } {
  if (count <= 1) return { lanes: [SINGLE_LANE], height: INTERVAL_HEIGHT };
  const block = LANE_HEADING + INTERVAL_TOP + LANE_PLOT + LANE_GAP;
  return { lanes: Array.from({ length: count }, (_, index) => ({ top: index * block + LANE_HEADING + INTERVAL_TOP, height: LANE_PLOT, index, axis: index === count - 1, heading: headings[index] ?? '' })), height: count * block - LANE_GAP + AXIS_HEIGHT };
}
/** The lane a height in the canvas is in. */
export function intervalLaneAt(lanes: readonly IntervalLane[], y: number): number { const at = lanes.findIndex((lane) => y <= lane.top + lane.height + LANE_GAP / 2); return at < 0 ? lanes.length - 1 : at; }
/** A lane's line: the CAN ID with its name, then the summary of what is shown. */
export function intervalHeading(data: IntervalData): string { return intervalLegendItems(data).map((item) => item.text).join('   '); }

export function paintFrameIntervals(context: ChartContext, width: number, data: IntervalData, view: TimingSpan, readFor: TimingSpan | undefined, ticks: (start: number, end: number, intervals: number) => readonly { readonly timestamp: number; readonly label: string }[], lines: readonly { readonly time: number | undefined; readonly color: string; readonly alpha: number }[] = [], gutters?: TimingGutters, lane: IntervalLane = SINGLE_LANE): void {
  const read = readFor ?? view; const { left, right, plotWidth } = timingGeometry(width, gutters); const bottom = lane.top + lane.height; const span = view.end - view.start || 1;
  const foreground = css('--vscode-foreground', '#ccc'); const muted = css('--vscode-descriptionForeground', '#999'); const grid = css('--vscode-panel-border', '#444'); const danger = css('--vscode-errorForeground', '#f14c4c'); const [colorName, colorFallback] = LANE_COLORS[lane.index % LANE_COLORS.length]; const color = css(colorName, colorFallback);
  const family = css('--vscode-font-family', 'sans-serif');
  // With a period the scale is fixed around it, so the same jitter looks the same wherever the view is; without one it fits the data.
  const period = data.periodMs; const scale = period !== undefined ? [0, period, period * 2] : chartTicks(0, Math.max(1e-6, data.stats?.maxMs ?? 1), 3);
  const top = period !== undefined ? period * 2.2 : Math.max(scale[scale.length - 1], data.stats?.maxMs ?? 1); const late = period !== undefined ? period * GAP_FACTOR : Infinity;
  const x = (time: number) => left + (time - view.start) / span * plotWidth; const y = (value: number) => bottom - Math.min(value, top) / top * lane.height;
  context.textBaseline = 'middle'; context.lineWidth = 1; context.font = `11px ${family}`;
  context.strokeStyle = grid; context.fillStyle = muted; context.textAlign = 'center';
  for (const tick of ticks(view.start, view.end, Math.max(1, Math.min(5, Math.floor(plotWidth / 100))))) {
    const px = Math.round(x(tick.timestamp)) + .5; if (px < left - 1 || px > left + plotWidth + 1) continue;
    context.globalAlpha = .48; context.beginPath(); context.moveTo(px, lane.top); context.lineTo(px, bottom); context.stroke(); context.globalAlpha = 1;
    if (!lane.axis) continue;
    const half = context.measureText(tick.label).width / 2; context.fillText(tick.label, Math.max(left + half, Math.min(px, width - right - half)), bottom + AXIS_HEIGHT / 2);
  }
  if (lane.heading) { context.textAlign = 'left'; context.font = `11px ${family}`; context.fillStyle = foreground; context.fillText(ellipsize(context, lane.heading, plotWidth), left, lane.top - INTERVAL_TOP - 9); context.fillStyle = muted; }
  context.textAlign = 'right';
  for (const value of scale) { if (value > top) continue; const py = Math.round(y(value)) + .5; context.fillStyle = muted; context.fillText(`${milliseconds(value)} ms`, left - 8, py); if (value === period) continue; context.globalAlpha = .48; context.beginPath(); context.moveTo(left, py); context.lineTo(width - right, py); context.stroke(); context.globalAlpha = 1; }
  if (period !== undefined) {
    context.fillStyle = color; context.globalAlpha = .1; context.fillRect(left, y(period * (1 + BAND)), plotWidth, y(period * (1 - BAND)) - y(period * (1 + BAND))); context.globalAlpha = 1;
    context.strokeStyle = muted; context.setLineDash([4, 4]); const py = Math.round(y(period)) + .5; context.beginPath(); context.moveTo(left, py); context.lineTo(width - right, py); context.stroke(); context.setLineDash([]);
  }
  context.save(); context.beginPath(); context.rect(left, 0, plotWidth, bottom); context.clip(); context.textAlign = 'left';
  let lastLabel = -Infinity;
  // An interval beyond the plot: a mark at the top with its value (not on top of the label before it).
  const beyond = (px: number, value: number) => { context.fillStyle = danger; context.beginPath(); context.moveTo(px, lane.top - 9); context.lineTo(px - 5, lane.top - 1); context.lineTo(px + 5, lane.top - 1); context.closePath(); context.fill(); const label = `${milliseconds(value)} ms`; if (px - lastLabel > context.measureText(label).width + 22) { context.fillText(label, px + 8, lane.top - 5); lastLabel = px; } };
  if (data.times && data.intervals) {
    const radius = data.times.length > 400 ? 1.5 : 2.5;
    for (let index = 0; index < data.times.length; index++) {
      const px = x(data.times[index]); const value = data.intervals[index];
      if (value > top) { beyond(px, value); continue; }
      context.fillStyle = value > late ? danger : color; context.globalAlpha = .85; context.beginPath(); context.arc(px, y(value), radius, 0, Math.PI * 2); context.fill(); context.globalAlpha = 1;
    }
  } else if (data.buckets) {
    // Too many to draw apart: each slice shows the range of its intervals as a bar, and their mean as a dot.
    const count = data.buckets.meanMs.length; const sliceSeconds = (read.end - read.start) / count;
    for (let slice = 0; slice < count; slice++) {
      const low = data.buckets.minMs[slice]; const high = data.buckets.maxMs[slice]; const mean = data.buckets.meanMs[slice]; if (low === null || high === null || mean === null) continue;
      const px = x(read.start + (slice + .5) * sliceSeconds);
      context.strokeStyle = high > late ? danger : color; context.globalAlpha = .45; context.lineWidth = 2; context.beginPath(); context.moveTo(px, y(low)); context.lineTo(px, Math.min(y(low) - 1, y(high))); context.stroke(); context.lineWidth = 1; context.globalAlpha = 1;
      if (high > top) beyond(px, high);
      context.fillStyle = color; context.beginPath(); context.arc(px, y(mean), 1.5, 0, Math.PI * 2); context.fill();
    }
  }
  context.restore();
  context.strokeStyle = grid; context.beginPath(); context.moveTo(left, bottom + .5); context.lineTo(width - right, bottom + .5); context.stroke();
  for (const mark of lines) { if (mark.time === undefined || mark.time < view.start || mark.time > view.end) continue; const px = Math.round(x(mark.time)) + .5; context.strokeStyle = mark.color; context.globalAlpha = mark.alpha; context.beginPath(); context.moveTo(px, lane.top); context.lineTo(px, bottom); context.stroke(); context.globalAlpha = 1; }
}

/** The summary of what is shown, as the texts of the view's legend; `muted` ones are set quieter. */
export function intervalLegendItems(data: IntervalData | undefined): { text: string; muted: boolean }[] {
  const items: { text: string; muted: boolean }[] = []; const add = (text: string, muted = true) => items.push({ text, muted });
  if (data?.canId) add(`${data.canId}${data.name ? `  ${data.name}` : ''}`, false);
  if (data?.periodMs !== undefined) add(`${t('Period', '周期')} ${data.estimated ? '≈ ' : ''}${milliseconds(data.periodMs)} ms`);
  if (data?.stats) { const stats = data.stats; add(`${t('Count', '件数')} ${stats.count.toLocaleString()}`); add(`${t('Mean', '平均')} ${milliseconds(stats.meanMs)}`); add(`${t('Min', '最小')} ${milliseconds(stats.minMs)}`); add(`${t('Max', '最大')} ${milliseconds(stats.maxMs)}`); add(`σ ${milliseconds(stats.sdMs)} ms`); }
  return items;
}

/** What the pointer is over, as the lines of a hover box; only the heading when there is nothing at `time`. `perPixel` is seconds per pixel. */
export function intervalTipLines(data: IntervalData, time: number, perPixel: number, readFor: TimingSpan | undefined, timeText: (time: number) => string): string[] {
  const lines: string[] = [`${data.canId ?? ''}${data.name ? `  ${data.name}` : ''}`];
  const delta = (value: number) => data.periodMs === undefined ? '' : `  (${value - data.periodMs >= 0 ? '+' : ''}${milliseconds(value - data.periodMs)} ms)`;
  if (data.times?.length && data.intervals) {
    let nearest = 0; for (let index = 1; index < data.times.length; index++) if (Math.abs(data.times[index] - time) < Math.abs(data.times[nearest] - time)) nearest = index;
    if (Math.abs(data.times[nearest] - time) <= perPixel * 8) lines.push(timeText(data.times[nearest]), `${t('Interval', '受信間隔')} ${milliseconds(data.intervals[nearest])} ms${delta(data.intervals[nearest])}`);
  } else if (data.buckets && readFor) {
    const slice = Math.floor((time - readFor.start) / ((readFor.end - readFor.start) / data.buckets.meanMs.length)); const low = data.buckets.minMs[slice]; const high = data.buckets.maxMs[slice]; const mean = data.buckets.meanMs[slice];
    if (low !== null && low !== undefined && high !== null && high !== undefined && mean !== null && mean !== undefined) lines.push(`${t('Interval', '受信間隔')} ${milliseconds(low)} – ${milliseconds(high)} ms`, `${t('Mean', '平均')} ${milliseconds(mean)} ms${delta(mean)}`);
  }
  return lines;
}
