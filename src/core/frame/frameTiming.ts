import { GAP_FACTOR, dropoutLimit, estimateSendMode, walkCycle, type SendMode, type SendModeEstimate, type TimeList } from '../timing/sendingPattern';
export { GAP_FACTOR, type TimeList };
export interface TimingRange { readonly start: number; readonly end: number }
export interface TimingGap { readonly start: number; readonly end: number }

/** How one CAN ID is sent over the whole log (or Clip). */
export interface FrameTimingSummary {
  readonly count: number;
  /** The base cycle in milliseconds: the expected period when one is defined, else the one found in the log. Undefined for one sent on events. */
  readonly periodMs?: number;
  /** True when `periodMs` was read from the log, not defined. */
  readonly estimated: boolean;
  /** How it is sent: the Frame's send mode when one is defined, else estimated from the log (`modeEstimated`). Undefined with too few frames to tell. */
  readonly mode?: SendMode;
  readonly modeEstimated: boolean;
  /** Intervals much longer than the period: frames were probably lost. At most `GAP_LIMIT` are listed; `gapCount` counts them all. */
  readonly gaps: readonly TimingGap[];
  readonly gapCount: number;
}

/** What to draw of one CAN ID in a span: every receive time, or, when those are too many to tell apart, how many fell in each slice. */
export interface FrameTimingSlice { readonly count: number; readonly times?: readonly number[]; readonly bins?: readonly number[] }

export const GAP_LIMIT = 500;
const PERIOD_SAMPLES = 2000;
/** A CAN ID is periodic when this share of its intervals is within 30 % of the usual one. */
const PERIODIC_SHARE = 0.7;

/** First index whose time is not before `time`. */
export function lowerBound(times: TimeList, time: number, from = 0, to = times.length): number {
  let low = from; let high = to;
  while (low < high) { const middle = (low + high) >>> 1; if (times.at(middle) < time) low = middle + 1; else high = middle; }
  return low;
}

/** The usual interval (ms) of a periodic CAN ID, from up to 2000 intervals spread over its frames; undefined when it is sent on events. */
export function estimatePeriodMs(times: TimeList, from = 0, to = times.length): number | undefined {
  const intervals = to - from - 1; if (intervals < 3) return undefined;
  const taken = Math.min(intervals, PERIOD_SAMPLES); const sample = new Float64Array(taken);
  for (let index = 0; index < taken; index++) { const at = from + 1 + Math.floor(index * intervals / taken); sample[index] = (times.at(at) - times.at(at - 1)) * 1000; }
  const sorted = Float64Array.from(sample).sort(); const median = sorted[taken >> 1]; if (!(median > 0)) return undefined;
  let near = 0; for (const value of sample) if (Math.abs(value - median) <= median * 0.3) near++;
  return near / taken >= PERIODIC_SHARE ? median : undefined;
}

/**
 * How one CAN ID is sent over `range` (or the whole log), and where reception broke off: no frame for `GAP_FACTOR` base
 * cycles. The Frame's own send mode and expected period are used when defined; the rest is estimated from its frames in
 * the range (`estimate`, when already known for these frames). A CAN ID sent on events has no gaps.
 */
export function summarizeTiming(times: TimeList, expectedPeriodMs?: number, range?: TimingRange, sendMode?: SendMode, estimate?: SendModeEstimate): FrameTimingSummary {
  const from = range ? lowerBound(times, range.start) : 0; const to = range ? upperBound(times, range.end) : times.length; const count = Math.max(0, to - from);
  const defined = expectedPeriodMs !== undefined && expectedPeriodMs > 0 ? expectedPeriodMs : undefined;
  const estimated = sendMode && defined !== undefined ? undefined : estimate ?? estimateSendMode(sliceTimes(times, from, to));
  const mode = sendMode ?? estimatedMode(estimated, defined !== undefined);
  const periodMs = mode === 'event' ? undefined : defined ?? (estimated?.cycle !== undefined ? estimated.cycle * 1000 : undefined);
  const gaps: TimingGap[] = []; let gapCount = 0; const limit = dropoutLimit(mode, periodMs === undefined ? undefined : periodMs / 1000);
  if (Number.isFinite(limit)) {
    let previous = count ? times.at(from) : 0;
    for (let index = from + 1; index < to; index++) { const time = times.at(index); if (time - previous > limit) { gapCount++; if (gaps.length < GAP_LIMIT) gaps.push({ start: previous, end: time }); } previous = time; }
  }
  return { count, periodMs, estimated: defined === undefined && periodMs !== undefined, mode, modeEstimated: !sendMode && mode !== undefined, gaps, gapCount };
}

/** The estimated send mode; a Frame with a defined expected period is sent periodically even when no cycle was found in the log. */
export function estimatedMode(estimate: SendModeEstimate | undefined, periodDefined: boolean): SendMode | undefined {
  return periodDefined && (!estimate || estimate.mode === 'event') ? 'periodic' : estimate?.mode;
}

/** `times[from..to)` as a list of its own. */
export function sliceTimes(times: TimeList, from: number, to: number): TimeList { return from === 0 && to === times.length ? times : { length: Math.max(0, to - from), at: (index) => times.at(from + index) }; }

/**
 * Which frames a periodic + events CAN ID sent on events (between its cycle frames), as a flag per frame. Walked from the
 * first frame of the log, so a frame is classed the same whatever part of the log is shown.
 */
export function eventFlags(times: TimeList, cycleMs: number): Uint8Array {
  const flags = new Uint8Array(times.length); walkCycle(times, cycleMs / 1000, 0, times.length, (index) => { flags[index] = 1; }); return flags;
}
/** The receive times in `range` of the frames `flags` marks. */
export function flaggedTimes(times: TimeList, flags: Uint8Array, range: TimingRange): number[] {
  const result: number[] = []; for (let index = lowerBound(times, range.start), end = upperBound(times, range.end); index < end; index++) if (flags[index]) result.push(times.at(index));
  return result;
}

/**
 * The frames of one CAN ID in `range`: their times while there are at most `maxTimes`, else counts in `bins` equal slices
 * of the range. Counting looks each slice's edge up in the sorted times, so a span of millions of frames costs the same.
 */
export function timingSlice(times: TimeList, range: TimingRange, bins: number, maxTimes: number): FrameTimingSlice {
  const from = lowerBound(times, range.start); const to = upperBound(times, range.end); const count = Math.max(0, to - from);
  if (count <= maxTimes) { const result: number[] = []; for (let index = from; index < to; index++) result.push(times.at(index)); return { count, times: result }; }
  const slices = Math.max(1, Math.floor(bins)); const counts: number[] = []; const width = (range.end - range.start) / slices; let edge = from;
  for (let slice = 1; slice <= slices; slice++) { const next = slice === slices ? to : lowerBound(times, range.start + width * slice, edge, to); counts.push(next - edge); edge = next; }
  return { count, bins: counts };
}

function upperBound(times: TimeList, time: number): number {
  let low = 0; let high = times.length;
  while (low < high) { const middle = (low + high) >>> 1; if (times.at(middle) <= time) low = middle + 1; else high = middle; }
  return low;
}

/** The receive intervals of one CAN ID in a span, in milliseconds. */
export interface IntervalStats { readonly count: number; readonly meanMs: number; readonly minMs: number; readonly maxMs: number; readonly sdMs: number }
export interface IntervalSeries {
  /** Undefined when the span has no interval. */
  readonly stats?: IntervalStats;
  /** Every interval with the time of the frame that ended it, while there are at most `maxPoints`. */
  readonly times?: readonly number[];
  readonly intervals?: readonly number[];
  /** Else the least, greatest and mean interval in each equal slice of the span; null where a slice has none. */
  readonly buckets?: { readonly minMs: readonly (number | null)[]; readonly maxMs: readonly (number | null)[]; readonly meanMs: readonly (number | null)[] };
}

/**
 * The intervals between the frames of one CAN ID that were received in `range`. An interval belongs to the frame that
 * ended it; the first frame at or after `firstTime` (the start of the log or Clip) has none.
 */
export function intervalSeries(times: TimeList, range: TimingRange, bucketCount: number, maxPoints: number, firstTime = -Infinity): IntervalSeries {
  const from = Math.max(lowerBound(times, range.start), lowerBound(times, firstTime) + 1, 1); const to = upperBound(times, range.end); const count = to - from;
  if (count <= 0) return {};
  const points = count <= maxPoints; const slices = Math.max(1, Math.floor(bucketCount)); const width = (range.end - range.start) / slices || 1;
  const pointTimes: number[] = []; const pointValues: number[] = [];
  const least = points ? undefined : new Array<number | null>(slices).fill(null); const most = points ? undefined : new Array<number | null>(slices).fill(null); const sums = points ? undefined : new Float64Array(slices); const counts = points ? undefined : new Uint32Array(slices);
  let sum = 0; let squares = 0; let minimum = Infinity; let maximum = -Infinity; let previous = times.at(from - 1);
  for (let index = from; index < to; index++) {
    const time = times.at(index); const interval = (time - previous) * 1000; previous = time;
    sum += interval; squares += interval * interval; if (interval < minimum) minimum = interval; if (interval > maximum) maximum = interval;
    if (points) { pointTimes.push(time); pointValues.push(interval); continue; }
    const slice = Math.min(slices - 1, Math.max(0, Math.floor((time - range.start) / width)));
    const low = least![slice]; if (low === null || interval < low) least![slice] = interval; const high = most![slice]; if (high === null || interval > high) most![slice] = interval;
    sums![slice] += interval; counts![slice]++;
  }
  const mean = sum / count; const stats: IntervalStats = { count, meanMs: mean, minMs: minimum, maxMs: maximum, sdMs: Math.sqrt(Math.max(0, squares / count - mean * mean)) };
  if (points) return { stats, times: pointTimes, intervals: pointValues };
  return { stats, buckets: { minMs: least!, maxMs: most!, meanMs: Array.from(sums!, (value, slice) => counts![slice] ? value / counts![slice] : null) } };
}
