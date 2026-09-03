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

export function nearestSample(samples: readonly SignalSample[], timestamp: number): SignalSample | undefined {
  if (!samples.length || !Number.isFinite(timestamp)) return undefined;
  let low = 0; let high = samples.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (samples[middle].timestamp < timestamp) low = middle + 1;
    else high = middle;
  }
  if (low === 0) return samples[0];
  const before = samples[low - 1]; const after = samples[low];
  return Math.abs(before.timestamp - timestamp) <= Math.abs(after.timestamp - timestamp) ? before : after;
}

export function samplesInRange(samples: readonly SignalSample[], range?: TimeRange): readonly SignalSample[] {
  if (!range) return samples;
  const start = lowerBound(samples, Math.min(range.start, range.end));
  const end = upperBound(samples, Math.max(range.start, range.end));
  return samples.slice(start, end);
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
