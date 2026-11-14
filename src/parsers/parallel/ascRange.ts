import { parseAscFrameBytes, parseAscLine, type AscNumericBase } from '../asc/ascLineParser';
import { FramePacker, type PackedFrames } from './packedFrames';
import { lastLines, LineCursor, pieceCut } from '../lineBreaks';

/**
 * A line of an ASC piece that is not a frame and not ignored (a `base` or `date` line, or one reported as a
 * diagnostic): the main thread reads it again in place, where its line number and the frames before it are known.
 * `line` and `frames` count from the start of the piece.
 */
export interface AscLineEvent { readonly line: number; readonly frames: number; readonly text: string }

export interface AscRangeResult {
  readonly frames: PackedFrames;
  readonly events: readonly AscLineEvent[];
  readonly lines: number;
  /** The base in force after the piece. */
  readonly base: AscNumericBase;
}

/**
 * Reads lines `[0, end)` of `buffer`, a piece of an ASC log that starts at the start of a line, exactly as
 * `parseAscFile` reads them, starting with `base`. `last`: the piece ends the file, so a last line without a line break
 * is read too; otherwise the piece ends after a \n or a lone \r.
 */
export function parseAscRange(buffer: Buffer, base: AscNumericBase, last: boolean): AscRangeResult {
  const packer = new FramePacker(); const events: AscLineEvent[] = [];
  let lines = 0;
  const context = { sourceId: '', line: 0, sequence: 0, base };
  const text = (line: string) => {
    lines++;
    const result = parseAscLine(line, { ...context, line: lines, sequence: packer.size });
    if (result.type === 'frame') packer.push(result.frame);
    else if (result.type === 'ignored') return;
    else { if (result.type === 'base') context.base = result.base; events.push({ line: lines, frames: packer.size, text: line }); }
  };
  // The piece ends after a line break (or is the end of the file), so all of it but what follows its last one is whole lines.
  const cut = pieceCut(buffer);
  const cursor = new LineCursor(buffer, cut);
  while (cursor.next()) {
    context.line = lines + 1; context.sequence = packer.size;
    const frame = parseAscFrameBytes(buffer, cursor.start, cursor.end, context);
    if (frame) { lines++; packer.push(frame); }
    else for (const piece of cursor.lines()) text(piece);
  }
  if (last && cut + 1 < buffer.length) for (const piece of lastLines(buffer.toString('utf8', cut + 1))) text(piece);
  return { frames: packer.finish(), events, lines, base: context.base };
}
