import type { Diagnostic } from '../../core/diagnostics/diagnostic';
import type { PluginRegistration } from '../../core/project/schema';
import type { ConfigSchema } from '../../plugin-sdk';

export interface PluginBindingDto { readonly id: string; readonly enabled: boolean; readonly automatic: boolean; readonly frameLabel: string; }
export interface PluginEditorModel {
  readonly registration: PluginRegistration;
  readonly loaded: boolean;
  readonly loadMessage?: string;
  readonly schema?: ConfigSchema;
  readonly diagnostics: readonly Diagnostic[];
  readonly bindings: readonly PluginBindingDto[];
}

export type PluginEditorToExtension =
  | { readonly type: 'ready' }
  | { readonly type: 'setEnabled'; readonly enabled: boolean }
  | { readonly type: 'setBindingEnabled'; readonly bindingId: string; readonly enabled: boolean }
  | { readonly type: 'addBinding' }
  | { readonly type: 'saveConfig'; readonly config: Readonly<Record<string, unknown>> }
  | { readonly type: 'reload' }
  | { readonly type: 'unregister' };

export type PluginEditorToWebview =
  | { readonly type: 'init'; readonly model: PluginEditorModel }
  | { readonly type: 'operationResult'; readonly diagnostics: readonly Diagnostic[] };
