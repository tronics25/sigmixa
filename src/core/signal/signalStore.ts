import type { SignalDefinition, SignalEvent, SignalSample } from './signal';
import { signalCellChange, type SignalCellChange } from './tableChanges';
import { finishScan, SCAN_STEP, textCells, WidestPicker } from '../frame/widestText';
import type { TimeRange } from '../timeline/timeline';
import { Column, F64Column, I32Column, stableOrder, U16Column, U32Column, U8Column } from '../storage/column';

export interface SignalEventRow {
  readonly id: string;
  readonly timestamp: number;
  readonly values: ReadonlyMap<string, SignalSample>;
  readonly changes?: Readonly<Record<string, SignalCellChange>>;
}

export interface SignalTablePage {
  readonly offset: number;
  readonly total: number;
  readonly rows: readonly SignalEventRow[];
  readonly generation: number;
}

export interface SignalSeriesSlice {
  readonly definition: SignalDefinition;
  readonly samples: readonly SignalSample[];
  readonly events?: readonly SignalEvent[];
  readonly totalSamplesInRange: number;
  readonly globalMinimum?: number;
  readonly globalMaximum?: number;
  readonly gaps: readonly SignalGap[];
}

export interface SignalGap {
  readonly startTimestamp: number;
  readonly endTimestamp: number;
}

export interface DecodedSignalSample {
  readonly definition: SignalDefinition;
  readonly sample: SignalSample;
}

/** A frame is named by its ordinal in the frame store (no text kept per frame) or, in small stores such as tests, by its ID. */
export type SignalFrameRef = string | number;

export interface SignalStoreOptions {
  /** The frame ID of a frame ordinal, for rows handed out. */
  readonly frameId?: (ordinal: number) => string | undefined;
}

/** No row: a sample that came without a frame (External CSV). */
const NO_ROW = 0xffffffff;
const QUALITIES = [undefined, 'valid', 'invalid', 'missing'] as const;
const qualityCode = (quality: SignalSample['quality']): number => quality === undefined ? 0 : quality === 'valid' ? 1 : quality === 'invalid' ? 2 : 3;

interface SampleExtras { readonly filterEvidence?: SignalSample['filterEvidence']; readonly originalTimestamp?: SignalSample['originalTimestamp'] }

/**
 * One Signal's samples, column by column. A sample's time is its frame's time unless it has its own (`times`), so most
 * samples need only their value, their row and, when some differ, their quality and state name.
 */
interface Series {
  definition: SignalDefinition;
  events: SignalEvent[];
  values: Column<Float64Array>;
  /** The row each sample came with (NO_ROW for none). */
  rows?: Column<Uint32Array>;
  /** Own sample times; made when a sample's time differs from its row's, or it has no row. */
  times?: Column<Float64Array>;
  /** Quality codes (QUALITIES); made when one differs from `quality`. */
  qualities?: Column<Uint8Array>; quality: number;
  /** State names, as the store's label number + 1 (0 = none). */
  labels?: Column<Uint32Array>;
  extras?: SampleExtrasColumn;
  minimum: number; maximum: number; minimumTimestamp: number; maximumTimestamp: number;
  sorted: boolean; lastTimestamp: number;
  /** `rows` never decreases, so a row's samples are found by binary search; otherwise through `rowOrder`. */
  rowsAscending: boolean; rowOrder?: Uint32Array;
  cadence?: { length: number; threshold: number };
  /** Per block of SUMMARY_BLOCK samples, made as the series grows (see `summaryOf`); dropped when samples are reordered. */
  summary?: BlockSummary;
}

/**
 * Of each full block of a series: its lowest and highest finite value (first one on ties, -1 for none), and the longest
 * time between neighbours inside it when all its samples are usable (NaN otherwise). Lets drawing a long range skip
 * blocks with no break, and take a block's extremes without reading it, with the same result as reading every sample.
 */
interface BlockSummary { blocks: number; low: Column<Int32Array>; high: Column<Int32Array>; maxDelta: Column<Float64Array> }
const SUMMARY_BLOCK = 64;

const newSeries = (definition: SignalDefinition): Series => ({
  definition, events: [], values: new F64Column(), quality: -1, minimum: Infinity, maximum: -Infinity, minimumTimestamp: Infinity, maximumTimestamp: -Infinity,
  sorted: true, lastTimestamp: -Infinity, rowsAscending: true,
});

interface RowEntry { readonly series: number; readonly sample: number }

/**
 * Signal values of a log. Everything is kept in typed arrays, so tens of millions of samples fit in memory; SignalSample
 * objects and rows are made only for what is handed out.
 */
export class InMemorySignalStore {
  private seriesList: Series[] = [];
  private seriesIndex = new Map<string, number>();
  // Rows (one per frame that gave values), with the Signals of each row (CSR: refStart..next row's refStart).
  private rowTimes = new F64Column();
  private rowKeys = new I32Column();
  private refStart = new U32Column();
  private refSeries: Column<Uint16Array> | Column<Uint32Array> = new U16Column();
  private rowsSorted = true; private lastRowTime = -Infinity;
  /** Row + 1 of each frame ordinal (0 = none); further rows of a frame and rows of string IDs are in `moreRows`. */
  private rowOfOrdinal = new I32Column();
  private moreRows = new Map<number, number[]>();
  // String frame IDs get negative keys.
  private stringKeys = new Map<string, number>(); private stringIds: string[] = [];
  private labelNumbers = new Map<string, number>(); private labelTexts: string[] = [];
  private version = 0;
  private layoutVersion = 0;
  private tableCacheKey = '';
  private tableCacheSelection: Uint8Array | undefined;
  /** The Signal IDs the Table's rows were picked for, so a Signal that appears later joins its selection. */
  private tableCacheIds?: ReadonlySet<string>;
  private tableCacheRange: TimeRange | undefined;
  private tableCache = new U32Column();

  constructor(private readonly options: SignalStoreOptions = {}) {}

  get generation(): number { return this.version; }
  /** Advanced whenever stored samples or rows are reordered (not when more are added), so a reader working in steps knows its sample numbers no longer hold. */
  get layout(): number { return this.layoutVersion; }

  /**
   * Makes room for about `rows` rows holding `refs` samples in all, so a large log does not copy its row columns again
   * and again as they grow (each copy of a column of tens of millions of entries pauses everything for a moment).
   */
  reserveRows(rows: number, refs: number): void {
    const count = Math.ceil(rows); const total = Math.ceil(refs);
    this.rowTimes.reserve(count); this.rowKeys.reserve(count); this.refStart.reserve(count); this.rowOfOrdinal.reserve(count); this.refSeries.reserve(total);
  }
  get rowCount(): number { return this.rowTimes.n; }
  /** Samples held by all rows together. */
  get refCount(): number { return this.refSeries.n; }

  registerDefinitions(definitions: readonly SignalDefinition[]): void {
    for (const definition of definitions) {
      const index = this.seriesIndex.get(definition.id);
      if (index !== undefined) this.seriesList[index].definition = definition;
      else this.addSeries(newSeries(definition));
    }
    this.version++;
  }

  appendFrame(frame: SignalFrameRef, timestamp: number, decoded: readonly DecodedSignalSample[]): void {
    if (!decoded.length) return;
    const row = this.rowTimes.n; const key = this.keyOf(frame);
    this.rowTimes.push(timestamp); this.rowKeys.push(key); this.refStart.push(this.refSeries.n);
    if (this.rowsSorted && timestamp < this.lastRowTime) this.rowsSorted = false;
    if (timestamp > this.lastRowTime) this.lastRowTime = timestamp;
    this.indexRow(key, row);
    for (const item of decoded) {
      let index = this.seriesIndex.get(item.definition.id);
      if (index === undefined) index = this.addSeries(newSeries(item.definition));
      this.pushRef(index);
      this.pushSample(this.seriesList[index], item.sample, row, timestamp);
    }
    if (this.tableCacheSelection && this.rowMatches(row, this.tableCacheSelection)
      && (!this.tableCacheRange || (timestamp >= this.tableCacheRange.start && timestamp <= this.tableCacheRange.end))) this.tableCache.push(row);
    this.version++;
  }

  samplesForFrame(frame: SignalFrameRef): readonly { signalId: string; sample: SignalSample }[] {
    const key = this.existingKey(frame); if (key === undefined) return [];
    return this.rowsOfKey(key).flatMap((row) => this.rowEntries(row).map((entry) => ({ signalId: this.seriesList[entry.series].definition.id, sample: this.sampleAt(this.seriesList[entry.series], entry.sample) })));
  }

  appendEvents(signalId: string, events: readonly SignalEvent[]): void {
    const index = this.seriesIndex.get(signalId);
    if (index === undefined) return;
    this.seriesList[index].events.push(...events);
    this.version++;
  }

  appendSeries(definition: SignalDefinition, samples: readonly SignalSample[], events: readonly SignalEvent[] = []): void {
    this.registerDefinitions([definition]);
    const target = this.seriesList[this.seriesIndex.get(definition.id)!];
    for (const sample of samples) this.pushSample(target, sample, NO_ROW, Number.NaN);
    target.events.push(...events); this.version++;
  }

  /**
   * Atomically replaces a subset of decoded definitions with a separately-built
   * shard. This keeps unrelated series intact during incremental reanalysis.
   */
  replaceDefinitions(predicate: (definition: SignalDefinition) => boolean, replacement: InMemorySignalStore): void {
    const incoming = new Set(replacement.seriesList.map((target) => target.definition.id));
    // Old series index -> new index (-1 = removed); replacement series follow the kept ones.
    const oldToNew = new Int32Array(this.seriesList.length).fill(-1); const series: Series[] = [];
    this.seriesList.forEach((target, index) => { if (!predicate(target.definition) && !incoming.has(target.definition.id)) { oldToNew[index] = series.length; series.push(target); } });
    const replacementToNew = replacement.seriesList.map((target, index) => { series.push(replacement.cloneSeries(index, this)); return series.length - 1; });
    const oldRows = this.rowTimes.n; const newRows = replacement.rowTimes.n;
    // Kept Signals of each old row; a row left with none is dropped.
    const keptRefs = new Uint32Array(oldRows);
    for (let row = 0; row < oldRows; row++) { const end = this.refEnd(row); for (let ref = this.refStart.a[row]; ref < end; ref++) if (oldToNew[this.refSeries.a[ref]] >= 0) keptRefs[row]++; }
    // Each replacement row joins the old row of its frame (at the same time, else the first), or becomes a row of its own.
    const target = new Int32Array(newRows).fill(-1);
    for (let row = 0; row < newRows; row++) {
      const key = this.existingKey(replacement.frameRefOf(replacement.rowKeys.a[row])); if (key === undefined) continue;
      const candidates = this.rowsOfKey(key).filter((candidate) => keptRefs[candidate] > 0);
      target[row] = candidates.find((candidate) => this.rowTimes.a[candidate] === replacement.rowTimes.a[row]) ?? candidates[0] ?? -1;
    }
    const joined = new Map<number, number[]>();
    for (let row = 0; row < newRows; row++) if (target[row] >= 0) { const list = joined.get(target[row]) ?? []; list.push(row); joined.set(target[row], list); }
    // Merged rows: kept old rows in their order, then new rows; sorted by time, keeping that order for equal times.
    const order: number[] = [];
    for (let row = 0; row < oldRows; row++) if (keptRefs[row] > 0) order.push(row);
    for (let row = 0; row < newRows; row++) if (target[row] < 0) order.push(oldRows + row);
    const timeOf = (item: number) => item < oldRows ? this.rowTimes.a[item] : replacement.rowTimes.a[item - oldRows];
    order.sort((left, right) => timeOf(left) - timeOf(right) || left - right);
    const oldRowToNew = new Int32Array(oldRows).fill(-1); const newRowToMerged = new Int32Array(newRows).fill(-1);
    const rowTimes = new F64Column(order.length + 1); const rowKeys = new I32Column(order.length + 1); const refStart = new U32Column(order.length + 1);
    const refSeries: Column<Uint32Array> = new U32Column(this.refSeries.n + replacement.refSeries.n + 1);
    const copyRefs = (store: InMemorySignalStore, row: number, map: (index: number) => number) => {
      const end = store.refEnd(row); for (let ref = store.refStart.a[row]; ref < end; ref++) { const index = map(store.refSeries.a[ref]); if (index >= 0) refSeries.push(index); }
    };
    for (const item of order) {
      const merged = rowTimes.n; refStart.push(refSeries.n);
      if (item < oldRows) {
        rowTimes.push(this.rowTimes.a[item]); rowKeys.push(this.rowKeys.a[item]); oldRowToNew[item] = merged;
        copyRefs(this, item, (index) => oldToNew[index]);
        for (const row of joined.get(item) ?? []) { newRowToMerged[row] = merged; copyRefs(replacement, row, (index) => replacementToNew[index]); }
      } else {
        const row = item - oldRows; rowTimes.push(replacement.rowTimes.a[row]); rowKeys.push(this.keyOf(replacement.frameRefOf(replacement.rowKeys.a[row]))); newRowToMerged[row] = merged;
        copyRefs(replacement, row, (index) => replacementToNew[index]);
      }
    }
    for (let index = 0; index < series.length; index++) {
      const item = series[index]; if (!item.rows) continue;
      const fromReplacement = replacementToNew.includes(index);
      const map = fromReplacement ? newRowToMerged : oldRowToNew; const sourceTimes = fromReplacement ? replacement.rowTimes.a : this.rowTimes.a;
      // A sample that takes its time from its row keeps that time, even if it joined a row at another time.
      if (!item.times) for (let sample = 0; sample < item.values.n; sample++) {
        const row = item.rows.a[sample]; if (row !== NO_ROW && rowTimes.a[map[row]] !== sourceTimes[row]) { this.ownTimes(item, sourceTimes); break; }
      }
      for (let sample = 0; sample < item.values.n; sample++) { const row = item.rows.a[sample]; if (row !== NO_ROW) item.rows.a[sample] = map[row]; }
      this.checkRowsAscending(item);
    }
    this.seriesList = series; this.seriesIndex = new Map(series.map((item, index) => [item.definition.id, index]));
    this.rowTimes = rowTimes; this.rowKeys = rowKeys; this.refStart = refStart; this.refSeries = refSeries;
    this.rowsSorted = true; this.lastRowTime = rowTimes.n ? rowTimes.a[rowTimes.n - 1] : -Infinity;
    this.rebuildRowIndex(); this.invalidateTableCache(); this.version++; this.layoutVersion++;
  }

  calculationSeries(): readonly { readonly definition: SignalDefinition; readonly samples: readonly SignalSample[] }[] {
    return this.seriesList.map((target) => { this.ensureSeriesSorted(target); return { definition: target.definition, samples: this.samplesBetween(target, 0, target.values.n) }; });
  }

  /** Puts rows and samples in time order once all are in. `deferTrim`: the spare room is given back later, by `trimSteps`. */
  finalize(options: { readonly deferTrim?: boolean } = {}): void {
    const reordered = !this.rowsSorted;
    this.sortRows();
    for (const target of this.seriesList) {
      this.ensureSeriesSorted(target);
      target.events.sort((left, right) => left.timestamp - right.timestamp);
    }
    if (!options.deferTrim) finishScan(this.trimSteps());
    // The Table's rows stay valid unless the rows were put in time order just now.
    if (reordered) this.invalidateTableCache();
    this.version++;
  }

  /** Gives back the spare room of every column, one column per step: on a large log each is a large copy. */
  *trimSteps(): Generator<void, void> {
    for (const target of this.seriesList) for (const column of [target.values, target.rows, target.times, target.qualities, target.labels]) if (column) { column.trim(); yield; }
    for (const column of [this.rowTimes, this.rowKeys, this.refStart, this.refSeries]) { column.trim(); yield; }
  }

  catalog(): readonly SignalDefinition[] { return this.seriesList.map((item) => item.definition); }

  /** The Signals this log has samples of; a definition alone does not count. */
  measuredSignalIds(): string[] { return this.seriesList.filter((item) => item.values.n > 0).map((item) => item.definition.id); }

  tablePage(selectedIds: readonly string[], offset: number, limit: number, range?: TimeRange): SignalTablePage {
    this.prepareTable(selectedIds, range);
    const safeOffset = Math.max(0, Math.floor(offset));
    const safeLimit = Math.max(1, Math.min(2000, Math.floor(limit)));
    const rows: SignalEventRow[] = [];
    for (let index = safeOffset; index < Math.min(this.tableCache.n, safeOffset + safeLimit); index++) rows.push(this.rowAt(this.tableCache.a[index]));
    return { offset: safeOffset, total: this.tableCache.n, rows, generation: this.version };
  }

  tableSample(selectedIds: readonly string[], limit = 300, range?: TimeRange): readonly SignalEventRow[] {
    this.prepareTable(selectedIds, range);
    return evenPositions(this.tableCache.n, limit).map((position) => this.rowAt(this.tableCache.a[position]));
  }

  /**
   * The Table rows holding the widest text of each selected Signal column (value and state name)
   * and of the time column, found by scanning every row the Table shows.
   */
  tableWidthRows(selectedIds: readonly string[], range?: TimeRange): readonly SignalEventRow[] { return finishScan(this.tableWidthScan(selectedIds, range)); }

  /** `tableWidthRows` in steps: yields every few thousand rows so a caller can let other work run on a large log. */
  *tableWidthScan(selectedIds: readonly string[], range?: TimeRange): Generator<void, readonly SignalEventRow[]> {
    // Works from the Signals' own samples, not from the Table's row list, so another Table selection made between steps
    // does not disturb it: every row holding a sample of a selected Signal is a Table row, when it is in the range.
    // Rows or samples put in another order between steps (the log finished reading) change what row numbers mean: start again.
    const layout = this.layoutVersion; const ids = [...new Set(selectedIds)];
    const picker = new WidestPicker<number>();
    const valueCells = memoCells(tableValueText); const labelCells = memoCells(textCells);
    // The earliest and the latest Table row; of rows with the same time, the first one, as the Table lists them.
    let first = -1; let last = -1;
    // Samples already looked at, per Signal. A pass looks at the samples added since, including Signals that got their first
    // sample meanwhile; passes repeat while the log grows, and the last one, small, runs without stopping so nothing added
    // before the result is left out.
    const done = new Map<string, number>();
    for (let scanned = 0; ;) {
      const targets = ids.flatMap((id) => {
        const index = this.seriesIndex.get(id); const target = index === undefined ? undefined : this.seriesList[index];
        return target?.rows ? [{ id, target }] : [];
      });
      let pending = 0; for (const { id, target } of targets) pending += target.values.n - (done.get(id) ?? 0);
      if (!pending) break;
      const steps = pending >= SCAN_STEP;
      for (const { id, target } of targets) {
        for (let sample = done.get(id) ?? 0; sample < target.values.n; sample++) {
          if (steps && ++scanned >= SCAN_STEP) { scanned = 0; done.set(id, sample); yield; if (this.layoutVersion !== layout) return yield* this.tableWidthScan(selectedIds, range); }
          // Read again after a step: the arrays grow while the log is read.
          const rows = target.rows!.a; const row = rows[sample]; if (row === NO_ROW) continue;
          const time = this.rowTimes.a[row]; if (range && (time < range.start || time > range.end)) continue;
          if (first < 0 || time < this.rowTimes.a[first] || (time === this.rowTimes.a[first] && row < first)) first = row;
          if (last < 0 || time > this.rowTimes.a[last] || (time === this.rowTimes.a[last] && row < last)) last = row;
          // A row shows the last sample of a Signal it holds twice; the next sample of the row may not be read yet.
          if (target.rowsAscending ? sample + 1 < target.values.n && rows[sample + 1] === row : this.lastSampleOfRow(target, row) !== sample) continue;
          const label = target.labels?.a[sample] ? this.labelTexts[target.labels.a[sample] - 1] : undefined;
          picker.add(id, valueCells(target.values.a[sample]) + (label ? labelCells(label) + 3 : 0), row);
        }
        done.set(id, target.values.n);
      }
    }
    if (first < 0) return [];
    const chosen = new Set<number>([first, last, ...picker.items()]);
    return Array.from(chosen, (row) => this.rowAt(row));
  }

  /** Cell count of the decoded text the RAW log shows for one frame (`name=value unit (state)` per Signal); 0 when nothing is decoded. */
  /** Cell count of the frame-definition tags only; Plugin tags are counted by the caller from the tags it shows. */
  frameTextCells(frame: SignalFrameRef): number { return this.frameTextCounter()(frame); }

  /** `frameTextCells` for many frames: names, values and state names already counted are reused. */
  frameTextCounter(): (frame: SignalFrameRef) => number {
    const nameCells = new Map<number, number>(); const valueCells = memoCells(decodedValueText); const labelCells = memoCells(textCells);
    // Frames are mostly asked in order, so each Signal's next sample is usually just after the last one found.
    const cursors = new Float64Array(this.seriesList.length);
    return (frame) => {
      const key = this.existingKey(frame); if (key === undefined) return 0;
      let cells = 0;
      // Each Signal of each row once (its last sample in the row), as `rowEntries` gives them, without making the entries.
      const countRow = (row: number): void => {
        const start = this.refStart.a[row]; const end = this.refEnd(row); const refs = this.refSeries.a;
        for (let ref = start; ref < end; ref++) {
          const series = refs[ref]; let repeated = false;
          for (let earlier = start; earlier < ref && !repeated; earlier++) repeated = refs[earlier] === series;
          if (repeated) continue;
          const target = this.seriesList[series];
          // Plugin tags can repeat a Signal within one frame, so the store cannot spell them; the caller counts them.
          if (target.definition.source.type === 'plugin') continue;
          const sample = this.sampleOfRowFrom(target, row, cursors, series); if (sample < 0) continue;
          let fixed = nameCells.get(series);
          if (fixed === undefined) {
            const definition = target.definition;
            // `name=` and ` unit`, plus the separator and chip padding the RAW screen draws around each tag.
            fixed = textCells(definition.name) + 1 + (definition.unit ? textCells(definition.unit) + 1 : 0) + 7; nameCells.set(series, fixed);
          }
          const label = this.labelOf(target, sample);
          cells += fixed + valueCells(target.values.a[sample]) + (label ? labelCells(label) + 3 : 0);
        }
      };
      const first = key >= 0 && key < this.rowOfOrdinal.n ? this.rowOfOrdinal.a[key] - 1 : -1;
      if (first >= 0) countRow(first);
      const more = this.moreRows.get(key); if (more) for (const row of more) countRow(row);
      return cells;
    };
  }

  /** Only bounded display pages carry metadata; stored rows and exports stay unchanged. */
  tableDisplayPage(selectedIds: readonly string[], offset: number, limit: number, range?: TimeRange): SignalTablePage {
    const page = this.tablePage(selectedIds, offset, limit, range);
    const selected = new Set(selectedIds);
    // A sample's predecessor is the one before it in time, so the samples are put in time order first.
    for (const id of selected) { const index = this.seriesIndex.get(id); if (index !== undefined) this.ensureSeriesSorted(this.seriesList[index]); }
    const rows = page.rows.map((row, position) => {
      const changes: Record<string, SignalCellChange> = Object.create(null);
      for (const entry of this.rowEntries(this.tableCache.a[page.offset + position])) {
        const target = this.seriesList[entry.series]; const id = target.definition.id;
        if (!selected.has(id) || entry.sample === 0) continue;
        if (range && this.timeAt(target, entry.sample - 1) < range.start) continue;
        if (!target.cadence || target.cadence.length !== target.values.n) target.cadence = { length: target.values.n, threshold: this.cadenceThreshold(target, 0, target.values.n) };
        const change = signalCellChange(row.values.get(id)!, this.sampleAt(target, entry.sample - 1), target.minimum, target.maximum, target.cadence.threshold);
        if (change) changes[id] = change;
      }
      return { ...row, changes };
    });
    return { ...page, rows };
  }

  /**
   * `range` is the viewport: one sample on each side of it is kept so lines reach the edges.
   * `bounds` is a Clip's range. The nearest sample outside each edge of the Clip is still needed to draw the lines
   * into and out of it: both are returned with their own time and value, marked `carried`, and never counted as Clip data.
   */
  /**
   * `joined`: the Signals are put together by their times (the axes of a trajectory), so they are thinned together: a time
   * kept for one is kept for all, and a point never loses an axis.
   */
  seriesSlice(selectedIds: readonly string[], range: TimeRange | undefined, maxPoints: number, bounds?: TimeRange, joined = false): readonly SignalSeriesSlice[] {
    const prepared = selectedIds.flatMap((id) => {
      const index = this.seriesIndex.get(id); if (index === undefined) return [];
      const target = this.seriesList[index]; this.ensureSeriesSorted(target);
      // The samples drawn from: [from, to) of the series. With a Clip, the nearest sample outside each edge is carried along.
      let from = 0; let to = target.values.n; let carriedFirst = false; let carriedLast = false;
      if (bounds) {
        const inside = this.lowerBound(target, Math.min(bounds.start, bounds.end), 0, to); const insideEnd = this.upperBound(target, Math.max(bounds.start, bounds.end), 0, to);
        const hasInside = inside < insideEnd;
        carriedFirst = (!hasInside || this.timeAt(target, inside) !== bounds.start) && inside > 0;
        carriedLast = (!hasInside || this.timeAt(target, insideEnd - 1) !== bounds.end) && insideEnd < to;
        from = carriedFirst ? inside - 1 : inside; to = carriedLast ? insideEnd + 1 : insideEnd;
      }
      let visibleFrom = from; let visibleTo = to; let renderedFrom = from; let renderedTo = to;
      if (range) {
        visibleFrom = this.lowerBound(target, Math.min(range.start, range.end), from, to); visibleTo = this.upperBound(target, Math.max(range.start, range.end), from, to);
        renderedFrom = Math.max(from, visibleFrom - 1); renderedTo = Math.min(to, visibleTo + 1);
      }
      const threshold = this.cadenceThreshold(target, renderedFrom, renderedTo);
      return [{ target, from, to, carriedFirst, carriedLast, renderedFrom, renderedTo, threshold,
        total: visibleTo - visibleFrom - (visibleTo > visibleFrom && visibleFrom === from && carriedFirst ? 1 : 0) }];
    });
    // Keep peaks, dips and break boundaries within the drawing budget. Gap metadata below still describes every break
    // even when there are too many boundaries to draw them all.
    const thin = (item: typeof prepared[number], limit: number): number[] => {
      const length = item.renderedTo - item.renderedFrom;
      if (length <= Math.max(0, Math.floor(limit))) return range0(item.renderedFrom, item.renderedTo, Math.max(0, Math.floor(limit)) === 0 ? 0 : length);
      return this.thinExtremes(item.target, item.renderedFrom, item.renderedTo, limit, this.lineBreaks(item.target, item.renderedFrom, item.renderedTo, item.threshold));
    };
    const times = joined ? new Set(prepared.flatMap((item) => thin(item, Math.floor(maxPoints / Math.max(1, prepared.length))).map((index) => this.timeAt(item.target, index)))) : undefined;
    return prepared.map((item) => {
      const { target, renderedFrom, renderedTo } = item;
      let indexes: number[];
      if (times) {
        const shared: number[] = []; for (let index = renderedFrom; index < renderedTo; index++) if (times.has(this.timeAt(target, index))) shared.push(index);
        indexes = evenPositions(shared.length, maxPoints).map((position) => shared[position]);
      } else indexes = thin(item, maxPoints);
      const samples = indexes.map((index) => this.sampleAt(target, index, (index === item.from && item.carriedFirst) || (index === item.to - 1 && item.carriedLast)));
      return {
        definition: target.definition,
        samples,
        events: range ? target.events.filter((event) => (event.endTimestamp ?? event.timestamp) >= range.start && event.timestamp <= range.end) : target.events,
        totalSamplesInRange: item.total,
        globalMinimum: Number.isFinite(target.minimum) ? target.minimum : undefined,
        globalMaximum: Number.isFinite(target.maximum) ? target.maximum : undefined,
        gaps: this.gaps(target, renderedFrom, renderedTo, item.threshold, gapResolution(range, renderedTo > renderedFrom ? this.timeAt(target, renderedFrom) : undefined, renderedTo > renderedFrom ? this.timeAt(target, renderedTo - 1) : undefined, maxPoints)),
      };
    });
  }

  nearest(selectedIds: readonly string[], timestamp: number, range?: TimeRange): readonly { definition: SignalDefinition; sample: SignalSample }[] {
    const result: { definition: SignalDefinition; sample: SignalSample }[] = [];
    for (const id of selectedIds) {
      const index = this.seriesIndex.get(id); if (index === undefined) continue;
      const target = this.seriesList[index]; this.ensureSeriesSorted(target);
      const sample = this.nearestIndex(target, timestamp, range); if (sample >= 0) result.push({ definition: target.definition, sample: this.sampleAt(target, sample) });
    }
    return result;
  }

  measured(selectedIds: readonly string[], timestamp: number, range?: TimeRange): readonly { signalId: string; sample: SignalSample }[] {
    const result: { signalId: string; sample: SignalSample }[] = [];
    for (const id of new Set(selectedIds)) {
      const index = this.seriesIndex.get(id); if (index === undefined) continue;
      const target = this.seriesList[index]; this.ensureSeriesSorted(target);
      // Original sample only: never interpolate, extrapolate or skip over an invalid sample.
      const first = range ? this.lowerBound(target, Math.min(range.start, range.end), 0, target.values.n) : 0;
      const end = range ? this.upperBound(target, Math.max(range.start, range.end), 0, target.values.n) : target.values.n;
      if (first >= end || timestamp < this.timeAt(target, first) || timestamp > this.timeAt(target, end - 1)) continue;
      const sample = this.nearestIndex(target, timestamp, range);
      if (sample >= 0 && Number.isFinite(target.values.a[sample]) && this.qualityAt(target, sample) <= 1) result.push({ signalId: id, sample: this.sampleAt(target, sample) });
    }
    return result;
  }

  fullRange(selectedIds: readonly string[]): TimeRange | undefined {
    let start = Infinity; let end = -Infinity;
    for (const id of selectedIds) {
      const index = this.seriesIndex.get(id); if (index === undefined) continue;
      const target = this.seriesList[index]; if (!target.values.n) continue;
      start = Math.min(start, target.minimumTimestamp);
      end = Math.max(end, target.maximumTimestamp);
    }
    return Number.isFinite(start) && Number.isFinite(end) ? { start, end } : undefined;
  }

  *eventRows(selectedIds: readonly string[], range?: TimeRange): Iterable<SignalEventRow> {
    const selected = this.selectionMask(selectedIds);
    for (let row = 0; row < this.rowTimes.n; row++) if (this.rowMatches(row, selected) && (!range || (this.rowTimes.a[row] >= range.start && this.rowTimes.a[row] <= range.end))) yield this.rowAt(row);
  }

  /**
   * Every usable sample a frame shows (the last of a Signal a frame holds twice; finite, valid), Signal by Signal in time
   * order: `visit(signalId, sample, frameOrdinal, time)`. Lets an index be built without a sample object per frame.
   */
  usableFrameSamples(visit: (signalId: string, sample: number, frame: number, time: number) => void): void { finishScan(this.usableFrameSampleSteps(visit)); }

  /** `usableFrameSamples` in steps: yields every SCAN_STEP samples. */
  *usableFrameSampleSteps(visit: (signalId: string, sample: number, frame: number, time: number) => void): Generator<void, void> {
    let visited = 0;
    for (const target of this.seriesList) {
      this.ensureSeriesSorted(target); const rows = target.rows; if (!rows) continue;
      const id = target.definition.id; const values = target.values.a;
      for (let sample = 0; sample < target.values.n; sample++) {
        const row = rows.a[sample]; if (row === NO_ROW) continue;
        const key = this.rowKeys.a[row]; if (key < 0) continue;
        if (target.rowsAscending ? sample + 1 < target.values.n && rows.a[sample + 1] === row : this.lastSampleOfRow(target, row) !== sample) continue;
        const time = this.timeAt(target, sample);
        if (!Number.isFinite(time) || !Number.isFinite(values[sample]) || this.qualityAt(target, sample) > 1) continue;
        visit(id, sample, key, time);
        if (++visited % SCAN_STEP === 0) yield;
      }
    }
  }

  /** Sample `sample` of a Signal, when it still came with frame `frame` (see `usableFrameSamples`). */
  frameSample(signalId: string, sample: number, frame: number): SignalSample | undefined {
    const index = this.seriesIndex.get(signalId); if (index === undefined) return undefined;
    const target = this.seriesList[index]; if (sample >= target.values.n) return undefined;
    const row = target.rows?.a[sample]; if (row === undefined || row === NO_ROW || this.rowKeys.a[row] !== frame) return undefined;
    return this.sampleAt(target, sample);
  }

  // ---- rows ----

  private keyOf(frame: SignalFrameRef): number {
    if (typeof frame === 'number') { if (!Number.isInteger(frame) || frame < 0 || frame > 0x7fffffff) throw new Error('Frame ordinal out of range.'); return frame; }
    let key = this.stringKeys.get(frame);
    if (key === undefined) { this.stringIds.push(frame); key = -this.stringIds.length; this.stringKeys.set(frame, key); }
    return key;
  }

  private existingKey(frame: SignalFrameRef): number | undefined { return typeof frame === 'number' ? frame : this.stringKeys.get(frame); }

  /** The frame reference a row key stands for. */
  private frameRefOf(key: number): SignalFrameRef { return key >= 0 ? key : this.stringIds[-key - 1]; }

  private frameIdOf(key: number): string { return key >= 0 ? this.options.frameId?.(key) ?? String(key) : this.stringIds[-key - 1]; }

  private indexRow(key: number, row: number): void {
    if (key >= 0) {
      if (key >= this.rowOfOrdinal.n) this.rowOfOrdinal.fill(0, key + 1 - this.rowOfOrdinal.n);
      if (this.rowOfOrdinal.a[key] === 0) { this.rowOfOrdinal.a[key] = row + 1; return; }
    }
    const list = this.moreRows.get(key); if (list) list.push(row); else this.moreRows.set(key, [row]);
  }

  private rowsOfKey(key: number): number[] {
    const first = key >= 0 && key < this.rowOfOrdinal.n ? this.rowOfOrdinal.a[key] - 1 : -1;
    const more = this.moreRows.get(key);
    return first >= 0 ? (more ? [first, ...more] : [first]) : (more ? [...more] : []);
  }

  private rebuildRowIndex(): void {
    this.rowOfOrdinal = new I32Column(); this.moreRows = new Map();
    for (let row = 0; row < this.rowTimes.n; row++) this.indexRow(this.rowKeys.a[row], row);
  }

  private refEnd(row: number): number { return row + 1 < this.refStart.n ? this.refStart.a[row + 1] : this.refSeries.n; }

  private pushRef(index: number): void {
    if (index > 0xffff && this.refSeries.a instanceof Uint16Array) {
      const wide = new U32Column(this.refSeries.a.length); wide.a.set(this.refSeries.a.subarray(0, this.refSeries.n)); wide.n = this.refSeries.n; this.refSeries = wide;
    }
    this.refSeries.push(index);
  }

  /** The Signals of a row and the sample of each (the last, when the row holds a Signal twice), in the order they came. */
  private rowEntries(row: number): RowEntry[] {
    const entries: RowEntry[] = []; const seen = new Map<number, number>();
    const end = this.refEnd(row);
    for (let ref = this.refStart.a[row]; ref < end; ref++) {
      const series = this.refSeries.a[ref]; if (seen.has(series)) continue;
      const sample = this.lastSampleOfRow(this.seriesList[series], row); if (sample < 0) continue;
      seen.set(series, entries.length); entries.push({ series, sample });
    }
    return entries;
  }

  private rowAt(row: number): SignalEventRow {
    const values = new Map<string, SignalSample>();
    for (const entry of this.rowEntries(row)) { const target = this.seriesList[entry.series]; values.set(target.definition.id, this.sampleAt(target, entry.sample)); }
    return { id: this.frameIdOf(this.rowKeys.a[row]), timestamp: this.rowTimes.a[row], values };
  }

  /** `lastSampleOfRow`, searching forward from `cursors[series]` (and keeping it) when rows only grow, as in an in-order scan. */
  private sampleOfRowFrom(target: Series, row: number, cursors: Float64Array, series: number): number {
    const rows = target.rows; if (!rows) return -1;
    if (!target.rowsAscending || series >= cursors.length) return this.lastSampleOfRow(target, row);
    let index = cursors[series];
    if (index > 0 && rows.a[index - 1] > row) return this.lastSampleOfRow(target, row);
    // After the loop, index is the first sample past `row` (up to 64 steps; else a binary search finds it).
    for (let steps = 0; index < rows.n && rows.a[index] <= row; steps++) {
      if (steps === 64) { const found = this.lastSampleOfRow(target, row); cursors[series] = found >= 0 ? found + 1 : index; return found; }
      index++;
    }
    if (index < rows.n && rows.a[index] === NO_ROW) return this.lastSampleOfRow(target, row);
    cursors[series] = index;
    return index > 0 && rows.a[index - 1] === row ? index - 1 : -1;
  }

  private lastSampleOfRow(target: Series, row: number): number {
    const rows = target.rows; if (!rows) return -1;
    if (target.rowsAscending) {
      let low = 0; let high = rows.n;
      while (low < high) { const middle = (low + high) >>> 1; if (rows.a[middle] <= row) low = middle + 1; else high = middle; }
      return low > 0 && rows.a[low - 1] === row ? low - 1 : -1;
    }
    const order = target.rowOrder ??= stableOrder(rows.n, (left, right) => rows.a[left] - rows.a[right]);
    let low = 0; let high = order.length;
    while (low < high) { const middle = (low + high) >>> 1; if (rows.a[order[middle]] <= row) low = middle + 1; else high = middle; }
    return low > 0 && rows.a[order[low - 1]] === row ? order[low - 1] : -1;
  }

  private rowMatches(row: number, selected: Uint8Array): boolean {
    const end = this.refEnd(row);
    for (let ref = this.refStart.a[row]; ref < end; ref++) if (selected[this.refSeries.a[ref]]) return true;
    return false;
  }

  private selectionMask(selectedIds: readonly string[]): Uint8Array {
    const mask = new Uint8Array(this.seriesList.length);
    for (const id of selectedIds) { const index = this.seriesIndex.get(id); if (index !== undefined) mask[index] = 1; }
    return mask;
  }

  private prepareTable(selectedIds: readonly string[], range?: TimeRange): void {
    const selected = [...new Set(selectedIds)].sort();
    const key = JSON.stringify([selected, range]);
    if (key === this.tableCacheKey) return;
    this.tableCacheKey = key;
    this.tableCacheRange = range ? { ...range } : undefined;
    this.tableCache = new U32Column();
    if (!selected.length) { this.tableCacheSelection = undefined; return; }
    this.tableCacheIds = new Set(selected);
    const mask = this.tableCacheSelection = this.selectionMask(selected);
    for (let row = 0; row < this.rowTimes.n; row++) {
      const time = this.rowTimes.a[row];
      if (this.rowMatches(row, mask) && (!range || (time >= range.start && time <= range.end))) this.tableCache.push(row);
    }
  }

  private invalidateTableCache(): void {
    this.tableCacheKey = ''; this.tableCacheSelection = undefined; this.tableCacheIds = undefined; this.tableCacheRange = undefined; this.tableCache = new U32Column();
  }

  private sortRows(): void {
    if (this.rowsSorted) return;
    const count = this.rowTimes.n; const times = this.rowTimes.a;
    const order = stableOrder(count, (left, right) => times[left] - times[right]);
    const newIndex = new Uint32Array(count); for (let index = 0; index < count; index++) newIndex[order[index]] = index;
    const refStart = new U32Column(count + 1); const refSeries = this.refSeries.a instanceof Uint16Array ? new U16Column(this.refSeries.n + 1) : new U32Column(this.refSeries.n + 1);
    for (let index = 0; index < count; index++) {
      const row = order[index]; refStart.push(refSeries.n);
      const end = this.refEnd(row); for (let ref = this.refStart.a[row]; ref < end; ref++) refSeries.push(this.refSeries.a[ref]);
    }
    this.rowTimes.permute(order); this.rowKeys.permute(order); this.refStart = refStart; this.refSeries = refSeries;
    for (const target of this.seriesList) {
      if (!target.rows) continue;
      for (let sample = 0; sample < target.values.n; sample++) { const row = target.rows.a[sample]; if (row !== NO_ROW) target.rows.a[sample] = newIndex[row]; }
      this.checkRowsAscending(target);
    }
    this.rowsSorted = true; this.rebuildRowIndex(); this.layoutVersion++;
  }

  // ---- samples ----

  private addSeries(target: Series): number {
    const index = this.seriesList.length; this.seriesList.push(target); this.seriesIndex.set(target.definition.id, index);
    // A selected Signal seen for the first time (a Plugin's, say): its rows join the Table from now on; none came before.
    if (this.tableCacheSelection && this.tableCacheIds?.has(target.definition.id)) {
      const mask = new Uint8Array(this.seriesList.length); mask.set(this.tableCacheSelection.subarray(0, Math.min(mask.length, this.tableCacheSelection.length))); mask[index] = 1;
      this.tableCacheSelection = mask;
    }
    return index;
  }

  private pushSample(target: Series, sample: SignalSample, row: number, rowTime: number): void {
    const index = target.values.n;
    target.values.push(sample.value);
    if (row !== NO_ROW || target.rows) {
      if (!target.rows) { target.rows = new U32Column(Math.max(16, index + 1)); target.rows.fill(NO_ROW, index); }
      target.rows.push(row);
      if (target.rowsAscending && index > 0 && row !== NO_ROW && target.rows.a[index - 1] !== NO_ROW && target.rows.a[index - 1] > row) target.rowsAscending = false;
      target.rowOrder = undefined;
    }
    if (target.times) target.times.push(sample.timestamp);
    else if (row === NO_ROW || !Object.is(sample.timestamp, rowTime)) { this.ownTimes(target, this.rowTimes.a, index); target.times!.push(sample.timestamp); }
    const quality = qualityCode(sample.quality);
    if (target.quality < 0) target.quality = quality;
    if (target.qualities) target.qualities.push(quality);
    else if (quality !== target.quality) { target.qualities = new U8Column(Math.max(16, index + 1)); target.qualities.fill(target.quality, index); target.qualities.push(quality); }
    if (sample.valueLabel !== undefined || target.labels) {
      if (!target.labels) { target.labels = new U32Column(Math.max(16, index + 1)); target.labels.fill(0, index); }
      target.labels.push(sample.valueLabel === undefined ? 0 : this.labelNumber(sample.valueLabel) + 1);
    }
    if (sample.filterEvidence !== undefined || sample.originalTimestamp !== undefined || target.extras) {
      target.extras ??= new SampleExtrasColumn(index);
      target.extras.push(sample.filterEvidence, sample.originalTimestamp);
    }
    if (Number.isFinite(sample.timestamp) && Number.isFinite(sample.value) && quality <= 1) { if (sample.value < target.minimum) target.minimum = sample.value; if (sample.value > target.maximum) target.maximum = sample.value; }
    if (sample.timestamp < target.minimumTimestamp) target.minimumTimestamp = sample.timestamp;
    if (sample.timestamp > target.maximumTimestamp) target.maximumTimestamp = sample.timestamp;
    if (sample.timestamp < target.lastTimestamp) target.sorted = false;
    target.lastTimestamp = sample.timestamp;
    // Each full block is summarized as it fills, so drawing a long log never has to read it all at once.
    if (target.sorted && target.values.n % SUMMARY_BLOCK === 0) this.summaryOf(target);
  }

  /** Gives a series its own sample times, taken from the rows (`rowTimes`) of the first `count` samples. */
  private ownTimes(target: Series, rowTimes: Float64Array, count = target.values.n): void {
    const times = new F64Column(Math.max(16, count + 1));
    for (let index = 0; index < count; index++) { const row = target.rows?.a[index] ?? NO_ROW; times.push(row === NO_ROW ? Number.NaN : rowTimes[row]); }
    target.times = times;
  }

  private labelNumber(label: string): number {
    let number = this.labelNumbers.get(label);
    if (number === undefined) { number = this.labelTexts.length; this.labelTexts.push(label); this.labelNumbers.set(label, number); }
    return number;
  }

  private timeAt(target: Series, index: number): number { return target.times ? target.times.a[index] : this.rowTimes.a[target.rows!.a[index]]; }
  private qualityAt(target: Series, index: number): number { return target.qualities ? target.qualities.a[index] : target.quality; }
  private labelOf(target: Series, index: number): string | undefined { const number = target.labels?.a[index]; return number ? this.labelTexts[number - 1] : undefined; }
  private usable(target: Series, index: number): boolean { return Number.isFinite(this.timeAt(target, index)) && Number.isFinite(target.values.a[index]) && this.qualityAt(target, index) <= 1; }

  private sampleAt(target: Series, index: number, carried = false): SignalSample {
    const sample: { -readonly [K in keyof SignalSample]: SignalSample[K] } = { timestamp: this.timeAt(target, index), value: target.values.a[index] };
    const quality = QUALITIES[this.qualityAt(target, index)]; if (quality !== undefined) sample.quality = quality;
    const label = this.labelOf(target, index); if (label !== undefined) sample.valueLabel = label;
    const extras = target.extras?.at(index);
    if (extras?.filterEvidence !== undefined) sample.filterEvidence = extras.filterEvidence;
    if (extras?.originalTimestamp !== undefined) sample.originalTimestamp = extras.originalTimestamp;
    if (carried) sample.carried = true;
    return sample;
  }

  private samplesBetween(target: Series, from: number, to: number): SignalSample[] { const result: SignalSample[] = []; for (let index = from; index < to; index++) result.push(this.sampleAt(target, index)); return result; }

  /** A copy of a series for the store `into`, with its state names numbered there. */
  private cloneSeries(index: number, into: InMemorySignalStore): Series {
    const source = this.seriesList[index]; let labels: Column<Uint32Array> | undefined;
    if (source.labels) {
      labels = source.labels.clone(); const numbers = this.labelTexts.map((text) => into.labelNumber(text) + 1);
      for (let sample = 0; sample < labels.n; sample++) if (labels.a[sample]) labels.a[sample] = numbers[labels.a[sample] - 1];
    }
    return { ...source, events: [...source.events], values: source.values.clone(), rows: source.rows?.clone(), times: source.times?.clone(), qualities: source.qualities?.clone(),
      labels, extras: source.extras?.clone(), rowOrder: undefined, cadence: undefined, summary: undefined };
  }

  private checkRowsAscending(target: Series): void {
    target.rowOrder = undefined; target.rowsAscending = true; const rows = target.rows; if (!rows) return;
    let previous = -1;
    for (let index = 0; index < rows.n; index++) { const row = rows.a[index]; if (row === NO_ROW) continue; if (row < previous) { target.rowsAscending = false; return; } previous = row; }
  }

  private ensureSeriesSorted(target: Series): void {
    if (target.sorted) return;
    const order = stableOrder(target.values.n, (left, right) => this.timeAt(target, left) - this.timeAt(target, right));
    target.values.permute(order); target.rows?.permute(order); target.times?.permute(order); target.qualities?.permute(order); target.labels?.permute(order);
    target.extras?.permute(order);
    target.summary = undefined; this.layoutVersion++; target.sorted = true; target.lastTimestamp = target.values.n ? this.timeAt(target, target.values.n - 1) : -Infinity;
    this.checkRowsAscending(target);
  }

  private lowerBound(target: Series, timestamp: number, from: number, to: number): number {
    let low = from; let high = to;
    while (low < high) { const middle = (low + high) >>> 1; if (this.timeAt(target, middle) < timestamp) low = middle + 1; else high = middle; }
    return low;
  }

  private upperBound(target: Series, timestamp: number, from: number, to: number): number {
    let low = from; let high = to;
    while (low < high) { const middle = (low + high) >>> 1; if (this.timeAt(target, middle) <= timestamp) low = middle + 1; else high = middle; }
    return low;
  }

  private nearestIndex(target: Series, timestamp: number, range?: TimeRange): number {
    if (!target.values.n || !Number.isFinite(timestamp)) return -1;
    let low = range ? this.lowerBound(target, Math.min(range.start, range.end), 0, target.values.n) : 0;
    const end = range ? this.upperBound(target, Math.max(range.start, range.end), 0, target.values.n) : target.values.n;
    if (low >= end) return -1;
    let high = end - 1; const first = low;
    while (low < high) { const middle = Math.floor((low + high) / 2); if (this.timeAt(target, middle) < timestamp) low = middle + 1; else high = middle; }
    if (low === first) return first;
    return Math.abs(this.timeAt(target, low - 1) - timestamp) <= Math.abs(this.timeAt(target, low) - timestamp) ? low - 1 : low;
  }

  /** Four times the median interval between usable samples of [from, to), from up to 2048 evenly picked pairs; Infinity when unknown. */
  private cadenceThreshold(target: Series, from: number, to: number): number {
    const length = to - from; const deltas: number[] = [];
    const candidateCount = Math.min(MAX_CADENCE_SAMPLES, length - 1);
    for (let pair = 0; pair < candidateCount; pair++) {
      const index = from + 1 + Math.floor(pair * (length - 1) / candidateCount);
      const delta = this.timeAt(target, index) - this.timeAt(target, index - 1);
      if (this.usable(target, index - 1) && this.usable(target, index) && Number.isFinite(delta) && delta > 0) deltas.push(delta);
    }
    deltas.sort((left, right) => left - right);
    const median = deltas.length ? deltas[Math.floor(deltas.length / 2)] : undefined;
    return median === undefined ? Infinity : median * 4;
  }

  /** The summary of every full block of `target`, brought up to date. */
  private summaryOf(target: Series): BlockSummary {
    const summary = target.summary ??= { blocks: 0, low: new I32Column(), high: new I32Column(), maxDelta: new F64Column() };
    const full = Math.floor(target.values.n / SUMMARY_BLOCK); const values = target.values.a;
    for (let block = summary.blocks; block < full; block++) {
      const start = block * SUMMARY_BLOCK; const end = start + SUMMARY_BLOCK;
      let low = -1; let high = -1; let lowValue = 0; let highValue = 0; let maxDelta = 0; let allUsable = true; let previousTime = 0;
      for (let index = start; index < end; index++) {
        const value = values[index];
        if (Number.isFinite(value)) {
          if (low < 0 || value < lowValue) { low = index; lowValue = value; }
          if (high < 0 || value > highValue) { high = index; highValue = value; }
        }
        if (allUsable) {
          if (!this.usable(target, index)) allUsable = false;
          else { const time = this.timeAt(target, index); if (index > start && time - previousTime > maxDelta) maxDelta = time - previousTime; previousTime = time; }
        }
      }
      summary.low.push(low); summary.high.push(high); summary.maxDelta.push(allUsable ? maxDelta : Number.NaN);
    }
    summary.blocks = full;
    return summary;
  }

  /**
   * Visits, in order, each i in (from, to) where samples i-1 and i are not both usable within `threshold` of each other.
   * Blocks whose samples are all usable and close enough are skipped without reading them.
   */
  private forEachBreak(target: Series, from: number, to: number, threshold: number, visit: (index: number, previousUsable: boolean, usable: boolean) => void): void {
    const summary = this.summaryOf(target); const maxDelta = summary.maxDelta.a;
    for (let index = from + 1; index < to;) {
      // index - 1 is the first sample of a block: when the whole block lies in range and has no break, go to its last pair.
      if ((index - 1) % SUMMARY_BLOCK === 0) {
        const block = (index - 1) / SUMMARY_BLOCK;
        if (block < summary.blocks && index - 1 + SUMMARY_BLOCK <= to && maxDelta[block] <= threshold) { index = index - 1 + SUMMARY_BLOCK; continue; }
      }
      const previousUsable = this.usable(target, index - 1); const usable = this.usable(target, index);
      if (!(previousUsable && usable && this.timeAt(target, index) - this.timeAt(target, index - 1) <= threshold)) visit(index, previousUsable, usable);
      index++;
    }
  }

  /**
   * The samples on either side of a break in the line: a gap in reception (longer than the Signal's usual interval), or a
   * sample that is not a usable value. Thinning keeps them, so the line on each side of a break keeps its ends.
   * Their positions in [from, to), ascending.
   */
  private lineBreaks(target: Series, from: number, to: number, threshold: number): number[] {
    const kept: number[] = []; const length = to - from; if (length < 2) return kept;
    const mark = (position: number): void => { if (kept.length === 0 || kept[kept.length - 1] < position) kept.push(position); };
    if (!this.usable(target, from)) mark(0);
    // The interior of one invalid interval adds no new break. Its boundaries are sufficient to represent it.
    this.forEachBreak(target, from, to, threshold, (index, previousUsable, usable) => { if (previousUsable || usable) { mark(index - 1 - from); mark(index - from); } });
    if (!this.usable(target, to - 1)) mark(length - 1);
    return kept;
  }

  /**
   * Every break in the line (see `lineBreaks`). Breaks less than `resolution` apart are merged, which bounds the list by
   * the point budget without ever hiding a line longer than that.
   */
  private gaps(target: Series, from: number, to: number, threshold: number, resolution: number): SignalGap[] {
    const gaps: SignalGap[] = []; if (to - from < 2) return gaps;
    this.forEachBreak(target, from, to, threshold, (index) => {
      const previousTime = this.timeAt(target, index - 1); const time = this.timeAt(target, index);
      const last = gaps.at(-1);
      if (last && previousTime - last.endTimestamp <= resolution) gaps[gaps.length - 1] = { startTimestamp: last.startTimestamp, endTimestamp: Math.max(last.endTimestamp, time) };
      else gaps.push({ startTimestamp: previousTime, endTimestamp: time });
    });
    return gaps;
  }

  /**
   * Thins [from, to) without losing its shape: it is cut into equal runs, and of each run the first, the last, the lowest
   * and the highest are kept, plus the first and last break sample (`breaks`, by position) of each run. Kept samples are
   * the originals: their time and value are never changed.
   */
  private thinExtremes(target: Series, from: number, to: number, limit: number, breaks: readonly number[]): number[] {
    const count = Math.max(0, Math.floor(limit)); const length = to - from;
    if (count === 0 || length === 0) return [];
    if (length <= count) return range0(from, to, length);
    const perRun = 6;
    if (count < perRun) return evenPositions(length, count).map((position) => from + position);
    // A run keeps at most `perRun` samples, mostly fewer (one sample is often both the first and the lowest): start with the
    // runs that surely fit, then use more runs while the result stays within the limit.
    let runs = Math.floor(count / perRun); let best = this.extremesOfRuns(target, from, length, runs, breaks);
    for (let attempt = 0; attempt < 3 && best.length < count * 0.9; attempt++) {
      const next = Math.min(length, Math.floor(runs * count / Math.max(1, best.length))); if (next <= runs) break;
      const tried = this.extremesOfRuns(target, from, length, next, breaks); if (tried.length > count) break;
      runs = next; best = tried;
    }
    return best;
  }

  private extremesOfRuns(target: Series, from: number, length: number, runs: number, breaks: readonly number[]): number[] {
    const values = target.values.a; const result: number[] = []; const summary = this.summaryOf(target);
    const blockLow = summary.low.a; const blockHigh = summary.high.a; let nextBreak = 0;
    for (let run = 0; run < runs; run++) {
      const start = Math.floor(run * length / runs); const end = Math.floor((run + 1) * length / runs); if (end <= start) continue;
      let low = -1; let high = -1; let lowValue = 0; let highValue = 0; let firstKept = -1; let lastKept = -1;
      while (nextBreak < breaks.length && breaks[nextBreak] < start) nextBreak++;
      while (nextBreak < breaks.length && breaks[nextBreak] < end) { if (firstKept < 0) firstKept = breaks[nextBreak]; lastKept = breaks[nextBreak]; nextBreak++; }
      const consider = (position: number): void => {
        const value = values[from + position];
        if (low < 0 || value < lowValue) { low = position; lowValue = value; }
        if (high < 0 || value > highValue) { high = position; highValue = value; }
      };
      for (let position = start; position < end;) {
        const index = from + position;
        if (index % SUMMARY_BLOCK === 0 && index / SUMMARY_BLOCK < summary.blocks && position + SUMMARY_BLOCK <= end) {
          const block = index / SUMMARY_BLOCK;
          if (blockLow[block] >= 0) consider(blockLow[block] - from);
          if (blockHigh[block] >= 0) consider(blockHigh[block] - from);
          position += SUMMARY_BLOCK; continue;
        }
        if (Number.isFinite(values[index])) consider(position);
        position++;
      }
      for (const position of [...new Set([start, end - 1, firstKept, lastKept, low, high])].filter((value) => value >= 0).sort((a, b) => a - b)) result.push(from + position);
    }
    return result;
  }
}

const MAX_CADENCE_SAMPLES = 2048;

type FilterEvidence = NonNullable<SignalSample['filterEvidence']>;
const TWO_FIELDS = ['previousValue', 'deltaSeconds']; const FOUR_FIELDS = ['previousValue', 'deltaSeconds', 'sampleCount', 'sum'];
const sameKeys = (keys: string[], expected: string[]): boolean => keys.length === expected.length && keys.every((key, index) => key === expected[index]);
const numberOrUndefined = (value: unknown): boolean => value === undefined || typeof value === 'number';

/**
 * Filter evidence and original times of a series' samples. The evidence a filter gives every sample
 * (`{ previousValue, deltaSeconds }`, and with a moving average `sampleCount` and `sum`) is kept in number columns;
 * anything else is kept as given. A sample gets back what it came with, fields in the same order.
 */
class SampleExtrasColumn {
  /** 0 none, 1 two fields, 2 four fields, 3 kept in `other`; plus 4 / 8 / 16 when previousValue / sampleCount / sum is undefined. */
  private kinds: Column<Uint8Array> = new U8Column();
  private fields?: Column<Float64Array>[];
  private other = new Map<number, SampleExtras>();

  constructor(count = 0) { this.kinds.fill(0, count); }

  push(filterEvidence: SignalSample['filterEvidence'], originalTimestamp: SignalSample['originalTimestamp']): void {
    const index = this.kinds.n;
    if (filterEvidence === undefined && originalTimestamp === undefined) { this.fields?.forEach((column) => column.push(0)); this.kinds.push(0); return; }
    const keys = filterEvidence && originalTimestamp === undefined ? Object.keys(filterEvidence) : undefined;
    const four = keys !== undefined && sameKeys(keys, FOUR_FIELDS);
    const evidence = filterEvidence as FilterEvidence;
    if (keys && (four || sameKeys(keys, TWO_FIELDS)) && numberOrUndefined(evidence.previousValue) && typeof evidence.deltaSeconds === 'number'
      && (!four || (numberOrUndefined(evidence.sampleCount) && numberOrUndefined(evidence.sum)))) {
      const fields = this.fields ??= [0, 1, 2, 3].map(() => { const column = new F64Column(index + 16); column.fill(0, index); return column; });
      const values = [evidence.previousValue, evidence.deltaSeconds, evidence.sampleCount, evidence.sum];
      for (let field = 0; field < 4; field++) fields[field].push(values[field] ?? 0);
      this.kinds.push((four ? 2 : 1) | (evidence.previousValue === undefined ? 4 : 0) | (four && evidence.sampleCount === undefined ? 8 : 0) | (four && evidence.sum === undefined ? 16 : 0));
      return;
    }
    this.fields?.forEach((column) => column.push(0));
    this.other.set(index, { filterEvidence, originalTimestamp }); this.kinds.push(3);
  }

  at(index: number): SampleExtras | undefined {
    const kind = this.kinds.a[index]; const type = kind & 3;
    if (type === 0) return undefined;
    if (type === 3) return this.other.get(index);
    const fields = this.fields!; const previousValue = kind & 4 ? undefined : fields[0].a[index]; const deltaSeconds = fields[1].a[index];
    if (type === 1) return { filterEvidence: { previousValue, deltaSeconds } };
    return { filterEvidence: { previousValue, deltaSeconds, sampleCount: kind & 8 ? undefined : fields[2].a[index], sum: kind & 16 ? undefined : fields[3].a[index] } };
  }

  /** Position `index` gets what position `order[index]` had. */
  permute(order: Uint32Array): void {
    const moved = new Map<number, SampleExtras>(); const from = new Uint32Array(this.kinds.n);
    for (let index = 0; index < order.length; index++) from[order[index]] = index;
    for (const [index, extras] of this.other) moved.set(from[index], extras);
    this.kinds.permute(order); this.fields?.forEach((column) => column.permute(order)); this.other = moved;
  }

  clone(): SampleExtrasColumn {
    const copy = new SampleExtrasColumn(); copy.kinds = this.kinds.clone(); copy.fields = this.fields?.map((column) => column.clone()); copy.other = new Map(this.other);
    return copy;
  }
}

/** Positions 0..length-1 evenly picked down to `limit` (all when they fit). */
function evenPositions(length: number, limit: number): number[] {
  const count = Math.max(0, Math.floor(limit));
  if (count === 0 || length === 0) return [];
  if (length <= count) return range0(0, length, length);
  if (count === 1) return [0];
  const result: number[] = []; let previous = -1;
  for (let index = 0; index < count; index++) {
    const position = Math.round(index * (length - 1) / (count - 1));
    if (position !== previous) result.push(position);
    previous = position;
  }
  return result;
}

function range0(from: number, to: number, count: number): number[] { const result: number[] = []; for (let index = from; index < Math.min(to, from + count); index++) result.push(index); return result; }


/**
 * The samples on either side of a break in the line: a gap in reception (longer than the Signal's usual interval), or a
 * sample that is not a usable value. Thinning keeps them, so the line on each side of a break keeps its ends.
 */
export function lineBreakSamples(samples: readonly SignalSample[]): ReadonlySet<SignalSample> {
  const kept = new Set<SignalSample>(); if (samples.length < 2) return kept;
  const threshold = signalCadenceThreshold(samples);
  if (!isUsableSample(samples[0])) kept.add(samples[0]);
  for (let index = 1; index < samples.length; index++) {
    const previous = samples[index - 1]; const current = samples[index];
    if (!isUsableSample(previous) && !isUsableSample(current)) continue;
    if (isUsableSample(previous) && isUsableSample(current) && current.timestamp - previous.timestamp <= threshold) continue;
    kept.add(previous); kept.add(current);
  }
  if (!isUsableSample(samples[samples.length - 1])) kept.add(samples[samples.length - 1]);
  return kept;
}

function signalCadenceThreshold(samples: readonly SignalSample[]): number {
  const deltas: number[] = [];
  const candidateCount = Math.min(MAX_CADENCE_SAMPLES, samples.length - 1);
  for (let sampleIndex = 0; sampleIndex < candidateCount; sampleIndex++) {
    const index = 1 + Math.floor(sampleIndex * (samples.length - 1) / candidateCount);
    const previous = samples[index - 1]; const current = samples[index];
    const delta = current.timestamp - previous.timestamp;
    if (isUsableSample(previous) && isUsableSample(current) && Number.isFinite(delta) && delta > 0) deltas.push(delta);
  }
  deltas.sort((left, right) => left - right);
  const median = deltas.length ? deltas[Math.floor(deltas.length / 2)] : undefined;
  return median === undefined ? Infinity : median * 4;
}

function isUsableSample(sample: SignalSample): boolean {
  return Number.isFinite(sample.timestamp) && Number.isFinite(sample.value) && (sample.quality === undefined || sample.quality === 'valid');
}

/**
 * The finest time step the drawing can show: the span drawn over the point budget. Two breaks closer than this cannot be
 * told apart on screen, so they are reported as one; a zoomed view asks again and gets them separately. A report asks with
 * a budget of every sample, so there every break stays its own.
 */
function gapResolution(range: TimeRange | undefined, first: number | undefined, last: number | undefined, maxPoints: number): number {
  const start = range?.start ?? first ?? 0; const end = range?.end ?? last ?? 0;
  const span = end - start; return Number.isFinite(span) && span > 0 ? span / Math.max(1, maxPoints) : 0;
}

/** The value text the Table draws (nine significant digits). */
function tableValueText(value: number): string { return !Number.isFinite(value) ? '—' : Number.isInteger(value) ? String(value) : Number(value.toPrecision(9)).toString(); }
/** The value text the RAW log draws (twelve significant digits). */
function decodedValueText(value: number): string { return Number.isInteger(value) ? String(value) : Number(value.toPrecision(12)).toString(); }
/** Counts cells of `format(key)` once per distinct key; logs repeat the same values many times. */
function memoCells<K>(format: (key: K) => string): (key: K) => number;
function memoCells(format: (key: string) => number): (key: string) => number;
function memoCells<K>(format: (key: K) => string | number): (key: K) => number {
  let memo = new Map<K, number>();
  return (key) => {
    // Integers (most CAN values) are counted directly: digits plus the minus sign.
    if (typeof key === 'number' && Number.isSafeInteger(key)) return integerCells(key);
    let cells = memo.get(key);
    if (cells === undefined) {
      const text = format(key); cells = typeof text === 'number' ? text : textCells(text);
      if (memo.size >= 100_000) memo = new Map();
      memo.set(key, cells);
    }
    return cells;
  };
}
function integerCells(value: number): number {
  let cells = value < 0 ? 2 : 1; let rest = Math.abs(value);
  while (rest >= 10) { rest = Math.floor(rest / 10); cells++; }
  return cells;
}
