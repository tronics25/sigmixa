/** Runs a column-width scan to the end, letting other work in the extension host run between its steps. */
export async function runScan<T>(scan: Generator<void, T>): Promise<T> {
  for (;;) {
    const step = scan.next(); if (step.done) return step.value;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
