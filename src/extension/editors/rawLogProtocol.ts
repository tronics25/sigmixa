import type { FrameFilter } from '../../core/frame/frameStore';
import type { Diagnostic } from '../../core/diagnostics/diagnostic';
import type { SignalDefinition, SignalEvent, SignalSample } from '../../core/signal/signal';

export interface LogViewState {
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
  readonly trajectoryView?: { readonly yaw: number; readonly pitch: number; readonly zoom: number; readonly panX: number; readonly panY: number; readonly mirrorHorizontal?: boolean };
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
  readonly remove?: { readonly type: 'external-csv'; readonly sourceId: string };
}

export interface SignalTableRowDto {
  readonly id: string;
  readonly timestamp: number;
  readonly values: Readonly<Record<string, number>>;
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

export interface ExternalCsvPreviewDto {
  readonly importId: string;
  readonly fileName: string;
  readonly headers: readonly string[];
  readonly suggestedTimestampColumn?: string;
  readonly suggestedTimestampUnit: 'seconds' | 'milliseconds' | 'microseconds';
}

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
  readonly canIdValue: number;
  readonly extended: boolean;
  readonly definitionId?: string;
  readonly decoded: boolean;
  readonly diagnostics: readonly { readonly code: string; readonly message: string }[];
}

export type ToExtensionMessage =
  | { readonly type: 'ready' }
  | { readonly type: 'pageRequest'; readonly requestId: number; readonly offset: number; readonly limit: number; readonly filter?: FrameFilter }
  | { readonly type: 'cancelParsing' }
  | { readonly type: 'autoFitSampleRequest'; readonly requestId: number; readonly filter?: FrameFilter }
  | { readonly type: 'openFrameDefinition'; readonly definitionId: string }
  | { readonly type: 'registerFrame'; readonly canId: number; readonly extended: boolean; readonly frameLength: number }
  | { readonly type: 'selectedRowsRequest'; readonly action: 'copy' | 'open'; readonly ranges: readonly { readonly start: number; readonly end: number }[]; readonly filter?: FrameFilter; readonly contentMode: 'raw' | 'decoded' }
  | { readonly type: 'signalCatalogRequest'; readonly requestId: number; readonly view: 'table' | 'timeSeries' | 'trajectory' }
  | { readonly type: 'signalTablePageRequest'; readonly requestId: number; readonly selectedIds: readonly string[]; readonly offset: number; readonly limit: number }
  | { readonly type: 'signalTableSampleRequest'; readonly requestId: number; readonly selectedIds: readonly string[] }
  | { readonly type: 'signalTableRowsRequest'; readonly action: 'copy' | 'open'; readonly ranges: readonly { readonly start: number; readonly end: number }[]; readonly selectedIds: readonly string[] }
  | { readonly type: 'signalSeriesRequest'; readonly requestId: number; readonly selectedIds: readonly string[]; readonly range?: { readonly start: number; readonly end: number }; readonly maxPoints: number }
  | { readonly type: 'cancelAnalysis' }
  | { readonly type: 'importExternalCsv' }
  | { readonly type: 'commitExternalCsv'; readonly importId: string; readonly timestampColumn: string; readonly timestampUnit: 'seconds' | 'milliseconds' | 'microseconds'; readonly valueColumns: readonly { readonly column: string; readonly name: string; readonly unit?: string }[] }
  | { readonly type: 'cancelExternalCsvImport'; readonly importId: string }
  | { readonly type: 'removeExternalCsvSignal'; readonly sourceId: string; readonly column: string }
  | { readonly type: 'exportSignalCsv'; readonly selectedIds: readonly string[] }
  | { readonly type: 'saveTimeSeriesImage'; readonly dataUrl: string }
  | { readonly type: 'saveTrajectoryImage'; readonly dataUrl: string }
  | { readonly type: 'snapTimeRangeRequest'; readonly requestId: number; readonly startTimestamp: number; readonly endTimestamp: number }
  | { readonly type: 'adjustTimeRangeRequest'; readonly requestId: number; readonly edge: 'start' | 'end'; readonly direction: -1 | 1; readonly startTimestamp: number; readonly endTimestamp: number }
  | { readonly type: 'createClip'; readonly startTimestamp: number; readonly endTimestamp: number; readonly signalIds: readonly string[] }
  | { readonly type: 'saveLogViewState'; readonly state: LogViewState };

export type ToWebviewMessage =
  | { readonly type: 'init'; readonly fileName: string; readonly parsing: boolean; readonly frames: number; readonly diagnostics: number; readonly channels: readonly number[]; readonly viewState?: LogViewState; readonly clip?: { readonly name: string; readonly startTimestamp: number; readonly endTimestamp: number } }
  | { readonly type: 'page'; readonly requestId: number; readonly offset: number; readonly total: number; readonly generation: number; readonly rows: readonly RawRowDto[] }
  | { readonly type: 'progress'; readonly frames: number; readonly bytesRead: number; readonly totalBytes: number; readonly channels: readonly number[] }
  | { readonly type: 'parseComplete'; readonly cancelled: boolean; readonly frames: number; readonly diagnostics: number; readonly channels: readonly number[] }
  | { readonly type: 'diagnostics'; readonly diagnostics: readonly Diagnostic[]; readonly total: number }
  | { readonly type: 'autoFitSample'; readonly requestId: number; readonly rows: readonly RawRowDto[] }
  | { readonly type: 'definitionsChanged' }
  | { readonly type: 'analysisProgress'; readonly processed: number; readonly total: number }
  | { readonly type: 'analysisComplete'; readonly processed: number; readonly cancelled: boolean }
  | { readonly type: 'clipCreated'; readonly clipId: string }
  | { readonly type: 'rowsCopied'; readonly count: number }
  | { readonly type: 'signalTableRowsCopied'; readonly count: number }
  | { readonly type: 'timeRangeAdjusted'; readonly requestId: number; readonly startTimestamp: number; readonly endTimestamp: number }
  | { readonly type: 'signalCatalog'; readonly requestId: number; readonly definitions: readonly SignalDefinition[]; readonly groups: readonly SignalGroupDto[] }
  | ({ readonly type: 'externalCsvPreview' } & ExternalCsvPreviewDto)
  | { readonly type: 'signalTablePage'; readonly requestId: number; readonly offset: number; readonly total: number; readonly generation: number; readonly rows: readonly SignalTableRowDto[] }
  | { readonly type: 'signalTableSample'; readonly requestId: number; readonly rows: readonly SignalTableRowDto[] }
  | { readonly type: 'signalSeries'; readonly requestId: number; readonly fullRange?: { readonly start: number; readonly end: number }; readonly series: readonly SignalSeriesDto[] };
