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
