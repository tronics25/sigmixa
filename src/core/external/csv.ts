import type { Diagnostic } from '../diagnostics/diagnostic';
import type { ExternalCsvSourceDefinition } from '../project/schema';
import type { SignalDefinition, SignalSample } from '../signal/signal';
import { parseClockDateTime, timestampFromClockText, timestampFromDisplay, type TimeReference } from '../time/timeFormat';

export type TimestampUnit = 'seconds' | 'milliseconds' | 'microseconds';

export interface ExternalSignalSeries {
  readonly definition: SignalDefinition;
  readonly samples: readonly SignalSample[];
}

export interface ExternalCsvImportResult {
  readonly headers: readonly string[];
  readonly series: readonly ExternalSignalSeries[];
  readonly diagnostics: readonly Diagnostic[];
  readonly rowsRead: number;
}

/** Incremental RFC4180-style parser, including quoted commas, escaped quotes, CRLF, and quoted newlines. */
export class CsvRowParser {
  private row: string[] = [];
  private field = '';
  private quoted = false;
  private quotePending = false;
  private skipLf = false;
  private line = 1;

  push(chunk: string, final = false): Array<{ readonly values: string[]; readonly line: number }> {
    const rows: Array<{ values: string[]; line: number }> = [];
    for (const character of chunk) {
      if (this.skipLf) { this.skipLf = false; if (character === '\n') continue; }
      if (this.quoted) {
        if (this.quotePending) {
          if (character === '"') { this.field += '"'; this.quotePending = false; continue; }
          this.quoted = false; this.quotePending = false;
          if (character === ',') { this.endField(); continue; }
          if (character === '\r' || character === '\n') { rows.push(this.endRow()); if (character === '\r') this.skipLf = true; continue; }
          if (/\s/.test(character)) continue;
          this.field += character;
          continue;
        }
        if (character === '"') this.quotePending = true;
        else { this.field += character; if (character === '\n') this.line++; }
        continue;
      }
      if (character === '"' && this.field.length === 0) this.quoted = true;
      else if (character === ',') this.endField();
      else if (character === '\r' || character === '\n') { rows.push(this.endRow()); if (character === '\r') this.skipLf = true; }
      else this.field += character;
    }
    if (final) {
      if (this.quotePending) { this.quoted = false; this.quotePending = false; }
      if (this.field.length || this.row.length) rows.push(this.endRow());
    }
    return rows;
  }

  private endField(): void { this.row.push(this.field); this.field = ''; }
  private endRow(): { values: string[]; line: number } {
    this.endField(); const result = { values: this.row, line: this.line }; this.row = []; this.line++; return result;
  }
}

export class ExternalCsvCollector {
  private headers: string[] | undefined;
  private rowsReadValue = 0;
  private readonly diagnostics: Diagnostic[] = [];
  private readonly samples = new Map<string, SignalSample[]>();
  private readonly definitions = new Map<string, SignalDefinition>();
  private indexes: { timestamp: number; values: Array<{ index: number; id: string; column: string }> } | undefined;

  private readonly timeBase: ExternalCsvSourceDefinition['timeBase'];

  /** `reference`: the log's, which places relative, Unix and date-time CSV times on its axis. */
  constructor(private readonly source: ExternalCsvSourceDefinition, private readonly reference?: TimeReference) {
    this.timeBase = source.timeBase ?? 'log';
    if (!reference && this.timeBase === 'datetime') this.add('CSV_TIME_BASE_UNAVAILABLE', 'The log does not record its start date and time, so CSV dates and times cannot be placed on it.', 'error');
    else if (!reference && this.timeBase === 'unix') this.add('CSV_TIME_BASE_UNAVAILABLE', 'The log does not record its start date and time, so CSV Unix times are placed as the log\'s own seconds.', 'warning');
  }

  accept(rows: readonly { readonly values: readonly string[]; readonly line: number }[]): void {
    for (const row of rows) {
      if (!this.headers) { this.initialize(row.values, row.line); continue; }
      if (row.values.length === 1 && row.values[0] === '') continue;
      this.rowsReadValue++; this.acceptData(row.values, row.line);
    }
  }

  finish(): ExternalCsvImportResult {
    if (!this.headers) this.add('CSV_EMPTY', 'CSV file has no header row.', 'error');
    return {
      headers: this.headers ?? [],
      series: [...this.definitions.values()].map((definition) => ({ definition, samples: this.samples.get(definition.id) ?? [] })),
      diagnostics: this.diagnostics,
      rowsRead: this.rowsReadValue,
    };
  }

  private initialize(headers: readonly string[], line: number): void {
    this.headers = headers.map((header) => header.trim());
    const timestamp = this.headers.indexOf(this.source.timestampColumn);
    if (timestamp < 0) this.add('CSV_TIMESTAMP_COLUMN_MISSING', `Timestamp column “${this.source.timestampColumn}” was not found.`, 'error', line);
    const values: Array<{ index: number; id: string; column: string }> = [];
    for (const column of this.source.valueColumns) {
      const index = this.headers.indexOf(column.column);
      if (index < 0) { this.add('CSV_VALUE_COLUMN_MISSING', `Value column “${column.column}” was not found.`, 'error', line); continue; }
      const id = externalSignalId(this.source.id, column.column);
      this.definitions.set(id, { id, name: column.name.trim() || column.column, unit: column.unit?.trim() || undefined, source: { type: 'external-csv', sourceId: this.source.id, column: column.column } });
      this.samples.set(id, []); values.push({ index, id, column: column.column });
    }
    if (timestamp >= 0) this.indexes = { timestamp, values };
  }

  private acceptData(row: readonly string[], line: number): void {
    if (!this.indexes) return;
    const text = row[this.indexes.timestamp] ?? '';
    const placed = this.placeTimestamp(text);
    if (!placed) { if (!(this.timeBase === 'datetime' && !this.reference)) this.add('CSV_TIMESTAMP_INVALID', 'CSV row has an invalid Timestamp.', 'warning', line); return; }
    const { timestamp, original } = placed;
    for (const value of this.indexes.values) {
      const parsed = Number(row[value.index]);
      if (!Number.isFinite(parsed)) { this.add('CSV_VALUE_INVALID', `Column “${value.column}” has a non-numeric value.`, 'warning', line); continue; }
      this.samples.get(value.id)!.push({ timestamp, value: parsed, quality: 'valid', originalTimestamp: { value: original, unit: this.source.timestampUnit } });
    }
  }

  /** The row's time on the log's axis, and the number it was written as (seconds of the clock for a date and time). */
  private placeTimestamp(text: string): { timestamp: number; original: number } | undefined {
    if (this.timeBase === 'datetime') {
      if (!this.reference) return undefined;
      const timestamp = timestampFromClockText(text, this.reference); const written = parseClockDateTime(text);
      return timestamp === undefined || !written ? undefined : { timestamp, original: written.seconds };
    }
    const original = Number(text);
    if (!Number.isFinite(original)) return undefined;
    const seconds = normalizeTimestamp(original, this.source.timestampUnit);
    const timestamp = this.timeBase === 'relative' ? timestampFromDisplay(seconds, 'relative', this.reference) : this.timeBase === 'unix' ? timestampFromDisplay(seconds, 'unix', this.reference) : seconds;
    return { timestamp, original };
  }

  private add(code: string, message: string, severity: Diagnostic['severity'], line?: number): void {
    if (this.diagnostics.length >= 2000) return;
    this.diagnostics.push({ id: `csv:${this.source.id}:${code}:${line ?? 'global'}`, source: 'csv', code, severity, message, location: { sourceId: this.source.id, line }, details: { externalSourceId: this.source.id } });
  }
}

/**
 * How a CSV's times are most likely written, from its first time: dates and times, Unix seconds (from about 1973 on) or
 * seconds from the measurement start. The import dialog proposes it; the user can change it.
 */
export function suggestCsvTimeBase(text: string | undefined, unit: TimestampUnit): 'datetime' | 'unix' | 'relative' {
  if (text !== undefined && parseClockDateTime(text)) return 'datetime';
  const value = Number(text);
  return text !== undefined && text.trim() && Number.isFinite(value) && Math.abs(normalizeTimestamp(value, unit)) >= 1e8 ? 'unix' : 'relative';
}

export function normalizeTimestamp(value: number, unit: TimestampUnit): number {
  if (!Number.isFinite(value)) return Number.NaN;
  return value * (unit === 'seconds' ? 1 : unit === 'milliseconds' ? 1e-3 : 1e-6);
}

export function externalSignalId(sourceId: string, column: string): string {
  return `external:${encodeURIComponent(sourceId)}:${encodeURIComponent(column)}`;
}

export function importExternalCsvText(text: string, source: ExternalCsvSourceDefinition, reference?: TimeReference): ExternalCsvImportResult {
  const parser = new CsvRowParser(); const collector = new ExternalCsvCollector(source, reference);
  collector.accept(parser.push(text, true)); return collector.finish();
}
