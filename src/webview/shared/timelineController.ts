import type { TimeRange } from '../../core/timeline/timeline';
export type TimelineSource = string;
type TimeListener = (timestamp: number | undefined, source: TimelineSource) => void;
export const SEEK_STEPS = 1_000_000;
/** Exact endpoints avoid floating point rounding just short of the final sample. */
export function seekTimestamp(value: number, range: TimeRange): number {
  if (value <= 0 || range.end === range.start) return range.start;
  if (value >= SEEK_STEPS) return range.end;
  return range.start + (range.end - range.start) * value / SEEK_STEPS;
}
export class TimelineController {
  private timestampValue: number | undefined;
  private readonly listeners = new Set<TimeListener>();
  private positionValue?: number;
  private positionVisibleValue = true;
  private readonly visibilityListeners = new Set<() => void>();
  get positionVisible(): boolean { return this.positionVisibleValue; }
  /**
   * The head of the Trace is the moment before the first frame of the log or Clip: nothing has been received yet
   * (a Clip only has the values carried from before it). Every view treats the head this way, for files and Clips alike.
   */
  get beforeFirstFrame(): boolean { return this.position !== undefined && !!this.boundsValue && this.position <= this.boundsValue.start; }
  setPositionVisible(visible: boolean): void {
    if (visible === this.positionVisibleValue) return;
    this.positionVisibleValue = visible; for (const listener of this.visibilityListeners) listener();
  }
  subscribePositionVisibility(listener: () => void): () => void { this.visibilityListeners.add(listener); return () => this.visibilityListeners.delete(listener); }

  private boundsValue?: TimeRange;
  private readonly positionListeners = new Set<TimeListener>();
  private hoverSource?: TimelineSource;
  private rangeValue?: TimeRange;
  private readonly rangeListeners = new Set<(range: TimeRange | undefined, source: TimelineSource) => void>();
  get bounds(): TimeRange | undefined { return this.boundsValue; }
  setBounds(range: TimeRange | undefined): void {
    this.boundsValue = range && Number.isFinite(range.start) && Number.isFinite(range.end) && range.start <= range.end ? { ...range } : undefined;
    this.setPosition(this.boundsValue ? this.positionValue ?? this.boundsValue.start : undefined, 'bounds');
  }
  get position(): number | undefined { return this.positionValue; }
  setPosition(timestamp: number | undefined, source: TimelineSource): void {
    if (timestamp !== undefined && !Number.isFinite(timestamp)) return;
    this.positionValue = timestamp === undefined ? undefined : this.boundsValue ? Math.max(this.boundsValue.start, Math.min(this.boundsValue.end, timestamp)) : timestamp;
    for (const listener of this.positionListeners) listener(this.positionValue, source);
  }
  subscribePosition(listener: TimeListener): () => void { this.positionListeners.add(listener); return () => this.positionListeners.delete(listener); }
  get range(): TimeRange | undefined { return this.rangeValue; }
  setRange(range: TimeRange | undefined, source: TimelineSource): void {
    if (range && (!Number.isFinite(range.start) || !Number.isFinite(range.end))) return;
    if (range?.start === this.rangeValue?.start && range?.end === this.rangeValue?.end) return;
    this.rangeValue = range && { start: Math.min(range.start, range.end), end: Math.max(range.start, range.end) };
    for (const listener of this.rangeListeners) listener(this.rangeValue, source);
  }
  subscribeRange(listener: (range: TimeRange | undefined, source: TimelineSource) => void): () => void { this.rangeListeners.add(listener); return () => this.rangeListeners.delete(listener); }
  private viewRangeValue?: TimeRange;
  private readonly viewRangeListeners = new Set<(range: TimeRange | undefined, source: TimelineSource) => void>();
  /** The time span every graph shows: one time axis for the whole log. Undefined means everything. */
  get viewRange(): TimeRange | undefined { return this.viewRangeValue; }
  setViewRange(range: TimeRange | undefined, source: TimelineSource): void {
    if (range && (!Number.isFinite(range.start) || !Number.isFinite(range.end) || !(range.end > range.start))) return;
    if (range?.start === this.viewRangeValue?.start && range?.end === this.viewRangeValue?.end) return;
    this.viewRangeValue = range && { ...range };
    for (const listener of this.viewRangeListeners) listener(this.viewRangeValue, source);
  }
  subscribeViewRange(listener: (range: TimeRange | undefined, source: TimelineSource) => void): () => void { this.viewRangeListeners.add(listener); return () => this.viewRangeListeners.delete(listener); }
  private clipRangesValue: readonly { readonly id: string; readonly name: string; readonly start: number; readonly end: number }[] = [];
  private readonly clipRangeListeners = new Set<() => void>();
  /** The Clips of the open log: every time-series graph marks their ranges. */
  get clipRanges(): readonly { readonly id: string; readonly name: string; readonly start: number; readonly end: number }[] { return this.clipRangesValue; }
  setClipRanges(clips: readonly { readonly id: string; readonly name: string; readonly start: number; readonly end: number }[]): void { this.clipRangesValue = clips.filter((clip) => Number.isFinite(clip.start) && Number.isFinite(clip.end) && clip.end > clip.start); for (const listener of this.clipRangeListeners) listener(); }
  subscribeClipRanges(listener: () => void): () => void { this.clipRangeListeners.add(listener); return () => this.clipRangeListeners.delete(listener); }
  get timestamp(): number | undefined { return this.timestampValue; }
  set(timestamp: number | undefined, source: TimelineSource): void {
    if (timestamp !== undefined && !Number.isFinite(timestamp)) return;
    if (timestamp === undefined && source !== this.hoverSource) return;
    this.hoverSource = timestamp === undefined ? undefined : source; this.timestampValue = timestamp;
    for (const listener of this.listeners) listener(timestamp, source);
  }
  subscribe(listener: TimeListener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
}
