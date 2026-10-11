import test from 'node:test';
import assert from 'node:assert/strict';
import { isCellBlock, matchChoice, parseCopiedCells } from '../src/core/manual/tablePaste';

test('copied cells are rows on lines and cells between tabs', () => {
  assert.deepEqual(parseCopiedCells('Speed\t0\t16\r\nTorque\t16\t12\r\n'), [['Speed', '0', '16'], ['Torque', '16', '12']]);
  assert.deepEqual(parseCopiedCells('Speed'), [['Speed']]);
  assert.deepEqual(parseCopiedCells('a\t\tc'), [['a', '', 'c']], 'an empty cell keeps its place');
  assert.deepEqual(parseCopiedCells(''), []);
});

test('a quoted cell may hold tabs, line breaks and quotes', () => {
  assert.deepEqual(parseCopiedCells('"two\nlines"\t"say ""hi"""\nnext\t1'), [['two\nlines', 'say "hi"'], ['next', '1']]);
});

test('one cell is typed, several cells are spread', () => {
  assert.equal(isCellBlock('Speed'), false); assert.equal(isCellBlock('Speed\n'), false);
  assert.equal(isCellBlock('Speed\tkm/h'), true); assert.equal(isCellBlock('Speed\nTorque'), true);
});

test('a choice is named by its value or its label', () => {
  const choices = [{ value: 'little', label: 'Intel' }, { value: 'big', label: 'Motorola' }];
  assert.equal(matchChoice('Motorola', choices), 'big'); assert.equal(matchChoice(' BIG ', choices), 'big');
  assert.equal(matchChoice('other', choices), undefined); assert.equal(matchChoice('', choices), undefined);
});
