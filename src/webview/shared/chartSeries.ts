import type { ChartAxisRangeSetting, SignalSeriesDto } from '../../extension/editors/rawLogProtocol';
import { convertDisplayUnit } from '../../core/units/displayUnit';
import type { SignalSample } from '../../core/signal/signal';

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
