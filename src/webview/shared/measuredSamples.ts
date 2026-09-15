import type { SignalSample } from '../../core/signal/signal';
import type { MeasuredSignalDto } from '../../extension/editors/rawLogProtocol';

export interface MeasuredSampleQuery {
  readonly slot: string;
  readonly sourceId?: string;
  readonly timestamp: number;
  readonly signalIds: readonly string[];
}

/** One request in flight. Moving the cursor replaces queued work, never the displayed sample. */
export class MeasuredSamples {
  private desired = new Map<string, MeasuredSampleQuery>();
  private readonly results = new Map<string, { key: string; samples: readonly MeasuredSignalDto[] }>();
  private inFlight: { requestId: number; query: MeasuredSampleQuery; key: string; revision: number } | undefined;
  private counter = 0;
  private revision = 0;

  constructor(private readonly send: (requestId: number, query: MeasuredSampleQuery) => void, private readonly changed: () => void) {}

  update(queries: readonly MeasuredSampleQuery[]): void {
    this.desired = new Map(queries.map((query) => [query.slot, query]));
    for (const slot of this.results.keys()) if (!this.desired.has(slot)) this.results.delete(slot);
    this.pump();
  }

  sample(slot: string, signalId: string): SignalSample | undefined {
    const query = this.desired.get(slot); const result = this.results.get(slot);
    if (!query || result?.key !== queryKey(query)) return undefined;
    const sample = result.samples.find((item) => item.signalId === signalId)?.sample;
    return sample && Number.isFinite(sample.value) && (sample.quality === undefined || sample.quality === 'valid') ? sample : undefined;
  }

  ready(slot: string): boolean {
    const query = this.desired.get(slot);
    return !!query && this.results.get(slot)?.key === queryKey(query);
  }

  referenceTimestamp(slot: string): number | undefined {
    const query = this.desired.get(slot);
    if (!query || !this.ready(slot)) return undefined;
    return nearestMeasuredTimestamp(query.timestamp, this.results.get(slot)!.samples.filter((item) => Number.isFinite(item.sample.value) && (item.sample.quality === undefined || item.sample.quality === 'valid')).map((item) => item.sample.timestamp));
  }

  pendingMarkers(): boolean {
    return [...this.desired.values()].some((query) => query.slot.startsWith('marker:') && this.results.get(query.slot)?.key !== queryKey(query));
  }

  receive(requestId: number, samples: readonly MeasuredSignalDto[]): void {
    const request = this.inFlight; if (request?.requestId !== requestId) return;
    this.inFlight = undefined;
    const current = this.desired.get(request.query.slot);
    if (request.revision === this.revision && current && queryKey(current) === request.key) this.results.set(current.slot, { key: request.key, samples });
    this.pump(); this.changed();
  }

  invalidate(): void { this.revision++; this.results.clear(); }

  private pump(): void {
    if (this.inFlight) return;
    // Fixed markers take priority, so continuous mouse motion cannot delay image export.
    const queries = [...this.desired.values()].sort((a, b) => Number(b.slot.startsWith('marker:')) - Number(a.slot.startsWith('marker:')));
    const query = queries.find((item) => this.results.get(item.slot)?.key !== queryKey(item)); if (!query) return;
    const requestId = ++this.counter;
    this.inFlight = { requestId, query, key: queryKey(query), revision: this.revision };
    this.send(requestId, query);
  }
}

function queryKey(query: MeasuredSampleQuery): string { return JSON.stringify([query.sourceId, query.timestamp, query.signalIds]); }

export function nearestMeasuredTimestamp(reference: number, timestamps: readonly number[]): number | undefined {
  if (!Number.isFinite(reference)) return undefined;
  let best: number | undefined;
  for (const timestamp of timestamps) {
    if (!Number.isFinite(timestamp)) continue;
    if (best === undefined || Math.abs(timestamp - reference) < Math.abs(best - reference) || (Math.abs(timestamp - reference) === Math.abs(best - reference) && timestamp < best)) best = timestamp;
  }
  return best;
}

export function measuredValueLabel(label: string, sampleTimestamp: number, referenceTimestamp: number): string {
  const delta = sampleTimestamp - referenceTimestamp;
  if (!Number.isFinite(delta) || Math.abs(delta) < 1e-9) return label;
  const magnitude = Math.abs(delta);
  const [factor, unit] = magnitude >= 1 - 1e-9 ? [1, 's'] : magnitude >= .001 - 1e-9 ? [1000, 'ms'] : magnitude >= .000001 - 1e-9 ? [1e6, 'µs'] : [1e9, 'ns'];
  const value = Number((delta * Number(factor)).toPrecision(3));
  return `${label} @${value >= 0 ? '+' : ''}${value}${unit}`;
}
