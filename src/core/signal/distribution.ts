/**
 * How the values of a Signal are spread: per equal slice of a time span, how many samples fell in each equal part
 * (`bins`) of the value span `lo`…`hi`, with what the statistics of any run of slices are made from. One slice is the
 * whole span; a report embeds many, so its statistics can follow the time span it shows.
 */
export interface DistributionGrid {
  readonly start: number; readonly end: number; readonly slices: number;
  readonly lo: number; readonly hi: number; readonly bins: number;
  /** `counts[slice * bins + bin]`. */
  readonly counts: readonly number[];
  /**
   * Per slice: the samples, the sum of (value − lo), the sum of squared differences from the slice's own mean (`m2`, kept
   * so: squares of large values would cancel when the spread is small), and the least and greatest value (null without samples).
   */
  readonly n: readonly number[]; readonly sum: readonly number[]; readonly m2: readonly number[];
  readonly min: readonly (number | null)[]; readonly max: readonly (number | null)[];
}

/** The statistics and histogram of a run of slices. `mean` and `sd` weigh every sample alike; undefined without samples. */
export interface Distribution { readonly count: number; readonly min?: number; readonly max?: number; readonly mean?: number; readonly sd?: number; readonly bins: readonly number[] }

/** The least and greatest usable value of the samples [from, to). */
export function valueExtent(from: number, to: number, valueAt: (index: number) => number, usable: (index: number) => boolean): { lo: number; hi: number } | undefined {
  let lo = Infinity; let hi = -Infinity;
  for (let index = from; index < to; index++) { if (!usable(index)) continue; const value = valueAt(index); if (value < lo) lo = value; if (value > hi) hi = value; }
  return lo <= hi ? { lo, hi } : undefined;
}

/** Counts the samples [from, to) whose time is in `range`; values outside `lo`…`hi` go to the first or last bin. */
export function buildDistribution(from: number, to: number, timeAt: (index: number) => number, valueAt: (index: number) => number, usable: (index: number) => boolean, range: { readonly start: number; readonly end: number }, sliceCount: number, extent: { readonly lo: number; readonly hi: number }, binCount: number): DistributionGrid {
  const slices = Math.max(1, Math.floor(sliceCount)); const { lo, hi } = extent; const bins = hi > lo ? Math.max(1, Math.floor(binCount)) : 1;
  const counts = new Array<number>(slices * bins).fill(0); const n = new Array<number>(slices).fill(0); const sum = new Array<number>(slices).fill(0); const m2 = new Array<number>(slices).fill(0);
  const min = new Array<number | null>(slices).fill(null); const max = new Array<number | null>(slices).fill(null);
  const width = (range.end - range.start) / slices; const step = (hi - lo) / bins;
  for (let index = from; index < to; index++) {
    if (!usable(index)) continue; const time = timeAt(index); if (time < range.start || time > range.end) continue;
    const value = valueAt(index); const slice = width > 0 ? Math.min(slices - 1, Math.floor((time - range.start) / width)) : 0; const bin = step > 0 ? Math.max(0, Math.min(bins - 1, Math.floor((value - lo) / step))) : 0;
    // Welford's update: the mean so far and the squared differences from it.
    counts[slice * bins + bin]++; const offset = value - lo; const before = n[slice] ? sum[slice] / n[slice] : 0; n[slice]++; sum[slice] += offset; m2[slice] += (offset - before) * (offset - sum[slice] / n[slice]);
    const least = min[slice]; if (least === null || value < least) min[slice] = value; const most = max[slice]; if (most === null || value > most) max[slice] = value;
  }
  return { start: range.start, end: range.end, slices, lo, hi, bins, counts, n, sum, m2, min, max };
}

/** The slices of a grid that lie in a time span: those whose middle is in it (at least one where the span meets the grid). */
export function slicesIn(grid: DistributionGrid, range: { readonly start: number; readonly end: number }): { from: number; to: number } {
  const width = (grid.end - grid.start) / grid.slices; if (!(width > 0)) return { from: 0, to: grid.slices };
  let from = Math.max(0, Math.min(grid.slices - 1, Math.ceil((range.start - grid.start) / width - .5))); let to = Math.max(0, Math.min(grid.slices, Math.floor((range.end - grid.start) / width + .5)));
  if (to <= from) { from = Math.max(0, Math.min(grid.slices - 1, Math.floor(((range.start + range.end) / 2 - grid.start) / width))); to = from + 1; }
  return { from, to };
}

/** The statistics and histogram of the slices [from, to). */
export function mergeDistribution(grid: DistributionGrid, from = 0, to = grid.slices): Distribution {
  const bins = new Array<number>(grid.bins).fill(0); let count = 0; let sum = 0; let m2 = 0; let min = Infinity; let max = -Infinity;
  for (let slice = Math.max(0, from); slice < Math.min(grid.slices, to); slice++) {
    const n = grid.n[slice]; if (!n) continue;
    // Chan's merge of two runs' squared differences: no squares of large values, which cancel when the spread is small.
    if (count) { const delta = grid.sum[slice] / n - sum / count; m2 += grid.m2[slice] + delta * delta * count * n / (count + n); } else m2 = grid.m2[slice];
    count += n; sum += grid.sum[slice];
    const least = grid.min[slice]; if (least !== null && least < min) min = least; const most = grid.max[slice]; if (most !== null && most > max) max = most;
    for (let bin = 0; bin < grid.bins; bin++) bins[bin] += grid.counts[slice * grid.bins + bin];
  }
  if (!count) return { count, bins };
  const mean = sum / count; return { count, min, max, mean: grid.lo + mean, sd: Math.sqrt(Math.max(0, m2 / count)), bins };
}
