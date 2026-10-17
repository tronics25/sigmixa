import { isPackedColumn, isPackedRows, packColumn, packRows, unpackColumn, unpackRows } from '../../core/report/compactArrays';
import type { ReportData } from './reportData';

/**
 * The report's data as it is written into the HTML file: every sample and table row, packed without loss
 * (`compactArrays`). `unpackReportData` gives back exactly the data that was packed; the report shows only that.
 */
export function packReportData(data: ReportData): unknown {
  return {
    ...data,
    series: data.series.map((entry) => ({ ...entry, items: entry.items.map((item) => ({ ...item, series: { ...item.series, samples: packRows(item.series.samples) } })) })),
    ...(data.table ? { table: { ...data.table, timestamps: { '~col': packColumn(data.table.timestamps) }, values: data.table.values.map((column) => ({ '~col': packColumn(column) })) } } : {}),
  };
}

export function unpackReportData(packed: unknown): ReportData {
  const data = packed as Record<string, unknown> & ReportData;
  const column = (value: unknown) => isPackedColumn(value) ? unpackColumn(value['~col']) : value;
  return {
    ...data,
    series: data.series.map((entry) => ({ ...entry, items: entry.items.map((item) => ({ ...item, series: { ...item.series, samples: (isPackedRows(item.series.samples) ? unpackRows(item.series.samples) : item.series.samples) as never } })) })),
    ...(data.table ? { table: { ...data.table, timestamps: column(data.table.timestamps) as number[], values: data.table.values.map(column) as (number | null)[][] } } : {}),
  };
}
