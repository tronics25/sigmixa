import type { CanFrame } from './canFrame';
import { formatCanId } from './canId';

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
}

export interface FrameStore {
  readonly size: number;
  readonly generation: number;
  append(frames: readonly CanFrame[]): void;
  query(query: FramePageQuery, context?: FrameQueryContext): FramePage;
  representativeSample(filter: FrameFilter | undefined, maxRows: number, context?: FrameQueryContext): readonly CanFrame[];
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
    const idHex = formatCanId(frame.canId, frame.extended);
    const decoded = context?.isDecoded?.(frame) ?? false;
    const fields = [idHex, `0x${idHex}`, frame.canId.toString(16), ...(filter.searchContent !== 'decoded' || !decoded ? [bytesToHex(frame.data)] : []), context?.additionalSearchText?.(frame) ?? ''];
    if (filter.searchRegex) {
      if (!searchPattern || !fields.some((field) => searchPattern.test(field))) return false;
    } else if (!fields.some((field) => field.toLowerCase().includes(search))) return false;
  }
  return true;
}

export class ChunkedFrameStore implements FrameStore {
  private readonly chunks: CanFrame[][] = [];
  private count = 0;
  private version = 0;
  private cachedFilterKey: string | undefined;
  private cachedFilter: FrameFilter | undefined;
  private cachedContext: FrameQueryContext | undefined;
  private readonly canRefIndexes = new Map<string, OrdinalIndex>();
  private readonly channelIndexes = new Map<number, OrdinalIndex>();
  private readonly directionIndexes = new Map<CanFrame['direction'], OrdinalIndex>();
  private cachedMatches = new OrdinalIndex();
  private cachedSearchPattern: RegExp | null | undefined;
  private timestampCacheGeneration = -1;
  private timestampCache: Float64Array = new Float64Array();

  constructor(private readonly chunkSize = 4096) {
    if (!Number.isInteger(chunkSize) || chunkSize < 1) throw new Error('chunkSize must be a positive integer.');
  }

  get size(): number { return this.count; }
  get generation(): number { return this.version; }

  *frames(): IterableIterator<CanFrame> { for (const chunk of this.chunks) yield* chunk; }

  *framesByCanRefs(refs: readonly { readonly canId: number; readonly extended: boolean }[]): IterableIterator<CanFrame> {
    for (const ordinal of mergeIndexes(this.canRefIndexesFor(refs))) { const frame = this.frameAt(ordinal); if (frame) yield frame; }
  }

  append(frames: readonly CanFrame[]): void {
    for (const frame of frames) {
      const ordinal = this.count;
      let chunk = this.chunks[this.chunks.length - 1];
      if (!chunk || chunk.length >= this.chunkSize) {
        chunk = [];
        this.chunks.push(chunk);
      }
      chunk.push(frame);
      this.count++;
      appendIndex(this.canRefIndexes, canKey(frame.canId, frame.extended), ordinal);
      appendIndex(this.channelIndexes, frame.channel, ordinal);
      appendIndex(this.directionIndexes, frame.direction, ordinal);
      if (this.cachedFilterKey !== undefined && matches(frame, this.cachedFilter, this.cachedContext, this.cachedSearchPattern)) this.cachedMatches.push(ordinal);
    }
    if (frames.length) this.version++;
  }

  query(query: FramePageQuery, context?: FrameQueryContext): FramePage {
    const offset = Math.max(0, Math.floor(query.offset));
    const limit = Math.min(2000, Math.max(1, Math.floor(query.limit)));
    const needsContext = Boolean(query.filter?.search?.trim() || query.filter?.decoded !== undefined);
    const activeContext = needsContext ? context : undefined;
    const filterKey = `${JSON.stringify(query.filter ?? {})}:${activeContext?.cacheKey ?? ''}`;
    if (filterKey === '{}:') {
      const rows: CanFrame[] = [];
      let absolute = 0;
      for (const chunk of this.chunks) {
        const chunkEnd = absolute + chunk.length;
        if (chunkEnd <= offset) { absolute = chunkEnd; continue; }
        const from = Math.max(0, offset - absolute);
        rows.push(...chunk.slice(from, from + limit - rows.length));
        if (rows.length >= limit) break;
        absolute = chunkEnd;
      }
      return { rows, offset, total: this.count, generation: this.version };
    }
    if (filterKey !== this.cachedFilterKey) {
      this.cachedFilterKey = filterKey;
      this.cachedFilter = query.filter;
      this.cachedContext = activeContext;
      this.cachedSearchPattern = compileSearchPattern(query.filter);
      this.cachedMatches = new OrdinalIndex();
      for (const ordinal of this.candidateOrdinals(query.filter)) {
        const frame = this.frameAt(ordinal);
        if (frame && matches(frame, query.filter, activeContext, this.cachedSearchPattern)) this.cachedMatches.push(ordinal);
      }
    }
    const rows: CanFrame[] = [];
    const end = Math.min(this.cachedMatches.length, offset + limit);
    for (let index = offset; index < end; index++) { const frame = this.frameAt(this.cachedMatches.at(index)!); if (frame) rows.push(frame); }
    return {
      rows, offset,
      total: this.cachedMatches.length, generation: this.version,
    };
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

  representativeSample(filter: FrameFilter | undefined, maxRows: number, context?: FrameQueryContext): readonly CanFrame[] {
    const limit = Math.max(1, Math.floor(maxRows));
    const searchPattern = compileSearchPattern(filter);
    let total = 0;
    const longestById = new Map<string, CanFrame>();
    for (const ordinal of this.candidateOrdinals(filter)) {
      const frame = this.frameAt(ordinal); if (!frame) continue;
      if (!matches(frame, filter, context, searchPattern)) continue;
      total++;
      const key = `${frame.extended ? 'e' : 's'}:${frame.canId}`;
      const current = longestById.get(key);
      if (!current || frame.dataLength > current.dataLength) longestById.set(key, frame);
    }
    if (total === 0) return [];
    const chosen = new Map<string, CanFrame>();
    // Keep the sample bounded while reserving part of it for positions across the
    // full timeline, even when a trace contains more CAN IDs than the sample cap.
    const perIdBudget = limit <= 2 ? 0 : Math.min(longestById.size, Math.floor(limit * 0.75));
    const perId = Array.from(longestById.values()).slice(0, perIdBudget);
    for (const frame of perId) chosen.set(frame.id, frame);
    const remaining = Math.max(0, limit - chosen.size);
    if (remaining) {
      const targets = new Set<number>();
      for (let i = 0; i < remaining; i++) targets.add(Math.round(i * (total - 1) / Math.max(1, remaining - 1)));
      let matched = 0;
      for (const ordinal of this.candidateOrdinals(filter)) {
        const frame = this.frameAt(ordinal); if (!frame) continue;
        if (!matches(frame, filter, context, searchPattern)) continue;
        if (targets.has(matched)) chosen.set(frame.id, frame);
        matched++;
        if (chosen.size >= limit) break;
      }
    }
    return Array.from(chosen.values()).slice(0, limit);
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
    this.chunks.length = 0;
    this.count = 0;
    this.version++;
    this.cachedFilterKey = undefined;
    this.cachedFilter = undefined;
    this.cachedContext = undefined;
    this.cachedMatches = new OrdinalIndex();
    this.cachedSearchPattern = undefined;
    this.canRefIndexes.clear(); this.channelIndexes.clear(); this.directionIndexes.clear();
    this.timestampCacheGeneration = -1;
    this.timestampCache = new Float64Array();
  }

  private frameAt(ordinal: number): CanFrame | undefined {
    return this.chunks[Math.floor(ordinal / this.chunkSize)]?.[ordinal % this.chunkSize];
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
    for (const chunk of this.chunks) for (const frame of chunk) timestamps[index++] = frame.timestamp;
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
