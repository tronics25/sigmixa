import test from 'node:test';
import assert from 'node:assert/strict';
import { extractBits } from '../src/core/manual/bits';

test('extracts Intel and Motorola fields across byte boundaries', () => {
  assert.equal(extractBits(Uint8Array.from([0x34, 0x12]), 0, 0, 16, 'little', 'unsigned'), 0x1234n);
  assert.equal(extractBits(Uint8Array.from([0x34, 0x12]), 0, 4, 8, 'little', 'unsigned'), 0x23n);
  assert.equal(extractBits(Uint8Array.from([0x12, 0x34]), 0, 0, 16, 'big', 'unsigned'), 0x1234n);
  assert.equal(extractBits(Uint8Array.from([0x12, 0x34]), 0, 4, 8, 'big', 'unsigned'), 0x23n);
});

test('applies two’s-complement signed decoding at different lengths', () => {
  assert.equal(extractBits(Uint8Array.from([0xff]), 0, 0, 8, 'little', 'signed'), -1n);
  assert.equal(extractBits(Uint8Array.from([0x00, 0x08]), 0, 0, 12, 'little', 'signed'), -2048n);
  assert.equal(extractBits(Uint8Array.from([0x80]), 0, 0, 8, 'big', 'signed'), -128n);
});

test('rejects invalid ranges instead of zero-filling bytes outside the payload', () => {
  assert.throws(() => extractBits(Uint8Array.from([1]), 1, 0, 8, 'little', 'unsigned'), /exceeds/);
  assert.throws(() => extractBits(Uint8Array.from([1]), 0, 0, 65, 'little', 'unsigned'), /1 and 64/);
});
