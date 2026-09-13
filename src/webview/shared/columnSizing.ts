export interface SizingColumn<Row> {
  readonly id: string;
  readonly label: string;
  readonly minWidth: number;
  readonly maxWidth: number;
  readonly flex?: number;
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
  let remaining = availableWidth - total;
  let flexible = columns.filter((column) => (column.flex ?? 0) > 0);
  if (!flexible.length) flexible = [...columns];
  while (remaining > 0.5 && flexible.length) {
    const totalFlex = flexible.reduce((sum, column) => sum + (column.flex ?? 1), 0); let used = 0;
    const next: typeof flexible = [];
    for (const column of flexible) {
      const capacity = Math.max(0, column.maxWidth - widths[column.id]); const share = remaining * (column.flex ?? 1) / totalFlex; const growth = Math.min(capacity, share);
      widths[column.id] += growth; used += growth; if (capacity - growth > 0.5) next.push(column);
    }
    if (used <= 0.5) break;
    remaining -= used; flexible = next;
  }
  return widths;
}
