import type { SignalSample } from './signal';

export type SignalCellChange =
  | { readonly kind: 'numeric'; readonly magnitude: number; readonly delta: number }
  | { readonly kind: 'state'; readonly previousLabel: string }
  | { readonly kind: 'recovery' };

/** Compare original samples, never neighboring event rows or interpolated values. */
export function signalCellChange(
  current: SignalSample, previous: SignalSample | undefined,
  minimum: number, maximum: number, gapThreshold: number,
): SignalCellChange | undefined {
  if (!previous || !usable(current)) return undefined;
  if (!usable(previous) || current.timestamp - previous.timestamp > gapThreshold) return { kind: 'recovery' };
  if (current.value === previous.value && current.valueLabel === previous.valueLabel) return undefined;
  // Special labeled RAW values can coexist with ordinary numeric measurements.
  if (current.valueLabel !== undefined || previous.valueLabel !== undefined) {
    return { kind: 'state', previousLabel: previous.valueLabel ?? String(previous.value) };
  }
  const delta = current.value - previous.value;
  if (!Number.isFinite(delta) || maximum <= minimum) return undefined;
  // Normalize before subtraction to avoid overflowing a wide observed range.
  const divisor = Math.max(Math.abs(minimum), Math.abs(maximum), Number.MIN_VALUE);
  const range = maximum / divisor - minimum / divisor;
  const magnitude = Math.min(1, Math.abs(current.value / divisor - previous.value / divisor) / range);
  return Number.isFinite(magnitude) ? { kind: 'numeric', magnitude, delta } : undefined;
}

function usable(sample: SignalSample): boolean {
  return Number.isFinite(sample.timestamp) && Number.isFinite(sample.value)
    && (sample.quality === undefined || sample.quality === 'valid');
}

/** Identity disambiguates equal timestamps; a page-local hint handles dense duplicates. */
export function sampleIndex(samples: readonly SignalSample[], sample: SignalSample, hint?: number): number {
  if (hint !== undefined && samples[hint] === sample) return hint;
  let low = 0; let high = samples.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (samples[middle].timestamp < sample.timestamp) low = middle + 1;
    else high = middle;
  }
  while (low < samples.length && samples[low].timestamp === sample.timestamp) {
    if (samples[low] === sample) return low;
    low++;
  }
  return -1;
}
