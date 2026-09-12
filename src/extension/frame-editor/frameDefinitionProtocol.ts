import type { Diagnostic } from '../../core/diagnostics/diagnostic';
import type { ManualFrameDefinition } from '../../core/manual/manualDefinition';

export type FrameEditorToExtension =
  | { readonly type: 'ready' }
  | { readonly type: 'save'; readonly revision: number; readonly frame: ManualFrameDefinition }
  | { readonly type: 'saveViewState'; readonly widths: Readonly<Record<string, number>> };

export type FrameEditorToWebview =
  | { readonly type: 'init'; readonly frame: ManualFrameDefinition; readonly widths?: Readonly<Record<string, number>> }
  | { readonly type: 'sortSignals' }
  | { readonly type: 'saveResult'; readonly revision: number; readonly saved: boolean; readonly diagnostics: readonly Diagnostic[]; readonly frame?: ManualFrameDefinition };
