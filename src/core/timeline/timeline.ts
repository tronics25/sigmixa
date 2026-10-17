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

/**
 * Thins samples without losing their shape: they are cut into equal runs, and of each run the first, the last, the lowest
 * and the highest of every measure are kept, and every one `keep` asks for (the ends of a break in the line). Peaks, dips and
 * short events therefore survive, where even spacing (`downsampleEven`) can step over them. Kept items are the originals:
 * their time and value are never changed.
 */
export function downsampleExtremes<T>(items: readonly T[], limit: number, measures: (item: T) => readonly number[], keep: (item: T) => boolean = () => false): readonly T[] {
  const count = Math.max(0, Math.floor(limit));
  if (count === 0 || items.length === 0) return [];
  if (items.length <= count) return items;
  const perRun = 3 + 2 * measures(items[0]).length;
  if (count < perRun) return downsampleEven(items, count);
  // A run keeps at most `perRun` samples, mostly fewer (one sample is often both the first and the lowest): start with the
  // runs that surely fit, then use more runs while the result stays within the limit.
  let runs = Math.floor(count / perRun); let best = extremesOfRuns(items, runs, measures, keep);
  for (let attempt = 0; attempt < 3 && best.length < count * 0.9; attempt++) {
    const next = Math.min(items.length, Math.floor(runs * count / Math.max(1, best.length))); if (next <= runs) break;
    const tried = extremesOfRuns(items, next, measures, keep); if (tried.length > count) break;
    runs = next; best = tried;
  }
  return best;
}

function extremesOfRuns<T>(items: readonly T[], runs: number, measures: (item: T) => readonly number[], keep: (item: T) => boolean): T[] {
  const width = measures(items[0]).length; const result: T[] = [];
  for (let run = 0; run < runs; run++) {
    const start = Math.floor(run * items.length / runs); const end = Math.floor((run + 1) * items.length / runs); if (end <= start) continue;
    const low = new Array<number>(width).fill(-1); const high = new Array<number>(width).fill(-1); const lowValue: number[] = []; const highValue: number[] = []; const kept: number[] = [];
    for (let index = start; index < end; index++) {
      const item = items[index]; if (keep(item)) kept.push(index);
      measures(item).forEach((value, axis) => {
        if (!Number.isFinite(value)) return;
        if (low[axis] < 0 || value < lowValue[axis]) { low[axis] = index; lowValue[axis] = value; }
        if (high[axis] < 0 || value > highValue[axis]) { high[axis] = index; highValue[axis] = value; }
      });
    }
    for (const index of [...new Set([start, end - 1, ...kept, ...low, ...high])].filter((value) => value >= 0).sort((a, b) => a - b)) result.push(items[index]);
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
