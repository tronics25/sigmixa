import test from 'node:test';
import assert from 'node:assert/strict';
import { signalByteMasks } from '../src/webview/raw/decodedInspection';

test('RAW inspection masks match LITTLE and BIG byte boundaries', () => {
  const detail = { tag: 'test', byteOffset: 2, bitOffset: 4, lengthBits: 8 };
  assert.deepEqual([...signalByteMasks({ ...detail, byteOrder: 'little' })], [[2, 0xf0], [3, 0x0f]]);
  assert.deepEqual([...signalByteMasks({ ...detail, byteOrder: 'big' })], [[2, 0x0f], [3, 0xf0]]);
});

test('derived/plugin values have no invented physical bit mapping', () => {
  assert.equal(signalByteMasks({ tag: 'derived=12' }).size, 0);
  assert.equal(signalByteMasks({ tag: 'bad', byteOffset: 0, bitOffset: 8, lengthBits: 12, byteOrder: 'little' }).size, 0);
  assert.equal(signalByteMasks({ tag: 'bad', byteOffset: 0, bitOffset: 0, lengthBits: 100000, byteOrder: 'little' }).size, 0);
});
