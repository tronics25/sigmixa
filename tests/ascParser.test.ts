import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAscLine } from '../src/parsers/asc/ascLineParser';

const context = { sourceId: 'fixture', line: 1, sequence: 0, base: 'hex' as const };

test('parses Classic CAN without changing the original timestamp', () => {
  const result = parseAscLine(' 12.345600 1 181 Rx d 3 01 A2 ff', context);
  assert.equal(result.type, 'frame');
  if (result.type !== 'frame') return;
  assert.equal(result.frame.timestamp, 12.3456);
  assert.equal(result.frame.dlcCode, 3);
  assert.equal(result.frame.dataLength, 3);
  assert.deepEqual(Array.from(result.frame.data), [1, 0xa2, 0xff]);
});

test('parses CAN FD DLC code separately from actual length', () => {
  const result = parseAscLine('3.5 CANFD 2 Tx 18FF00A1x FrameName 1 0 f 12 00 01 02 03 04 05 06 07 08 09 0A 0B', context);
  assert.equal(result.type, 'frame');
  if (result.type !== 'frame') return;
  assert.equal(result.frame.extended, true);
  assert.equal(result.frame.dlcCode, 15);
  assert.equal(result.frame.dataLength, 12);
});

test('reports malformed rows rather than silently dropping them', () => {
  const result = parseAscLine('this is not a frame', context);
  assert.equal(result.type, 'diagnostic');
  if (result.type === 'diagnostic') assert.equal(result.diagnostic.code, 'ASC_UNSUPPORTED_ROW');
});

test('does not zero-fill a truncated payload', () => {
  const result = parseAscLine('1.0 1 123 Rx d 4 01 02', context);
  assert.equal(result.type, 'diagnostic');
});
