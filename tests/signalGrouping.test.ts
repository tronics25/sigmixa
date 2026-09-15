import test from 'node:test';
import assert from 'node:assert/strict';
import { signalUnitGroup } from '../src/webview/shared/signalGrouping';

test('selector attributes follow graph unit compatibility, including aliases and SI case', () => {
  assert.equal(signalUnitGroup('km/h').key, signalUnitGroup('MPh').key);
  assert.equal(signalUnitGroup('deg').key, signalUnitGroup('radian').key);
  assert.equal(signalUnitGroup('MPa').key, signalUnitGroup('psi').key);
  assert.equal(signalUnitGroup('m/s^2').key, signalUnitGroup('m/s²').key);
  assert.notEqual(signalUnitGroup('m/s').key, signalUnitGroup('m/s^2').key);
  assert.notEqual(signalUnitGroup('nm').key, signalUnitGroup('Nm').key);
});

test('descriptive unit groups retain their meaning and do not join unrelated unitless data', () => {
  assert.equal(signalUnitGroup('  指令値  ').label, '指令値');
  assert.notEqual(signalUnitGroup('係数').key, signalUnitGroup('指令値').key);
  assert.notEqual(signalUnitGroup('係数').key, signalUnitGroup(undefined).key);
  assert.equal(signalUnitGroup(' ').key, signalUnitGroup(undefined).key);
  assert.ok(signalUnitGroup('係数').order > signalUnitGroup('bar').order);
});
