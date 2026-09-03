export type TimelineSource = 'timeSeries' | 'trajectory';
export class TimelineController {
  private timestampValue: number | undefined;
  private readonly listeners = new Set<(timestamp: number, source: TimelineSource) => void>();
  get timestamp(): number | undefined { return this.timestampValue; }
  set(timestamp: number, source: TimelineSource): void {
    if (!Number.isFinite(timestamp)) return; this.timestampValue = timestamp;
    for (const listener of this.listeners) listener(timestamp, source);
  }
  subscribe(listener: (timestamp: number, source: TimelineSource) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
}
