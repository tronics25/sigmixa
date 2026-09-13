import test from 'node:test';
import assert from 'node:assert/strict';
import { commonDisplayUnit, convertDisplayUnit, preferredDisplayUnit, resolveDisplayUnit } from '../src/core/units/displayUnit';

test('compatible length and speed units resolve to common display axes', () => {
  const millimetres = resolveDisplayUnit('mm')!; const metres = resolveDisplayUnit('m')!;
  assert.equal(millimetres.family, metres.family); assert.equal(millimetres.displayUnit, 'm'); assert.equal(millimetres.convert(1250), 1.25);
  const kilometresPerHour = resolveDisplayUnit('km/h')!; const metresPerSecond = resolveDisplayUnit('m/s')!;
  assert.equal(kilometresPerHour.family, metresPerSecond.family); assert.equal(kilometresPerHour.convert(36), 10);
});

test('affine temperature conversion and unknown units remain explicit', () => {
  assert.equal(resolveDisplayUnit('°F')!.convert(32), 0);
  assert.ok(Math.abs(resolveDisplayUnit('K')!.convert(273.15)) < 1e-12);
  assert.equal(resolveDisplayUnit('custom-count'), undefined);
});

test('common engineering notation and spelling variants share their physical quantity', () => {
  for (const notation of ['m/s²', 'm/s^2', 'm/s2', 'mps2']) assert.equal(resolveDisplayUnit(notation)!.family, 'acceleration');
  assert.equal(resolveDisplayUnit('radian')!.displayUnit, 'deg');
  assert.ok(Math.abs(resolveDisplayUnit('rad')!.convert(Math.PI) - 180) < 1e-12);
  assert.equal(resolveDisplayUnit('N*m')!.displayUnit, 'Nm');
  assert.ok(Math.abs(resolveDisplayUnit('ft-lb')!.convert(1) - 1.3558179483) < 1e-12);
});

test('case-sensitive SI symbols do not confuse nanometres, torque, watts and megawatts', () => {
  assert.equal(resolveDisplayUnit('nm')!.family, 'length');
  assert.equal(resolveDisplayUnit('Nm')!.family, 'torque');
  assert.equal(resolveDisplayUnit('mW')!.convert(1), 1e-6);
  assert.equal(resolveDisplayUnit('MW')!.convert(1), 1e3);
});

test('physical quantity order is stable and independent of Signal selection order', () => {
  const order = ['m', 'm/s', 'm/s^2', 'm/s^3', 'deg', 'deg/s', 'rpm', 'Nm', 'kW', 'kPa', 'V', 'A'].map((unit) => resolveDisplayUnit(unit)!.order);
  assert.deepEqual(order, [...order].sort((left, right) => left - right));
});

test('a shared source unit is preserved and mixed compatible units use the canonical display unit', () => {
  assert.equal(preferredDisplayUnit(['km', 'km']), 'km');
  assert.equal(convertDisplayUnit(2.25, 'km', 'km'), 2.25);
  assert.equal(preferredDisplayUnit(['km', 'm']), 'm');
  assert.equal(convertDisplayUnit(2.25, 'km', 'm'), 2250);
  assert.equal(preferredDisplayUnit(['km/h', 'km/h']), 'km/h');
  assert.equal(convertDisplayUnit(36, 'km/h', 'km/h'), 36);
  assert.equal(preferredDisplayUnit(['°F', '°F']), '°F');
  assert.ok(Math.abs(convertDisplayUnit(0, '°C', 'K') - 273.15) < 1e-12);
  assert.deepEqual(commonDisplayUnit(['km', 'km']), { unit: 'km', family: 'length' });
  assert.deepEqual(commonDisplayUnit(['m', 'mm']), { unit: 'm', family: 'length' });
  assert.equal(commonDisplayUnit(['m', 's']), undefined);
  assert.equal(commonDisplayUnit(['m', undefined]), undefined);
});
