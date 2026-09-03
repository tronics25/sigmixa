import type { SignalDefinition, SignalEvent, SignalSample, SignalSeries } from './signal';
import { downsampleEven, nearestSample, samplesInRange, type TimeRange } from '../timeline/timeline';

export interface SignalEventRow {
  readonly id: string;
  readonly timestamp: number;
  readonly values: ReadonlyMap<string, SignalSample>;
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

export interface DecodedSignalSample {
  readonly definition: SignalDefinition;
  readonly sample: SignalSample;
}

export class InMemorySignalStore {
  private readonly series = new Map<string, MutableSeries>();
  private readonly rows: SignalEventRow[] = [];
  private version = 0;
  private tableCacheKey = '';
  private tableCacheSelection: readonly string[] = [];
  private tableCache: SignalEventRow[] = [];

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
      target.minimum = Math.min(target.minimum, item.sample.value);
      target.maximum = Math.max(target.maximum, item.sample.value);
      target.minimumTimestamp = Math.min(target.minimumTimestamp, item.sample.timestamp);
      target.maximumTimestamp = Math.max(target.maximumTimestamp, item.sample.timestamp);
      values.set(item.definition.id, item.sample);
    }
    const row = { id: frameId, timestamp, values };
    this.rows.push(row);
    if (this.tableCacheSelection.length && this.rowMatches(row, this.tableCacheSelection)) this.tableCache.push(row);
    this.version++;
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
      target.samples.push(sample); target.minimum = Math.min(target.minimum, sample.value); target.maximum = Math.max(target.maximum, sample.value);
      target.minimumTimestamp = Math.min(target.minimumTimestamp, sample.timestamp); target.maximumTimestamp = Math.max(target.maximumTimestamp, sample.timestamp);
    }
    target.events.push(...events); this.version++;
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
    this.tableCacheKey = '';
    this.tableCacheSelection = [];
    this.tableCache = [];
    this.version++;
  }

  catalog(): readonly SignalDefinition[] { return Array.from(this.series.values(), (item) => item.definition); }

  tablePage(selectedIds: readonly string[], offset: number, limit: number): SignalTablePage {
    const selected = [...new Set(selectedIds)].sort();
    const key = JSON.stringify(selected);
    if (key !== this.tableCacheKey) {
      this.tableCacheKey = key;
      this.tableCacheSelection = selected;
      this.tableCache = selected.length ? this.rows.filter((row) => this.rowMatches(row, selected)) : [];
    }
    const safeOffset = Math.max(0, Math.floor(offset));
    const safeLimit = Math.max(1, Math.min(2000, Math.floor(limit)));
    return { offset: safeOffset, total: this.tableCache.length, rows: this.tableCache.slice(safeOffset, safeOffset + safeLimit), generation: this.version };
  }

  tableSample(selectedIds: readonly string[], limit = 300): readonly SignalEventRow[] {
    this.tablePage(selectedIds, 0, 1);
    return downsampleEven(this.tableCache, limit);
  }

  seriesSlice(selectedIds: readonly string[], range: TimeRange | undefined, maxPoints: number): readonly SignalSeriesSlice[] {
    const result: SignalSeriesSlice[] = [];
    for (const id of selectedIds) {
      const target = this.series.get(id);
      if (!target) continue;
      this.ensureSeriesSorted(target);
      const visible = samplesInRange(target.samples, range);
      result.push({
        definition: target.definition,
        samples: downsampleEven(visible, maxPoints),
        events: range ? target.events.filter((event) => (event.endTimestamp ?? event.timestamp) >= range.start && event.timestamp <= range.end) : target.events,
        totalSamplesInRange: visible.length,
        globalMinimum: Number.isFinite(target.minimum) ? target.minimum : undefined,
        globalMaximum: Number.isFinite(target.maximum) ? target.maximum : undefined,
      });
    }
    return result;
  }

  nearest(selectedIds: readonly string[], timestamp: number): readonly { definition: SignalDefinition; sample: SignalSample }[] {
    const result: { definition: SignalDefinition; sample: SignalSample }[] = [];
    for (const id of selectedIds) {
      const target = this.series.get(id); if (!target) continue; this.ensureSeriesSorted(target);
      const sample = nearestSample(target.samples, timestamp); if (sample) result.push({ definition: target.definition, sample });
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

  *eventRows(selectedIds: readonly string[]): Iterable<SignalEventRow> {
    const selected = [...new Set(selectedIds)];
    for (const row of this.rows) if (this.rowMatches(row, selected)) yield row;
  }

  private rowMatches(row: SignalEventRow, selectedIds: readonly string[]): boolean {
    return selectedIds.some((id) => row.values.has(id));
  }

  private ensureSeriesSorted(target: MutableSeries): void {
    if (target.sorted) return;
    target.samples.sort((left, right) => left.timestamp - right.timestamp);
    target.sorted = true;
  }
}
