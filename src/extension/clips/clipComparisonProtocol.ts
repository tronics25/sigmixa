import type { SignalDefinition } from '../../core/signal/signal';
import type { SignalGroupDto, SignalSeriesDto } from '../editors/rawLogProtocol';

export interface ComparisonClipDto {
  readonly id: string;
  readonly name: string;
  readonly fileName: string;
  readonly startTimestamp: number;
  readonly endTimestamp: number;
  readonly anchorTimestamp: number;
  readonly series: readonly SignalSeriesDto[];
}

export type ClipComparisonToExtension =
  | { readonly type: 'ready' }
  | { readonly type: 'selectSignals'; readonly requestId: number; readonly signalIds: readonly string[] }
  | { readonly type: 'resetAnchor'; readonly clipId: string }
  | { readonly type: 'shiftAnchor'; readonly clipId: string; readonly direction: -1 | 1 }
  | { readonly type: 'saveClipComparisonImage'; readonly dataUrl: string };

export type ClipComparisonToWebview =
  | { readonly type: 'init'; readonly clips: readonly ComparisonClipDto[]; readonly definitions: readonly SignalDefinition[]; readonly groups: readonly SignalGroupDto[]; readonly selectedSignalIds: readonly string[] }
  | { readonly type: 'seriesChanged'; readonly requestId: number; readonly seriesByClip: readonly { readonly clipId: string; readonly series: readonly SignalSeriesDto[] }[] }
  | { readonly type: 'anchorChanged'; readonly clipId: string; readonly anchorTimestamp: number };
