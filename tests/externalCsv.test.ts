import test from 'node:test';
import assert from 'node:assert/strict';
import { importExternalCsvText, normalizeTimestamp } from '../src/core/external/csv';
import type { ExternalCsvSourceDefinition } from '../src/core/project/schema';

const source: ExternalCsvSourceDefinition = {
  id: 'reference', path: 'reference.csv', fileName: 'reference.csv', timestampColumn: 'Time ms', timestampUnit: 'milliseconds',
  valueColumns: [{ column: 'Reference, Speed', name: 'Reference Speed', unit: 'km/h' }, { column: 'Temperature', name: 'Reference Temperature', unit: '°C' }],
};

test('External CSV imports quoted multiple value columns and preserves non-zero original Timestamps', () => {
  const result = importExternalCsvText('Time ms,"Reference, Speed",Temperature\r\n5000,10,20\r\n5250,12.5,21\r\n', source);
  assert.equal(result.diagnostics.length, 0); assert.equal(result.series.length, 2);
  assert.deepEqual(result.series[0].samples.map((sample) => sample.timestamp), [5, 5.25]);
  assert.deepEqual(result.series[0].samples.map((sample) => sample.originalTimestamp), [{ value: 5000, unit: 'milliseconds' }, { value: 5250, unit: 'milliseconds' }]);
  assert.deepEqual(result.series[1].samples.map((sample) => sample.value), [20, 21]);
});

test('Timestamp normalization supports seconds, milliseconds, and microseconds without rebasing', () => {
  assert.equal(normalizeTimestamp(12.5, 'seconds'), 12.5);
  assert.equal(normalizeTimestamp(12_500, 'milliseconds'), 12.5);
  assert.equal(normalizeTimestamp(12_500_000, 'microseconds'), 12.5);
});

test('invalid CSV Timestamp and values produce visible Diagnostics without synthetic samples', () => {
  const result = importExternalCsvText('Time ms,"Reference, Speed",Temperature\ninvalid,10,20\n5250,bad,21\n', source);
  assert.deepEqual(result.diagnostics.map((item) => item.code), ['CSV_TIMESTAMP_INVALID', 'CSV_VALUE_INVALID']);
  assert.equal(result.series[0].samples.length, 0); assert.deepEqual(result.series[1].samples.map((sample) => sample.timestamp), [5.25]);
});
