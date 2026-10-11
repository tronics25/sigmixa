import test from 'node:test';
import assert from 'node:assert/strict';
import { reportCellLabel, reportTableCells } from '../src/extension/report/reportTableCells';

const sample = (value: number, valueLabel?: string) => ({ timestamp: 0, value, ...(valueLabel ? { valueLabel } : {}) });

test('a value with one label keeps it once, for every row', () => {
  const cells = reportTableCells(['mode'], [[sample(1, 'Eco')], [sample(2, 'Sport')], [sample(1, 'Eco')]]);
  assert.deepEqual(cells.labels, { mode: { 1: 'Eco', 2: 'Sport' } }); assert.deepEqual(cells.rowLabels, {});
});

test('the same value labelled differently over time: every row shows its own label', () => {
  const rows = [[sample(0, 'Idle')], [sample(0, 'Fault')], [sample(0, 'Idle')], [sample(0)], [undefined]];
  const cells = reportTableCells(['state'], rows); const table = { signalIds: ['state'], ...cells };
  assert.deepEqual(rows.map((_, row) => reportCellLabel(table, 0, row)), ['Idle', 'Fault', 'Idle', undefined, undefined]);
});

test('a row without a label does not pick up the label a later row gives that value', () => {
  const rows = [[sample(3)], [sample(3, 'Third')], [sample(Number.NaN, 'ignored')]];
  const cells = reportTableCells(['gear'], rows); const table = { signalIds: ['gear'], ...cells };
  assert.deepEqual(rows.map((_, row) => reportCellLabel(table, 0, row)), [undefined, 'Third', undefined]); assert.deepEqual(cells.values, [[3, 3, null]]);
});

test('a report without row labels (made by an earlier build) reads as before', () => {
  assert.equal(reportCellLabel({ signalIds: ['a'], values: [[1]], labels: { a: { 1: 'One' } } }, 0, 0), 'One');
});
