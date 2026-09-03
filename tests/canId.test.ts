import test from 'node:test';
import assert from 'node:assert/strict';
import { formatCanId, parseCanId } from '../src/core/frame/canId';
import { parseAscLine } from '../src/parsers/asc/ascLineParser';

test('CAN ID notation infers long extended IDs and requires x only for short extended IDs', () => {
  assert.deepEqual(parseCanId('1AB'), { canId: 0x1ab, extended: false });
  assert.deepEqual(parseCanId('1ABx'), { canId: 0x1ab, extended: true });
  assert.deepEqual(parseCanId('800'), { canId: 0x800, extended: true });
  assert.deepEqual(parseCanId('18FF1234'), { canId: 0x18ff1234, extended: true });
  assert.deepEqual(parseCanId('0x1abx'), { canId: 0x1ab, extended: true });
  assert.equal(parseCanId('20000000'), undefined);
  assert.equal(formatCanId(0x1ab, false), '1AB');
  assert.equal(formatCanId(0x1ab, true), '1ABx');
  assert.equal(formatCanId(0x18ff1234, true), '18FF1234');
});

test('ASC parsing applies the same CAN ID inference', () => {
  const context = { sourceId: 'notation.asc', line: 1, sequence: 1, base: 'hex' as const };
  const long = parseAscLine('0.100000 1 18FF1234 Rx d 1 01', context);
  const shortExtended = parseAscLine('0.200000 1 1ABx Rx d 1 02', { ...context, line: 2, sequence: 2 });
  assert.equal(long.type, 'frame');
  assert.equal(shortExtended.type, 'frame');
  if (long.type === 'frame') assert.deepEqual({ canId: long.frame.canId, extended: long.frame.extended }, { canId: 0x18ff1234, extended: true });
  if (shortExtended.type === 'frame') assert.deepEqual({ canId: shortExtended.frame.canId, extended: shortExtended.frame.extended }, { canId: 0x1ab, extended: true });
});
