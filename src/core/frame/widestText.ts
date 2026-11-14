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
 * Cells of a value as the screens spell it, from the cells of its parts: `value (label)` (a Table cell, a RAW tag's
 * value). Every width measure of values goes through this and `tagTextCells`, so it counts what the screens show.
 */
export function valueTextCells(value: number, label: number | undefined): number { return value + (label ? label + 3 : 0); }

/** Cells of a RAW log tag, `name=value unit (label)` (see `formatDecodedSignal`), from the cells of its parts. */
export function tagTextCells(name: number, unit: number | undefined, value: number, label?: number): number { return name + 1 + valueTextCells(value, label) + (unit ? unit + 1 : 0); }

/** Cells the RAW log adds around each tag (the separator and the chip's padding). */
export const TAG_SPACING = 7;

/**
 * `textCells` of `format(key)`, remembered for the last 100,000 keys. Integers (most CAN values) are counted directly:
 * digits plus the minus sign.
 */
export function memoCells<K>(format: (key: K) => string): (key: K) => number {
  let memo = new Map<K, number>();
  return (key) => {
    if (typeof key === 'number' && Number.isSafeInteger(key)) return integerCells(key);
    let cells = memo.get(key);
    if (cells === undefined) {
      cells = textCells(format(key));
      if (memo.size >= 100_000) memo = new Map();
      memo.set(key, cells);
    }
    return cells;
  };
}

function integerCells(value: number): number {
  let cells = value < 0 ? 2 : 1; let rest = Math.abs(value);
  while (rest >= 10) { rest = Math.floor(rest / 10); cells++; }
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
export { finishSteps as finishScan } from '../storage/steps';

