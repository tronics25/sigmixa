/** Milliseconds: retain up to nanosecond resolution, suppress signed/float-noise zero. */
export function traceMilliseconds(value: number | undefined, signed = false): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  const rounded = Number(value.toFixed(6));
  const text = rounded.toFixed(6).replace(/(\.\d{3})0+$/, '$1').replace(/(\.\d{3,}?[1-9])0+$/, '$1');
  return signed && rounded > 0 ? `+${text}` : text;
}
