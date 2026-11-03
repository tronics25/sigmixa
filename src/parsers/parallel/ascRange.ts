import { parseAscFrameBytes, parseAscLine, type AscNumericBase } from '../asc/ascLineParser';
import { FramePacker, type PackedFrames } from './packedFrames';

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
 * is read too; otherwise the piece ends after a \n.
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
  const cut = buffer.lastIndexOf(10);
  let position = 0;
  while (position <= cut) {
    let next = buffer.indexOf(10, position); if (next < 0 || next > cut) next = cut;
    const lineEnd = next > position && buffer[next - 1] === 13 ? next - 1 : next;
    context.line = lines + 1; context.sequence = packer.size;
    const frame = parseAscFrameBytes(buffer, position, lineEnd, context);
    if (frame) { lines++; packer.push(frame); }
    else { const pieces = buffer.toString('utf8', position, next + 1).split(/\r\n|\n|\r/); pieces.pop(); for (const piece of pieces) text(piece); }
    position = next + 1;
  }
  if (last && cut + 1 < buffer.length) {
    const pieces = buffer.toString('utf8', cut + 1).split(/\r\n|\n|\r/);
    // A last line ending in a lone \r gives an empty piece after it, which readline does not report as a line.
    if (pieces.length > 1 && pieces[pieces.length - 1] === '') pieces.pop();
    for (const piece of pieces) text(piece);
  }
  return { frames: packer.finish(), events, lines, base: context.base };
}
