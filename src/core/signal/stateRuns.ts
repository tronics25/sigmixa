/**
 * A Signal as states over time: runs of samples with the same value (and state name). A run lasts until the next
 * sample with another value; the last one ends at the Signal's last sample.
 */
export interface StateRuns {
  /** When each run starts, ascending. */
  readonly starts: readonly number[];
  /** The state of each run: an index into `states`. */
  readonly stateOf: readonly number[];
  /** The distinct states, by value ascending (then by name). */
  readonly states: readonly { readonly value: number; readonly label?: string }[];
  /** The time of the Signal's last sample. */
  readonly end: number;
  /** True when the Signal changes more often than the limit: it is not a state Signal, and its runs are not listed. */
  readonly tooMany: boolean;
}

export interface StateRun { readonly start: number; readonly end: number; readonly state: number }
/** What to draw of a Signal in a span: its runs, or, when those are too many, the state that lasts longest in each equal slice (`mixed` when the slice has more than one). */
export interface StateSlice { readonly runs?: readonly StateRun[]; readonly bins?: readonly ({ readonly state: number; readonly mixed: boolean } | null)[] }

export const STATE_RUN_LIMIT = 200_000;
export const STATE_LIMIT = 64;

/** Builds the runs from samples in time order. `next` gives one sample at a time, or undefined at the end. */
export function buildStateRuns(count: number, timeAt: (index: number) => number, valueAt: (index: number) => number, labelAt: (index: number) => string | undefined, usable: (index: number) => boolean = () => true, limit = STATE_RUN_LIMIT): StateRuns {
  const starts: number[] = []; const keys: number[] = []; const found = new Map<string, number>(); const list: { value: number; label?: string }[] = [];
  let last = -1; let end = -Infinity; let tooMany = false;
  for (let index = 0; index < count; index++) {
    if (!usable(index)) continue;
    const value = valueAt(index); const label = labelAt(index); const key = `${value}\u0000${label ?? ''}`; let state = found.get(key);
    if (state === undefined) { state = list.length; found.set(key, state); list.push(label === undefined ? { value } : { value, label }); }
    end = timeAt(index);
    if (state !== last) { if (starts.length >= limit || list.length > STATE_LIMIT) { tooMany = true; break; } starts.push(end); keys.push(state); last = state; }
  }
  if (tooMany) return { starts: [], stateOf: [], states: [], end, tooMany };
  // States are numbered by value, so a Signal's colours do not depend on which state came first in this log.
  const order = list.map((_, index) => index).sort((left, right) => list[left].value - list[right].value || (list[left].label ?? '').localeCompare(list[right].label ?? ''));
  const rank = new Array<number>(list.length); order.forEach((from, to) => { rank[from] = to; });
  return { starts, stateOf: keys.map((state) => rank[state]), states: order.map((index) => list[index]), end, tooMany };
}

/** The runs of a Signal that overlap `range`, cut to it; or the longest-lasting state per slice when there are more than `maxRuns`. */
export function sliceStateRuns(runs: StateRuns, range: { readonly start: number; readonly end: number }, maxRuns: number, bins: number): StateSlice {
  const total = runs.starts.length; if (!total || range.end < runs.starts[0] || range.start > runs.end) return { runs: [] };
  const endOf = (index: number) => index + 1 < total ? runs.starts[index + 1] : runs.end;
  let first = upper(runs.starts, range.start) - 1; if (first < 0) first = 0; const last = upper(runs.starts, range.end);
  if (last - first <= maxRuns) {
    const result: StateRun[] = [];
    for (let index = first; index < last; index++) { const start = Math.max(range.start, runs.starts[index]); const end = Math.min(range.end, endOf(index)); if (end >= start) result.push({ start, end, state: runs.stateOf[index] }); }
    return { runs: result };
  }
  const slices = Math.max(1, Math.floor(bins)); const width = (range.end - range.start) / slices; const result: ({ state: number; mixed: boolean } | null)[] = []; let index = first;
  for (let slice = 0; slice < slices; slice++) {
    const from = range.start + width * slice; const to = slice === slices - 1 ? range.end : from + width;
    while (index < total - 1 && endOf(index) <= from) index++;
    // The state that lasts longest in the slice in all, counting every run of it (A 3 s, B 4 s, A 3 s gives A).
    const lengths = new Map<number, number>(); let seen = 0;
    for (let at = index; at < total && runs.starts[at] < to; at++) { const overlap = Math.min(to, endOf(at)) - Math.max(from, runs.starts[at]); if (overlap <= 0) continue; seen++; lengths.set(runs.stateOf[at], (lengths.get(runs.stateOf[at]) ?? 0) + overlap); }
    let best = -1; let bestLength = 0; for (const [state, length] of lengths) if (length > bestLength) { bestLength = length; best = state; }
    result.push(best < 0 ? null : { state: best, mixed: seen > 1 });
  }
  return { bins: result };
}

function lower(values: readonly number[], value: number): number { let low = 0; let high = values.length; while (low < high) { const middle = (low + high) >>> 1; if (values[middle] < value) low = middle + 1; else high = middle; } return low; }
function upper(values: readonly number[], value: number): number { let low = 0; let high = values.length; while (low < high) { const middle = (low + high) >>> 1; if (values[middle] <= value) low = middle + 1; else high = middle; } return low; }
