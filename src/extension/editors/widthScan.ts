/**
 * Runs work done in steps (see core/storage/steps) to the end, letting other work in the extension host run between
 * its steps; stops (undefined) as soon as `stopped` says so, without running the rest.
 */
export async function runScan<T>(scan: Generator<void, T>): Promise<T>;
export async function runScan<T>(scan: Generator<void, T>, stopped: () => boolean): Promise<T | undefined>;
export async function runScan<T>(scan: Generator<void, T>, stopped?: () => boolean): Promise<T | undefined> {
  for (;;) {
    const step = scan.next(); if (step.done) return step.value;
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (stopped?.()) return undefined;
  }
}
