export interface SizingColumn<Row> {
  readonly id: string;
  readonly label: string;
  readonly minWidth: number;
  readonly maxWidth: number;
  readonly value: (row: Row) => string;
}

export type TextMeasure = (text: string) => number;

export function autoFitColumns<Row>(
  columns: readonly SizingColumn<Row>[],
  rows: readonly Row[],
  measure: TextMeasure,
  padding = 28
): Readonly<Record<string, number>> {
  const widths: Record<string, number> = {};
  for (const column of columns) {
    let width = measure(column.label) + padding;
    for (const row of rows) width = Math.max(width, measure(column.value(row)) + padding);
    widths[column.id] = Math.max(column.minWidth, Math.min(column.maxWidth, Math.ceil(width)));
  }
  return widths;
}

export function fitColumnsToView<Row>(
  columns: readonly SizingColumn<Row>[],
  current: Readonly<Record<string, number>>,
  availableWidth: number
): Readonly<Record<string, number>> {
  const widths = Object.fromEntries(columns.map((column) => [column.id, current[column.id] ?? column.minWidth]));
  const total = Object.values(widths).reduce((sum, width) => sum + width, 0);
  if (total >= availableWidth || availableWidth <= 0) return widths;
  const extra = (availableWidth - total) / columns.length;
  for (const column of columns) widths[column.id] = Math.min(column.maxWidth, widths[column.id] + extra);
  return widths;
}
