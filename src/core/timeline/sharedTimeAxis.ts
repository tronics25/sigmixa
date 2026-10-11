export interface AxisRange { readonly start: number; readonly end: number }

/**
 * One time axis for several graphs. Each graph reports the span its own data covers; the axis spans all of them, and every
 * graph shows the same part of it, so zooming or scrolling one moves them all.
 */
export class SharedTimeAxis {
  private readonly own = new Map<string, AxisRange>();
  private readonly listeners = new Set<() => void>();
  private fullValue: AxisRange | undefined;
  private viewValue: AxisRange | undefined;

  /** Everything the graphs have, or undefined while none has data. */
  get full(): AxisRange | undefined { return this.fullValue; }
  /** The part shown. */
  get view(): AxisRange | undefined { return this.viewValue; }
  get zoomed(): boolean { const full = this.fullValue; const view = this.viewValue; return !!full && !!view && (Math.abs(view.start - full.start) > 1e-9 || Math.abs(view.end - full.end) > 1e-9); }
  /** False at the closest zoom: 0.5 % of the whole. */
  get canZoomIn(): boolean { const full = this.fullValue; const view = this.viewValue; return !!full && !!view && view.end - view.start > (full.end - full.start) * .005 + 1e-12; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  /** A graph's own span changed (undefined: it has no data, or is gone). The shown part keeps its place where it still fits. */
  report(id: string, range: AxisRange | undefined): void {
    const before = this.own.get(id);
    if (range ? before && Math.abs(before.start - range.start) <= 1e-12 && Math.abs(before.end - range.end) <= 1e-12 : !before) return;
    if (range) this.own.set(id, range); else this.own.delete(id);
    let full: AxisRange | undefined;
    for (const item of this.own.values()) full = full ? { start: Math.min(full.start, item.start), end: Math.max(full.end, item.end) } : item;
    const wasWhole = !this.zoomed;
    this.fullValue = full; this.viewValue = !full ? undefined : wasWhole ? full : reconcile(this.viewValue, full);
    this.notify();
  }

  setView(range: AxisRange): void { if (!this.fullValue || !(range.end > range.start)) return; this.viewValue = reconcile(range, this.fullValue); this.notify(); }
  reset(): void { if (!this.fullValue) return; this.viewValue = this.fullValue; this.notify(); }

  /** `factor` below 1 zooms in. The time at `center` (default: the middle) stays where it is on screen. */
  zoom(factor: number, center?: number): void {
    const full = this.fullValue; const view = this.viewValue; if (!full || !view) return;
    const fullSpan = full.end - full.start || 1; const current = view.end - view.start || fullSpan;
    const span = Math.max(fullSpan * .005, Math.min(fullSpan, current * factor)); const pivot = center ?? (view.start + view.end) / 2; const ratio = (pivot - view.start) / current;
    let start = pivot - span * ratio; let end = start + span;
    if (start < full.start) { start = full.start; end = start + span; } if (end > full.end) { end = full.end; start = end - span; }
    this.viewValue = { start, end }; this.notify();
  }

  /** Scrolls by 18 % of what is shown. */
  pan(direction: -1 | 1): void {
    const full = this.fullValue; const view = this.viewValue; if (!full || !view) return;
    const span = view.end - view.start; if (span >= full.end - full.start - 1e-12) return;
    let start = view.start + span * .18 * direction; let end = start + span;
    if (start < full.start) { start = full.start; end = start + span; } if (end > full.end) { end = full.end; start = end - span; }
    this.viewValue = { start, end }; this.notify();
  }

  private notify(): void { for (const listener of [...this.listeners]) listener(); }
}

function reconcile(view: AxisRange | undefined, full: AxisRange): AxisRange {
  if (!view) return full; const fullSpan = full.end - full.start; const span = Math.min(fullSpan, Math.max(0, view.end - view.start));
  if (span >= fullSpan || view.end < full.start || view.start > full.end) return full;
  const start = Math.max(full.start, Math.min(view.start, full.end - span)); return { start, end: start + span };
}
