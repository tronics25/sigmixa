import test from 'node:test';
import assert from 'node:assert/strict';
import { formatCsvSignalValue, formatCsvTimestamp } from '../src/core/export/csvNumber';

test('CSV Timestamp formatting removes binary floating-point tails', () => {
  assert.equal(formatCsvTimestamp(2.250000000002), '2.25');
  assert.equal(formatCsvTimestamp(12.1234567894), '12.123456789');
  assert.equal(formatCsvTimestamp(-0), '0');
});

test('CSV Signal formatting keeps useful precision without exporting noise', () => {
  assert.equal(formatCsvSignalValue(2.250000000002), '2.25');
  assert.equal(formatCsvSignalValue(1 / 3), '0.333333333333');
  assert.equal(formatCsvSignalValue(4_294_967_295), '4294967295');
  assert.equal(formatCsvSignalValue(0.000000000123456789), '1.23456789e-10');
});
