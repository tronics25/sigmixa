import test from 'node:test';
import assert from 'node:assert/strict';
import { adjustResolution, parseResolution, resolutionStepFactor } from '../src/core/manual/resolution';

test('parses decimal, integer, and fraction resolution while retaining display text', () => {
  for (const [text, expected] of [['1', 1], ['0.0078125', 0.0078125], ['1/128', 1 / 128], ['3/10', 0.3]] as const) {
    const result = parseResolution(text); assert.equal(result.valid, true); if (result.valid) { assert.equal(result.resolution.value, expected); assert.equal(result.resolution.text, text); }
  }
});

test('rejects zero denominator, negative, non-finite, and configured range violations', () => {
  for (const text of ['1/0', '-1', 'Infinity', '1e-16', '1e16']) assert.equal(parseResolution(text).valid, false, text);
});

test('fraction spinner uses ×2 for powers of two and ×10 otherwise', () => {
  assert.equal(resolutionStepFactor('1/128'), 2); assert.equal(resolutionStepFactor('3/10'), 10);
  const up = adjustResolution('1/128', 'increase'); const down = adjustResolution('1/128', 'decrease');
  assert.equal(up.valid && up.resolution.text, '1/64'); assert.equal(down.valid && down.resolution.text, '1/256');
  const decimal = adjustResolution('3/10', 'decrease'); assert.equal(decimal.valid && decimal.resolution.value, 0.03);
});
