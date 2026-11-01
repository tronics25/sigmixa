import type { CanFrame } from './canFrame';
import { formatCanId } from './canId';
import { finishScan, SCAN_STEP, WidestPicker } from './widestText';

export interface FrameFilter {
  readonly search?: string;
  readonly searchRegex?: boolean;
  readonly searchContent?: 'raw' | 'decoded';
  readonly canIds?: readonly number[];
  readonly canIdRefs?: readonly { readonly canId: number; readonly extended: boolean }[];
  readonly direction?: 'Rx' | 'Tx';
  readonly channel?: number;
  readonly timeStart?: number;
  readonly timeEnd?: number;
  readonly decoded?: boolean;
}

export interface FrameQueryContext {
  readonly cacheKey: string;
  readonly additionalSearchText?: (frame: CanFrame) => string;
  readonly isDecoded?: (frame: CanFrame) => boolean;
}

export interface FramePageQuery {
  readonly offset: number;
  readonly limit: number;
  readonly filter?: FrameFilter;
}

export interface FramePage {
  readonly rows: readonly CanFrame[];
  readonly offset: number;
  readonly total: number;
  readonly generation: number;
  /** False while a filter is still being applied to the whole log: `total` and later rows are what was found so far. */
  readonly complete?: boolean;
}

export interface FrameStore {
  readonly size: number;
  readonly generation: number;
  append(frames: readonly CanFrame[]): void;
  query(query: FramePageQuery, context?: FrameQueryContext): FramePage;
  widthCandidates(filter: FrameFilter | undefined, contentCells: (frame: CanFrame) => readonly number[], context?: FrameQueryContext): readonly CanFrame[];
  clear(): void;
}

/** A compact append-only ordinal list. Unlike number[], entries stay at four bytes each. */
class OrdinalIndex {
  private readonly chunks: Uint32Array[] = [];
  private count = 0;
  constructor(private readonly chunkSize = 4096) {}
  get length(): number { return this.count; }
  push(value: number): void {
    if (value < 0 || value > 0xffffffff) throw new Error('Frame index exceeds the supported range.');
    const chunkIndex = Math.floor(this.count / this.chunkSize); const offset = this.count % this.chunkSize;
    if (!this.chunks[chunkIndex]) this.chunks.push(new Uint32Array(this.chunkSize));
    this.chunks[chunkIndex][offset] = value; this.count++;
  }
  at(index: number): number | undefined {
    if (index < 0 || index >= this.count) return undefined;
    return this.chunks[Math.floor(index / this.chunkSize)][index % this.chunkSize];
  }
  *values(): IterableIterator<number> { for (let index = 0; index < this.count; index++) yield this.at(index)!; }
}

const bytesToHex = (data: Uint8Array): string => Array.from(data, (byte) => byte.toString(16).padStart(2, '0')).join(' ');

/** How long a page request may read frames for a filter; the rest is read in the background. */
const QUERY_SCAN_MS = 40;
const HEX_PAIRS = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, '0'));
const idTexts = new Map<number, readonly string[]>();
/**
 * A plain (not regular expression) search over the same texts as the regular expression path, lowercased: CAN ID forms,
 * payload, then the decoded text, which is the costly one and is made only when nothing before it matched.
 */
function plainMatch(frame: CanFrame, search: string, withPayload: boolean, context?: FrameQueryContext): boolean {
  const idKey = frame.canId * 2 + (frame.extended ? 1 : 0); let ids = idTexts.get(idKey);
  if (!ids) { const idHex = formatCanId(frame.canId, frame.extended); ids = [idHex.toLowerCase(), `0x${idHex}`.toLowerCase(), frame.canId.toString(16)]; if (idTexts.size < 100_000) idTexts.set(idKey, ids); }
  if (ids[0].includes(search) || ids[1].includes(search) || ids[2].includes(search)) return true;
  if (withPayload) {
    let hex = ''; for (let index = 0; index < frame.data.length; index++) hex += index ? ` ${HEX_PAIRS[frame.data[index]]}` : HEX_PAIRS[frame.data[index]];
    if (hex.includes(search)) return true;
  }
  return (context?.additionalSearchText?.(frame) ?? '').toLowerCase().includes(search);
}

function matches(frame: CanFrame, filter: FrameFilter | undefined, context?: FrameQueryContext, searchPattern?: RegExp | null): boolean {
  if (!filter) return true;
  if (filter.canIds?.length && !filter.canIds.includes(frame.canId)) return false;
  if (filter.canIdRefs?.length && !filter.canIdRefs.some((item) => item.canId === frame.canId && item.extended === frame.extended)) return false;
  if (filter.direction && frame.direction !== filter.direction) return false;
  if (filter.channel !== undefined && frame.channel !== filter.channel) return false;
  if (filter.timeStart !== undefined && frame.timestamp < filter.timeStart) return false;
  if (filter.timeEnd !== undefined && frame.timestamp > filter.timeEnd) return false;
  if (filter.decoded !== undefined && (context?.isDecoded?.(frame) ?? false) !== filter.decoded) return false;
  const search = filter.search?.trim().toLowerCase();
  if (search) {
    // The payload is searched unless only decoded text is searched and the frame has some.
    const withPayload = filter.searchContent !== 'decoded' || !(context?.isDecoded?.(frame) ?? false);
    if (filter.searchRegex) {
      const idHex = formatCanId(frame.canId, frame.extended);
      const fields = [idHex, `0x${idHex}`, frame.canId.toString(16), ...(withPayload ? [bytesToHex(frame.data)] : []), context?.additionalSearchText?.(frame) ?? ''];
      if (!searchPattern || !fields.some((field) => searchPattern.test(field))) return false;
    } else if (!plainMatch(frame, search, withPayload, context)) return false;
  }
  return true;
}

/**
 * Frames packed into typed arrays, a chunk at a time: a few dozen bytes per frame plus its payload, outside the
 * JavaScript heap. A CanFrame object is made only when a frame is read, so tens of millions of frames fit in memory.
 */
class FrameChunk {
  readonly timestamps: Float64Array; readonly canIds: Uint32Array; readonly flags: Uint8Array; readonly channels: Uint32Array;
  readonly dlcCodes: Uint8Array; readonly lengths: Uint8Array; readonly payloadLengths: Uint8Array; readonly dataOffsets: Uint32Array; readonly sequences: Float64Array; readonly prefixes: Uint16Array;
  data: Uint8Array; dataUsed = 0; length = 0;
  constructor(readonly capacity: number) {
    this.timestamps = new Float64Array(capacity); this.canIds = new Uint32Array(capacity); this.flags = new Uint8Array(capacity); this.channels = new Uint32Array(capacity);
    this.dlcCodes = new Uint8Array(capacity); this.lengths = new Uint8Array(capacity); this.payloadLengths = new Uint8Array(capacity); this.dataOffsets = new Uint32Array(capacity); this.sequences = new Float64Array(capacity); this.prefixes = new Uint16Array(capacity);
    this.data = new Uint8Array(Math.min(capacity * 8, 1 << 20));
  }
  reserve(bytes: number): void {
    if (this.dataUsed + bytes <= this.data.length) return;
    let size = this.data.length * 2; while (size < this.dataUsed + bytes) size *= 2;
    const next = new Uint8Array(size); next.set(this.data.subarray(0, this.dataUsed)); this.data = next;
  }
  /** Gives back the unused part of the payload buffer once the chunk is full. */
  trim(): void { if (this.data.length > this.dataUsed) this.data = this.data.slice(0, this.dataUsed); }
}

const FLAG_EXTENDED = 1; const FLAG_TX = 2;

export class ChunkedFrameStore implements FrameStore {
  private readonly chunks: FrameChunk[] = [];
  private count = 0;
  private version = 0;
  private bounds?: { start: number; end: number };
  private cachedFilterKey: string | undefined;
  private cachedFilter: FrameFilter | undefined;
  private cachedContext: FrameQueryContext | undefined;
  private readonly canRefIndexes = new Map<string, OrdinalIndex>();
  private readonly channelIndexes = new Map<number, OrdinalIndex>();
  private readonly directionIndexes = new Map<CanFrame['direction'], OrdinalIndex>();
  private cachedMatches = new OrdinalIndex();
  private cachedSearchPattern: RegExp | null | undefined;
  /** The filter being applied to frames below `scanLimit` (those there when it was set); undefined once done. */
  private scan?: Iterator<number>;
  private scanLimit = 0;
  private appendedMatches = new OrdinalIndex();
  private timestampCacheGeneration = -1;
  private timestampCache: Float64Array = new Float64Array();
  /** Frame IDs are `<prefix><number>`; the prefixes (one per source and parser) are kept once here. */
  private readonly idPrefixes: { prefix: string; sourceId: string }[] = [];
  private readonly prefixIndex = new Map<string, number>();
  /** IDs that do not end in a number, kept as they are (none come from the bundled parsers). */
  private readonly otherIds = new Map<number, { readonly id: string; readonly sourceId: string }>();
  /** Ordinal minus sequence of every frame of a prefix (NaN once they differ). */
  private prefixOffsets: number[] = [];
  /** ID -> ordinal for logs whose IDs do not follow their order; built when first needed. */
  private idOrdinals?: { readonly count: number; readonly map: Map<string, number> };
  private lastPrefix?: { readonly prefix: string; readonly sourceId: string; readonly index: number };

  constructor(private readonly chunkSize = 65536) {
    if (!Number.isInteger(chunkSize) || chunkSize < 1) throw new Error('chunkSize must be a positive integer.');
  }

  get size(): number { return this.count; }
  get generation(): number { return this.version; }
  get timeRange(): { readonly start: number; readonly end: number } | undefined { return this.bounds && { ...this.bounds }; }

  *frames(): IterableIterator<CanFrame> { for (let ordinal = 0; ordinal < this.count; ordinal++) yield this.frameAt(ordinal)!; }

  /** The frame at `ordinal` (0 = first appended), made on demand. */
  frame(ordinal: number): CanFrame | undefined { return this.frameAt(ordinal); }

  /** The ID of the frame at `ordinal`, without making the whole frame. */
  idAt(ordinal: number): string | undefined {
    if (ordinal < 0 || ordinal >= this.count) return undefined;
    const chunk = this.chunks[Math.floor(ordinal / this.chunkSize)]; const at = ordinal % this.chunkSize; const prefixIndex = chunk.prefixes[at];
    return prefixIndex === 0xffff ? this.otherIds.get(ordinal)!.id : `${this.idPrefixes[prefixIndex].prefix}${chunk.sequences[at]}`;
  }

  /** The ordinal of a frame this store handed out. */
  ordinalOf(frame: Pick<CanFrame, 'id' | 'sourceId'>): number | undefined {
    const parsed = this.parseId(frame.id, frame.sourceId, false);
    const offset = parsed && this.prefixOffsets[parsed.prefix];
    if (parsed && offset !== undefined && Number.isFinite(offset)) {
      const ordinal = parsed.sequence + offset;
      if (ordinal >= 0 && ordinal < this.count) {
        const chunk = this.chunks[Math.floor(ordinal / this.chunkSize)]; const at = ordinal % this.chunkSize;
        if (chunk.prefixes[at] === parsed.prefix && chunk.sequences[at] === parsed.sequence) return ordinal;
      }
      return undefined;
    }
    if (this.idOrdinals?.count !== this.count) {
      const map = this.idOrdinals?.map ?? new Map<string, number>();
      for (let ordinal = this.idOrdinals?.count ?? 0; ordinal < this.count; ordinal++) { const id = this.idAt(ordinal)!; if (!map.has(id)) map.set(id, ordinal); }
      this.idOrdinals = { count: this.count, map };
    }
    return this.idOrdinals.map.get(frame.id);
  }

  *framesByCanRefs(refs: readonly { readonly canId: number; readonly extended: boolean }[]): IterableIterator<CanFrame> {
    for (const ordinal of mergeIndexes(this.canRefIndexesFor(refs))) { const frame = this.frameAt(ordinal); if (frame) yield frame; }
  }

  append(frames: readonly CanFrame[]): void {
    for (const frame of frames) {
      if (Number.isFinite(frame.timestamp)) {
        this.bounds ??= { start: frame.timestamp, end: frame.timestamp };
        if (frame.timestamp < this.bounds.start) this.bounds.start = frame.timestamp;
        if (frame.timestamp > this.bounds.end) this.bounds.end = frame.timestamp;
      }
      const ordinal = this.count;
      let chunk = this.chunks[this.chunks.length - 1];
      if (!chunk || chunk.length >= chunk.capacity) {
        chunk?.trim();
        chunk = new FrameChunk(this.chunkSize);
        this.chunks.push(chunk);
      }
      const at = chunk.length;
      chunk.timestamps[at] = frame.timestamp; chunk.canIds[at] = frame.canId;
      chunk.flags[at] = (frame.extended ? FLAG_EXTENDED : 0) | (frame.direction === 'Tx' ? FLAG_TX : 0);
      chunk.channels[at] = frame.channel; chunk.dlcCodes[at] = frame.dlcCode; chunk.lengths[at] = frame.dataLength;
      const payload = frame.data.length > 255 ? frame.data.subarray(0, 255) : frame.data;
      chunk.reserve(payload.length); chunk.dataOffsets[at] = chunk.dataUsed; chunk.payloadLengths[at] = payload.length; chunk.data.set(payload, chunk.dataUsed); chunk.dataUsed += payload.length;
      this.storeId(chunk, at, ordinal, frame);
      chunk.length++;
      this.count++;
      appendIndex(this.canRefIndexes, canKey(frame.canId, frame.extended), ordinal);
      appendIndex(this.channelIndexes, frame.channel, ordinal);
      appendIndex(this.directionIndexes, frame.direction, ordinal);
      if (this.cachedFilterKey !== undefined && matches(frame, this.cachedFilter, this.cachedContext, this.cachedSearchPattern)) (this.scan ? this.appendedMatches : this.cachedMatches).push(ordinal);
    }
    if (frames.length) this.version++;
  }

  private storeId(chunk: FrameChunk, at: number, ordinal: number, frame: CanFrame): void {
    const parsed = this.parseId(frame.id, frame.sourceId, true);
    if (!parsed) { this.otherIds.set(ordinal, { id: frame.id, sourceId: frame.sourceId }); chunk.prefixes[at] = 0xffff; chunk.sequences[at] = 0; return; }
    chunk.prefixes[at] = parsed.prefix; chunk.sequences[at] = parsed.sequence;
    // While every frame of a prefix sits at its number plus one offset, a frame's place follows from its ID.
    const offset = ordinal - parsed.sequence; const known = this.prefixOffsets[parsed.prefix];
    if (known === undefined) this.prefixOffsets[parsed.prefix] = offset; else if (known !== offset) this.prefixOffsets[parsed.prefix] = Number.NaN;
  }

  /** An ID's prefix number and sequence, as stored; `create` adds a new prefix. Undefined for IDs kept as they are. */
  private parseId(id: string, sourceId: string, create: boolean): { prefix: number; sequence: number } | undefined {
    // Frames of one source share a prefix: try the last one before the regular expression.
    const last = this.lastPrefix;
    if (last && sourceId === last.sourceId && id.length > last.prefix.length && id.startsWith(last.prefix)) {
      const digits = id.length - last.prefix.length; let plain = digits <= 15 && (digits === 1 || id.charCodeAt(last.prefix.length) !== 48);
      for (let index = last.prefix.length; plain && index < id.length; index++) { const code = id.charCodeAt(index); if (code < 48 || code > 57) plain = false; }
      if (plain) return { prefix: last.index, sequence: Number(id.slice(last.prefix.length)) };
    }
    const match = /^(.*?)(\d{1,15})$/.exec(id);
    if (!match || String(Number(match[2])) !== match[2]) return undefined;
    const index = create ? this.rememberPrefix(match[1], sourceId) : this.prefixIndex.get(`${match[1]}\u0000${sourceId}`);
    if (index === undefined) return undefined;
    if (create) {
      // Only a prefix not ending in a digit can be matched by `startsWith` alone: the regular expression takes all trailing digits it can.
      const end = match[1].charCodeAt(match[1].length - 1);
      this.lastPrefix = match[1] && !(end >= 48 && end <= 57) ? { prefix: match[1], sourceId, index } : undefined;
    }
    return { prefix: index, sequence: Number(match[2]) };
  }

  private rememberPrefix(prefix: string, sourceId: string): number {
    const key = `${prefix}\u0000${sourceId}`; let index = this.prefixIndex.get(key);
    if (index === undefined) {
      if (this.idPrefixes.length >= 0xffff) throw new Error('Too many frame sources in one log.');
      index = this.idPrefixes.length; this.idPrefixes.push({ prefix, sourceId }); this.prefixIndex.set(key, index);
    }
    return index;
  }

  /** `wait`: read as far as the page needs however long it takes (for copying rows), instead of a short time. */
  query(query: FramePageQuery, context?: FrameQueryContext, options?: { readonly wait?: boolean }): FramePage {
    const offset = Math.max(0, Math.floor(query.offset));
    const limit = Math.min(2000, Math.max(1, Math.floor(query.limit)));
    const needsContext = Boolean(query.filter?.search?.trim() || query.filter?.decoded !== undefined);
    const activeContext = needsContext ? context : undefined;
    const filterKey = `${JSON.stringify(query.filter ?? {})}:${activeContext?.cacheKey ?? ''}`;
    if (filterKey === '{}:') {
      // Leaving a filter drops it, so coming back to it reads it again rather than keeping a half-read result.
      this.cachedFilterKey = undefined; this.scan = undefined;
      const rows: CanFrame[] = [];
      for (let ordinal = offset; ordinal < Math.min(this.count, offset + limit); ordinal++) rows.push(this.frameAt(ordinal)!);
      return { rows, offset, total: this.count, generation: this.version };
    }
    if (filterKey !== this.cachedFilterKey) {
      this.cachedFilterKey = filterKey;
      this.cachedFilter = query.filter;
      this.cachedContext = activeContext;
      this.cachedSearchPattern = compileSearchPattern(query.filter);
      this.cachedMatches = new OrdinalIndex(); this.appendedMatches = new OrdinalIndex();
      this.scanLimit = this.count; this.scan = this.candidateOrdinals(query.filter)[Symbol.iterator]();
    }
    // Read only as far as this page needs, and for a short time: the rest is read by `continueScan`, so a search over a
    // large log never holds up the extension.
    this.advanceScan(offset + limit, options?.wait ? Infinity : performance.now() + QUERY_SCAN_MS);
    const rows: CanFrame[] = [];
    const end = Math.min(this.cachedMatches.length, offset + limit);
    for (let index = offset; index < end; index++) { const frame = this.frameAt(this.cachedMatches.at(index)!); if (frame) rows.push(frame); }
    return {
      rows, offset,
      total: this.cachedMatches.length, generation: this.version, complete: !this.scan,
    };
  }

  /** Applies the current filter to more frames, for about `budgetMs`; true once every frame has been read. */
  continueScan(budgetMs: number): boolean { this.advanceScan(Infinity, performance.now() + budgetMs); return !this.scan; }

  private advanceScan(needed: number, deadline: number): void {
    const scan = this.scan; if (!scan) return;
    let read = 0;
    while (this.cachedMatches.length < needed) {
      const next = scan.next();
      if (next.done || next.value >= this.scanLimit) {
        // Frames that arrived while reading were matched as they came; they follow every frame read here.
        for (const ordinal of this.appendedMatches.values()) this.cachedMatches.push(ordinal);
        this.appendedMatches = new OrdinalIndex(); this.scan = undefined; return;
      }
      const frame = this.frameAt(next.value);
      if (frame && matches(frame, this.cachedFilter, this.cachedContext, this.cachedSearchPattern)) this.cachedMatches.push(next.value);
      if (++read % 256 === 0 && performance.now() >= deadline) return;
    }
  }

  /** Number of frames matching exact standard/extended CAN references. */
  countByCanRefs(refs: readonly { readonly canId: number; readonly extended: boolean }[]): number {
    return this.canRefIndexesFor(refs).reduce((sum, index) => sum + index.length, 0);
  }

  /** Pages exact CAN-reference matches in original file order without scanning unrelated frames. */
  queryByCanRefs(refs: readonly { readonly canId: number; readonly extended: boolean }[], offset: number, limit: number): readonly CanFrame[] {
    const rows: CanFrame[] = []; const start = Math.max(0, Math.floor(offset)); const end = start + Math.max(1, Math.floor(limit)); let matchIndex = 0;
    for (const ordinal of mergeIndexes(this.canRefIndexesFor(refs))) {
      if (matchIndex >= end) break;
      if (matchIndex++ < start) continue;
      const frame = this.frameAt(ordinal); if (frame) rows.push(frame);
    }
    return rows;
  }

  /**
   * The frames holding the widest text of every RAW column among all frames matching `filter`.
   * Every frame is scanned, so a long value anywhere in the log is found. `contentCells` gives
   * the cell count of each form the CONTENT column can show (raw bytes, decoded signals).
   */
  widthCandidates(filter: FrameFilter | undefined, contentCells: (frame: CanFrame) => readonly number[], context?: FrameQueryContext): readonly CanFrame[] {
    return finishScan(this.widthScan(filter, contentCells, context));
  }

  /** `widthCandidates` in steps: yields every few thousand frames so a caller can let other work run on a large log. */
  *widthScan(filter: FrameFilter | undefined, contentCells: (frame: CanFrame, ordinal: number) => readonly number[], context?: FrameQueryContext): Generator<void, readonly CanFrame[]> {
    const searchPattern = compileSearchPattern(filter);
    const content = new WidestPicker<CanFrame>();
    // Name and CAN ID are fixed per CAN ID; direction, CH, DLC and LENGTH have only a few distinct values.
    const fixed = new Map<string, CanFrame>();
    const perId = new Map<number, CanFrame>();
    let first: CanFrame | undefined; let last: CanFrame | undefined; let scanned = 0;
    for (const ordinal of this.candidateOrdinals(filter)) {
      if (++scanned % SCAN_STEP === 0) yield;
      const frame = this.frameAt(ordinal); if (!frame) continue;
      if (!matches(frame, filter, context, searchPattern)) continue;
      if (!first || frame.timestamp < first.timestamp) first = frame;
      if (!last || frame.timestamp > last.timestamp) last = frame;
      const id = frame.extended ? -1 - frame.canId : frame.canId;
      if (!perId.has(id)) perId.set(id, frame);
      keepFirst(fixed, `d${frame.direction}`, frame); keepFirst(fixed, `c${frame.channel}`, frame); keepFirst(fixed, `l${frame.dlcCode}`, frame); keepFirst(fixed, `n${frame.dataLength}`, frame);
      const cells = contentCells(frame, ordinal);
      for (let form = 0; form < cells.length; form++) content.add(`${form}:${id}`, cells[form], frame);
    }
    const chosen = new Map<string, CanFrame>();
    for (const frame of [first, last, ...perId.values(), ...fixed.values(), ...content.items()]) if (frame) chosen.set(frame.id, frame);
    return Array.from(chosen.values());
  }

  adjacentTimestamp(timestamp: number, direction: -1 | 1, range?: { readonly start: number; readonly end: number }): number | undefined {
    if (this.timestampCacheGeneration !== this.version) {
      this.rebuildTimestampCache();
    }
    const timestamps = this.timestampCache;
    let index = direction < 0 ? lowerBound(timestamps, timestamp) - 1 : upperBound(timestamps, timestamp);
    if (range && direction < 0 && timestamps[index] > range.end) index = upperBound(timestamps, range.end) - 1;
    if (range && direction > 0 && timestamps[index] < range.start) index = lowerBound(timestamps, range.start);
    const candidate = timestamps[index];
    if (candidate === undefined || (range && (candidate < range.start || candidate > range.end))) return undefined;
    return candidate;
  }

  nearestTimestamp(timestamp: number, range?: { readonly start: number; readonly end: number }): number | undefined {
    if (!Number.isFinite(timestamp)) return undefined;
    if (this.timestampCacheGeneration !== this.version) {
      this.rebuildTimestampCache();
    }
    const start = range ? lowerBound(this.timestampCache, range.start) : 0;
    const end = range ? upperBound(this.timestampCache, range.end) : this.timestampCache.length;
    if (start >= end) return undefined;
    const afterIndex = Math.min(end - 1, Math.max(start, lowerBound(this.timestampCache, timestamp)));
    const beforeIndex = Math.max(start, afterIndex - 1); const before = this.timestampCache[beforeIndex]; const after = this.timestampCache[afterIndex];
    return Math.abs(timestamp - before) <= Math.abs(after - timestamp) ? before : after;
  }

  clear(): void {
    this.bounds = undefined;
    this.chunks.length = 0;
    this.count = 0;
    this.version++;
    this.cachedFilterKey = undefined;
    this.cachedFilter = undefined;
    this.cachedContext = undefined;
    this.cachedMatches = new OrdinalIndex();
    this.cachedSearchPattern = undefined; this.scan = undefined; this.appendedMatches = new OrdinalIndex();
    this.canRefIndexes.clear(); this.channelIndexes.clear(); this.directionIndexes.clear();
    this.timestampCacheGeneration = -1;
    this.timestampCache = new Float64Array();
    this.idPrefixes.length = 0; this.prefixIndex.clear(); this.otherIds.clear(); this.prefixOffsets = []; this.idOrdinals = undefined; this.lastPrefix = undefined;
  }

  private frameAt(ordinal: number): CanFrame | undefined {
    if (ordinal < 0 || ordinal >= this.count) return undefined;
    const chunk = this.chunks[Math.floor(ordinal / this.chunkSize)]; const at = ordinal % this.chunkSize;
    const prefixIndex = chunk.prefixes[at]; const flags = chunk.flags[at]; const offset = chunk.dataOffsets[at];
    const source = prefixIndex === 0xffff ? this.otherIds.get(ordinal)! : undefined; const prefix = source ? undefined : this.idPrefixes[prefixIndex];
    const frame: CanFrame = {
      id: source ? source.id : `${prefix!.prefix}${chunk.sequences[at]}`,
      sourceId: source ? source.sourceId : prefix!.sourceId,
      timestamp: chunk.timestamps[at], canId: chunk.canIds[at], extended: (flags & FLAG_EXTENDED) !== 0,
      direction: flags & FLAG_TX ? 'Tx' : 'Rx', channel: chunk.channels[at], dlcCode: chunk.dlcCodes[at], dataLength: chunk.lengths[at],
      data: chunk.data.subarray(offset, offset + chunk.payloadLengths[at]),
    };
    return frame;
  }

  private canRefIndexesFor(refs: readonly { readonly canId: number; readonly extended: boolean }[]): readonly OrdinalIndex[] {
    const unique = new Set(refs.map((ref) => canKey(ref.canId, ref.extended)));
    return [...unique].map((key) => this.canRefIndexes.get(key)).filter((index): index is OrdinalIndex => Boolean(index));
  }

  private candidateOrdinals(filter: FrameFilter | undefined): Iterable<number> {
    const constrained: OrdinalIndex[] = [];
    if (filter?.direction) { const index = this.directionIndexes.get(filter.direction); if (!index) return []; constrained.push(index); }
    if (filter?.channel !== undefined) { const index = this.channelIndexes.get(filter.channel); if (!index) return []; constrained.push(index); }
    const refs = filter?.canIdRefs?.length ? filter.canIdRefs : filter?.canIds?.flatMap((canId) => [{ canId, extended: false }, { canId, extended: true }]);
    const canIndexes = refs?.length ? this.canRefIndexesFor(refs) : [];
    if (refs?.length && !canIndexes.length) return [];
    const canCount = canIndexes.reduce((sum, index) => sum + index.length, 0);
    const narrowest = constrained.sort((left, right) => left.length - right.length)[0];
    if (narrowest && (!canIndexes.length || narrowest.length <= canCount)) return narrowest.values();
    if (canIndexes.length) return mergeIndexes(canIndexes);
    return allOrdinals(this.count);
  }

  private rebuildTimestampCache(): void {
    const timestamps = new Float64Array(this.count); let index = 0;
    for (const chunk of this.chunks) { timestamps.set(chunk.timestamps.subarray(0, chunk.length), index); index += chunk.length; }
    timestamps.sort(); this.timestampCache = timestamps; this.timestampCacheGeneration = this.version;
  }
}

function lowerBound(values: ArrayLike<number>, target: number): number { let low = 0; let high = values.length; while (low < high) { const middle = (low + high) >>> 1; if (values[middle] < target) low = middle + 1; else high = middle; } return low; }
function upperBound(values: ArrayLike<number>, target: number): number { let low = 0; let high = values.length; while (low < high) { const middle = (low + high) >>> 1; if (values[middle] <= target) low = middle + 1; else high = middle; } return low; }
function compileSearchPattern(filter: FrameFilter | undefined): RegExp | null | undefined { if (!filter?.searchRegex || !filter.search?.trim()) return undefined; try { return new RegExp(filter.search, 'i'); } catch { return null; } }
function canKey(canId: number, extended: boolean): string { return `${extended ? 'e' : 's'}:${canId}`; }
function appendIndex<K>(map: Map<K, OrdinalIndex>, key: K, ordinal: number): void { let index = map.get(key); if (!index) { index = new OrdinalIndex(); map.set(key, index); } index.push(ordinal); }
function* allOrdinals(count: number): IterableIterator<number> { for (let index = 0; index < count; index++) yield index; }

/** Stable k-way merge for independently append-sorted ordinal indexes. */
function* mergeIndexes(indexes: readonly OrdinalIndex[]): IterableIterator<number> {
  const heap: Array<{ value: number; index: number; position: number }> = [];
  for (let index = 0; index < indexes.length; index++) { const value = indexes[index].at(0); if (value !== undefined) heapPush(heap, { value, index, position: 0 }); }
  let previous = -1;
  while (heap.length) {
    const current = heapPop(heap)!; const nextPosition = current.position + 1; const next = indexes[current.index].at(nextPosition);
    if (next !== undefined) heapPush(heap, { value: next, index: current.index, position: nextPosition });
    if (current.value !== previous) { previous = current.value; yield current.value; }
  }
}

function heapPush<T extends { value: number }>(heap: T[], item: T): void {
  let index = heap.push(item) - 1;
  while (index > 0) { const parent = (index - 1) >>> 1; if (heap[parent].value <= item.value) break; heap[index] = heap[parent]; index = parent; }
  heap[index] = item;
}
function heapPop<T extends { value: number }>(heap: T[]): T | undefined {
  const first = heap[0]; const last = heap.pop(); if (!heap.length || !last) return first;
  let index = 0;
  while (true) {
    const left = index * 2 + 1; if (left >= heap.length) break;
    const right = left + 1; const child = right < heap.length && heap[right].value < heap[left].value ? right : left;
    if (heap[child].value >= last.value) break; heap[index] = heap[child]; index = child;
  }
  heap[index] = last; return first;
}

function keepFirst(map: Map<string, CanFrame>, key: string, frame: CanFrame): void { if (!map.has(key)) map.set(key, frame); }
