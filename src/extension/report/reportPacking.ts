import { isPackedColumn, isPackedRows, packColumn, packRows, unpackColumn, unpackRows } from '../../core/report/compactArrays';
import type { ReportAnalysis, ReportData } from './reportData';

/** The columns of a distribution grid: mostly zeros and repeats, so they pack well. */
const GRID_COLUMNS = ['counts', 'n', 'sum', 'm2', 'min', 'max'] as const;

/**
 * The report's data as it is written into the HTML file: every sample and table row, packed without loss
 * (`compactArrays`). `unpackReportData` gives back exactly the data that was packed; the report shows only that.
 */
export function packReportData(data: ReportData): unknown {
  const packStates = (rows: ReportAnalysis['states']) => rows.map((row) => row.starts && row.stateOf ? { ...row, starts: { '~col': packColumn(row.starts) }, stateOf: { '~col': packColumn(row.stateOf) } } : row);
  const packGrids = (rows: ReportAnalysis['distributions']) => rows.map((row) => ({ ...row, grid: { ...row.grid, ...Object.fromEntries(GRID_COLUMNS.map((key) => [key, { '~col': packColumn(row.grid[key]) }])) } }));
  return {
    ...data,
    series: data.series.map((entry) => ({ ...entry, items: entry.items.map((item) => ({ ...item, series: { ...item.series, samples: packRows(item.series.samples) } })) })),
    ...(data.table ? { table: { ...data.table, timestamps: { '~col': packColumn(data.table.timestamps) }, values: data.table.values.map((column) => ({ '~col': packColumn(column) })) } } : {}),
    ...(data.analysis ? { analysis: { ...data.analysis, frames: data.analysis.frames.map((row) => row.times ? { ...row, times: { '~col': packColumn(row.times) } } : row), intervals: data.analysis.intervals, states: packStates(data.analysis.states), distributions: packGrids(data.analysis.distributions) } } : {}),
  };
}

export function unpackReportData(packed: unknown): ReportData {
  const data = packed as Record<string, unknown> & ReportData;
  const column = (value: unknown) => isPackedColumn(value) ? unpackColumn(value['~col']) : value;
  const states = (rows: ReportAnalysis['states']) => rows.map((row) => row.starts && row.stateOf ? { ...row, starts: column(row.starts) as number[], stateOf: column(row.stateOf) as number[] } : row);
  const grids = (rows: ReportAnalysis['distributions']) => rows.map((row) => ({ ...row, grid: { ...row.grid, ...Object.fromEntries(GRID_COLUMNS.map((key) => [key, column(row.grid[key])])) } }));
  return {
    ...data,
    series: data.series.map((entry) => ({ ...entry, items: entry.items.map((item) => ({ ...item, series: { ...item.series, samples: (isPackedRows(item.series.samples) ? unpackRows(item.series.samples) : item.series.samples) as never } })) })),
    ...(data.table ? { table: { ...data.table, timestamps: column(data.table.timestamps) as number[], values: data.table.values.map(column) as (number | null)[][] } } : {}),
    ...(data.analysis ? { analysis: { ...data.analysis, frames: data.analysis.frames.map((row) => row.times ? { ...row, times: column(row.times) as number[] } : row), intervals: data.analysis.intervals, states: states(data.analysis.states), distributions: grids(data.analysis.distributions) } } : {}),
  };
}
