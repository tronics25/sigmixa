import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { traceMilliseconds } from '../src/webview/raw/traceNumbers';

test('trace deviation does not show a plus or minus sign for zero or floating point residue', () => {
  for (const value of [0, -0, (0.03 - 0.02) * 1000 - 10, (0.02 - 0.01) * 1000 - 10, -1e-12, 1e-12]) assert.equal(traceMilliseconds(value, true), '0.000');
});
test('trace exposes sub-microsecond deviations without excessive trailing zeros', () => {
  assert.equal(traceMilliseconds(0.0002, true), '+0.0002');
  assert.equal(traceMilliseconds(-0.0002, true), '-0.0002');
  assert.equal(traceMilliseconds(0.000001, true), '+0.000001');
  assert.equal(traceMilliseconds(1.2345678, true), '+1.234568');
  assert.equal(traceMilliseconds(12.1), '12.100');
  assert.equal(traceMilliseconds(1.2345), '1.2345');
  assert.equal(traceMilliseconds(undefined), '—');
});
