import type { CanFrame } from './canFrame';
import type { SignalSample } from '../signal/signal';
import { Column, F64Column, I32Column, stableOrder, U32Column } from '../storage/column';

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

/**
 * One Signal's usable samples in a bucket, as the bucket entry each came with and its place in that frame's samples. The
 * sample itself is read again from the frame when shown, so the index holds only numbers.
 */
interface SignalTrack {
  /** Bucket entry of each sample; absent while sample k came with entry k (the usual case). */
  entries?: Column<Uint32Array>;
  count: number;
  /** Place in the frame's samples; one value (`slot`) until they differ. */
  slots?: Column<Uint32Array>; slot: number;
  /** Own sample times; made when one differs from its frame's time. */
  times?: Column<Float64Array>;
  /** With Signal columns: the sample number of each sample, `base + at` until they differ. */
  base?: number; refs?: Column<Uint32Array>;
}

/** Signal values kept in columns (the Signal store), read without a sample object per frame. */
export interface TraceSampleColumns {
  /** Every usable sample, Signal by Signal in time order, with the index of its frame in `frames`. */
  usableFrameSamples(visit: (signalId: string, sample: number, frame: number, time: number) => void): void;
  /** `usableFrameSamples` in steps, yielding now and then so a caller can let other work run. */
  usableFrameSampleSteps?(visit: (signalId: string, sample: number, frame: number, time: number) => void): Generator<void, void>;
  /** Sample `sample` of a Signal, when it still came with frame `frame`. */
  frameSample(signalId: string, sample: number, frame: number): SignalSample | undefined;
}

interface Bucket {
  identity: TraceSnapshot['identity']; multiplexer?: TraceMultiplexer;
  /** Frames as their index in the frames given, with their times. */
  frames: Column<Uint32Array>; times: Column<Float64Array>;
  signals: Map<string, SignalTrack>;
  /** Entry of the latest frame at or before each entry whose payload differs from its predecessor. */
  changes?: Column<Int32Array>; lastData?: Uint8Array;
  /** Shortest and longest frame gap (ms) of each block of BLOCK entries, for interval statistics over any range. */
  blocks?: { min: Float64Array; max: Float64Array };
  /** Number while building from columns. */
  id?: number;
}

const BLOCK = 1024;
/** Frames between yields of a stepped build. */
const STEP = 50_000;

function samePayload(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
  return true;
}

export function traceFrameKey(frame: Pick<CanFrame, 'canId' | 'extended' | 'channel' | 'direction'>): string {
  return `${frame.extended ? 'e' : 's'}:${frame.canId}:${frame.channel}:${frame.direction}`;
}

/**
 * Retains independent Signal histories per source/ID/channel/direction, before display downsampling. Only numbers are
 * kept per frame: frames are read again through `frameAt` (or kept, when it is not given) and samples through `samples`.
 */
export class TraceIndex {
  private readonly buckets = new Map<string, Bucket>();
  private readonly aggregates = new Map<string, Bucket>();
  private readonly kept: CanFrame[] = [];
  private readonly frameOf: (index: number) => CanFrame | undefined;

  /**
   * `samples(frame, index)` must give the same samples whenever it is asked about a frame (`index` is its place in
   * `frames`). `frameAt(index)` gives that frame again; without it the frames are kept.
   */
  constructor(frames: Iterable<CanFrame>, private readonly samples: (frame: CanFrame, index: number) => readonly TraceSignalSample[], multiplexerFor?: (frame: CanFrame) => TraceMultiplexer | undefined, frameAt?: (index: number) => CanFrame | undefined, private readonly columns?: TraceSampleColumns, build = true) {
    this.frameOf = frameAt ?? ((index) => this.kept[index]);
    if (!build) return;
    if (columns) { const steps = this.fromColumns(frames, columns, multiplexerFor, !frameAt); while (!steps.next().done); return; }
    let index = 0;
    for (const frame of frames) {
      if (!frameAt) this.kept.push(frame);
      const multiplexer = multiplexerFor?.(frame);
      const decoded = samples(frame, index);
      this.add(this.buckets, `${frame.sourceId}:${traceFrameKey(frame)}${multiplexer ? `:mux:${multiplexer.value ?? '?'}` : ''}`, multiplexer, frame, index, decoded);
      if (multiplexer) this.add(this.aggregates, `${frame.sourceId}:${traceFrameKey(frame)}`, undefined, frame, index, decoded);
      index++;
    }
    for (const bucket of [...this.buckets.values(), ...this.aggregates.values()]) this.settle(bucket);
  }

  /**
   * The index of a log kept in Signal columns, built in steps: the generator yields every few thousand frames or samples,
   * so a large log can be indexed while other work goes on. The frames and samples must not change while it runs.
   */
  static *fromColumnSteps(frames: Iterable<CanFrame>, samples: (frame: CanFrame, index: number) => readonly TraceSignalSample[], multiplexerFor: ((frame: CanFrame) => TraceMultiplexer | undefined) | undefined, frameAt: (index: number) => CanFrame | undefined, columns: TraceSampleColumns): Generator<void, TraceIndex> {
    const index = new TraceIndex(frames, samples, multiplexerFor, frameAt, columns, false);
    yield* index.fromColumns(frames, columns, multiplexerFor, false);
    return index;
  }

  /**
   * Frames first (their buckets), then the samples Signal by Signal from the columns. Gives the same index as reading
   * each frame's samples: same samples, same order, same Signal order in each bucket.
   */
  private *fromColumns(frames: Iterable<CanFrame>, columns: TraceSampleColumns, multiplexerFor: ((frame: CanFrame) => TraceMultiplexer | undefined) | undefined, keep: boolean): Generator<void, void> {
    const list: Bucket[] = []; const bucketOf = new I32Column(); const entryOf = new U32Column(); const aggregateOf = new I32Column(); const aggregateEntryOf = new U32Column();
    const place = (buckets: Map<string, Bucket>, key: string, multiplexer: TraceMultiplexer | undefined, frame: CanFrame, index: number): Bucket => {
      let bucket = buckets.get(key);
      if (!bucket) { const { sourceId, canId, extended, channel, direction } = frame; bucket = { identity: { sourceId, canId, extended, channel, direction }, multiplexer, frames: new U32Column(), times: new F64Column(), signals: new Map(), changes: new I32Column(), id: list.length }; list.push(bucket); buckets.set(key, bucket); }
      return bucket;
    };
    // The bucket key of a frame, remembered by its numbers so most frames build no text.
    const routes = new Map<string, Map<number, Map<number | string | undefined, { bucket: Bucket; aggregate?: Bucket }>>>();
    const routeOf = (frame: CanFrame, multiplexer: TraceMultiplexer | undefined) => {
      const number = frame.channel < 65536 ? ((frame.canId * 2 + (frame.extended ? 1 : 0)) * 2 + (frame.direction === 'Tx' ? 1 : 0)) * 65536 + frame.channel : -1;
      let bySource = routes.get(frame.sourceId); if (!bySource) { bySource = new Map(); routes.set(frame.sourceId, bySource); }
      let byMultiplexer = number >= 0 ? bySource.get(number) : undefined; if (!byMultiplexer) { byMultiplexer = new Map(); if (number >= 0) bySource.set(number, byMultiplexer); }
      const muxKey = multiplexer ? (multiplexer.value ?? '?') : undefined;
      let route = byMultiplexer.get(muxKey);
      if (!route || (multiplexer && route.bucket.multiplexer?.name !== multiplexer.name)) {
        route = { bucket: place(this.buckets, `${frame.sourceId}:${traceFrameKey(frame)}${multiplexer ? `:mux:${multiplexer.value ?? '?'}` : ''}`, multiplexer, frame, 0),
          aggregate: multiplexer ? place(this.aggregates, `${frame.sourceId}:${traceFrameKey(frame)}`, undefined, frame, 0) : undefined };
        byMultiplexer.set(muxKey, route);
      }
      return route;
    };
    let index = 0;
    for (const frame of frames) {
      if (keep) this.kept.push(frame);
      const multiplexer = multiplexerFor?.(frame);
      const route = routeOf(frame, multiplexer);
      bucketOf.push(route.bucket.id!); entryOf.push(this.addFrame(route.bucket, frame, index));
      if (route.aggregate) { aggregateOf.push(route.aggregate.id!); aggregateEntryOf.push(this.addFrame(route.aggregate, frame, index)); }
      else { aggregateOf.push(-1); aggregateEntryOf.push(0); }
      index++;
      if (index % STEP === 0) yield;
    }
    // Tracks of the Signal being read, by bucket; the first sample of each track decides its place among the bucket's Signals.
    let currentId = ''; let tracks: (SignalTrack | undefined)[] = [];
    const firsts: { bucket: Bucket; signalId: string; track: SignalTrack; frame: number }[] = []; let first: (typeof firsts)[number][] = [];
    const push = (bucketId: number, entry: number, signalId: string, sample: number, frame: number, time: number) => {
      const bucket = list[bucketId]; let track = tracks[bucketId];
      if (!track) { track = { count: 0, slot: 0, base: sample }; tracks[bucketId] = track; first[bucketId] = { bucket, signalId, track, frame }; firsts.push(first[bucketId]); }
      else if (frame < first[bucketId].frame) first[bucketId].frame = frame;
      if (!track.entries && entry !== track.count) track.entries = identity(track.count);
      track.entries?.push(entry);
      if (!track.refs && sample !== track.base! + track.count) { track.refs = new U32Column(track.count + 16); for (let at = 0; at < track.count; at++) track.refs.push(track.base! + at); }
      track.refs?.push(sample);
      if (!track.times && time !== bucket.times.a[entry]) { track.times = new F64Column(track.count + 16); for (let at = 0; at < track.count; at++) track.times.push(bucket.times.a[this.entryOf(track, at)]); }
      track.times?.push(time);
      track.count++;
    };
    const visit = (signalId: string, sample: number, frame: number, time: number) => {
      if (frame >= index) return;
      if (signalId !== currentId) { currentId = signalId; tracks = []; first = []; }
      push(bucketOf.a[frame], entryOf.a[frame], signalId, sample, frame, time);
      const aggregate = aggregateOf.a[frame];
      if (aggregate >= 0) push(aggregate, aggregateEntryOf.a[frame], signalId, sample, frame, time);
    };
    if (columns.usableFrameSampleSteps) yield* columns.usableFrameSampleSteps(visit); else columns.usableFrameSamples(visit);
    // Signals in each bucket in the order the frames first show them, as when each frame's samples are read.
    const positions = new Map<number, readonly TraceSignalSample[]>();
    const position = (frame: number, signalId: string) => {
      let samples = positions.get(frame); if (!samples) { const value = this.frameOf(frame); samples = value ? this.samples(value, frame) : []; positions.set(frame, samples); }
      const at = samples.findIndex((item) => item.signalId === signalId); return at < 0 ? Infinity : at;
    };
    firsts.map((item) => ({ ...item, at: position(item.frame, item.signalId) }))
      .sort((left, right) => left.frame - right.frame || left.at - right.at)
      .forEach((item) => item.bucket.signals.set(item.signalId, item.track));
    yield;
    for (const bucket of [...this.buckets.values(), ...this.aggregates.values()]) { this.settle(bucket); yield; }
  }

  /** Adds a frame to a bucket; returns its entry. */
  private addFrame(target: Bucket, frame: CanFrame, index: number): number {
    const entry = target.frames.n;
    // Payload changes are worked out on the way while frames come in time order; otherwise after sorting.
    if (target.changes && entry > 0 && frame.timestamp < target.times.a[entry - 1]) { target.changes = undefined; target.lastData = undefined; }
    if (target.changes) { target.changes.push(entry > 0 && samePayload(frame.data, target.lastData!) ? target.changes.a[entry - 1] : entry); target.lastData = frame.data; }
    target.frames.push(index); target.times.push(frame.timestamp);
    return entry;
  }

  private add(buckets: Map<string, Bucket>, key: string, multiplexer: TraceMultiplexer | undefined, frame: CanFrame, index: number, decoded: readonly TraceSignalSample[]): void {
    let bucket = buckets.get(key);
    if (!bucket) {
      const { sourceId, canId, extended, channel, direction } = frame;
      bucket = { identity: { sourceId, canId, extended, channel, direction }, multiplexer, frames: new U32Column(), times: new F64Column(), signals: new Map(), changes: new I32Column() };
      buckets.set(key, bucket);
    }
    const target = bucket; const entry = this.addFrame(target, frame, index);
    decoded.forEach(({ signalId, sample }, slot) => {
      if (!Number.isFinite(sample.value) || !Number.isFinite(sample.timestamp) || (sample.quality && sample.quality !== 'valid')) return;
      let track = target.signals.get(signalId);
      if (!track) { track = { count: 0, slot }; target.signals.set(signalId, track); }
      if (!track.entries && entry !== track.count) track.entries = identity(track.count);
      track.entries?.push(entry);
      if (!track.slots && slot !== track.slot) { track.slots = new U32Column(track.count + 16); track.slots.fill(track.slot, track.count); }
      track.slots?.push(slot);
      if (!track.times && sample.timestamp !== frame.timestamp) { track.times = new F64Column(track.count + 16); for (let at = 0; at < track.count; at++) track.times.push(target.times.a[this.entryOf(track, at)]); }
      track.times?.push(sample.timestamp);
      track.count++;
    });
  }

  /** Frames and samples in time order, keeping their order for equal times (as a stable sort would). */
  private settle(bucket: Bucket): void {
    const count = bucket.frames.n; let sorted = true;
    for (let entry = 1; entry < count && sorted; entry++) if (bucket.times.a[entry] < bucket.times.a[entry - 1]) sorted = false;
    if (!sorted) {
      const times = bucket.times.a; const order = stableOrder(count, (left, right) => times[left] - times[right]);
      const moved = new Uint32Array(count); for (let entry = 0; entry < count; entry++) moved[order[entry]] = entry;
      bucket.frames.permute(order); bucket.times.permute(order);
      for (const track of bucket.signals.values()) {
        const entries = new U32Column(track.count + 1); for (let at = 0; at < track.count; at++) entries.push(moved[this.entryOf(track, at)]);
        track.entries = entries;
      }
    }
    for (const track of bucket.signals.values()) {
      // Samples in order of their own time; equal times keep the order they came in.
      let inOrder = true;
      for (let at = 1; at < track.count && inOrder; at++) if (this.sampleTime(bucket, track, at) < this.sampleTime(bucket, track, at - 1)) inOrder = false;
      if (!inOrder) {
        track.entries ??= identity(track.count);
        const order = stableOrder(track.count, (left, right) => this.sampleTime(bucket, track, left) - this.sampleTime(bucket, track, right));
        if (track.base !== undefined && !track.refs) { track.refs = new U32Column(track.count + 1); for (let at = 0; at < track.count; at++) track.refs.push(track.base + at); }
        track.entries.permute(order); track.slots?.permute(order); track.times?.permute(order); track.refs?.permute(order);
      }
      track.entries?.trim(); track.slots?.trim(); track.times?.trim(); track.refs?.trim();
    }
    bucket.frames.trim(); bucket.times.trim(); bucket.changes?.trim(); bucket.lastData = undefined;
  }

  private entryOf(track: SignalTrack, at: number): number { return track.entries ? track.entries.a[at] : at; }
  private sampleTime(bucket: Bucket, track: SignalTrack, at: number): number { return track.times ? track.times.a[at] : bucket.times.a[this.entryOf(track, at)]; }

  private changeIndex(bucket: Bucket, entry: number): number {
    if (!bucket.changes) {
      const changes = new I32Column(bucket.frames.n + 1); let previous: Uint8Array | undefined;
      for (let at = 0; at < bucket.frames.n; at++) {
        const data = this.frameOf(bucket.frames.a[at])?.data ?? new Uint8Array();
        changes.push(at > 0 && previous && samePayload(data, previous) ? changes.a[at - 1] : at); previous = data;
      }
      bucket.changes = changes;
    }
    return bucket.changes.a[entry];
  }

  /** Shortest and longest gap (ms) between consecutive entries first..last: block summaries plus the partial blocks at each end. */
  private intervals(bucket: Bucket, first: number, last: number): { min: number; max: number } {
    const times = bucket.times.a; const gap = (entry: number) => (times[entry] - times[entry - 1]) * 1000;
    if (!bucket.blocks) {
      const blocks = Math.ceil(bucket.frames.n / BLOCK); const min = new Float64Array(blocks).fill(Infinity); const max = new Float64Array(blocks).fill(-Infinity);
      for (let entry = 1; entry < bucket.frames.n; entry++) { const block = Math.floor(entry / BLOCK); const value = gap(entry); if (value < min[block]) min[block] = value; if (value > max[block]) max[block] = value; }
      bucket.blocks = { min, max };
    }
    let min = Infinity; let max = -Infinity; let entry = first + 1;
    const take = (low: number, high: number) => { if (low < min) min = low; if (high > max) max = high; };
    for (; entry <= last && entry % BLOCK !== 0; entry++) { const value = gap(entry); take(value, value); }
    for (; entry + BLOCK - 1 <= last; entry += BLOCK) take(bucket.blocks.min[entry / BLOCK], bucket.blocks.max[entry / BLOCK]);
    for (; entry <= last; entry++) { const value = gap(entry); take(value, value); }
    return { min, max };
  }

  /** The sample `at` of a track, read again from its frame. */
  private sampleOf(bucket: Bucket, signalId: string, track: SignalTrack, at: number): SignalSample | undefined {
    const index = bucket.frames.a[this.entryOf(track, at)];
    if (this.columns && track.base !== undefined) { const sample = this.columns.frameSample(signalId, track.refs ? track.refs.a[at] : track.base + at, index); if (sample) return sample; }
    const frame = this.frameOf(index); if (!frame) return undefined;
    const list = this.samples(frame, index); const slot = track.slots ? track.slots.a[at] : track.slot;
    return (list[slot]?.signalId === signalId ? list[slot] : list.find((item) => item.signalId === signalId))?.sample;
  }

  at(timestamp: number, start = -Infinity, end = Infinity, groupByMultiplexer = true): TraceSnapshot[] {
    if (!Number.isFinite(timestamp) || start > end) return [];
    const buckets = groupByMultiplexer ? [...this.buckets.values()] : [...this.buckets.values()].filter((bucket) => !bucket.multiplexer).concat([...this.aggregates.values()]);
    const until = Math.min(timestamp, end);
    return buckets.map((bucket) => {
      const { identity, signals, multiplexer } = bucket; const times = bucket.times.a; const count = bucket.frames.n;
      const first = bound(count, (entry) => times[entry], start, false); const last = bound(count, (entry) => times[entry], until, true) - 1;
      const frame = last >= first ? this.frameOf(bucket.frames.a[last]) : undefined;
      const stats = frame && last > first ? this.intervals(bucket, first, last) : undefined;
      // Keys carry the source like the buckets do, so rows from different sources never collide.
      return { key: `${identity.sourceId}:${traceFrameKey(identity)}${multiplexer ? `:mux:${multiplexer.value ?? '?'}` : ''}`, identity, multiplexer, frame, count: frame ? last - first + 1 : 0, age: frame ? timestamp - times[last] : undefined,
        intervalMs: frame && last > first ? (times[last] - times[last - 1]) * 1000 : undefined,
        minIntervalMs: stats?.min, maxIntervalMs: stats?.max,
        lastChangeAt: frame ? times[Math.max(first, this.changeIndex(bucket, last))] : undefined,
        signals: new Map([...signals].map(([id, track]) => {
          const at = bound(track.count, (index) => this.sampleTime(bucket, track, index), until, true) - 1;
          const sample = at >= 0 ? this.sampleOf(bucket, id, track, at) : undefined;
          // A value from before the Clip is still the Signal's value when the Clip begins: shown, marked as carried.
          return [id, sample && sample.timestamp < start ? { ...sample, carried: true } : sample];
        })),
      };
    });
  }
}

function identity(count: number): Column<Uint32Array> { const column = new U32Column(count + 16); for (let index = 0; index < count; index++) column.push(index); return column; }

function bound(count: number, timeAt: (index: number) => number, time: number, inclusive: boolean): number {
  let low = 0; let high = count;
  while (low < high) { const middle = (low + high) >>> 1; const value = timeAt(middle); if (value < time || (inclusive && value === time)) low = middle + 1; else high = middle; }
  return low;
}
