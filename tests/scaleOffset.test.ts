import test from 'node:test';
import assert from 'node:assert/strict';
import { convertScaleOffset } from '../src/core/manual/scaleOffset';
import type { ManualConversion } from '../src/core/manual/manualDefinition';

function conversion(scale: string, offset = 0): ManualConversion {
  const fraction = scale.split('/');
  return { type: 'scale-offset', lsb: fraction.length === 2 ? Number(fraction[0]) / Number(fraction[1]) : Number(scale), lsbText: scale, offset };
}

test('Scale automatically selects wide RAW shifts for equivalent powers of two before Offset', () => {
  assert.equal(convertScaleOffset(36n, conversion('1/16')), 2);
  assert.equal(convertScaleOffset(36n, conversion('0.0625')), 2);
  assert.equal(convertScaleOffset(36n, conversion('2/32')), 2);
  assert.equal(convertScaleOffset(0xffffffffn, conversion('2')), 8589934590);
  assert.equal(convertScaleOffset(0xffffffffn, conversion('1/16')), 268435455);
  assert.equal(convertScaleOffset(36n, conversion('1/16', .9)), 2.9);
  assert.equal(convertScaleOffset(36n, conversion('-1/16', .9)), -1.1);
  assert.equal(convertScaleOffset(-36n, conversion('-1/16')), 3);
  assert.equal(convertScaleOffset(36n, conversion('-0.0625')), -2);
  assert.equal(convertScaleOffset(0xffffffffn, conversion('-2')), -8589934590);
});

test('decimal and fractional arithmetic preserves integer boundaries without floating intermediate error', () => {
  assert.equal(3 * .3 + .1, .9999999999999999);
  assert.equal(convertScaleOffset(3n, conversion('.3', .1)), 1);
  assert.equal(convertScaleOffset(29n, conversion('.1', .1)), 3);
  assert.equal(convertScaleOffset(29n, conversion('1/10', .1)), 3);
  assert.equal(convertScaleOffset(10n, conversion('.1', -1)), 0);
  assert.equal(convertScaleOffset(7n, conversion('.01', -.03)), .04);
  assert.equal(convertScaleOffset(225n, conversion('1/100')), 2.25);
  assert.equal(convertScaleOffset(225n, conversion('0.01')), 2.25);
  assert.equal(convertScaleOffset(3n, conversion('0.01')), .03);
  assert.equal(convertScaleOffset(2251n, conversion('1e-3')), 2.251);
  assert.equal(convertScaleOffset(36n, conversion('3/16')), 6.75);
  assert.equal(convertScaleOffset(225n, conversion('0.01', .005)), 2.255); // Offset is not truncated either.
  assert.equal(convertScaleOffset(1n, conversion('1/3')), 1 / 3);
  assert.equal(convertScaleOffset(3n, conversion('1/3')), 1);
});

test('signed RAW uses arithmetic right shifts, not truncation of the final converted result', () => {
  assert.equal(convertScaleOffset(-36n, conversion('1/16')), -3);
  assert.equal(convertScaleOffset(36n, conversion('1/16', -5)), -3);
  assert.equal(convertScaleOffset(-1n, conversion('1/16')), -1);
  assert.equal(convertScaleOffset(-225n, conversion('0.01')), -2.25);
});

test('final numeric conversion rounds safely across large values, subnormals and scientific notation', () => {
  assert.equal(convertScaleOffset(1n, conversion('1e-3')), .001);
  assert.equal(convertScaleOffset(0n, conversion('1', 1e308)), 1e308);
  assert.equal(convertScaleOffset(0n, conversion('1', Number.MAX_VALUE)), Number.MAX_VALUE);
  assert.equal(convertScaleOffset(0n, conversion('1', Number.MIN_VALUE)), Number.MIN_VALUE);
  assert.equal(convertScaleOffset(9007199254740993n, conversion('3')), 27021597764222980);
  assert.equal(convertScaleOffset(9007199254740995n, conversion('3')), 27021597764222984);
  assert.ok(Number.isNaN(convertScaleOffset(9007199254740993n, conversion('1'))));
  assert.ok(Number.isNaN(convertScaleOffset(1n, conversion('1/0'))));
});

test('changing a Signal Scale invalidates cached arithmetic without a Frame setting', () => {
  const changing = conversion('1/16');
  assert.equal(convertScaleOffset(36n, changing), 2);
  Object.assign(changing, conversion('0.01'));
  assert.equal(convertScaleOffset(36n, changing), .36);
  Object.assign(changing, conversion('2', .1));
  assert.equal(convertScaleOffset(36n, changing), 72.1);
});
