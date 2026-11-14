import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import type { Diagnostic } from '../src/core/diagnostics/diagnostic';
import type { TimeReference } from '../src/core/time/timeFormat';
import { csvTimeColumn, nameAndUnit, parseCsvLogFile } from '../src/parsers/csv/parseCsvLog';
import type { MdfSignalSeries } from '../src/parsers/mdf/parseMdf';

async function read(text: string): Promise<{ diagnostics: Diagnostic[]; series: MdfSignalSeries[]; reference?: TimeReference }> {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'sigmixa-csv-')), 'log.csv'); writeFileSync(file, text);
  const diagnostics: Diagnostic[] = []; let series: MdfSignalSeries[] = []; let reference: TimeReference | undefined;
  await parseCsvLogFile(file, { sourceId: 'log.csv', onFrames: () => undefined, onDiagnostics: (items) => diagnostics.push(...items), onSignals: (items) => { series = [...items]; }, onTimeReference: (value) => { reference = value; } });
  return { diagnostics, series, reference };
}
const rows = (series: MdfSignalSeries[]) => series.map((item) => [item.channel, item.unit, Array.from(item.times), Array.from(item.values)]);

test('the time column is found by its name, else the first; its unit comes from its name', () => {
  assert.deepEqual(csvTimeColumn(['Speed', 'Time_ms', 'Temp']), { index: 1, unit: 1e-3 });
  assert.deepEqual(csvTimeColumn(['t [us]', 'Speed']), { index: 0, unit: 1e-6 });
  assert.deepEqual(csvTimeColumn(['Timestamp (ns)', 'V']), { index: 0, unit: 1e-9 });
  assert.deepEqual(csvTimeColumn(['Seconds', 'V']), { index: 0, unit: 1 });
});

test('a CSV log: each value column is a Signal with the unit in brackets; empty cells are gaps; a non-numeric column is an error', async () => {
  const { diagnostics, series, reference } = await read('Time_ms,Speed [km/h],Gear,Note\n0,10,1,ok\n500,,2,warm\n1000,12.5,3,\n');
  assert.deepEqual(rows(series), [['Speed', 'km/h', [0, 0.5, 1], [10, Number.NaN, 12.5]], ['Gear', undefined, [0, 0.5, 1], [1, 2, 3]]]);
  assert.deepEqual(diagnostics.map((item) => [item.code, item.severity]), [['CSV_COLUMN_NOT_NUMERIC', 'error']]);
  assert.match(diagnostics[0].message, /Note/);
  assert.equal(reference, undefined);
});

test('times written as dates and times, or as Unix seconds, are clock times with the first as the start', async () => {
  const dated = await read('Time,V\n2026-11-04 09:00:00.250,1\n2026-11-04 09:00:01.250,2\n');
  assert.deepEqual(rows(dated.series)[0][2], [Date.UTC(2026, 10, 4, 9, 0, 0, 250) / 1000, Date.UTC(2026, 10, 4, 9, 0, 1, 250) / 1000]);
  assert.equal(dated.reference?.start, Date.UTC(2026, 10, 4, 9, 0, 0, 250) / 1000); assert.equal(dated.reference?.offset, 0);
  const unix = await read('timestamp,V\n1700000000,1\n1700000001,2\n');
  assert.equal(unix.reference?.start, 1_700_000_000);
});

test('rows without a readable time are reported and left out; an empty file or one without values is an error', async () => {
  const skipped = await read('Time,V\n0,1\nx,2\n1,3\n');
  assert.deepEqual(rows(skipped.series), [['V', undefined, [0, 1], [1, 3]]]);
  assert.deepEqual(skipped.diagnostics.map((item) => item.code), ['CSV_TIME_INVALID']);
  assert.deepEqual((await read('')).diagnostics.map((item) => item.code), ['CSV_EMPTY']);
  assert.deepEqual((await read('Time\n0\n1\n')).diagnostics.map((item) => item.code), ['CSV_NO_VALUES']);
});

test('a Japanese time name followed by its unit is the time column; units in brackets are read from long names quickly', () => {
  assert.deepEqual(csvTimeColumn(['Speed', '時刻 [ms]']), { index: 1, unit: 1e-3 });
  assert.deepEqual(nameAndUnit('Speed [km/h]'), { channel: 'Speed', unit: 'km/h' });
  assert.deepEqual(nameAndUnit('Speed (rpm)'), { channel: 'Speed', unit: 'rpm' });
  assert.deepEqual(nameAndUnit('[V]'), { channel: '[V]', unit: 'V' });
  assert.deepEqual(nameAndUnit('Speed []'), { channel: 'Speed []' });
  const started = Date.now(); nameAndUnit(`A${'['.repeat(1_000_000)}`); nameAndUnit(`A${'['.repeat(1_000_000)}]`);
  assert.ok(Date.now() - started < 1000);
});

test('an unreadable first time does not decide how the times are written; signals are named by column alone', async () => {
  const { series, diagnostics, reference } = await read('Time,V\nbad,0\n2026-11-04 09:00:00,1\n2026-11-04 09:00:01,2\n');
  assert.deepEqual(rows(series), [['V', undefined, [Date.UTC(2026, 10, 4, 9) / 1000, Date.UTC(2026, 10, 4, 9, 0, 1) / 1000], [1, 2]]]);
  assert.deepEqual(diagnostics.map((item) => item.code), ['CSV_TIME_INVALID']);
  assert.equal(reference?.start, Date.UTC(2026, 10, 4, 9) / 1000);
  assert.deepEqual(series.map((item) => item.group), ['']);
});

test('a header of many columns does not reserve memory ahead of the values', async () => {
  const { series } = await read(`Time,${Array.from({ length: 100_000 }, (_, index) => `c${index}`).join(',')}\n0,${'1,'.repeat(99_999)}1\n`);
  assert.equal(series.length, 100_000); assert.ok(series[0].times.buffer.byteLength <= 16 * 8);
});

test('a cancel while pausing after the last chunk stops the read: no signals, reported as cancelled', async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'sigmixa-csv-')), 'log.csv'); writeFileSync(file, 'Time,V\n0,1\n1,2\n');
  const controller = new AbortController(); let signals = 0;
  const result = await parseCsvLogFile(file, { sourceId: 'log.csv', signal: controller.signal, onFrames: () => undefined, onDiagnostics: () => undefined, onSignals: () => { signals++; }, onProgress: () => controller.abort() });
  assert.equal(result.cancelled, true); assert.equal(signals, 0);
});

test('times written with a changing UTC offset keep their real distance, on the first time\'s clock', async () => {
  const { series, reference } = await read('Time,V\n2026-11-01 01:59:59-04:00,1\n2026-11-01 01:00:00-05:00,2\n');
  assert.deepEqual(rows(series)[0][2].map((time) => time - (rows(series)[0][2][0] as number)), [0, 1]);
  assert.equal(reference?.utcOffsetMinutes, -240);
});
