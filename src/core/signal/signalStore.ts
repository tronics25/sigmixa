import type { SignalDefinition, SignalEvent, SignalSample, SignalSeries } from './signal';
import { sampleIndex, signalCellChange, type SignalCellChange } from './tableChanges';
import { downsampleEven, downsampleExtremes, nearestSample, nearestMeasuredSample, samplesInRange, samplesInRangeWithContext, type TimeRange } from '../timeline/timeline';

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

export interface SignalSeriesSlice extends SignalSeries {
  readonly totalSamplesInRange: number;
  readonly globalMinimum?: number;
  readonly globalMaximum?: number;
  readonly gaps: readonly SignalGap[];
}

export interface SignalGap {
  readonly startTimestamp: number;
  readonly endTimestamp: number;
}

interface MutableSeries {
  definition: SignalDefinition;
  samples: SignalSample[];
  events: SignalEvent[];
  minimum: number;
  maximum: number;
  minimumTimestamp: number;
  maximumTimestamp: number;
  sorted: boolean;
}

interface MutableSignalEventRow {
  readonly id: string;
  readonly timestamp: number;
  readonly values: Map<string, SignalSample>;
  readonly changes?: Readonly<Record<string, SignalCellChange>>;
}

export interface DecodedSignalSample {
  readonly definition: SignalDefinition;
  readonly sample: SignalSample;
}

export class InMemorySignalStore {
  private readonly series = new Map<string, MutableSeries>();
  private readonly rows: MutableSignalEventRow[] = [];
  private readonly rowsById = new Map<string, MutableSignalEventRow[]>();
  private version = 0;
  private tableCacheKey = '';
  private tableCacheSelection: readonly string[] = [];
  private tableCacheRange: TimeRange | undefined;
  private tableCache: SignalEventRow[] = [];
  private readonly tableCadence = new WeakMap<MutableSeries, { length: number; threshold: number }>();

  get generation(): number { return this.version; }
  get rowCount(): number { return this.rows.length; }

  registerDefinitions(definitions: readonly SignalDefinition[]): void {
    for (const definition of definitions) {
      const existing = this.series.get(definition.id);
      if (existing) existing.definition = definition;
      else this.series.set(definition.id, { definition, samples: [], events: [], minimum: Infinity, maximum: -Infinity, minimumTimestamp: Infinity, maximumTimestamp: -Infinity, sorted: true });
    }
    this.version++;
  }

  appendFrame(frameId: string, timestamp: number, decoded: readonly DecodedSignalSample[]): void {
    if (!decoded.length) return;
    const values = new Map<string, SignalSample>();
    for (const item of decoded) {
      let target = this.series.get(item.definition.id);
      if (!target) {
        target = { definition: item.definition, samples: [], events: [], minimum: Infinity, maximum: -Infinity, minimumTimestamp: Infinity, maximumTimestamp: -Infinity, sorted: true };
        this.series.set(item.definition.id, target);
      }
      const previous = target.samples[target.samples.length - 1];
      if (previous && previous.timestamp > item.sample.timestamp) target.sorted = false;
      target.samples.push(item.sample);
      if (isUsableSample(item.sample)) { target.minimum = Math.min(target.minimum, item.sample.value); target.maximum = Math.max(target.maximum, item.sample.value); }
      target.minimumTimestamp = Math.min(target.minimumTimestamp, item.sample.timestamp);
      target.maximumTimestamp = Math.max(target.maximumTimestamp, item.sample.timestamp);
      values.set(item.definition.id, item.sample);
    }
    const row = { id: frameId, timestamp, values }; this.rows.push(row);
    const indexed = this.rowsById.get(frameId) ?? []; indexed.push(row); this.rowsById.set(frameId, indexed);
    if (this.tableCacheSelection.length && this.rowMatches(row, this.tableCacheSelection)
      && (!this.tableCacheRange || (timestamp >= this.tableCacheRange.start && timestamp <= this.tableCacheRange.end))) this.tableCache.push(row);
    this.version++;
  }

  samplesForFrame(frameId: string): readonly { signalId: string; sample: SignalSample }[] {
    return (this.rowsById.get(frameId) ?? []).flatMap((row) => [...row.values].map(([signalId, sample]) => ({ signalId, sample })));
  }

  appendEvents(signalId: string, events: readonly SignalEvent[]): void {
    const target = this.series.get(signalId);
    if (!target) return;
    target.events.push(...events);
    this.version++;
  }

  appendSeries(definition: SignalDefinition, samples: readonly SignalSample[], events: readonly SignalEvent[] = []): void {
    this.registerDefinitions([definition]);
    const target = this.series.get(definition.id)!;
    for (const sample of samples) {
      const previous = target.samples[target.samples.length - 1]; if (previous && previous.timestamp > sample.timestamp) target.sorted = false;
      target.samples.push(sample); if (isUsableSample(sample)) { target.minimum = Math.min(target.minimum, sample.value); target.maximum = Math.max(target.maximum, sample.value); }
      target.minimumTimestamp = Math.min(target.minimumTimestamp, sample.timestamp); target.maximumTimestamp = Math.max(target.maximumTimestamp, sample.timestamp);
    }
    target.events.push(...events); this.version++;
  }

  /**
   * Atomically replaces a subset of decoded definitions with a separately-built
   * shard. This keeps unrelated series intact during incremental reanalysis.
   */
  replaceDefinitions(predicate: (definition: SignalDefinition) => boolean, replacement: InMemorySignalStore): void {
    const removed = new Set<string>();
    for (const [id, target] of this.series) if (predicate(target.definition)) { removed.add(id); this.series.delete(id); }
    if (removed.size) {
      for (let index = this.rows.length - 1; index >= 0; index--) {
        const row = this.rows[index]; for (const id of removed) row.values.delete(id);
        if (!row.values.size) {
          this.rows.splice(index, 1); const indexed = this.rowsById.get(row.id)?.filter((candidate) => candidate !== row) ?? [];
          if (indexed.length) this.rowsById.set(row.id, indexed); else this.rowsById.delete(row.id);
        }
      }
    }
    for (const [id, target] of replacement.series) this.series.set(id, {
      definition: target.definition, samples: [...target.samples], events: [...target.events],
      minimum: target.minimum, maximum: target.maximum, minimumTimestamp: target.minimumTimestamp,
      maximumTimestamp: target.maximumTimestamp, sorted: target.sorted,
    });
    for (const source of replacement.rows) {
      const existing = this.rowsById.get(source.id)?.find((row) => row.timestamp === source.timestamp) ?? this.rowsById.get(source.id)?.[0];
      if (existing) for (const [id, sample] of source.values) existing.values.set(id, sample);
      else {
        const row = { id: source.id, timestamp: source.timestamp, values: new Map(source.values) }; this.rows.push(row);
        const indexed = this.rowsById.get(row.id) ?? []; indexed.push(row); this.rowsById.set(row.id, indexed);
      }
    }
    this.rows.sort((left, right) => left.timestamp - right.timestamp);
    this.invalidateTableCache(); this.version++;
  }

  calculationSeries(): readonly { readonly definition: SignalDefinition; readonly samples: readonly SignalSample[] }[] {
    return [...this.series.values()].map((target) => { this.ensureSeriesSorted(target); return { definition: target.definition, samples: target.samples }; });
  }

  finalize(): void {
    for (const target of this.series.values()) {
      this.ensureSeriesSorted(target);
      target.events.sort((left, right) => left.timestamp - right.timestamp);
    }
    this.rows.sort((left, right) => left.timestamp - right.timestamp);
    this.invalidateTableCache();
    this.version++;
  }

  catalog(): readonly SignalDefinition[] { return Array.from(this.series.values(), (item) => item.definition); }

  /** The Signals this log has samples of; a definition alone does not count. */
  measuredSignalIds(): string[] { return Array.from(this.series.values()).filter((item) => item.samples.length > 0).map((item) => item.definition.id); }

  tablePage(selectedIds: readonly string[], offset: number, limit: number, range?: TimeRange): SignalTablePage {
    const selected = [...new Set(selectedIds)].sort();
    const key = JSON.stringify([selected, range]);
    if (key !== this.tableCacheKey) {
      this.tableCacheKey = key;
      this.tableCacheSelection = selected;
      this.tableCacheRange = range ? { ...range } : undefined;
      this.tableCache = selected.length ? this.rows.filter((row) => this.rowMatches(row, selected) && (!range || (row.timestamp >= range.start && row.timestamp <= range.end))) : [];
    }
    const safeOffset = Math.max(0, Math.floor(offset));
    const safeLimit = Math.max(1, Math.min(2000, Math.floor(limit)));
    return { offset: safeOffset, total: this.tableCache.length, rows: this.tableCache.slice(safeOffset, safeOffset + safeLimit), generation: this.version };
  }

  tableSample(selectedIds: readonly string[], limit = 300, range?: TimeRange): readonly SignalEventRow[] {
    this.tablePage(selectedIds, 0, 1, range);
    return downsampleEven(this.tableCache, limit);
  }

  /** Only bounded display pages carry metadata; stored rows and exports stay unchanged. */
  tableDisplayPage(selectedIds: readonly string[], offset: number, limit: number, range?: TimeRange): SignalTablePage {
    const page = this.tablePage(selectedIds, offset, limit, range);
    const selected = new Set(selectedIds);
    const hints = new Map<string, number>();
    return { ...page, rows: page.rows.map((row) => {
      const changes: Record<string, SignalCellChange> = Object.create(null);
      for (const [id, sample] of row.values) {
        if (!selected.has(id)) continue;
        const target = this.series.get(id); if (!target) continue;
        this.ensureSeriesSorted(target);
        const index = sampleIndex(target.samples, sample, hints.get(id));
        if (index < 0) continue;
        hints.set(id, index + 1);
        const previous = target.samples[index - 1];
        if (!previous || (range && previous.timestamp < range.start)) continue;
        let cadence = this.tableCadence.get(target);
        if (!cadence || cadence.length !== target.samples.length) {
          cadence = { length: target.samples.length, threshold: signalCadenceThreshold(target.samples) };
          this.tableCadence.set(target, cadence);
        }
        const change = signalCellChange(sample, previous, target.minimum, target.maximum, cadence.threshold);
        if (change) changes[id] = change;
      }
      return { ...row, changes };
    }) };
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
    const result: SignalSeriesSlice[] = [];
    const prepared = selectedIds.flatMap((id) => {
      const target = this.series.get(id);
      if (!target) return [];
      this.ensureSeriesSorted(target);
      const source = bounds ? withEdgeSamples(target.samples, bounds) : target.samples;
      const rendered = samplesInRangeWithContext(source, range);
      return [{ target, visible: samplesInRange(source, range), rendered, breaks: lineBreakSamples(rendered) }];
    });
    // Keep peaks, dips and break boundaries within the drawing budget. Gap metadata below still describes every break
    // even when there are too many boundaries to draw them all.
    const thin = (item: typeof prepared[number], limit: number) => downsampleExtremes(item.rendered, limit, (sample) => [sample.value], (sample) => item.breaks.has(sample));
    const times = joined ? new Set(prepared.flatMap((item) => thin(item, Math.floor(maxPoints / Math.max(1, prepared.length))).map((sample) => sample.timestamp))) : undefined;
    for (const { target, visible, rendered, breaks } of prepared) {
      result.push({
        definition: target.definition,
        samples: times ? downsampleEven(rendered.filter((sample) => times.has(sample.timestamp)), maxPoints) : thin({ target, visible, rendered, breaks }, maxPoints),
        events: range ? target.events.filter((event) => (event.endTimestamp ?? event.timestamp) >= range.start && event.timestamp <= range.end) : target.events,
        totalSamplesInRange: visible.length - (visible[0]?.carried ? 1 : 0),
        globalMinimum: Number.isFinite(target.minimum) ? target.minimum : undefined,
        globalMaximum: Number.isFinite(target.maximum) ? target.maximum : undefined,
        gaps: detectSignalGaps(rendered),
      });
    }
    return result;
  }

  nearest(selectedIds: readonly string[], timestamp: number, range?: TimeRange): readonly { definition: SignalDefinition; sample: SignalSample }[] {
    const result: { definition: SignalDefinition; sample: SignalSample }[] = [];
    for (const id of selectedIds) {
      const target = this.series.get(id); if (!target) continue; this.ensureSeriesSorted(target);
      const sample = nearestSample(target.samples, timestamp, range); if (sample) result.push({ definition: target.definition, sample });
    }
    return result;
  }

  measured(selectedIds: readonly string[], timestamp: number, range?: TimeRange): readonly { signalId: string; sample: SignalSample }[] {
    const result: { signalId: string; sample: SignalSample }[] = [];
    for (const id of new Set(selectedIds)) {
      const target = this.series.get(id); if (!target) continue; this.ensureSeriesSorted(target);
      const sample = nearestMeasuredSample(target.samples, timestamp, range);
      if (sample) result.push({ signalId: id, sample });
    }
    return result;
  }

  fullRange(selectedIds: readonly string[]): TimeRange | undefined {
    let start = Infinity; let end = -Infinity;
    for (const id of selectedIds) {
      const target = this.series.get(id);
      if (!target?.samples.length) continue;
      start = Math.min(start, target.minimumTimestamp);
      end = Math.max(end, target.maximumTimestamp);
    }
    return Number.isFinite(start) && Number.isFinite(end) ? { start, end } : undefined;
  }

  *eventRows(selectedIds: readonly string[], range?: TimeRange): Iterable<SignalEventRow> {
    const selected = [...new Set(selectedIds)];
    for (const row of this.rows) if (this.rowMatches(row, selected) && (!range || (row.timestamp >= range.start && row.timestamp <= range.end))) yield row;
  }

  private rowMatches(row: SignalEventRow, selectedIds: readonly string[]): boolean {
    return selectedIds.some((id) => row.values.has(id));
  }

  private invalidateTableCache(): void {
    this.tableCacheKey = ''; this.tableCacheSelection = []; this.tableCacheRange = undefined; this.tableCache = [];
  }

  private ensureSeriesSorted(target: MutableSeries): void {
    if (target.sorted) return;
    target.samples.sort((left, right) => left.timestamp - right.timestamp);
    target.sorted = true;
  }
}

const MAX_CADENCE_SAMPLES = 2048;
const MAX_REPORTED_GAPS = 2000;

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
    // The interior of one invalid interval adds no new break. Its boundaries are sufficient to represent it.
    if (!isUsableSample(previous) && !isUsableSample(current)) continue;
    if (isUsableSample(previous) && isUsableSample(current) && current.timestamp - previous.timestamp <= threshold) continue;
    kept.add(previous); kept.add(current);
  }
  if (!isUsableSample(samples[samples.length - 1])) kept.add(samples[samples.length - 1]);
  return kept;
}

function detectSignalGaps(samples: readonly SignalSample[]): readonly SignalGap[] {
  if (samples.length < 2) return [];
  const threshold = signalCadenceThreshold(samples);
  const gaps: SignalGap[] = [];
  for (let index = 1; index < samples.length; index++) {
    const previous = samples[index - 1]; const current = samples[index]; const delta = current.timestamp - previous.timestamp;
    if (isUsableSample(previous) && isUsableSample(current) && delta <= threshold) continue;
    const gap = { startTimestamp: previous.timestamp, endTimestamp: current.timestamp };
    const last = gaps.at(-1);
    if (last && gap.startTimestamp <= last.endTimestamp) gaps[gaps.length - 1] = { startTimestamp: last.startTimestamp, endTimestamp: Math.max(last.endTimestamp, gap.endTimestamp) };
    else if (gaps.length < MAX_REPORTED_GAPS) gaps.push(gap);
    else gaps[gaps.length - 1] = { startTimestamp: gaps.at(-1)!.startTimestamp, endTimestamp: gap.endTimestamp };
  }
  return gaps;
}

function isUsableSample(sample: SignalSample): boolean {
  return Number.isFinite(sample.timestamp) && Number.isFinite(sample.value) && (sample.quality === undefined || sample.quality === 'valid');
}

/**
 * The samples inside `bounds`, with the nearest sample outside each edge when none falls exactly on that edge:
 * the last one before `bounds.start` and the first one after `bounds.end`. Both keep their own time and value, so
 * the lines into and out of the Clip have their true slope; they are marked `carried` because they are not data of the Clip.
 */
function withEdgeSamples(samples: readonly SignalSample[], bounds: TimeRange): readonly SignalSample[] {
  const inside = samplesInRange(samples, bounds);
  const firstAtOrAfter = (time: number, inclusive: boolean) => { let low = 0; let high = samples.length; while (low < high) { const middle = (low + high) >> 1; if (samples[middle].timestamp < time || (!inclusive && samples[middle].timestamp === time)) low = middle + 1; else high = middle; } return low; };
  const before = inside[0]?.timestamp === bounds.start ? undefined : samples[firstAtOrAfter(bounds.start, true) - 1];
  const after = inside.at(-1)?.timestamp === bounds.end ? undefined : samples[firstAtOrAfter(bounds.end, false)];
  return [...(before ? [{ ...before, carried: true }] : []), ...inside, ...(after ? [{ ...after, carried: true }] : [])];
}
