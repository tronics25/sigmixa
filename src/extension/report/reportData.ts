import type { ComparisonDefinition } from '../../core/project/comparison';
import type { SignalDefinition } from '../../core/signal/signal';
import type { ComparisonSeriesDto, ComparisonTargetStateDto } from '../comparison/comparisonProtocol';
import type { SignalGroupDto } from '../editors/rawLogProtocol';

export const REPORT_FORMAT_VERSION = 1;

/** Signal table embedded in a log/Clip report: one row per timestamp, one column per Signal. */
export interface ReportTable {
  readonly signalIds: readonly string[];
  readonly timestamps: readonly number[];
  /** `values[column][row]`; null where that Signal has no value at the row's time. */
  readonly values: readonly (readonly (number | null)[])[];
  /** The label of a value, per Signal: `labels[signalId][value]`. */
  readonly labels: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Rows whose label is not the one `labels` has for that value (a Plugin may label one value differently over time): `rowLabels[signalId][row]`. */
  readonly rowLabels?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly totalRows: number;
  /** Columns without a single value: Signals that are selected or drawn, but that this log has no data of. */
  readonly emptySignalIds?: readonly string[];
}

/**
 * Everything a standalone HTML report shows. It is plain data: the report page never runs
 * definitions, Plugins or anything from the source logs.
 */
export interface ReportData {
  readonly formatVersion: typeof REPORT_FORMAT_VERSION;
  readonly kind: 'log' | 'comparison';
  readonly title: string;
  readonly generatedAt: string;
  readonly appVersion: string;
  /** Lines describing the source(s): file, Clip range, analysis group. */
  readonly source: readonly string[];
  /** What was reduced for size, e.g. "Vehicle Speed: 120,000 → 20,000 points". Empty when complete. */
  readonly notices: readonly string[];
  readonly comparison: ComparisonDefinition;
  readonly targets: readonly ComparisonTargetStateDto[];
  readonly definitions: readonly SignalDefinition[];
  readonly groups: readonly SignalGroupDto[];
  readonly availability: Readonly<Record<string, readonly string[]>>;
  readonly series: readonly { readonly targetId: string; readonly items: readonly ComparisonSeriesDto[] }[];
  readonly table?: ReportTable;
  /** The Clips of the log a log report shows (none when the report is of a Clip), in the log's own time. */
  readonly clipSpans?: readonly { readonly id: string; readonly name: string; readonly start: number; readonly end: number }[];
}
