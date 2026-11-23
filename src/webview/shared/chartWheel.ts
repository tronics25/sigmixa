export type ChartWheelGesture =
  | { readonly kind: 'scroll' }
  | { readonly kind: 'pan'; readonly delta: number }
  | { readonly kind: 'zoom'; readonly delta: number };

export interface ChartWheelInput {
  readonly deltaX: number;
  readonly deltaY: number;
  readonly deltaMode: number;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}

/**
 * Keeps ordinary vertical scrolling available while the pointer is over a chart.
 * Horizontal gestures and Shift + wheel pan the time axis; modifier-wheel zooms.
 */
export function chartWheelGesture(event: ChartWheelInput, pageSize: number): ChartWheelGesture {
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? pageSize : 1;
  const deltaX = event.deltaX * unit;
  const deltaY = event.deltaY * unit;
  if (event.ctrlKey || event.metaKey) return { kind: 'zoom', delta: deltaY || deltaX };
  if (event.shiftKey) return { kind: 'pan', delta: Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : deltaY };
  if (Math.abs(deltaX) > Math.abs(deltaY)) return { kind: 'pan', delta: deltaX };
  return { kind: 'scroll' };
}

export interface WheelRange { readonly start: number; readonly end: number }

/**
 * How much one wheel event zooms: below 1 zooms in. A mouse wheel notch (a delta of about 100) is about 1.4 times;
 * the small deltas of a trackpad pinch add up to the same over the gesture, so the graph follows the fingers.
 */
export function wheelZoomFactor(delta: number): number {
  const bounded = Math.max(-240, Math.min(240, delta));
  return Math.exp(bounded * (Math.abs(delta) < 50 ? 0.01 : 0.0035));
}

/** The span shown after a wheel pan: the graph moves by the wheel's pixels, as if dragged, and stops at the ends. */
export function wheelPanRange(view: WheelRange, full: WheelRange, delta: number, plotWidth: number): WheelRange {
  const span = view.end - view.start; if (span >= full.end - full.start) return { start: full.start, end: full.end };
  let start = view.start + delta / Math.max(1, plotWidth) * span;
  start = Math.max(full.start, Math.min(start, full.end - span));
  return { start, end: start + span };
}
