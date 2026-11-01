/**
 * Helpers for column autofit: every row is scanned, and only the rows that hold
 * the widest text of a column are handed to the screen, which measures them in
 * its own font. Nothing is guessed from a sample.
 */

/** Text length in character cells; East Asian wide characters and emoji count twice. Used only to rank rows before they are measured. */
export function textCells(text: string): number {
  let cells = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    cells += code >= 0x1100 && (code <= 0x115f || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1f000 && code <= 0x1faff) || code >= 0x20000) ? 2 : 1;
  }
  return cells;
}

/**
 * Keeps, for each key, the few items with the most cells. A few are kept rather
 * than one because a proportional font can draw a slightly shorter text wider.
 */
export class WidestPicker<T> {
  private readonly kept = new Map<string, { size: number; item: T }[]>();
  constructor(private readonly perKey = 3) {}

  add(key: string, size: number, item: T): void {
    let list = this.kept.get(key);
    if (!list) { list = []; this.kept.set(key, list); }
    if (list.length >= this.perKey && size <= list[list.length - 1].size) return;
    let index = list.length;
    while (index > 0 && list[index - 1].size < size) index--;
    list.splice(index, 0, { size, item });
    if (list.length > this.perKey) list.pop();
  }

  items(): T[] { return Array.from(this.kept.values(), (list) => list.map((entry) => entry.item)).flat(); }
}

/** How many rows a width scan reads between yields. */
export const SCAN_STEP = 50_000;

/** Runs a width scan to the end at once. */
export function finishScan<T>(scan: Generator<void, T>): T {
  for (;;) { const step = scan.next(); if (step.done) return step.value; }
}

