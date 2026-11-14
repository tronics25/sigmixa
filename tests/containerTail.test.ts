import test from 'node:test';
import assert from 'node:assert/strict';
import { ContainerTail } from '../src/parsers/blf/parseBlf';
import { ReadBudget } from '../src/parsers/readBudget';

/** The start of a BLF object (LOBJ header) declaring `size` bytes, with `length` bytes given. */
function objectStart(size: number, length: number): Buffer {
  const buffer = Buffer.alloc(length); buffer.write('LOBJ', 0, 'ascii'); buffer.writeUInt16LE(16, 4); buffer.writeUInt32LE(size, 8); buffer.writeUInt32LE(86, 12);
  return buffer;
}

test('an object larger than a piece is let go before its bytes are joined; what follows it is read', () => {
  const budget = new ReadBudget(undefined, { pieceBytes: 1024 }); const tail = new ContainerTail(budget); const codes: string[] = [];
  tail.keep(objectStart(1500, 800));
  const next = Buffer.alloc(800); next.fill(7, 700);
  assert.deepEqual(tail.add(next, (code) => codes.push(code)), Buffer.alloc(100, 7));
  assert.deepEqual(codes, ['BLF_INNER_OBJECT_TRUNCATED']); assert.equal(tail.length, 0);
  // Its rest spanning several containers is skipped across them.
  const long = new ContainerTail(budget); const longCodes: string[] = [];
  long.keep(objectStart(3000, 500));
  assert.equal(long.add(Buffer.alloc(1000), (code) => longCodes.push(code)), undefined); assert.equal(long.skipping, 1500);
  assert.equal(long.add(Buffer.alloc(1000), (code) => longCodes.push(code)), undefined); assert.equal(long.skipping, 500);
  const last = Buffer.alloc(600); last.fill(9, 500);
  assert.deepEqual(long.add(last, (code) => longCodes.push(code)), Buffer.alloc(100, 9));
  assert.deepEqual(longCodes, ['BLF_INNER_OBJECT_TRUNCATED']);
});

test('an object within a piece is joined across containers once it is whole', () => {
  const budget = new ReadBudget(undefined, { pieceBytes: 1024 }); const tail = new ContainerTail(budget); const codes: string[] = [];
  tail.keep(objectStart(600, 400));
  assert.equal(tail.add(Buffer.alloc(100), (code) => codes.push(code)), undefined);
  assert.equal(tail.add(Buffer.alloc(300), (code) => codes.push(code))?.length, 800);
  assert.deepEqual(codes, []);
});
