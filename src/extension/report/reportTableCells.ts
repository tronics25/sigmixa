import type { SignalSample } from '../../core/signal/signal';
import type { ReportTable } from './reportData';

/**
 * The cells of a report table, column by column. A value's label is kept once per value. Where a later row gives the same
 * value another label (a Plugin may do that), that row keeps its own label, so no row ever shows another row's label.
 */
export function reportTableCells(signalIds: readonly string[], rows: readonly (readonly (SignalSample | undefined)[])[]): Pick<ReportTable, 'values' | 'labels'> & { rowLabels: Record<string, Record<string, string>> } {
  const labels: Record<string, Record<string, string>> = {}; const rowLabels: Record<string, Record<string, string>> = {};
  const values = signalIds.map((id, column) => rows.map((row, rowIndex) => {
    const sample = row[column]; if (!sample || !Number.isFinite(sample.value)) return null;
    const key = String(sample.value); const known = labels[id]?.[key];
    if (sample.valueLabel) { if (known === undefined) (labels[id] ??= {})[key] = sample.valueLabel; else if (known !== sample.valueLabel) (rowLabels[id] ??= {})[String(rowIndex)] = sample.valueLabel; }
    // A row without a label, for a value that has one elsewhere, says so with an empty label of its own.
    else if (known !== undefined) (rowLabels[id] ??= {})[String(rowIndex)] = '';
    return sample.value;
  }));
  // A value first seen without a label and labelled later: the earlier rows must not pick that label up.
  for (const [id, byValue] of Object.entries(labels)) {
    const column = signalIds.indexOf(id);
    rows.forEach((row, rowIndex) => { const sample = row[column]; if (sample && Number.isFinite(sample.value) && !sample.valueLabel && byValue[String(sample.value)] !== undefined) (rowLabels[id] ??= {})[String(rowIndex)] = ''; });
  }
  return { values, labels, rowLabels };
}

/** The label a cell shows: the row's own when it has one, otherwise the value's. */
export function reportCellLabel(table: Pick<ReportTable, 'signalIds' | 'values' | 'labels' | 'rowLabels'>, column: number, row: number): string | undefined {
  const value = table.values[column]?.[row]; if (value === null || value === undefined) return undefined;
  const id = table.signalIds[column]; const own = table.rowLabels?.[id]?.[String(row)];
  return (own ?? table.labels[id]?.[String(value)]) || undefined;
}

/**
 * The Signals of a report table and their order. A report's table holds everything the report shows: the Signals chosen in
 * the Table (in the order of its columns), then the Signals of the graphs and trajectories that are not among them.
 *
 * Columns with values come first. A Signal without a single value keeps its column, after them, so that data missing from
 * this log can be seen as missing; only a Signal this log has no definition for at all is left out, as it has no name.
 */
export function reportTableColumns(tableIds: readonly string[], columnOrder: readonly string[] | undefined, graphIds: readonly string[], hasValues: (id: string) => boolean, known: (id: string) => boolean): { signalIds: string[]; emptyIds: string[] } {
  const chosen = new Set(tableIds); const ordered = [...new Set([...(columnOrder ?? []).filter((id) => chosen.has(id)), ...tableIds, ...graphIds])];
  const filled = ordered.filter(hasValues); const empty = ordered.filter((id) => !hasValues(id) && known(id));
  return { signalIds: [...filled, ...empty], emptyIds: empty };
}

/**
 * Rows for a report table: the Table's rows (one per CAN event), plus the samples of Signals that have none in those rows
 * but are drawn in the report (a Signal from an external CSV file, say), each at its own time. Nothing is interpolated:
 * a sample joins a row only where the times are exactly equal.
 */
export function reportTableRows(eventRows: readonly { readonly timestamp: number; readonly values: ReadonlyMap<string, SignalSample> }[], others: readonly { readonly signalId: string; readonly samples: readonly SignalSample[] }[]): { timestamp: number; values: ReadonlyMap<string, SignalSample> }[] {
  if (!others.some((item) => item.samples.length)) return eventRows.map((row) => ({ timestamp: row.timestamp, values: row.values }));
  const rows = eventRows.map((row) => ({ timestamp: row.timestamp, values: new Map(row.values) })); const firstAt = new Map<number, Map<string, SignalSample>>();
  for (const row of rows) if (!firstAt.has(row.timestamp)) firstAt.set(row.timestamp, row.values);
  for (const { signalId, samples } of others) for (const sample of samples) {
    if (sample.carried) continue;
    let values = firstAt.get(sample.timestamp); if (!values || values.has(signalId)) { values = new Map(); rows.push({ timestamp: sample.timestamp, values }); if (!firstAt.has(sample.timestamp)) firstAt.set(sample.timestamp, values); }
    values.set(signalId, sample);
  }
  // Rows keep their order within one time: the sort is stable.
  return rows.sort((a, b) => a.timestamp - b.timestamp);
}
