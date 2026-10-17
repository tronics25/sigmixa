import test from 'node:test';
import assert from 'node:assert/strict';
import { packColumn, unpackColumn, packRows, unpackRows } from '../src/core/report/compactArrays';
import { packReportData, unpackReportData } from '../src/extension/report/reportPacking';
import type { ReportData } from '../src/extension/report/reportData';

/** What the report gets is what JSON would have carried: the packing must not change one value. */
const throughJson = <T>(value: T): unknown => JSON.parse(JSON.stringify(value));

test('a packed column gives back every value exactly, including timestamps that do not step evenly in binary', () => {
  const times = Array.from({ length: 10_000 }, (_, index) => index * 0.01 + (index % 997 === 0 ? 0.0003 : 0));
  const values = [7, 7, 7, 7, 1.1, 2.2, 3.3000000000000003, Number.NaN, null, 'Off', 'Off', 'On', 5, 5];
  for (const column of [times, values, [], [0], [0.1, 0.2, 0.30000000000000004, 0.4]]) {
    assert.deepEqual(unpackColumn(throughJson(packColumn(column)) as never), throughJson(column));
  }
  assert.ok(JSON.stringify(packColumn(Array.from({ length: 10_000 }, () => 7))).length < 40, 'a repeated value is one run');
});

test('packed rows keep every key of every row, and leave a missing key missing', () => {
  const rows = [{ timestamp: 0, value: 1, quality: 'valid' }, { timestamp: 0.01, value: 1 }, { timestamp: 0.02, value: 2, valueLabel: 'Drive', carried: true }, { timestamp: 0.03, value: 2, filterEvidence: { deltaSeconds: 0.01 } }];
  assert.deepEqual(unpackRows(throughJson(packRows(rows)) as never), throughJson(rows));
});

test('a whole report is rebuilt exactly as it was before packing, and its file is much smaller', () => {
  const samples = Array.from({ length: 50_000 }, (_, index) => ({ timestamp: index / 100, value: Math.floor(index / 1000), quality: 'valid' as const }));
  const data = { formatVersion: 1, kind: 'log', title: 't', generatedAt: '', appVersion: '', source: [], notices: [], comparison: { id: 'c', name: 'c', targets: [], graphs: [] }, targets: [], definitions: [], groups: [], availability: {},
    series: [{ targetId: 'log', items: [{ signalId: 's', series: { definition: { id: 's', name: 's', source: { type: 'manual-can', frameDefinitionId: 'f' } }, samples, events: [], totalSamplesInRange: samples.length, gaps: [] } }] }],
    table: { signalIds: ['s'], timestamps: samples.map((sample) => sample.timestamp), values: [samples.map((sample) => sample.value)], labels: {}, totalRows: samples.length } } as unknown as ReportData;
  const packed = JSON.stringify(packReportData(data));
  assert.deepEqual(unpackReportData(JSON.parse(packed)), throughJson(data));
  assert.ok(packed.length * 10 < JSON.stringify(data).length, `${packed.length} vs ${JSON.stringify(data).length}`);
});

test('large and unusual numbers come back exactly; where a run cannot hold them, they are stored as they are', () => {
  const cases: number[][] = [
    [9007199254740991, 1.6], [1.6, 9007199254740991], [9007199254740991, 9007199254740990, 9007199254740989],
    [1e300, 1e300, 1e300], [5e-324, 5e-324], [-0.000001, 0.000002, 0.000005], [123456789.123456, 123456789.123457],
    [0.1 + 0.2, 0.30000000000000004, 0.5000000000000001], [Number.MAX_VALUE, -Number.MAX_VALUE],
  ];
  // And many random ones: decimals of every length, and arbitrary doubles.
  let seed = 7; const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let round = 0; round < 300; round++) {
    const digits = Math.floor(random() * 12); const magnitude = 10 ** Math.floor(random() * 20 - 5);
    cases.push(Array.from({ length: 20 }, (_, index) => (random() < 0.5 ? Number((random() * magnitude).toFixed(digits)) : random() * magnitude * (index % 3 === 0 ? -1 : 1))));
  }
  for (const column of cases) assert.deepEqual(unpackColumn(throughJson(packColumn(column)) as never), throughJson(column), JSON.stringify(column));
});
