import type { DecodedExplanation } from '../../core/manual/decodedExplanation';
import type { FrameFilter } from '../../core/frame/frameStore';
import type { DiagnosticGroup } from '../../core/diagnostics/diagnosticTally';
import type { SignalDefinition, SignalEvent, SignalSample } from '../../core/signal/signal';
import type { SignalCellChange } from '../../core/signal/tableChanges';
import type { TimeDisplayMode, TimeReference } from '../../core/time/timeFormat';
import type { ExternalCsvTimeBase } from '../../core/project/schema';

export interface VisualizeViewDefinition {
  readonly id: string;
  readonly kind: 'graph' | 'trajectory' | 'frameTiming' | 'frameInterval' | 'stateTimeline' | 'distribution';
  readonly name: string;
  readonly settings: LogViewState;
  readonly height?: number;
}

/** One CAN ID in the frame timing view: how it is sent over the log, and what to draw of it in the requested span. */
export interface FrameTimingRowDto {
  /** `s:<id>` or `e:<id>` (extended). */
  readonly key: string;
  readonly canId: string;
  readonly name: string;
  /** Frames in the whole log (or Clip). */
  readonly total: number;
  /** Frames in the requested span. */
  readonly count: number;
  /** The base cycle in milliseconds; undefined for a CAN ID sent on events. `estimated` when read from the log instead of the Frame definition. */
  readonly periodMs?: number;
  readonly estimated: boolean;
  /** How it is sent; `modeEstimated` when read from the log instead of the Frame definition. Undefined with too few frames to tell. */
  readonly mode?: 'periodic' | 'event' | 'mixed';
  readonly modeEstimated?: boolean;
  /** For periodic + events: the frames in `times` sent on events, between the cycle frames. */
  readonly eventTimes?: readonly number[];
  /** Intervals much longer than the period over the whole log (the first 500), and how many there are in all. */
  readonly gaps: readonly { readonly start: number; readonly end: number }[];
  readonly gapCount: number;
  /** Every receive time in the span, or, when those are too many to tell apart, frames per equal slice of it. */
  readonly times?: readonly number[];
  readonly bins?: readonly number[];
}

/** One Signal in the state timeline: its states, and what to draw of it in the requested span. */
export interface StateRowDto {
  readonly signalId: string;
  readonly name: string;
  readonly unit?: string;
  /** The distinct states of the Signal over the whole log, by value: runs and slices refer to them by index. */
  readonly states: readonly { readonly value: number; readonly label?: string }[];
  /** True when the Signal changes too often to be shown as states. */
  readonly tooMany: boolean;
  /** The runs in the span, or, when those are too many to draw apart, the longest-lasting state per equal slice of it. */
  readonly runs?: readonly { readonly start: number; readonly end: number; readonly state: number }[];
  readonly bins?: readonly ({ readonly state: number; readonly mixed: boolean } | null)[];
}

/** One Signal of the distribution view: how its values are spread in the requested span, and their statistics. */
export interface DistributionRowDto {
  readonly signalId: string;
  readonly name: string;
  readonly unit?: string;
  /** The Signal's least and greatest value over the whole log or Clip: the span the bars divide. */
  readonly lo: number; readonly hi: number;
  /** Samples in each equal part of `lo`…`hi`. */
  readonly bins: readonly number[];
  readonly count: number;
  /** Undefined when the span has no sample. */
  readonly min?: number; readonly max?: number; readonly mean?: number; readonly sd?: number;
}

/** The receive intervals of one CAN ID in the requested span, for the receive interval view. */
export interface FrameIntervalsDto {
  /** Every CAN ID of the log, to choose from. */
  readonly ids: readonly { readonly key: string; readonly canId: string; readonly name: string }[];
  /** The CAN ID shown: the one asked for, or the one chosen for a view that has none yet. Undefined when the log has no frames. */
  readonly key?: string;
  readonly canId?: string;
  readonly name?: string;
  readonly periodMs?: number;
  readonly estimated?: boolean;
  readonly stats?: { readonly count: number; readonly meanMs: number; readonly minMs: number; readonly maxMs: number; readonly sdMs: number };
  /** Every interval (ms) with the time of the frame that ended it, or, when those are too many, the least, greatest and mean per equal slice of the span. */
  readonly times?: readonly number[];
  readonly intervals?: readonly number[];
  readonly buckets?: { readonly minMs: readonly (number | null)[]; readonly maxMs: readonly (number | null)[]; readonly meanMs: readonly (number | null)[] };
}

export interface TrajectorySeriesDefinition { readonly id: string; readonly name: string; readonly xId?: string; readonly yId?: string; readonly zId?: string; }

export interface LogViewState {
  /** How times are shown, copied and exported; the date and time when undefined (and the log's start is known). */
  readonly timeDisplay?: TimeDisplayMode;
  /** RAW Log column widths, kept with the view settings. */
  readonly rawWidths?: Readonly<Record<string, number>>;
  readonly traceSettings?: TraceDisplaySettings;
  readonly trajectorySeries?: readonly TrajectorySeriesDefinition[];
  /** State timeline: the Signals shown, in order. Undefined for a new view, which starts with the Signals that have state names. */
  readonly stateTimelineIds?: readonly string[];
  /** The Signals of a distribution view; undefined in a new view, which then shows the first measured Signals without state names. */
  readonly distributionIds?: readonly string[];
  /** Receive interval: the CAN ID (`s:<id>` / `e:<id>`) shown. */
  readonly frameIntervalKey?: string;
  /** The CAN IDs of a receive interval view (`frameIntervalKey` in views saved before it could show several); undefined in a new view. */
  readonly frameIntervalKeys?: readonly string[];
  /** Frame timing: the CAN IDs (`s:<id>` / `e:<id>`) left out of the view. */
  readonly frameTimingHiddenKeys?: readonly string[];
  readonly visualizeViews?: readonly VisualizeViewDefinition[];
  readonly visualizeSelectedViewId?: string;
  readonly visualizeOptionsCollapsed?: boolean;
  /** Legacy setting, only read to migrate the open/closed state. */
  readonly visualizeOptionsPinned?: boolean;
  readonly visualizeTraceHeight?: number;
  readonly visualizeTraceCollapsed?: boolean;
  readonly visualizeTraceMarkerVisible?: boolean;
  readonly activeTab?: 'raw-view' | 'table-view' | 'visualize-view';
  readonly chartSignalGrouping?: 'frame' | 'unit';
  readonly tableSignalGrouping?: 'frame' | 'unit';
  readonly tableSelectedIds?: readonly string[];
  readonly tableColumnOrder?: readonly string[];
  readonly tableWidths?: Readonly<Record<string, number>>;
  readonly tablePaneWidth?: number;
  readonly tablePaneCollapsed?: boolean;
  readonly chartSelectedIds?: readonly string[];
  readonly chartColors?: Readonly<Record<string, string>>;
  readonly chartMode?: 'raw' | 'normalized';
  readonly chartConnectGaps?: boolean;
  readonly chartAxisRange?: ChartAxisRangeSetting;
  readonly chartGroupLayout?: readonly (readonly string[])[];
  /** @deprecated Migrated to chartAxisRange when an older workspace is opened. */
  readonly chartAxisRanges?: Readonly<Record<string, ChartAxisRangeSetting>>;
  readonly chartPaneWidth?: number;
  readonly chartPaneCollapsed?: boolean;
  /** The lanes under the graph (one per Signal, shape only) are open. */
  readonly chartLanesExpanded?: boolean;
  readonly trajectoryXId?: string;
  readonly trajectoryYId?: string;
  readonly trajectoryZId?: string;
  readonly trajectoryInvert?: { readonly x: boolean; readonly y: boolean; readonly z: boolean };
  readonly trajectoryEqualAspect?: boolean;
  readonly trajectoryConnectGaps?: boolean;
  readonly trajectoryShowGrid?: boolean;
  readonly trajectoryShowPoints?: boolean;
  readonly trajectoryTrail?: 'all' | 'to-current' | 'last-seconds';
  readonly trajectoryTrailSeconds?: number;
  readonly trajectorySpeed?: 0.25 | 0.5 | 1 | 2 | 5;
  readonly trajectoryCoordinateSystem?: 'right' | 'left';
  /** The 3D camera. Views saved by older versions may also hold `mirrorHorizontal`, which is ignored. */
  readonly trajectoryView?: { readonly yaw: number; readonly pitch: number; readonly zoom: number; readonly panX: number; readonly panY: number };
  /** The camera's zoom and pan follow the data and the view size (set by X/Y/Z and Reset view, cleared by zooming, panning or rotating). True when no camera is saved. */
  readonly trajectoryViewFit?: boolean;
}

export interface ChartAxisRangeSetting {
  readonly mode: 'visible' | 'global' | 'manual';
  readonly minimum?: number;
  readonly maximum?: number;
  readonly includeZero?: boolean;
}

export interface SignalGroupDto {
  readonly id: string;
  readonly label: string;
  readonly signalIds: readonly string[];
  /** The heading the group is listed under, a level above it (the comparison screen's "only in …"). */
  readonly section?: { readonly id: string; readonly label: string };
  /** The whole file's measured Signals with no group name of their own: a CSV log's. (MF4/MDF channel groups without a name are read as "Group N".) */
  readonly unnamed?: boolean;
}

export interface SignalTableRowDto {
  readonly id: string;
  readonly timestamp: number;
  readonly values: Readonly<Record<string, number>>;
  readonly valueLabels?: Readonly<Record<string, string>>;
  readonly changes?: Readonly<Record<string, SignalCellChange>>;
}

export interface SignalSeriesDto {
  readonly definition: SignalDefinition;
  readonly samples: readonly SignalSample[];
  readonly events: readonly SignalEvent[];
  readonly totalSamplesInRange: number;
  readonly globalMinimum?: number;
  readonly globalMaximum?: number;
  readonly gaps: readonly { readonly startTimestamp: number; readonly endTimestamp: number }[];
}

export interface MeasuredSignalDto { readonly signalId: string; readonly sample: SignalSample; }


export interface RawRowDto {
  readonly id: string;
  readonly time: number;
  readonly direction: 'Rx' | 'Tx';
  readonly canId: string;
  readonly name: string;
  readonly channel: number;
  readonly dlc: number;
  readonly length: number;
  readonly rawContent: string;
  readonly decodedContent: string;
  readonly decodedSignals?: readonly DecodedExplanation[];
  readonly canIdValue: number;
  readonly extended: boolean;
  readonly definitionId?: string;
  readonly decoded: boolean;
  readonly diagnostics: readonly { readonly code: string; readonly message: string }[];
}

export interface TraceSignalDto { readonly id: string; readonly name: string; readonly unit?: string; readonly value?: number; readonly valueLabel?: string; readonly timestamp?: number; /** Received before the Clip's range. */ readonly carried?: boolean; }
export interface LastFrameDto { readonly key: string; readonly parentKey?: string; readonly multiplexerRows?: readonly LastFrameDto[]; readonly multiplexer?: { readonly name: string; readonly value?: number }; readonly row: RawRowDto; readonly count: number; readonly age?: number; readonly intervalMs?: number; readonly minIntervalMs?: number; readonly maxIntervalMs?: number; readonly lastChangeAt?: number; readonly expectedPeriodMs?: number; /** True when `expectedPeriodMs` is the cycle found in the log, not a defined period. */ readonly expectedEstimated?: boolean; readonly deviationMs?: number; readonly signals: readonly TraceSignalDto[]; }
export type TraceColumn = 'channel' | 'direction' | 'receivedAt' | 'age' | 'count' | 'interval' | 'minInterval' | 'maxInterval' | 'lastChange' | 'expected' | 'deviation';
export type TraceSort = 'canId' | 'name' | 'multiplexer' | 'content' | TraceColumn;
export interface TraceDisplaySettings {
  readonly widths?: Readonly<Partial<Record<TraceSort, number>>>;
  /** CAN ID + standard/extended format; all channels/directions of an ID move together. */
  readonly pinnedIds?: readonly string[];
  readonly defaultMode?: 'raw' | 'decoded';
  readonly columns?: readonly TraceColumn[];
  readonly sort?: TraceSort;
  readonly descending?: boolean;
}

export type ToExtensionMessage =
  /** Text the Webview already has (Trace rows), opened in an untitled editor. */
  | { readonly type: 'openText'; readonly text: string }
  | { readonly type: 'ready' }
  /** `shown` is the settings the view showed when it sent the message, so a view not yet reloaded cannot save into the other one. */
  | { readonly type: 'setViewSettingsScope'; readonly scope: 'file' | 'group'; readonly shown?: 'file' | 'group'; readonly state: LogViewState }
  | { readonly type: 'lastFramesRequest'; readonly requestId: number; readonly timestamp: number }
  | { readonly type: 'pageRequest'; readonly requestId: number; readonly offset: number; readonly limit: number; readonly filter?: FrameFilter }
  | { readonly type: 'cancelParsing' }
  | { readonly type: 'autoFitSampleRequest'; readonly requestId: number; readonly filter?: FrameFilter }
  | { readonly type: 'openFrameDefinition'; readonly definitionId: string }
  | { readonly type: 'registerFrame'; readonly canId: number; readonly extended: boolean; readonly frameLength: number }
  | { readonly type: 'selectedRowsRequest'; readonly action: 'copy' | 'open'; readonly ranges: readonly { readonly start: number; readonly end: number }[]; readonly filter?: FrameFilter; readonly contentMode: 'raw' | 'decoded'; readonly timeDisplay?: TimeDisplayMode }
  | { readonly type: 'signalCatalogRequest'; readonly requestId: number; readonly view: 'table' | 'timeSeries' | 'trajectory' }
  | { readonly type: 'signalTablePageRequest'; readonly requestId: number; readonly selectedIds: readonly string[]; readonly offset: number; readonly limit: number }
  | { readonly type: 'signalTableSampleRequest'; readonly requestId: number; readonly selectedIds: readonly string[] }
  | { readonly type: 'signalTableRowsRequest'; readonly action: 'copy' | 'open'; readonly ranges: readonly { readonly start: number; readonly end: number }[]; readonly selectedIds: readonly string[]; readonly timeDisplay?: TimeDisplayMode }
  /** `joined`: the axes of a trajectory, put together by their times, so they are thinned together. */
  | { readonly type: 'frameTimingRequest'; readonly requestId: number; readonly range?: { readonly start: number; readonly end: number }; readonly bins: number; readonly maxTimes: number }
  | { readonly type: 'frameIntervalRequest'; readonly requestId: number; readonly key?: string; readonly keys?: readonly string[]; readonly range?: { readonly start: number; readonly end: number }; readonly buckets: number; readonly maxPoints: number }
  | { readonly type: 'distributionRequest'; readonly requestId: number; readonly selectedIds: readonly string[]; readonly range?: { readonly start: number; readonly end: number }; readonly bins: number }
  | { readonly type: 'stateTimelineRequest'; readonly requestId: number; readonly selectedIds: readonly string[]; readonly range?: { readonly start: number; readonly end: number }; readonly bins: number; readonly maxRuns: number }
  | { readonly type: 'signalSeriesRequest'; readonly requestId: number; readonly selectedIds: readonly string[]; readonly joined?: boolean; readonly range?: { readonly start: number; readonly end: number }; readonly maxPoints: number }
  | { readonly type: 'timelineRangeRequest'; readonly requestId: number }
  | { readonly type: 'measuredSignalsRequest'; readonly requestId: number; readonly selectedIds: readonly string[]; readonly timestamp: number }
  | { readonly type: 'cancelAnalysis' }
  /** Opens one of the open log's Clips, from its marker on a graph. */
  | { readonly type: 'openClip'; readonly clipId: string }
  /** From a Clip, opens its whole log (the breadcrumb's log name). */
  | { readonly type: 'openWholeLog' }
  /** A Clip's start or end was dragged on a graph. */
  | { readonly type: 'updateClipRange'; readonly clipId: string; readonly startTimestamp: number; readonly endTimestamp: number }
  | { readonly type: 'exportSignalCsv'; readonly selectedIds: readonly string[]; readonly timeDisplay?: TimeDisplayMode }
  | { readonly type: 'saveTimeSeriesImage'; readonly pngDataUrl: string; readonly svg: string }
  | { readonly type: 'saveTrajectoryImage'; readonly pngDataUrl: string; readonly svg: string }
  | { readonly type: 'exportVisualize'; readonly trajectoryCurrentTime?: number; readonly pngDataUrl?: string; readonly svg?: string }
  | { readonly type: 'snapTimeRangeRequest'; readonly requestId: number; readonly startTimestamp: number; readonly endTimestamp: number }
  | { readonly type: 'adjustTimeRangeRequest'; readonly requestId: number; readonly edge: 'start' | 'end'; readonly direction: -1 | 1; readonly startTimestamp: number; readonly endTimestamp: number }
  | { readonly type: 'createTableClip'; readonly startRow: number; readonly endRow: number; readonly generation: number; readonly signalIds: readonly string[] }
  | { readonly type: 'createClip'; readonly startTimestamp: number; readonly endTimestamp: number; readonly signalIds: readonly string[]; readonly viewState?: LogViewState }
  | { readonly type: 'saveLogViewState'; readonly shown?: 'file' | 'group'; readonly state: LogViewState };

export type ToWebviewMessage =
  | { readonly type: 'timelineRange'; readonly requestId: number; readonly range?: { readonly start: number; readonly end: number } }
  | { readonly type: 'lastFrames'; readonly requestId: number; readonly timestamp: number; readonly values: readonly LastFrameDto[] }
  | { readonly type: 'measuredSignals'; readonly requestId: number; readonly samples: readonly MeasuredSignalDto[] }
  | { readonly type: 'init'; readonly place?: string; readonly groupName?: string; readonly viewSettingsScope?: 'file' | 'group'; readonly fileName: string; readonly parsing: boolean; readonly frames: number; readonly diagnostics: number; readonly channels: readonly number[]; readonly viewState?: LogViewState; readonly clip?: { readonly name: string; readonly startTimestamp?: number; readonly endTimestamp?: number }; readonly timeReference?: TimeReference }
  /** The log's start became known while it was being read. */
  | { readonly type: 'timeReference'; readonly reference: TimeReference }
  | { readonly type: 'page'; readonly requestId: number; readonly offset: number; readonly total: number; readonly generation: number; readonly rows: readonly RawRowDto[]; readonly complete?: boolean }
  | { readonly type: 'progress'; readonly frames: number; readonly bytesRead: number; readonly totalBytes: number; readonly channels: readonly number[] }
  | { readonly type: 'parseComplete'; readonly cancelled: boolean; readonly frames: number; readonly diagnostics: number; readonly channels: readonly number[] }
  | { readonly type: 'sourceDiagnostics'; readonly groups: readonly DiagnosticGroup[]; readonly total: number }
  | { readonly type: 'analysisDiagnostics'; readonly groups: readonly DiagnosticGroup[]; readonly total: number }
  | { readonly type: 'autoFitSample'; readonly requestId: number; readonly rows: readonly RawRowDto[] }
  | { readonly type: 'definitionsChanged' }
  | { readonly type: 'analysisProgress'; readonly processed: number; readonly total: number }
  /** More frames were read for the RAW filter (`complete` once all were): pages are asked again. */
  | { readonly type: 'searchProgress'; readonly complete: boolean }
  | { readonly type: 'analysisComplete'; readonly processed: number; readonly cancelled: boolean }
  | { readonly type: 'clipCreated'; readonly clipId: string }
  /** The Clips of the open log, so graphs can mark their time ranges. Empty when a Clip itself is open. */
  | { readonly type: 'clipRanges'; readonly clips: readonly { readonly id: string; readonly name: string; readonly start: number; readonly end: number }[] }
  | { readonly type: 'rowsCopied'; readonly count: number }
  | { readonly type: 'signalTableRowsCopied'; readonly count: number }
  | { readonly type: 'timeRangeAdjusted'; readonly requestId: number; readonly startTimestamp: number; readonly endTimestamp: number }
  | { readonly type: 'signalCatalog'; readonly requestId: number; readonly definitions: readonly SignalDefinition[]; readonly groups: readonly SignalGroupDto[]; /** The Signals this log has samples of. Lists show only these (and what is already chosen). */ readonly measuredIds?: readonly string[]; /** True when the view settings are shared in a group (the workspace root included), where Signals another log has may be wanted too. */ readonly unmeasuredOption?: boolean }
  | { readonly type: 'signalTablePage'; readonly requestId: number; readonly offset: number; readonly total: number; readonly generation: number; readonly rows: readonly SignalTableRowDto[] }
  | { readonly type: 'signalTableSample'; readonly requestId: number; readonly rows: readonly SignalTableRowDto[] }
  | { readonly type: 'frameTiming'; readonly requestId: number; readonly fullRange?: { readonly start: number; readonly end: number }; readonly rows: readonly FrameTimingRowDto[] }
  | { readonly type: 'frameIntervals'; readonly requestId: number; readonly fullRange?: { readonly start: number; readonly end: number }; readonly data: FrameIntervalsDto; readonly items: readonly FrameIntervalsDto[] }
  | { readonly type: 'distribution'; readonly requestId: number; readonly fullRange?: { readonly start: number; readonly end: number }; readonly rows: readonly DistributionRowDto[] }
  | { readonly type: 'stateTimeline'; readonly requestId: number; readonly fullRange?: { readonly start: number; readonly end: number }; readonly rows: readonly StateRowDto[] }
  | { readonly type: 'signalSeries'; readonly requestId: number; readonly fullRange?: { readonly start: number; readonly end: number }; readonly series: readonly SignalSeriesDto[] };
