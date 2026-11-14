import test from 'node:test';
import { strict as assert } from 'node:assert';
import { chunkCut, firstLineEnd, lastLines, LineCursor, pieceCut, wholeLines } from '../src/parsers/lineBreaks';

/** Every line of `text` as the readers cut it: in pieces cut by `chunkCut`, the rest of the file read by `lastLines`. */
function linesInChunks(text: string, size: number): string[] {
  const bytes = Buffer.from(text); const lines: string[] = []; let carry = Buffer.alloc(0);
  for (let at = 0; at < bytes.length; at += size) {
    const buffer = Buffer.concat([carry, bytes.subarray(at, at + size)]);
    const cut = chunkCut(buffer);
    if (cut < 0) { carry = buffer; continue; }
    const cursor = new LineCursor(buffer, cut);
    while (cursor.next()) lines.push(...cursor.lines());
    carry = buffer.subarray(cut + 1);
  }
  if (carry.length) lines.push(...lastLines(carry.toString('utf8')));
  return lines;
}

test('lines end at \\n, \\r\\n or a lone \\r wherever the chunks are cut', () => {
  const text = 'a\nb\r\nc\rd\r\r\ne\n\n😀é\r\rlast';
  const expected = ['a', 'b', 'c', 'd', '', 'e', '', '😀é', '', 'last'];
  assert.deepEqual(lastLines(text), expected);
  for (let size = 1; size <= text.length + 1; size++) assert.deepEqual(linesInChunks(text, size), expected, `chunks of ${size}`);
  // A last line break does not start another line; a lone \r at the very end is a line break too.
  assert.deepEqual(linesInChunks('a\r', 1), ['a']);
  assert.deepEqual(lastLines(''), ['']);
  assert.deepEqual(wholeLines('a\r\nb'), ['a']);
});

test('the first line end in a window: \\n, or a \\r the next byte shows is alone', () => {
  assert.equal(firstLineEnd(Buffer.from('ab\ncd'), 5), 2);
  assert.equal(firstLineEnd(Buffer.from('ab\r\ncd'), 6), 3);
  assert.equal(firstLineEnd(Buffer.from('ab\rcd\n'), 6), 2);
  // A \r at the limit is told apart by the byte after it.
  assert.equal(firstLineEnd(Buffer.from('ab\r\n'), 3), -1);
  assert.equal(firstLineEnd(Buffer.from('ab\rx'), 3), 2);
  // At the end of the file there is no next byte: the \r ends the line.
  assert.equal(firstLineEnd(Buffer.from('ab\r'), 3), 2);
  assert.equal(firstLineEnd(Buffer.from('abc'), 3), -1);
  assert.equal(firstLineEnd(Buffer.from('ab\n'), 2), -1);
});

test('a piece is cut after a last lone \\r or after its last \\n', () => {
  assert.equal(pieceCut(Buffer.from('a\nb\r')), 3);
  assert.equal(pieceCut(Buffer.from('a\nb\r\n')), 4);
  assert.equal(pieceCut(Buffer.from('a\nb')), 1);
  assert.equal(pieceCut(Buffer.alloc(0)), -1);
});
