import type { ChartAxisRangeSetting, SignalSeriesDto } from '../../extension/editors/rawLogProtocol';
import { convertDisplayUnit } from '../../core/units/displayUnit';
import type { SignalSample } from '../../core/signal/signal';
import type { ChartContext } from './svgCanvas';

/**
 * Draws a Signal's line on a canvas: `point` for each drawable sample, `end` where the line stops. A stretch of line too
 * short to see (a lone sample between gaps, or samples that fall on the same spot) becomes a dot, so its value stays
 * visible when gaps are not connected.
 * With `receivePoints` (the most dots that still stand apart), every sample drawn between `left` and `right` (the plot)
 * also gets a dot, while there are at most that many there.
 */
/** The radius of a lone sample's dot, in pixels. */
const LONE_DOT_RADIUS = 3;
/** A stretch of line spanning less than this many pixels both across and up is not visible as a line. */
const VISIBLE_LINE_SPAN = 1;

export class SeriesPath {
  private count = 0; private lastX = 0; private lastY = 0; private firstX = 0; private firstY = 0; private short = true; private readonly dots: [number, number][] = []; private readonly all: [number, number][] = [];
  constructor(private readonly context: ChartContext, private readonly receivePoints = 0, private readonly left = -Infinity, private readonly right = Infinity) { context.beginPath(); }
  point(x: number, y: number, separated = false): void {
    if (separated) this.end();
    if (this.count) this.context.lineTo(x, y); else { this.context.moveTo(x, y); this.firstX = x; this.firstY = y; this.short = true; }
    if (this.short && (Math.abs(x - this.firstX) >= VISIBLE_LINE_SPAN || Math.abs(y - this.firstY) >= VISIBLE_LINE_SPAN)) this.short = false;
    this.count++; this.lastX = x; this.lastY = y; if (this.receivePoints > 0 && x >= this.left && x <= this.right && this.all.length <= this.receivePoints) this.all.push([x, y]);
  }
  end(): void { if (this.count && this.short) this.dots.push([this.firstX, this.firstY]); this.count = 0; }
  stroke(): void {
    const context = this.context; this.end(); context.stroke();
    const dots = this.receivePoints > 0 && this.all.length <= this.receivePoints ? this.all : this.dots; if (!dots.length) return;
    // Big enough to see at a glance: a dot as wide as the line was easy to miss.
    const radius = Math.max(LONE_DOT_RADIUS, context.lineWidth + 1);
    context.save(); context.setLineDash([]); context.fillStyle = context.strokeStyle; context.beginPath();
    for (const [x, y] of dots) { context.moveTo(x + radius, y); context.arc(x, y, radius, 0, Math.PI * 2); }
    context.fill(); context.restore();
  }
}

/**
 * The most receive points a plot of this width shows (each needs room to stand apart), for a series drawn over the
 * sample times `start`…`end`; 0 when they are off, too dense there, or the series was thinned for drawing (not every
 * receive time is known then). A report holds every sample, so zooming into it brings its points out.
 */
export function receivePointLimit(enabled: boolean, plotWidth: number, series: { readonly samples: readonly SignalSample[]; readonly totalSamplesInRange: number }, start: number, end: number): number {
  if (!enabled || series.totalSamplesInRange > series.samples.length) return 0;
  const limit = Math.floor(plotWidth / RECEIVE_POINT_SPACING); let shown = 0;
  for (const sample of series.samples) if (sample.timestamp >= start && sample.timestamp <= end && ++shown > limit) return 0;
  return limit;
}
/** Pixels of plot width per receive point: denser than this, the points would run into a line, so they are left out until zoomed in. */
const RECEIVE_POINT_SPACING = 4;

export function displaySeriesRange(series: readonly SignalSeriesDto[], setting?: ChartAxisRangeSetting, visibleRange?: { readonly start: number; readonly end: number }, displayUnit?: string): { minimum: number; maximum: number } {
  let range = visibleDisplayRange(series, visibleRange, displayUnit);
  if (setting?.mode === 'global') range = globalDisplayRange(series, visibleRange, displayUnit);
  else if (setting?.mode === 'manual' && Number.isFinite(setting.minimum) && Number.isFinite(setting.maximum) && setting.maximum! > setting.minimum!) range = { minimum: setting.minimum!, maximum: setting.maximum! };
  if (setting?.includeZero) range = { minimum: Math.min(0, range.minimum), maximum: Math.max(0, range.maximum) };
  return range;
}

export function crossesSeriesGap(gaps: SignalSeriesDto['gaps'] | undefined, startTimestamp: number, endTimestamp: number): boolean {
  if (!gaps?.length || endTimestamp <= startTimestamp) return false;
  let low = 0; let high = gaps.length;
  while (low < high) { const middle = Math.floor((low + high) / 2); if (gaps[middle].endTimestamp <= startTimestamp) low = middle + 1; else high = middle; }
  const gap = gaps[low]; return Boolean(gap && gap.startTimestamp < endTimestamp && gap.endTimestamp > startTimestamp);
}

/**
 * Returns the value on the rendered polyline at the cursor Timestamp.
 * Fixed markers deliberately use the full-resolution measured lookup instead.
 */
export function interpolatedSeriesSample(series: SignalSeriesDto, timestamp: number, connectGaps: boolean): SignalSample | undefined {
  const samples = series.samples;
  if (!samples.length || !Number.isFinite(timestamp)) return undefined;
  let low = 0; let high = samples.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (samples[middle].timestamp < timestamp) low = middle + 1;
    else high = middle;
  }

  for (let index = low; index < samples.length && samples[index].timestamp === timestamp; index++) {
    if (usableSample(samples[index])) return samples[index];
  }

  let leftIndex = low - 1;
  let rightIndex = low;
  let skippedInvalid = false;
  while (leftIndex >= 0 && !usableSample(samples[leftIndex])) { skippedInvalid = true; leftIndex--; }
  while (rightIndex < samples.length && !usableSample(samples[rightIndex])) { skippedInvalid = true; rightIndex++; }
  const left = samples[leftIndex]; const right = samples[rightIndex];
  if (!left || !right || timestamp < left.timestamp || timestamp > right.timestamp) return undefined;
  if (!connectGaps && (skippedInvalid || crossesSeriesGap(series.gaps, left.timestamp, right.timestamp))) return undefined;
  const span = right.timestamp - left.timestamp;
  if (!(span > 0)) return left;
  return { timestamp, value: left.value + (right.value - left.value) * ((timestamp - left.timestamp) / span), quality: 'valid' };
}

function usableSample(sample: SignalSample): boolean {
  return Number.isFinite(sample.value) && (sample.quality === undefined || sample.quality === 'valid');
}

function visibleDisplayRange(series: readonly SignalSeriesDto[], visibleRange?: { readonly start: number; readonly end: number }, displayUnit?: string): { minimum: number; maximum: number } {
  let minimum = Infinity; let maximum = -Infinity;
  for (const item of series) for (const sample of item.samples) {
    if (visibleRange && (sample.timestamp < visibleRange.start || sample.timestamp > visibleRange.end)) continue;
    const value = convertDisplayUnit(sample.value, item.definition.unit, displayUnit);
    if (Number.isFinite(value) && (sample.quality === undefined || sample.quality === 'valid')) { minimum = Math.min(minimum, value); maximum = Math.max(maximum, value); }
  }
  if (Number.isFinite(minimum)) return { minimum, maximum };
  return visibleRange ? visibleDisplayRange(series, undefined, displayUnit) : { minimum: 0, maximum: 1 };
}

function globalDisplayRange(series: readonly SignalSeriesDto[], visibleRange?: { readonly start: number; readonly end: number }, displayUnit?: string): { minimum: number; maximum: number } {
  let minimum = Infinity; let maximum = -Infinity;
  for (const item of series) {
    if (!Number.isFinite(item.globalMinimum) || !Number.isFinite(item.globalMaximum)) continue;
    const first = convertDisplayUnit(item.globalMinimum!, item.definition.unit, displayUnit); const second = convertDisplayUnit(item.globalMaximum!, item.definition.unit, displayUnit);
    minimum = Math.min(minimum, first, second); maximum = Math.max(maximum, first, second);
  }
  return Number.isFinite(minimum) ? { minimum, maximum } : visibleDisplayRange(series, visibleRange, displayUnit);
}
