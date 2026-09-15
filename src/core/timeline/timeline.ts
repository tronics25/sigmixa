import type { SignalSample } from '../signal/signal';

export interface TimeRange { readonly start: number; readonly end: number; }

export function downsampleEven<T>(items: readonly T[], limit: number): readonly T[] {
  const count = Math.max(0, Math.floor(limit));
  if (count === 0 || items.length === 0) return [];
  if (items.length <= count) return items;
  if (count === 1) return [items[0]];
  const result: T[] = [];
  let previous = -1;
  for (let index = 0; index < count; index++) {
    const sourceIndex = Math.round(index * (items.length - 1) / (count - 1));
    if (sourceIndex !== previous) result.push(items[sourceIndex]);
    previous = sourceIndex;
  }
  return result;
}

export function normalizeValue(value: number, minimum: number, maximum: number): number {
  if (![value, minimum, maximum].every(Number.isFinite)) return Number.NaN;
  if (maximum === minimum) return 50;
  return (value - minimum) / (maximum - minimum) * 100;
}

export function nearestSample(samples: readonly SignalSample[], timestamp: number, range?: TimeRange): SignalSample | undefined {
  if (!samples.length || !Number.isFinite(timestamp)) return undefined;
  let low = range ? lowerBound(samples, Math.min(range.start, range.end)) : 0;
  const end = range ? upperBound(samples, Math.max(range.start, range.end)) : samples.length;
  if (low >= end) return undefined;
  let high = end - 1; const first = low;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (samples[middle].timestamp < timestamp) low = middle + 1;
    else high = middle;
  }
  if (low === first) return samples[first];
  const before = samples[low - 1]; const after = samples[low];
  return Math.abs(before.timestamp - timestamp) <= Math.abs(after.timestamp - timestamp) ? before : after;
}

/** Original sample only: never interpolate, extrapolate or skip over an invalid sample. */
export function nearestMeasuredSample(samples: readonly SignalSample[], timestamp: number, range?: TimeRange): SignalSample | undefined {
  const first = range ? lowerBound(samples, Math.min(range.start, range.end)) : 0;
  const end = range ? upperBound(samples, Math.max(range.start, range.end)) : samples.length;
  if (first >= end || timestamp < samples[first].timestamp || timestamp > samples[end - 1].timestamp) return undefined;
  const sample = nearestSample(samples, timestamp, range);
  return sample && Number.isFinite(sample.value) && (sample.quality === undefined || sample.quality === 'valid') ? sample : undefined;
}

export function samplesInRange(samples: readonly SignalSample[], range?: TimeRange): readonly SignalSample[] {
  if (!range) return samples;
  const start = lowerBound(samples, Math.min(range.start, range.end));
  const end = upperBound(samples, Math.max(range.start, range.end));
  return samples.slice(start, end);
}

/** Includes one adjacent sample on each side so a continuous line reaches the viewport edge. */
export function samplesInRangeWithContext(samples: readonly SignalSample[], range?: TimeRange): readonly SignalSample[] {
  if (!range) return samples;
  const start = lowerBound(samples, Math.min(range.start, range.end));
  const end = upperBound(samples, Math.max(range.start, range.end));
  return samples.slice(Math.max(0, start - 1), Math.min(samples.length, end + 1));
}

function lowerBound(samples: readonly SignalSample[], timestamp: number): number {
  let low = 0; let high = samples.length;
  while (low < high) { const middle = Math.floor((low + high) / 2); if (samples[middle].timestamp < timestamp) low = middle + 1; else high = middle; }
  return low;
}

function upperBound(samples: readonly SignalSample[], timestamp: number): number {
  let low = 0; let high = samples.length;
  while (low < high) { const middle = Math.floor((low + high) / 2); if (samples[middle].timestamp <= timestamp) low = middle + 1; else high = middle; }
  return low;
}
