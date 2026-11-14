/**
 * Work done in steps (a generator that yields between them, so a large log's screens are served meanwhile), and how it
 * notices that what it was reading changed between two steps. Every job done in steps goes through these, rather than
 * each checking in its own way.
 */

/** What a job depends on: values read again after every step and compared, one by one (by identity), with the first. */
export type Stamp = () => readonly unknown[];

/** True once any value of `stamp` differs from what it was when `watch` was called. */
export function watch(stamp: Stamp): () => boolean {
  const first = stamp();
  return () => { const now = stamp(); return now.length !== first.length || now.some((value, index) => !Object.is(value, first[index])); };
}

/**
 * Runs the job `start` makes, step by step. Between two steps (while other work runs) `stamp` must stay as the step left
 * it; what the job changes itself does not count. When it changed, the job's work so far no longer holds: `restart`
 * makes the job again and runs it from its beginning, `drop` ends with undefined. A job that ends gives its result.
 */
export function* watchedSteps<T>(stamp: Stamp, start: () => Generator<void, T>, onChange: 'restart' | 'drop'): Generator<void, T | undefined> {
  for (;;) {
    const job = start(); let changed = false;
    while (!changed) {
      const step = job.next(); if (step.done) return step.value;
      const unchanged = watch(stamp);
      yield;
      changed = unchanged();
    }
    if (onChange === 'drop') return undefined;
  }
}

/** Runs steps to the end at once. */
export function finishSteps<T>(steps: Generator<void, T>): T {
  for (;;) { const step = steps.next(); if (step.done) return step.value; }
}
