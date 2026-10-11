import type { ComparisonDefinition, ComparisonTargetKind } from '../../core/project/comparison';
import type { SignalDefinition } from '../../core/signal/signal';
import type { MeasuredSignalDto, SignalGroupDto, SignalSeriesDto } from '../editors/rawLogProtocol';

export type ComparisonTargetStatus = 'loading' | 'ready' | 'error';

/** One target as shown in the comparison: what it is, where it came from, and whether it loaded. */
export interface ComparisonTargetStateDto {
  readonly id: string;
  readonly kind: ComparisonTargetKind;
  readonly name: string;
  readonly fileName: string;
  readonly filePath: string;
  readonly groupName?: string;
  readonly rangeLabel: string;
  readonly status: ComparisonTargetStatus;
  readonly message?: string;
  readonly start?: number;
  readonly end?: number;
}

export interface ComparisonSeriesDto {
  /** Comparison-level Signal ID (colors, grouping); `series.definition` is the target's own Signal. */
  readonly signalId: string;
  readonly series: SignalSeriesDto;
}

export type ComparisonToExtension =
  | { readonly type: 'ready' }
  | { readonly type: 'reorderTargets'; readonly order: readonly string[] }
  | { readonly type: 'removeTarget'; readonly targetId: string }
  | { readonly type: 'update'; readonly comparison: Pick<ComparisonDefinition, 'graphs' | 'colors' | 'hiddenTargetIds'> }
  | { readonly type: 'seriesRequest'; readonly requestId: number; readonly graphId: string; readonly signalIds: readonly string[]; readonly maxPoints?: number }
  | { readonly type: 'measuredSignalsRequest'; readonly requestId: number; readonly targetId: string; readonly signalIds: readonly string[]; readonly timestamp: number }
  | { readonly type: 'shiftOffset'; readonly targetId: string; readonly direction: -1 | 1; readonly steps?: number }
  | { readonly type: 'setOffset'; readonly targetId: string; readonly offset: number }
  | { readonly type: 'resetOffset'; readonly targetId: string }
  | { readonly type: 'openTarget'; readonly targetId: string }
  | { readonly type: 'exportAll'; readonly pngDataUrl?: string; readonly svg?: string }
  | { readonly type: 'saveComparisonImage'; readonly pngDataUrl: string; readonly svg: string };

export type ComparisonToWebview =
  | { readonly type: 'init'; readonly comparison: ComparisonDefinition }
  | { readonly type: 'comparison'; readonly comparison: ComparisonDefinition }
  | { readonly type: 'targets'; readonly targets: readonly ComparisonTargetStateDto[] }
  /** The Clips of the one log a report shows, in the log's own time. The comparison screen never gets this. */
  | { readonly type: 'clipSpans'; readonly clips: readonly { readonly id: string; readonly name: string; readonly start: number; readonly end: number }[] }
  | { readonly type: 'catalog'; readonly definitions: readonly SignalDefinition[]; readonly groups: readonly SignalGroupDto[]; readonly availability: Readonly<Record<string, readonly string[]>>; /** The Signals at least one compared log has samples of; the lists offer these. */ readonly measuredIds?: readonly string[] }
  | { readonly type: 'series'; readonly requestId: number; readonly graphId: string; readonly seriesByTarget: readonly { readonly targetId: string; readonly series: readonly ComparisonSeriesDto[] }[] }
  | { readonly type: 'measuredSignals'; readonly requestId: number; readonly samples: readonly MeasuredSignalDto[] }
  | { readonly type: 'reload' };
