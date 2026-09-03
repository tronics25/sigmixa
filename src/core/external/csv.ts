import type { Diagnostic } from '../diagnostics/diagnostic';
import type { ExternalCsvSourceDefinition } from '../project/schema';
import type { SignalDefinition, SignalSample } from '../signal/signal';

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

  constructor(private readonly source: ExternalCsvSourceDefinition) {}

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
    const original = Number(row[this.indexes.timestamp]);
    if (!Number.isFinite(original)) { this.add('CSV_TIMESTAMP_INVALID', 'CSV row has an invalid Timestamp.', 'warning', line); return; }
    const timestamp = normalizeTimestamp(original, this.source.timestampUnit);
    for (const value of this.indexes.values) {
      const parsed = Number(row[value.index]);
      if (!Number.isFinite(parsed)) { this.add('CSV_VALUE_INVALID', `Column “${value.column}” has a non-numeric value.`, 'warning', line); continue; }
      this.samples.get(value.id)!.push({ timestamp, value: parsed, quality: 'valid', originalTimestamp: { value: original, unit: this.source.timestampUnit } });
    }
  }

  private add(code: string, message: string, severity: Diagnostic['severity'], line?: number): void {
    if (this.diagnostics.length >= 2000) return;
    this.diagnostics.push({ id: `csv:${this.source.id}:${code}:${line ?? 'global'}`, source: 'csv', code, severity, message, location: { sourceId: this.source.id, line }, details: { externalSourceId: this.source.id } });
  }
}

export function normalizeTimestamp(value: number, unit: TimestampUnit): number {
  if (!Number.isFinite(value)) return Number.NaN;
  return value * (unit === 'seconds' ? 1 : unit === 'milliseconds' ? 1e-3 : 1e-6);
}

export function externalSignalId(sourceId: string, column: string): string {
  return `external:${encodeURIComponent(sourceId)}:${encodeURIComponent(column)}`;
}

export function importExternalCsvText(text: string, source: ExternalCsvSourceDefinition): ExternalCsvImportResult {
  const parser = new CsvRowParser(); const collector = new ExternalCsvCollector(source);
  collector.accept(parser.push(text, true)); return collector.finish();
}
