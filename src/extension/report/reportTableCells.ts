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
