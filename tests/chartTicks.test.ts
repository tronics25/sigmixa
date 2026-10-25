import test from 'node:test';
import assert from 'node:assert/strict';
import { chartTicks } from '../src/webview/shared/chartAxes';

test('chart ticks use readable intervals without expanding or rounding the viewport', () => {
  assert.deepEqual(chartTicks(0, 60.007), [0, 10, 20, 30, 40, 50, 60]);
  assert.deepEqual(chartTicks(0, 25.263, 4), [0, 5, 10, 15, 20, 25]);
  assert.deepEqual(chartTicks(-0.0031, 0.0032), [-0.003, -0.002, -0.001, 0, 0.001, 0.002, 0.003]);
  const ticks = chartTicks(11.8563, 24.5);
  assert.ok(ticks.length > 1);
  assert.ok(ticks.every((value) => value >= 11.8563 && value <= 24.5));
  assert.deepEqual(chartTicks(0, 60.007, 2), [0, 20, 40, 60]);
});

test('chart ticks remain finite and ordered for small ranges and large offsets', () => {
  for (const [start, end] of [[1e9, 1e9 + 0.007], [1e-12, 9e-12], [-1e12, -1e12 + 0.01]]) {
    const ticks = chartTicks(start, end);
    assert.ok(ticks.length > 0 && ticks.length <= 101);
    ticks.forEach((tick, index) => { assert.ok(Number.isFinite(tick) && tick >= start && tick <= end); if (index) assert.ok(tick > ticks[index - 1]); });
  }
  assert.deepEqual(chartTicks(1, 1), []);
  assert.deepEqual(chartTicks(NaN, 10), []);
  assert.deepEqual(chartTicks(0, Infinity), []);
});

test('chart ticks are decimal-exact, without float accumulation noise', () => {
  assert.deepEqual(chartTicks(0, 0.7, 4), [0, 0.2, 0.4, 0.6]);
  assert.deepEqual(chartTicks(0, 1.05), [0, 0.2, 0.4, 0.6, 0.8, 1]);
  assert.deepEqual(chartTicks(0.1, 0.75, 6), [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]);
  for (const [start, end] of [[0, 0.7], [-0.37, 0.91], [0.0001, 0.00093], [12.3, 12.9], [-1e9, -1e9 + 0.9]]) {
    for (const tick of chartTicks(start, end)) assert.ok(String(tick).replace(/^-/, '').length <= 14, `${start}..${end}: ${tick}`);
  }
  assert.deepEqual(chartTicks(0, 7e-23), [0, 1e-23, 2e-23, 3e-23, 4e-23, 5e-23, 6e-23, 7e-23]);
  assert.deepEqual(chartTicks(1e12, 1e12 + 0.003), [1e12, 1000000000000.0005, 1000000000000.001, 1000000000000.0015, 1000000000000.002, 1000000000000.0025, 1000000000000.003]);
});
