/**
 * How a CAN frame (or a measured Signal) is sent, and from that where reception broke off.
 *
 * Send modes are those of a DBC's GenMsgSendType and AUTOSAR COM: periodic, on events, or periodic with events in
 * between. When the mode is not defined it is estimated from the receive times:
 * - A base cycle is looked for: a cycle at which at least `CYCLE_SHARE` of the frames come, each within `TOLERANCE` of
 *   the expected time, and that misses at most `MISS_SHARE` of its cycles in short runs (a pause of more than
 *   `SHORT_MISS` cycles is a dropout, not a sign of another pattern), and that keeps coming: its frames cover at least
 *   `COVER_SHARE` of the time read, or its longer pauses (dropouts) are rare, after at most `PAUSE_SHARE` of its frames.
 *   Frames sent in bursts on events (a dozen frames 10 ms apart, then nothing for an irregular while) keep a cycle only
 *   inside each burst and pause after every burst, so they are sent on events. Candidates are the interval lengths that recur at
 *   a steady length; the shortest that holds is the cycle (an event sent several times in quick succession recurs too,
 *   but does not hold over time).
 * - With a cycle, frames between two cycle frames are sent on events: more than `EVENT_SHARE` of them makes the mode
 *   periodic + events. Without a cycle the frame is sent on events.
 * Reception broke off where no frame came for `GAP_FACTOR` cycles. A frame sent on events has no such limit.
 * Only a few runs of frames are read to estimate (`RUN_LENGTH` from the start, the middle and the end), so it costs the
 * same for any number of frames.
 */
export type SendMode = 'periodic' | 'event' | 'mixed';
export const SEND_MODES: readonly SendMode[] = ['periodic', 'event', 'mixed'];

/** Times in seconds, ascending. */
export interface TimeList { readonly length: number; at(index: number): number }

export interface SendModeEstimate {
  readonly mode: SendMode;
  /** The base cycle in seconds; absent for a frame sent on events. */
  readonly cycle?: number;
}

/** No frame for this many cycles (or longer) is a dropout. */
export const GAP_FACTOR = 1.6;
/** A cycle frame may come this share of the cycle early or late. */
const TOLERANCE = 0.3;
/** How far each found frame draws the walk towards itself. */
const FOLLOW = 0.2;
const CYCLE_SHARE = 0.4;
const MISS_SHARE = 0.3;
const SHORT_MISS = 4;
/** A cycle's frames must span at least this share of the time read (each found frame stands for one cycle). */
const COVER_SHARE = 0.5;
/** Or longer pauses (dropouts) may follow at most this share of the cycle frames (one is always allowed). */
const PAUSE_SHARE = 0.01;
const EVENT_SHARE = 0.02;
const RUN_LENGTH = 2048;
const SPREAD = 1.3;
const STEADY = 2.5;
const RECURRING_MIN = 8;
const MIN_TIMES = 4;
/** Candidates are also read between a frame and up to this many frames after it. */
const LAGS = 3;

/** The runs of frames read to estimate: all of them when few, else three runs. */
function runs(times: TimeList): [number, number][] {
  const count = times.length; if (count <= RUN_LENGTH * 3) return [[0, count]];
  const middle = Math.floor((count - RUN_LENGTH) / 2);
  return [[0, RUN_LENGTH], [middle, middle + RUN_LENGTH], [count - RUN_LENGTH, count]];
}

/**
 * Times between frames that recur at a steady length, shortest first: the candidates for the base cycle. Also between a
 * frame and the second and third after it, so a cycle with events between its frames (a frame every 100 ms and an event
 * 30 ms after each) still shows its length.
 */
function candidates(times: TimeList, parts: readonly [number, number][]): number[] {
  let adjacent = 0; for (const [from, to] of parts) adjacent += Math.max(0, to - from - 1);
  if (adjacent < MIN_TIMES - 1) return [];
  const least = Math.max(Math.min(RECURRING_MIN, Math.ceil(adjacent / 4)), 3); const result: number[] = [];
  // Each lag is grouped on its own: with jitter, the times to the next frame and to the one after can run into each other.
  for (let lag = 1; lag <= LAGS; lag++) {
    const intervals: number[] = [];
    for (const [from, to] of parts) for (let index = from + lag; index < to; index++) { const value = times.at(index) - times.at(index - lag); if (Number.isFinite(value) && value > 0) intervals.push(value); }
    const sorted = Float64Array.from(intervals).sort(); let start = 0;
    for (let index = 1; index <= sorted.length; index++) {
      if (index < sorted.length && sorted[index] <= sorted[index - 1] * SPREAD) continue;
      const at = (share: number) => sorted[start + Math.floor((index - 1 - start) * share)];
      if (index - start >= least && at(0.9) <= at(0.1) * STEADY) result.push(at(0.5));
      start = index;
    }
  }
  return result.sort((left, right) => left - right);
}

/**
 * Walks `from..to` on a cycle: each step looks for a frame near the expected time. Counts the cycles found and missed
 * (and those missed in runs of at most `SHORT_MISS`), and the frames in between (sent on events). `onEvent` gets the index of each frame in between.
 */
export function walkCycle(times: TimeList, cycle: number, from = 0, to = times.length, onEvent?: (index: number) => void): { found: number; missed: number; shortMissed: number; pauses: number; events: number } {
  let found = 0; let missed = 0; let shortMissed = 0; let pauses = 0; let events = 0; if (to - from < 2 || !(cycle > 0)) return { found, missed, shortMissed, pauses, events };
  const tolerance = cycle * TOLERANCE; let anchor = times.at(from); let index = from + 1;
  while (index < to) {
    const expected = anchor + cycle;
    // Frames before the expected time (less the tolerance) are in between: sent on events.
    while (index < to && times.at(index) < expected - tolerance) { events++; onEvent?.(index); index++; }
    if (index >= to) break;
    const time = times.at(index);
    if (time <= expected + tolerance) {
      // The nearest frame to the expected time is the cycle frame; others close by count as in between.
      let best = index; for (let next = index + 1; next < to && times.at(next) <= expected + tolerance; next++) if (Math.abs(times.at(next) - expected) < Math.abs(times.at(best) - expected)) best = next;
      for (let between = index; between < best; between++) { events++; onEvent?.(between); }
      // The walk keeps to the cycle's own times, drawn a little towards each frame: the jitter of single frames does not
      // move it, a clock that runs slightly fast or slow does.
      found++; anchor = expected + (times.at(best) - expected) * FOLLOW; index = best + 1;
    } else {
      // No frame this cycle: count every missed cycle up to the next frame, then follow on from it.
      const cycles = Math.max(1, Math.round((time - anchor) / cycle) - 1); missed += cycles; if (cycles <= SHORT_MISS) shortMissed += cycles; else pauses++; found++; anchor = time; index++;
    }
  }
  return { found, missed, shortMissed, pauses, events };
}

/** The send mode estimated from the receive times; undefined with too few frames to tell. */
export function estimateSendMode(times: TimeList): SendModeEstimate | undefined {
  if (times.length < MIN_TIMES) return undefined;
  const parts = runs(times);
  for (const cycle of candidates(times, parts)) {
    let found = 0; let shortMissed = 0; let pauses = 0; let events = 0; let frames = 0; let span = 0;
    for (const [from, to] of parts) { const walk = walkCycle(times, cycle, from, to); found += walk.found; shortMissed += walk.shortMissed; pauses += walk.pauses; events += walk.events; frames += to - from; span += times.at(to - 1) - times.at(from); }
    if (found < Math.min(RECURRING_MIN, frames / 2) || found < frames * CYCLE_SHARE || shortMissed > (found + shortMissed) * MISS_SHARE) continue;
    if (found * cycle < span * COVER_SHARE && pauses > Math.max(1, found * PAUSE_SHARE)) continue;
    return { mode: events > frames * EVENT_SHARE ? 'mixed' : 'periodic', cycle };
  }
  return { mode: 'event' };
}

/** The longest interval that is still continuous reception, in seconds: Infinity for a frame sent on events. */
export function dropoutLimit(mode: SendMode | undefined, cycle: number | undefined): number {
  return mode === 'event' || !(cycle !== undefined && cycle > 0) ? Infinity : cycle * GAP_FACTOR;
}

/** The dropouts in `from..to`: each interval longer than `limit`, as its two receive times. */
export function dropouts(times: TimeList, limit: number, from = 0, to = times.length): { readonly starts: Float64Array; readonly ends: Float64Array } {
  const starts: number[] = []; const ends: number[] = [];
  if (Number.isFinite(limit)) for (let index = from + 1; index < to; index++) { const previous = times.at(index - 1); const time = times.at(index); if (time - previous > limit) { starts.push(previous); ends.push(time); } }
  return { starts: Float64Array.from(starts), ends: Float64Array.from(ends) };
}
