import type { CanFrame } from './canFrame';
import { formatCanId } from './canId';

export interface FrameFilter {
  readonly search?: string;
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

const bytesToHex = (data: Uint8Array): string => Array.from(data, (byte) => byte.toString(16).padStart(2, '0')).join(' ');

function matches(frame: CanFrame, filter: FrameFilter | undefined, context?: FrameQueryContext): boolean {
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
    const haystack = `${idHex} 0x${idHex} ${frame.canId.toString(16)} ${bytesToHex(frame.data)} ${context?.additionalSearchText?.(frame) ?? ''}`.toLowerCase();
    if (!haystack.includes(search)) return false;
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
  private cachedMatches: CanFrame[] = [];

  constructor(private readonly chunkSize = 4096) {
    if (!Number.isInteger(chunkSize) || chunkSize < 1) throw new Error('chunkSize must be a positive integer.');
  }

  get size(): number { return this.count; }
  get generation(): number { return this.version; }

  append(frames: readonly CanFrame[]): void {
    for (const frame of frames) {
      let chunk = this.chunks[this.chunks.length - 1];
      if (!chunk || chunk.length >= this.chunkSize) {
        chunk = [];
        this.chunks.push(chunk);
      }
      chunk.push(frame);
      this.count++;
      if (this.cachedFilterKey !== undefined && matches(frame, this.cachedFilter, this.cachedContext)) this.cachedMatches.push(frame);
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
      this.cachedMatches = [];
      for (const chunk of this.chunks) for (const frame of chunk) if (matches(frame, query.filter, activeContext)) this.cachedMatches.push(frame);
    }
    return {
      rows: this.cachedMatches.slice(offset, offset + limit), offset,
      total: this.cachedMatches.length, generation: this.version,
    };
  }

  representativeSample(filter: FrameFilter | undefined, maxRows: number, context?: FrameQueryContext): readonly CanFrame[] {
    const limit = Math.max(1, Math.floor(maxRows));
    let total = 0;
    const longestById = new Map<string, CanFrame>();
    for (const chunk of this.chunks) {
      for (const frame of chunk) {
        if (!matches(frame, filter, context)) continue;
        total++;
        const key = `${frame.extended ? 'e' : 's'}:${frame.canId}`;
        const current = longestById.get(key);
        if (!current || frame.dataLength > current.dataLength) longestById.set(key, frame);
      }
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
      outer: for (const chunk of this.chunks) {
        for (const frame of chunk) {
          if (!matches(frame, filter, context)) continue;
          if (targets.has(matched)) chosen.set(frame.id, frame);
          matched++;
          if (chosen.size >= limit) break outer;
        }
      }
    }
    return Array.from(chosen.values()).slice(0, limit);
  }

  clear(): void {
    this.chunks.length = 0;
    this.count = 0;
    this.version++;
    this.cachedFilterKey = undefined;
    this.cachedFilter = undefined;
    this.cachedContext = undefined;
    this.cachedMatches = [];
  }
}
