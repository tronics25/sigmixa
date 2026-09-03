import type { Diagnostic } from '../core/diagnostics/diagnostic';
import type { CanFrame } from '../core/frame/canFrame';
import type { SignalEvent, SignalSample } from '../core/signal/signal';

/** Host API implemented by this release. Major versions are compatibility boundaries. */
export const PLUGIN_API_VERSION = '1.0';

export interface SpecificFrameSupport {
  readonly canId: number;
  readonly extended?: boolean;
  readonly name?: string;
  readonly frameLength?: number;
}

export type FrameSupport =
  | { readonly type: 'any' }
  | { readonly type: 'specific'; readonly frames: readonly SpecificFrameSupport[] };

type ConfigPropertyMetadata = {
  readonly title?: string;
  readonly description?: string;
};

export type ConfigScalarPropertySchema = ConfigPropertyMetadata & (
  | { readonly type: 'string'; readonly enum?: readonly string[]; readonly default?: string; readonly generate?: 'uuid' }
  | { readonly type: 'number' | 'integer'; readonly minimum?: number; readonly maximum?: number; readonly default?: number }
  | { readonly type: 'boolean'; readonly default?: boolean }
);

export type ConfigObjectPropertySchema = ConfigPropertyMetadata & {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, ConfigPropertySchema>>;
  readonly required?: readonly string[];
};

export type ConfigArrayPropertySchema = ConfigPropertyMetadata & {
  readonly type: 'array';
  readonly default?: readonly Readonly<Record<string, unknown>>[];
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly presentation?: 'table' | 'hierarchy';
  readonly itemTitle?: string;
  readonly addLabel?: string;
  readonly searchable?: boolean;
  readonly items: ConfigObjectPropertySchema;
};

export type ConfigPropertySchema = ConfigScalarPropertySchema | ConfigObjectPropertySchema | ConfigArrayPropertySchema;

export interface ConfigSchema {
  readonly type: 'object';
  readonly title?: string;
  readonly description?: string;
  readonly schemaVersion?: string;
  readonly properties: Readonly<Record<string, ConfigPropertySchema>>;
  readonly required?: readonly string[];
}

export interface PluginSignalSampleOutput {
  /** Stable within this Plugin. The Host namespaces it by Plugin and Binding. */
  readonly signalId: string;
  readonly name: string;
  readonly unit?: string;
  /** Optional source-defined label used only to group Signals in selectors. */
  readonly group?: string;
  readonly value: number;
  readonly quality?: SignalSample['quality'];
  readonly events?: readonly Omit<SignalEvent, 'timestamp'>[];
}

export type PluginProcessResult =
  | { readonly status: 'handled'; readonly samples: readonly PluginSignalSampleOutput[]; readonly diagnostics?: readonly Diagnostic[] }
  | { readonly status: 'ignored' }
  | { readonly status: 'error'; readonly diagnostics: readonly Diagnostic[] };

/** Per-analysis processor. Use this for protocol state learned from earlier Frames. */
export interface SigMixaPluginSession {
  processFrame(frame: Readonly<CanFrame>): PluginProcessResult;
  dispose?(): void;
}

export interface SigMixaPlugin extends SigMixaPluginSession {
  readonly id: string;
  readonly version: string;
  /** Declare PLUGIN_API_VERSION so the Host can verify compatibility. */
  readonly apiVersion?: string;
  getSupportedFrames(): FrameSupport;
  /**
   * Creates isolated state for one log analysis. When omitted, processFrame() is
   * used directly for backwards-compatible stateless Plugins.
   */
  createSession?(): SigMixaPluginSession;
  getConfigSchema?(): ConfigSchema | undefined;
  getConfig?(): unknown;
  setConfig?(config: unknown): void;
  validateConfig?(config: unknown): readonly Diagnostic[];
}

export function definePlugin<T extends SigMixaPlugin>(plugin: T): T { return plugin; }
