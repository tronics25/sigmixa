/**
 * How text logs are cut into lines, in one place for every reader (the ASC reader on the main thread and on worker
 * threads): a line ends at \n, \r\n or a lone \r, as readline reads them. Bytes are cut only after a line break, so a
 * UTF-8 character is never split.
 */

const LINE_BREAK = /\r\n|\n|\r/;

/**
 * Where a chunk read from a file may be cut so that only whole lines come before the cut: after its last \n. A chunk
 * without one (a log with lone \r endings) is cut after its last \r that is not the last byte, which may be the first half
 * of a \r\n; so a log whose chunks all end in \r never piles up. -1: no line ends in the chunk yet.
 */
export function chunkCut(buffer: Buffer): number {
  const cut = buffer.lastIndexOf(10);
  return cut >= 0 || buffer.length < 2 ? cut : buffer.lastIndexOf(13, buffer.length - 2);
}

/**
 * Where the first line in `window[0..limit)` ends: the index of its \n, or of a lone \r (one the next byte of `window`
 * shows is not followed by \n). -1: none ends there. Give `window` one byte past `limit` (when the file has it), so a \r
 * at the limit can be told apart from the first half of a \r\n.
 */
export function firstLineEnd(window: Buffer, limit: number): number {
  const newline = window.indexOf(10);
  const end = newline >= 0 && newline < limit ? newline : limit;
  for (let at = window.indexOf(13); at >= 0 && at < end; at = window.indexOf(13, at + 1)) if (window[at + 1] !== 10) return at;
  return end < limit ? end : -1;
}

/** Where a piece of a log that starts at the start of a line and ends at the end of one is cut into lines: after its last byte when that is a lone \r, else after its last \n. */
export function pieceCut(buffer: Buffer): number { return buffer.length && buffer[buffer.length - 1] === 13 ? buffer.length - 1 : buffer.lastIndexOf(10); }

/**
 * Walks `buffer[0..cut]` (cut at a line break) one stretch at a time: each ends at a \n, or at `cut`. A stretch ending at
 * a \n is usually one line, `[start, end)` without its \r\n or \n, which a reader may take from the bytes directly;
 * otherwise (or when the bytes are not a line it reads directly) `lines()` gives its lines by the full rules.
 */
export class LineCursor {
  /** The current stretch: its first byte, the end of its first line's text, and its last byte (the line break). */
  start = 0; end = 0; last = -1;
  private position = 0;
  constructor(private readonly buffer: Buffer, private readonly cut: number) {}
  /** Moves to the next stretch; false after the last one. */
  next(): boolean {
    if (this.position > this.cut) return false;
    const buffer = this.buffer; const start = this.position;
    let last = buffer.indexOf(10, start); if (last < 0 || last > this.cut) last = this.cut;
    this.start = start; this.last = last;
    this.end = buffer[last] === 10 && last > start && buffer[last - 1] === 13 ? last - 1 : last;
    this.position = last + 1;
    return true;
  }
  /** The stretch ends at a \n, so `[start, end)` is a whole line unless it holds a lone \r. */
  get newline(): boolean { return this.buffer[this.last] === 10; }
  /** The lines of the stretch, split at every line break it holds. */
  lines(): string[] { return wholeLines(this.buffer.toString('utf8', this.start, this.last + 1)); }
}

/** The whole lines of `text`: what follows its last line break is not a line yet. */
export function wholeLines(text: string): string[] { const lines = text.split(LINE_BREAK); lines.pop(); return lines; }

/** The lines of the end of a file: the last one needs no line break, and a last line break does not start another line. */
export function lastLines(text: string): string[] {
  const lines = text.split(LINE_BREAK);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}
