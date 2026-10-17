/**
 * Lossless packing for the data of an HTML report: the file is smaller, and the report rebuilds exactly the same data
 * before it shows anything. Long arrays of samples and table columns are stored column by column, and a column as runs:
 * numbers that go up by the same step (equal values are a step of 0) as start, step and count; other repeated values as
 * one value and a count. A run only covers what it rebuilds exactly (the same arithmetic both ways), so nothing changes.
 */

/**
 * A number run is `[first, step, count, digits]`: the k-th value is `(first + k * step) / 10 ** digits`, with `first` and
 * `step` integers. Decimal values (timestamps such as 12.345) are integers over a power of ten, and dividing the integer
 * gives exactly the number the log's text was read as, so the arithmetic never drifts.
 */
type Run = number | readonly [number, number, number, number] | { readonly v?: unknown; readonly n: number };
export interface PackedRows { readonly '~rows': number; readonly cols: Readonly<Record<string, readonly Run[]>> }
export interface PackedColumn { readonly '~col': readonly Run[] }

const same = (a: unknown, b: unknown) => a === b || (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null && JSON.stringify(a) === JSON.stringify(b));
const SCALES = Array.from({ length: 10 }, (_, digits) => 10 ** digits);

/** The fewest decimal digits that give `value` back exactly as an integer over a power of ten (undefined: none do). */
function digitsOf(value: number): number | undefined {
  for (let digits = 0; digits < SCALES.length; digits++) {
    const scaled = Math.round(value * SCALES[digits]);
    if (Math.abs(scaled) <= Number.MAX_SAFE_INTEGER && scaled / SCALES[digits] === value) return digits;
  }
  return undefined;
}

export function packColumn(values: readonly unknown[]): Run[] {
  const runs: Run[] = []; let index = 0;
  while (index < values.length) {
    const first = values[index];
    const digits = typeof first === 'number' && Number.isFinite(first) ? digitsOf(first) : undefined;
    if (digits !== undefined) {
      // Integers over 10 ** d, for the d of the first value or the next one's, whichever is longer. A run is made only when
      // every value it holds, the first one too, comes back exactly with integers that are safe to compute with.
      const next = values[index + 1]; const nextDigits = typeof next === 'number' && Number.isFinite(next) ? digitsOf(next) : undefined;
      const d = Math.max(digits, nextDigits ?? 0); const scale = SCALES[d]; const start = Math.round((first as number) * scale);
      const valueAt = (k: number, step: number) => (start + k * step) / scale;
      const safe = (integer: number) => Math.abs(integer) <= Number.MAX_SAFE_INTEGER;
      let count = 1; let step = 0;
      if (nextDigits !== undefined && safe(start) && valueAt(0, 0) === first) {
        step = Math.round((next as number) * scale) - start;
        while (safe(step) && index + count < values.length && safe(start + count * step) && values[index + count] === valueAt(count, step)) count++;
      }
      runs.push(count === 1 ? first as number : [start, step, count, d]); index += count; continue;
    }
    let count = 1; while (index + count < values.length && same(values[index + count], first)) count++;
    runs.push(first === undefined ? { n: count } : { v: first, n: count }); index += count;
  }
  return runs;
}

export function unpackColumn(runs: readonly Run[]): unknown[] {
  const values: unknown[] = [];
  for (const run of runs) {
    if (typeof run === 'number') values.push(run);
    else if (Array.isArray(run)) { const [start, step, count, digits] = run as readonly [number, number, number, number]; const scale = SCALES[digits]; for (let k = 0; k < count; k++) values.push((start + k * step) / scale); }
    else { const { v, n } = run as { v?: unknown; n: number }; for (let k = 0; k < n; k++) values.push('v' in run ? v : undefined); }
  }
  return values;
}

/** An array of objects as columns, one per key; a missing key stays missing. */
export function packRows(rows: readonly object[]): PackedRows {
  const keys: string[] = []; for (const row of rows) for (const key of Object.keys(row)) if (!keys.includes(key)) keys.push(key);
  return { '~rows': rows.length, cols: Object.fromEntries(keys.map((key) => [key, packColumn(rows.map((row) => (row as Record<string, unknown>)[key]))])) };
}

export function unpackRows(packed: PackedRows): Record<string, unknown>[] {
  const rows = Array.from({ length: packed['~rows'] }, () => ({} as Record<string, unknown>));
  for (const [key, runs] of Object.entries(packed.cols)) unpackColumn(runs).forEach((value, index) => { if (value !== undefined) rows[index][key] = value; });
  return rows;
}

export const isPackedRows = (value: unknown): value is PackedRows => typeof value === 'object' && value !== null && '~rows' in value;
export const isPackedColumn = (value: unknown): value is PackedColumn => typeof value === 'object' && value !== null && '~col' in value;
