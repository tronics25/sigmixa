import type { CanFrame } from '../../core/frame/canFrame';

/**
 * Frames of one piece of a log, packed into typed arrays so they cross between threads without copying: frame `i` is
 * at index `i` of every column, its payload at `data[dataOffsets[i]..dataOffsets[i + 1])`.
 */
export interface PackedFrames {
  readonly count: number;
  readonly timestamps: Float64Array;
  readonly canIds: Uint32Array;
  /** PACKED_EXTENDED | PACKED_TX. */
  readonly flags: Uint8Array;
  readonly channels: Uint32Array;
  readonly dlcCodes: Uint8Array;
  readonly lengths: Uint8Array;
  /** count + 1 entries. */
  readonly dataOffsets: Uint32Array;
  readonly data: Uint8Array;
}

export const PACKED_EXTENDED = 1;
export const PACKED_TX = 2;

/** Packs frames as they are read. */
export class FramePacker {
  private count = 0; private dataUsed = 0;
  private timestamps = new Float64Array(1024); private canIds = new Uint32Array(1024); private flags = new Uint8Array(1024); private channels = new Uint32Array(1024);
  private dlcCodes = new Uint8Array(1024); private lengths = new Uint8Array(1024); private dataOffsets = new Uint32Array(1025); private data = new Uint8Array(8192);

  get size(): number { return this.count; }

  push(frame: Omit<CanFrame, 'id' | 'sourceId'>): void {
    if (this.count === this.timestamps.length) this.grow();
    const at = this.count;
    this.timestamps[at] = frame.timestamp; this.canIds[at] = frame.canId; this.flags[at] = (frame.extended ? PACKED_EXTENDED : 0) | (frame.direction === 'Tx' ? PACKED_TX : 0);
    this.channels[at] = frame.channel; this.dlcCodes[at] = frame.dlcCode; this.lengths[at] = frame.dataLength;
    const payload = frame.data;
    if (this.dataUsed + payload.length > this.data.length) { let size = this.data.length * 2; while (size < this.dataUsed + payload.length) size *= 2; const next = new Uint8Array(size); next.set(this.data.subarray(0, this.dataUsed)); this.data = next; }
    this.data.set(payload, this.dataUsed); this.dataUsed += payload.length;
    this.count++; this.dataOffsets[this.count] = this.dataUsed;
  }

  finish(): PackedFrames {
    const n = this.count;
    return {
      count: n, timestamps: this.timestamps.slice(0, n), canIds: this.canIds.slice(0, n), flags: this.flags.slice(0, n), channels: this.channels.slice(0, n),
      dlcCodes: this.dlcCodes.slice(0, n), lengths: this.lengths.slice(0, n), dataOffsets: this.dataOffsets.slice(0, n + 1), data: this.data.slice(0, this.dataUsed),
    };
  }

  private grow(): void {
    const size = this.timestamps.length * 2;
    const grow = <T extends Float64Array | Uint32Array | Uint8Array>(array: T, length = size): T => { const next = new (array.constructor as new (length: number) => T)(length); next.set(array); return next; };
    this.timestamps = grow(this.timestamps); this.canIds = grow(this.canIds); this.flags = grow(this.flags); this.channels = grow(this.channels);
    this.dlcCodes = grow(this.dlcCodes); this.lengths = grow(this.lengths); this.dataOffsets = grow(this.dataOffsets, size + 1);
  }
}

/** The frame at `index` of packed frames, as the parser gave it (without its ID). */
export function unpackFrame(packed: PackedFrames, index: number): Omit<CanFrame, 'id' | 'sourceId'> {
  const flags = packed.flags[index];
  return {
    timestamp: packed.timestamps[index], canId: packed.canIds[index], extended: (flags & PACKED_EXTENDED) !== 0, direction: flags & PACKED_TX ? 'Tx' : 'Rx',
    channel: packed.channels[index], dlcCode: packed.dlcCodes[index], dataLength: packed.lengths[index],
    data: packed.data.subarray(packed.dataOffsets[index], packed.dataOffsets[index + 1]),
  };
}

export function packedTransfer(packed: PackedFrames): ArrayBuffer[] {
  return [packed.timestamps, packed.canIds, packed.flags, packed.channels, packed.dlcCodes, packed.lengths, packed.dataOffsets, packed.data].map((array) => array.buffer as ArrayBuffer);
}

/**
 * Signal values a worker decoded from packed frames: row `r` belongs to frame `rowFrames[r]` and holds samples
 * `rowStarts[r]..rowStarts[r + 1]`, each a Signal (its number in the list the worker was given), a value and a state
 * name (`labels`: 0 for none, else its number in `labelTexts` + 1). Every sample is valid and has its frame's time.
 * A row the main thread is to finish (`rowKinds`) is there even with no samples.
 */
export interface PackedSignals {
  readonly rows: number;
  readonly rowFrames: Uint32Array;
  readonly rowStarts: Uint32Array;
  /** ROW_DONE, ROW_SIGNALS or ROW_MANUAL (chunkDecoder): what is left to the main thread for the row's frame. */
  readonly rowKinds: Uint8Array;
  readonly signals: Uint32Array;
  readonly values: Float64Array;
  readonly labels: Uint32Array;
  readonly labelTexts: readonly string[];
  /** Frames the worker left to the main thread, ascending: they are decoded there as before (Plugins, filters, diagnostics). */
  readonly mainFrames: Uint32Array;
}

export function signalsTransfer(signals: PackedSignals): ArrayBuffer[] {
  return [signals.rowFrames, signals.rowStarts, signals.rowKinds, signals.signals, signals.values, signals.labels, signals.mainFrames].map((array) => array.buffer as ArrayBuffer);
}
