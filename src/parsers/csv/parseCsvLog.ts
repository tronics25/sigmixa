import { createReadStream, promises as fs } from 'fs';
import * as path from 'path';
import type { Diagnostic } from '../../core/diagnostics/diagnostic';
import { CsvRowParser } from '../../core/external/csv';
import { parseClockDateTime, type TimeReference } from '../../core/time/timeFormat';
import { ReadBudget } from '../readBudget';
import type { MdfParseOptions, MdfParseSummary, MdfSignalSeries } from '../mdf/parseMdf';

/**
 * A CSV file opened as a log, as an MDF file of measured signals is: a header row, a time column and value columns, each
 * a Signal. The time column is the one named like a time (time, timestamp, 時刻, ...), else the first; its unit comes from
 * its name (`_ms`, `[us]`, ...; seconds otherwise). Times written as dates and times, or as Unix seconds, are clock times.
 * A column holding anything but numbers (empty cells aside) is reported as an error and not imported.
 */

export function isCsvLogFileName(name: string): boolean { return /\.csv$/i.test(name); }

type Unit = 1 | 1e-3 | 1e-6 | 1e-9;

/** The time column and its unit, from the header. */
export function csvTimeColumn(headers: readonly string[]): { readonly index: number; readonly unit: Unit } {
  const named = headers.findIndex((header) => /^\s*(time|timestamp|zeit|temps|時刻|時間|タイムスタンプ)(?![A-Za-z0-9_])/i.test(header) || /(^|[\s_[(])(time|timestamp)([\s_\])]|$)/i.test(header));
  const index = named >= 0 ? named : 0;
  const header = headers[index] ?? '';
  const unit: Unit = /(^|[\s_[(/])(ns|nanoseconds?)([\s_\])]|$)/i.test(header) ? 1e-9
    : /(^|[\s_[(/])(us|µs|μs|microseconds?)([\s_\])]|$)/i.test(header) ? 1e-6
      : /(^|[\s_[(/])(ms|milliseconds?)([\s_\])]|$)/i.test(header) ? 1e-3 : 1;
  return { index, unit };
}

/** A unit in brackets after the name: "Speed [km/h]" or "Speed (km/h)". Read without a regular expression, so a long header cannot stall it. */
export function nameAndUnit(header: string): { readonly channel: string; readonly unit?: string } {
  const name = header.trim(); const close = name[name.length - 1];
  const open = close === ']' ? name.lastIndexOf('[') : close === ')' ? name.lastIndexOf('(') : -1;
  const unit = open >= 0 ? name.slice(open + 1, -1).trim() : '';
  if (!unit || /[\])]/.test(unit)) return { channel: name };
  return { channel: name.slice(0, open).trim() || name, unit };
}

class Column {
  // Small to start with: a file can have many columns, and each grows only with its own values.
  times = new Float64Array(16); values = new Float64Array(16); length = 0;
  push(time: number, value: number): void {
    if (this.length === this.times.length) {
      const times = new Float64Array(this.length * 2); times.set(this.times); this.times = times;
      const values = new Float64Array(this.length * 2); values.set(this.values); this.values = values;
    }
    this.times[this.length] = time; this.values[this.length++] = value;
  }
}

export async function parseCsvLogFile(filePath: string, options: MdfParseOptions): Promise<MdfParseSummary> {
  const totalBytes = (await fs.stat(filePath)).size;
  let diagnostics = 0;
  const report = (code: string, severity: Diagnostic['severity'], message: string, line?: number, details?: Diagnostic['details']) => {
    diagnostics++;
    options.onDiagnostics([{ id: `${options.sourceId}:csv:${code}:${details?.column ?? line ?? diagnostics}`, source: 'parser', code, severity, message, location: { sourceId: options.sourceId, ...(line !== undefined ? { line } : {}) }, ...(details ? { details } : {}) }]);
  };
  const parser = new CsvRowParser();
  // Signals are named by their column alone, so they keep their IDs (and the settings using them) when the file is renamed.
  const group = '';
  let headers: string[] | undefined; let time = { index: 0, unit: 1 as Unit };
  let columns: (Column | undefined)[] = [];
  /** How times are written, from the first one: clock text, Unix seconds or seconds from the start. */
  let clock: 'text' | 'unix' | 'relative' | undefined;
  let reference: TimeReference | undefined;
  let bytesRead = 0; let rowsRead = 0; let badTimes = 0;
  const rejected = new Set<number>();
  const take = (rows: readonly { readonly values: string[]; readonly line: number }[]) => {
    for (const { values, line } of rows) {
      if (!headers) {
        headers = values.map((value) => value.trim());
        time = csvTimeColumn(headers);
        columns = headers.map((_, index) => index === time.index ? undefined : new Column());
        continue;
      }
      if (values.length === 1 && !values[0].trim()) continue;
      const text = (values[time.index] ?? '').trim();
      // The first readable time tells how times are written; an unreadable one decides nothing (and is reported below).
      const written = clock === undefined || clock === 'text' ? parseClockDateTime(text) : undefined;
      if (clock === undefined && text && (written || Number.isFinite(Number(text)))) {
        const start = written ? written.seconds : Number(text) * time.unit;
        clock = written ? 'text' : Math.abs(start) >= 1e8 ? 'unix' : 'relative';
        if (clock !== 'relative' && Number.isFinite(start)) { reference = { start, offset: 0, ...(written?.utcOffsetMinutes !== undefined ? { utcOffsetMinutes: written.utcOffsetMinutes } : {}) }; options.onTimeReference?.(reference); }
      }
      // A time written with another UTC offset than the first (a change to or from daylight saving time) is put on the
      // first one's clock, so times keep their real distance.
      const shift = written?.utcOffsetMinutes !== undefined && reference?.utcOffsetMinutes !== undefined ? (reference.utcOffsetMinutes - written.utcOffsetMinutes) * 60 : 0;
      const seconds = clock === 'text' ? (written ? written.seconds + shift : Number.NaN) : clock && text ? Number(text) * time.unit : Number.NaN;
      if (!Number.isFinite(seconds)) { if (badTimes++ < 100) report('CSV_TIME_INVALID', 'warning', `Row ${line} has no readable time in column “${headers[time.index]}”; the row was not imported.`, line); continue; }
      rowsRead++;
      for (let index = 0; index < columns.length; index++) {
        const column = columns[index]; if (!column) continue;
        const cell = (values[index] ?? '').trim();
        // An empty cell is a gap in the line; anything but a number makes the column unusable.
        if (!cell) { column.push(seconds, Number.NaN); continue; }
        const value = Number(cell);
        if (Number.isFinite(value)) { column.push(seconds, value); continue; }
        columns[index] = undefined; rejected.add(index);
        report('CSV_COLUMN_NOT_NUMERIC', 'error', `Column “${headers[index]}” holds a value that is not a number (“${cell.length > 40 ? `${cell.slice(0, 40)}…` : cell}”, row ${line}); the column was not imported.`, line, { column: headers[index] });
      }
    }
  };
  const stream = createReadStream(filePath, { encoding: 'utf8', highWaterMark: 1 << 20 });
  let cancelled = false; const budget = new ReadBudget(options.signal);
  try {
    for await (const chunk of stream) {
      if (budget.cancelled) { cancelled = true; break; }
      bytesRead += Buffer.byteLength(chunk as string); take(parser.push(chunk as string));
      options.onProgress?.({ framesParsed: 0, bytesRead, totalBytes });
      await budget.pause();
    }
    // A cancel during the last pause (after the last chunk) counts too.
    if (!cancelled && budget.cancelled) cancelled = true;
    if (!cancelled) take(parser.push('', true));
  } finally { stream.destroy(); }
  if (badTimes > 100) report('CSV_TIME_INVALID_MORE', 'warning', `${badTimes - 100} more rows had no readable time.`);
  if (!headers) report('CSV_EMPTY', 'error', 'The CSV file is empty: it needs a header row and rows of values.');
  else if (!rowsRead) report('CSV_NO_ROWS', 'error', `The CSV file has no rows with a readable time in column “${headers[time.index]}”.`);
  const series: MdfSignalSeries[] = [];
  columns.forEach((column, index) => {
    if (!column || !column.length || !headers) return;
    const name = headers[index] || `Column ${index + 1}`;
    const { channel, unit } = nameAndUnit(name);
    series.push({ group, channel, ...(unit ? { unit } : {}), times: column.times.slice(0, column.length), values: column.values.slice(0, column.length) });
  });
  if (!cancelled && series.length) options.onSignals?.(series);
  else if (!cancelled && headers && rowsRead && !rejected.size) report('CSV_NO_VALUES', 'error', 'The CSV file has no value columns besides its time column.');
  return { totalBytes, bytesRead: cancelled ? bytesRead : totalBytes, linesRead: 0, framesParsed: 0, diagnostics, cancelled, ...(reference ? { timeReference: reference } : {}) };
}
