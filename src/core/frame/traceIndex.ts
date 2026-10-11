import type { CanFrame } from './canFrame';
import type { SignalSample } from '../signal/signal';

export interface TraceSignalSample { readonly signalId: string; readonly sample: SignalSample; }
export interface TraceMultiplexer { readonly name: string; readonly value?: number; }
export interface TraceSnapshot {
  readonly key: string;
  readonly identity: Pick<CanFrame, 'sourceId' | 'canId' | 'extended' | 'channel' | 'direction'>;
  readonly frame?: CanFrame;
  readonly count: number;
  readonly age?: number;
  readonly intervalMs?: number;
  /** Shortest / longest gap between consecutive frames from the range start up to the seek time. */
  readonly minIntervalMs?: number;
  readonly maxIntervalMs?: number;
  /** Time the payload last differed from the frame before it (the first frame in range counts as a change). */
  readonly lastChangeAt?: number;
  readonly signals: ReadonlyMap<string, SignalSample | undefined>;
  readonly multiplexer?: TraceMultiplexer;
}
interface Bucket {
  identity: TraceSnapshot['identity']; frames: CanFrame[]; signals: Map<string, SignalSample[]>; multiplexer?: TraceMultiplexer;
  /** Index of the latest frame at or before i whose payload differs from its predecessor. */
  changeIndex?: Int32Array;
  /** Running min/max interval (ms) from a given first index; one range start is used per document. */
  intervalStats?: { first: number; min: Float64Array; max: Float64Array };
}
function samePayload(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
  return true;
}
function changeIndexOf(bucket: Bucket): Int32Array {
  if (bucket.changeIndex) return bucket.changeIndex;
  const result = new Int32Array(bucket.frames.length);
  for (let index = 1; index < bucket.frames.length; index++) result[index] = samePayload(bucket.frames[index].data, bucket.frames[index - 1].data) ? result[index - 1] : index;
  return (bucket.changeIndex = result);
}
function intervalStatsFrom(bucket: Bucket, first: number): NonNullable<Bucket['intervalStats']> {
  if (bucket.intervalStats?.first === first) return bucket.intervalStats;
  const { frames } = bucket; const min = new Float64Array(frames.length).fill(Number.NaN); const max = new Float64Array(frames.length).fill(Number.NaN);
  for (let index = first + 1; index < frames.length; index++) {
    const gap = (frames[index].timestamp - frames[index - 1].timestamp) * 1000;
    min[index] = index === first + 1 ? gap : Math.min(min[index - 1], gap);
    max[index] = index === first + 1 ? gap : Math.max(max[index - 1], gap);
  }
  return (bucket.intervalStats = { first, min, max });
}
export function traceFrameKey(frame: Pick<CanFrame, 'canId' | 'extended' | 'channel' | 'direction'>): string {
  return `${frame.extended ? 'e' : 's'}:${frame.canId}:${frame.channel}:${frame.direction}`;
}
/** Retains independent Signal histories per source/ID/channel/direction, before display downsampling. */
export class TraceIndex {
  private readonly buckets = new Map<string, Bucket>();
  private readonly aggregates = new Map<string, Bucket>();
  constructor(frames: Iterable<CanFrame>, samples: (frame: CanFrame) => readonly TraceSignalSample[], multiplexerFor?: (frame: CanFrame) => TraceMultiplexer | undefined) {
    for (const frame of frames) {
      const multiplexer = multiplexerFor?.(frame);
      const key = `${frame.sourceId}:${traceFrameKey(frame)}${multiplexer ? `:mux:${multiplexer.value ?? '?'}` : ''}`;
      const decoded = samples(frame);
      const destinations: [Map<string, Bucket>, string, TraceMultiplexer | undefined][] = [[this.buckets, key, multiplexer]];
      if (multiplexer) destinations.push([this.aggregates, `${frame.sourceId}:${traceFrameKey(frame)}`, undefined]);
      for (const [buckets, bucketKey, mux] of destinations) {
        let bucket = buckets.get(bucketKey);
        if (!bucket) { const { sourceId, canId, extended, channel, direction } = frame; bucket = { identity: { sourceId, canId, extended, channel, direction }, frames: [], signals: new Map(), multiplexer: mux }; buckets.set(bucketKey, bucket); }
        bucket.frames.push(frame);
        for (const { signalId, sample } of decoded) {
          if (!Number.isFinite(sample.value) || !Number.isFinite(sample.timestamp) || (sample.quality && sample.quality !== 'valid')) continue;
          const values = bucket.signals.get(signalId) ?? []; values.push(sample); bucket.signals.set(signalId, values);
        }
      }
    }
    for (const bucket of [...this.buckets.values(), ...this.aggregates.values()]) {
      bucket.frames.sort((a, b) => a.timestamp - b.timestamp);
      for (const values of bucket.signals.values()) values.sort((a, b) => a.timestamp - b.timestamp);
    }
  }
  at(timestamp: number, start = -Infinity, end = Infinity, groupByMultiplexer = true): TraceSnapshot[] {
    if (!Number.isFinite(timestamp) || start > end) return [];
    const buckets = groupByMultiplexer ? [...this.buckets.values()] : [...this.buckets.values()].filter((bucket) => !bucket.multiplexer).concat([...this.aggregates.values()]);
    return buckets.map((bucket) => {
      const { identity, frames, signals, multiplexer } = bucket;
      const first = bound(frames, start, false); const last = bound(frames, Math.min(timestamp, end), true) - 1;
      const frame = last >= first ? frames[last] : undefined;
      const stats = frame && last > first ? intervalStatsFrom(bucket, first) : undefined;
      // Keys carry the source like the buckets do, so rows from different sources never collide.
      return { key: `${identity.sourceId}:${traceFrameKey(identity)}${multiplexer ? `:mux:${multiplexer.value ?? '?'}` : ''}`, identity, multiplexer, frame, count: frame ? last - first + 1 : 0, age: frame ? timestamp - frame.timestamp : undefined,
        intervalMs: frame && last > first ? (frame.timestamp - frames[last - 1].timestamp) * 1000 : undefined,
        minIntervalMs: stats ? stats.min[last] : undefined, maxIntervalMs: stats ? stats.max[last] : undefined,
        lastChangeAt: frame ? frames[Math.max(first, changeIndexOf(bucket)[last])].timestamp : undefined,
        signals: new Map([...signals].map(([id, values]) => {
          const sample = values[bound(values, Math.min(timestamp, end), true) - 1];
          // A value from before the Clip is still the Signal's value when the Clip begins: shown, marked as carried.
          return [id, sample && sample.timestamp < start ? { ...sample, carried: true } : sample];
        })),
      };
    });
  }
}
function bound(values: readonly { readonly timestamp: number }[], time: number, inclusive: boolean): number {
  let low = 0; let high = values.length;
  while (low < high) { const middle = (low + high) >>> 1; if (values[middle].timestamp < time || (inclusive && values[middle].timestamp === time)) low = middle + 1; else high = middle; }
  return low;
}
