import type { ComparisonDefinition } from '../../core/project/comparison';
import type { SignalDefinition } from '../../core/signal/signal';
import type { DistributionGrid } from '../../core/signal/distribution';
import type { ComparisonSeriesDto, ComparisonTargetStateDto } from '../comparison/comparisonProtocol';
import type { FrameIntervalsDto, FrameTimingRowDto, SignalGroupDto, StateRowDto } from '../editors/rawLogProtocol';
import type { TimeDisplayMode, TimeReference } from '../../core/time/timeFormat';

export const REPORT_FORMAT_VERSION = 1;

export interface ReportAnalysis {
  /** Every CAN ID with its receive times over the report's span (`times`), or frames per equal slice of the span (`bins`) for the CAN IDs with too many frames to embed. */
  readonly frames: readonly FrameTimingRowDto[];
  /** The receive intervals of the interval views' CAN IDs that have too many frames to embed their times. */
  readonly intervals: readonly ReportFrameIntervals[];
  /** The Signals of the state timeline views, and the log's other Signals with state names. */
  readonly states: readonly ReportStateRow[];
  /** The Signals of the distribution views, and those of the report's graphs. */
  readonly distributions: readonly ReportDistributionRow[];
  /** The Signals of `states` and `distributions` with their groups, for the Signal lists of those views' settings. */
  readonly definitions?: readonly SignalDefinition[];
  readonly groups?: readonly SignalGroupDto[];
}

/**
 * The receive intervals of one CAN ID over a report's span: every receive time (`times`, the intervals are between
 * them), or, for a CAN ID with too many frames to embed, the least, greatest and mean interval per equal slice of the span.
 */
export interface ReportFrameIntervals extends Pick<FrameIntervalsDto, 'key' | 'canId' | 'name' | 'periodMs' | 'estimated' | 'stats' | 'buckets'> { readonly times?: readonly number[] }

/** A Signal's values over a report's span, in slices of it: the report shows the statistics and histogram of the slices in view. */
export interface ReportDistributionRow { readonly signalId: string; readonly name: string; readonly unit?: string; readonly grid: DistributionGrid }

/**
 * A Signal as states over a report's span: every run (`starts[i]` to `starts[i + 1]`, the last one to `end`, in state
 * `stateOf[i]`), or, for a Signal with too many runs to embed, the longest-lasting state per equal slice of the span.
 */
export interface ReportStateRow extends Pick<StateRowDto, 'signalId' | 'name' | 'unit' | 'states' | 'tooMany' | 'bins'> { readonly starts?: readonly number[]; readonly stateOf?: readonly number[]; readonly end?: number }

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
  /**
   * What the frame timing, receive interval, state timeline and distribution views of a log report are drawn from. The
   * views themselves are among `comparison.graphs`, in their Visualize order; a view added or changed in the report can
   * show anything that is here.
   */
  readonly analysis?: ReportAnalysis;
  /** How the log report's table shows times: the log's start and the chosen mode. Absent in older reports (seconds). */
  readonly time?: { readonly reference?: TimeReference; readonly mode?: TimeDisplayMode };
}
