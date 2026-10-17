import test from 'node:test';
import assert from 'node:assert/strict';
import { reportCellLabel, reportTableCells, reportTableColumns, reportTableRows } from '../src/extension/report/reportTableCells';

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

test('a report table holds every Signal the report shows: the Table columns, then the graphed Signals', () => {
  const has = new Set(['pressure', 'speed', 'pedal', 'reference']); const known = (id: string) => id !== 'undefined-here';
  const columns = reportTableColumns(['speed', 'rpm', 'pressure'], ['pressure', 'speed'], ['pressure', 'pedal', 'reference', 'gear', 'undefined-here'], (id) => has.has(id), known);
  assert.deepEqual(columns.signalIds, ['pressure', 'speed', 'pedal', 'reference', 'rpm', 'gear'], 'with values first: the Table order, then the graphed ones; then those without');
  assert.deepEqual(columns.emptyIds, ['rpm', 'gear'], 'a Signal without data keeps its column, so missing data is seen; one without a definition has no name and is left out');
  assert.deepEqual(reportTableColumns([], undefined, ['pedal'], (id) => has.has(id), known).signalIds, ['pedal'], 'graphs alone make a table');
  assert.deepEqual(reportTableColumns([], undefined, [], (id) => has.has(id), known).signalIds, []);
});

test('Signals without rows of their own are added at their own times, never moved to another time', () => {
  const events = [{ timestamp: 1, values: new Map([['a', sample(10)]]) }, { timestamp: 2, values: new Map([['a', sample(20)]]) }, { timestamp: 2, values: new Map([['b', sample(5)]]) }];
  const rows = reportTableRows(events, [{ signalId: 'csv', samples: [{ timestamp: 0.5, value: 1 }, { timestamp: 2, value: 2 }, { timestamp: 2, value: 3 }, { timestamp: 9, value: 4, carried: true }] }]);
  assert.deepEqual(rows.map((row) => [row.timestamp, [...row.values].map(([id, value]) => `${id}=${value.value}`).join(' ')]),
    [[0.5, 'csv=1'], [1, 'a=10'], [2, 'a=20 csv=2'], [2, 'b=5'], [2, 'csv=3']], 'equal times share a row; a second sample at that time gets a row of its own; a carried point is not data');
  assert.deepEqual(reportTableRows(events, []).map((row) => row.timestamp), [1, 2, 2]);
});
