import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { displaySeconds, effectiveTimeMode, formatClockDateTime, formatClockTime, formatExportTime, formatTimeRange, parseAscDate, parseClockDateTime, timeColumnLabel, timestampFromClockText, timestampFromDisplay, type TimeReference } from '../src/core/time/timeFormat';
import { parseAscLine } from '../src/parsers/asc/ascLineParser';
import { parseAscFile } from '../src/parsers/asc/parseAscStream';
import { parseBlfBuffer } from '../src/parsers/blf/parseBlf';
import { importExternalCsvText, suggestCsvTimeBase } from '../src/core/external/csv';
import type { CanFrame } from '../src/core/frame/canFrame';
import type { ExternalCsvSourceDefinition } from '../src/core/project/schema';

const start = Date.UTC(2024, 11, 31, 14, 9, 43, 491) / 1000;
const blf: TimeReference = { start, offset: 0 };
const asc: TimeReference = { start, offset: start };

test('ASC date lines are read as recorded, with or without weekday, fraction and am/pm', () => {
  assert.equal(parseAscDate('date Sun Aug 30 12:00:00.000 2026'), Date.UTC(2026, 7, 30, 12) / 1000);
  assert.equal(parseAscDate('date Tue Dec 31 02:09:43.491 pm 2024'), start);
  assert.equal(parseAscDate('date Thu Jan 1 12:00:00 am 1970'), 0);
  assert.equal(parseAscDate('date Mi Okt 24 08:15:30.250 2018'), Date.UTC(2018, 9, 24, 8, 15, 30, 250) / 1000);
  for (const line of ['date', 'date Sun Feb 30 12:00:00 2026', 'date Sun Aug 30 25:00:00 2026', 'date Sun Xyz 30 12:00:00 2026', 'date Sun Aug 30 13:00:00 pm 2026']) assert.equal(parseAscDate(line), undefined, line);
});

test('the ASC parser reports a date line before frames as its time reference, and nothing without one', async () => {
  assert.deepEqual(parseAscLine('date Sun Aug 30 12:00:00.000 2026', { sourceId: 's', line: 1, sequence: 0, base: 'hex' }), { type: 'date', start: Date.UTC(2026, 7, 30, 12) / 1000 });
  assert.deepEqual(parseAscLine('date unreadable', { sourceId: 's', line: 1, sequence: 0, base: 'hex' }), { type: 'ignored' });
  const seen: TimeReference[] = []; const frames: CanFrame[] = [];
  const summary = await parseAscFile('sample/sigmixa-basic.asc', { sourceId: 'basic', onFrames: (items) => { frames.push(...items); }, onTimeReference: (reference) => { assert.equal(frames.length, 0); seen.push(reference); } });
  const expected = Date.UTC(2026, 7, 30, 12) / 1000;
  assert.deepEqual(seen, [{ start: expected, offset: expected }]); assert.deepEqual(summary.timeReference, seen[0]);
  // Frame timestamps themselves stay relative: Clips saved with them keep their meaning.
  assert.ok(frames[0].timestamp < 100);
});

test('the BLF parser reports its header start; its timestamps already are clock seconds', () => {
  // The python-can fixture of the reported issue: a header start of 2024-12-31 14:09:40.222.
  const seen: TimeReference[] = []; const frames: CanFrame[] = [];
  const summary = parseBlfBuffer(readFileSync('tests/fixtures/python-can/issue_1905.blf'), { sourceId: 'issue', onFrames: (items) => { frames.push(...items); }, onDiagnostics: () => undefined, onTimeReference: (reference) => seen.push(reference) });
  assert.deepEqual(seen, [{ start: Date.UTC(2024, 11, 31, 14, 9, 40, 222) / 1000, offset: 0 }]); assert.deepEqual(summary.timeReference, seen[0]);
  assert.ok(frames.length > 0 && frames[0].timestamp >= seen[0].start && frames[0].timestamp - seen[0].start < 100);
  assert.match(formatExportTime(frames[0].timestamp, 'datetime', seen[0], String), /^2024-12-31 14:09:\d{2}\.\d{6}$/);
  // A header without a start (the sample's) gives none: its times are shown as seconds, as before.
  const sample = parseBlfBuffer(readFileSync('sample/sigmixa-basic.blf'), { sourceId: 'basic', onFrames: () => undefined, onDiagnostics: () => undefined, onTimeReference: () => assert.fail('no start expected') });
  assert.equal(sample.timeReference, undefined);
});

test('BLF and ASC logs of the same recording show the same relative seconds, date and time, and Unix seconds', () => {
  const blfTimestamp = start + 12.345678; const ascTimestamp = 12.345678;
  for (const mode of ['relative', 'datetime', 'unix'] as const) assert.ok(Math.abs(displaySeconds(blfTimestamp, mode, blf) - displaySeconds(ascTimestamp, mode, asc)) < 1e-6, mode);
  assert.equal(formatExportTime(blfTimestamp, 'datetime', blf, String), '2024-12-31 14:09:55.836678');
  assert.equal(formatExportTime(ascTimestamp, 'datetime', asc, String), '2024-12-31 14:09:55.836678');
  assert.equal(formatExportTime(ascTimestamp, 'relative', asc, (value) => value.toFixed(6)), '12.345678');
  assert.equal(formatExportTime(blfTimestamp, 'unix', blf, (value) => value.toFixed(6)), (start + 12.345678).toFixed(6));
  for (const mode of ['relative', 'datetime', 'unix'] as const) assert.ok(Math.abs(timestampFromDisplay(displaySeconds(ascTimestamp, mode, asc), mode, asc) - ascTimestamp) < 1e-6, mode);
});

test('without a known start only seconds are shown, exactly as the timestamps are', () => {
  assert.equal(effectiveTimeMode('datetime', undefined), 'relative');
  assert.equal(effectiveTimeMode(undefined, asc), 'datetime');
  assert.equal(formatExportTime(3.5, 'datetime', undefined, String), '3.5');
  assert.equal(timeColumnLabel('datetime', undefined), 'TIME(S)'); assert.equal(timeColumnLabel('datetime', asc), 'TIME'); assert.equal(timeColumnLabel('unix', asc), 'TIME (UNIX S)');
});

test('clock text rounds with carries and keeps narrow forms short', () => {
  assert.equal(formatClockDateTime(Date.UTC(2024, 11, 31, 23, 59, 59) / 1000 + 0.9999996), '2025-01-01 00:00:00.000000');
  assert.equal(formatClockTime(start + 0.0004, 3), '14:09:43.491');
  assert.equal(formatClockTime(start), '14:09:43.491000');
  assert.equal(formatTimeRange(start, start + 9.509, 'datetime', blf), '2024-12-31 14:09:43.491–14:09:53.000');
  assert.equal(formatTimeRange(start, start + 86_400, 'datetime', blf), '2024-12-31 14:09:43.491–2025-01-01 14:09:43.491');
  assert.equal(formatTimeRange(1.5, 9.5, 'relative', asc), '1.500–9.500 s');
  // The date belongs to the written time: half a second before midnight is still that day.
  const late = Date.UTC(2024, 11, 31, 23, 59, 59, 600) / 1000;
  assert.equal(formatTimeRange(late, late + 0.1, 'datetime', blf), '2024-12-31 23:59:59.600–23:59:59.700');
  assert.equal(formatTimeRange(late, late + 0.3999999, 'datetime', blf), '2024-12-31 23:59:59.600–2025-01-01 00:00:00.000');
});

test('a known UTC offset is written with the date and time, and makes Unix seconds true UTC', () => {
  const mdf: TimeReference = { start, offset: start, utcOffsetMinutes: 540 };
  assert.equal(formatExportTime(0, 'datetime', mdf, String), '2024-12-31 14:09:43.491000+09:00');
  assert.ok(Math.abs(displaySeconds(0, 'unix', mdf) - (start - 9 * 3600)) < 1e-6);
  assert.ok(Math.abs(timestampFromClockText('2024-12-31T05:09:43.491Z', mdf)!) < 1e-6);
  // BLF and ASC record no time zone: a written offset is taken as written.
  assert.ok(Math.abs(timestampFromClockText('2024-12-31 14:09:43.491+01:00', asc)!) < 1e-6);
  assert.deepEqual(parseClockDateTime('2024-12-31 14:09:43.5-05:30'), { seconds: start + 0.009, utcOffsetMinutes: -330 });
  assert.equal(parseClockDateTime('2024-02-30 00:00:00'), undefined);
});

const csv = (timeBase: ExternalCsvSourceDefinition['timeBase'], unit: ExternalCsvSourceDefinition['timestampUnit'] = 'seconds'): ExternalCsvSourceDefinition => ({
  id: 'csv', path: 'a.csv', fileName: 'a.csv', timestampColumn: 'TIME', timestampUnit: unit, ...(timeBase ? { timeBase } : {}), valueColumns: [{ column: 'Speed', name: 'Speed' }],
});
const times = (text: string, source: ExternalCsvSourceDefinition, reference?: TimeReference) => importExternalCsvText(text, source, reference).series[0].samples.map((sample) => sample.timestamp);
const near = (actual: readonly number[], expected: readonly number[]) => { assert.equal(actual.length, expected.length); actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-6, `${value} ≠ ${expected[index]}`)); };

test('External CSV times land on the same log moment whether written relative, as Unix seconds or as dates', () => {
  for (const reference of [blf, asc]) {
    const expected = [timestampFromDisplay(1.5, 'relative', reference)];
    near(times('TIME,Speed\n1.5,10\n', csv('relative'), reference), expected);
    near(times(`TIME,Speed\n${(start + 1.5).toFixed(6)},10\n`, csv('unix'), reference), expected);
    near(times(`TIME,Speed\n${((start + 1.5) * 1000).toFixed(3)},10\n`, csv('unix', 'milliseconds'), reference), expected);
    near(times('TIME,Speed\n2024-12-31 14:09:44.991000,10\n', csv('datetime'), reference), expected);
  }
});

test('External CSV sources saved before the choice keep the log’s own time', () => {
  near(times('TIME,Speed\n1.5,10\n', csv(undefined), blf), [1.5]);
  near(times('TIME,Speed\n1.5,10\n', csv('log'), asc), [1.5]);
});

test('CSV dates cannot be placed on a log without a start, and say so once', () => {
  const result = importExternalCsvText('TIME,Speed\n2024-12-31 14:09:44,10\n2024-12-31 14:09:45,11\n', csv('datetime'));
  assert.deepEqual(result.diagnostics.map((item) => item.code), ['CSV_TIME_BASE_UNAVAILABLE']); assert.equal(result.series[0].samples.length, 0);
});

test('the CSV time format is proposed from the first time', () => {
  assert.equal(suggestCsvTimeBase('2024-12-31 14:09:43.491113', 'seconds'), 'datetime');
  assert.equal(suggestCsvTimeBase('1735654183.491113', 'seconds'), 'unix');
  assert.equal(suggestCsvTimeBase('1735654183491', 'milliseconds'), 'unix');
  assert.equal(suggestCsvTimeBase('12.5', 'seconds'), 'relative');
  assert.equal(suggestCsvTimeBase(undefined, 'seconds'), 'relative');
});
