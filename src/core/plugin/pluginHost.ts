import type { Diagnostic } from '../diagnostics/diagnostic';
import type { CanFrame } from '../frame/canFrame';
import type { PluginBinding, PluginRegistration } from '../project/schema';
import type { SignalDefinition, SignalEvent, SignalSample } from '../signal/signal';
import { PLUGIN_API_VERSION, type SigMixaPlugin, type SigMixaPluginSession, type FrameSupport, type PluginSignalSampleOutput } from '../../plugin-sdk';

export interface LoadedPlugin {
  readonly plugin: SigMixaPlugin;
  readonly source: string;
}

export class PluginRegistry {
  private readonly loaded = new Map<string, LoadedPlugin>();

  register(plugin: SigMixaPlugin, source = 'memory'): LoadedPlugin {
    validatePlugin(plugin);
    const loaded = { plugin, source };
    this.loaded.set(plugin.id, loaded);
    return loaded;
  }

  get(id: string): LoadedPlugin | undefined { return this.loaded.get(id); }
  remove(id: string): void { this.loaded.delete(id); }
  clear(): void { this.loaded.clear(); }
  entries(): readonly LoadedPlugin[] { return [...this.loaded.values()]; }
}

export interface PluginFrameDefinition {
  readonly id: string;
  readonly canId: number;
  readonly extended: boolean;
}

export interface PluginDecodedSignal {
  readonly definition: SignalDefinition;
  readonly sample: SignalSample;
}

export interface PluginHostResult {
  readonly handled: boolean;
  readonly decoded: readonly PluginDecodedSignal[];
  readonly events: ReadonlyMap<string, readonly SignalEvent[]>;
  readonly diagnostics: readonly Diagnostic[];
}

export class PluginHost {
  private readonly registrations = new Map<string, PluginRegistration>();
  private readonly bindingsByCanKey = new Map<string, PluginBinding[]>();
  private readonly sessions = new Map<string, SigMixaPluginSession | Error>();

  constructor(
    private readonly registry: PluginRegistry,
    frames: readonly PluginFrameDefinition[],
    registrations: readonly PluginRegistration[],
    bindings: readonly PluginBinding[]
  ) {
    const framesById = new Map(frames.map((frame) => [frame.id, frame]));
    registrations.forEach((registration) => {
      this.registrations.set(registration.id, registration);
      if (!registration.enabled) return;
      const loaded = registry.get(registration.id);
      if (!loaded) return;
      try {
        const session = loaded.plugin.createSession?.() ?? loaded.plugin;
        if (!session || typeof session.processFrame !== 'function') throw new Error('Plugin createSession() must return a processor with processFrame().');
        this.sessions.set(registration.id, session);
      } catch (error) {
        this.sessions.set(registration.id, error instanceof Error ? error : new Error(String(error)));
      }
    });
    for (const binding of bindings) {
      const frame = framesById.get(binding.frameId); if (!frame) continue;
      const key = canKey(frame.canId, frame.extended); const list = this.bindingsByCanKey.get(key) ?? [];
      list.push(binding); this.bindingsByCanKey.set(key, list);
    }
  }

  processFrame(frame: CanFrame): PluginHostResult {
    const decoded: PluginDecodedSignal[] = []; const diagnostics: Diagnostic[] = []; const events = new Map<string, SignalEvent[]>(); let handled = false;
    const bindings = this.bindingsByCanKey.get(canKey(frame.canId, frame.extended)) ?? [];
    for (const binding of bindings) {
      const registration = this.registrations.get(binding.pluginId);
      if (!registration?.enabled || !binding.enabled) continue;
      const loaded = this.registry.get(binding.pluginId);
      if (!loaded) {
        diagnostics.push(pluginDiagnostic(binding.pluginId, binding.id, frame, 'PLUGIN_NOT_LOADED', 'Plugin is registered but not loaded.'));
        continue;
      }
      const session = this.sessions.get(binding.pluginId) ?? loaded.plugin;
      if (session instanceof Error) {
        diagnostics.push(pluginDiagnostic(binding.pluginId, binding.id, frame, 'PLUGIN_SESSION_CREATE_FAILED', `Plugin could not create an analysis session: ${session.message}`));
        continue;
      }
      try {
        const result = session.processFrame(readonlyFrame(frame));
        if (!result || !['handled', 'ignored', 'error'].includes(result.status)) throw new Error('Plugin returned an invalid process result.');
        if (result.status === 'ignored') continue;
        if (result.status === 'error') {
          diagnostics.push(...normalizeDiagnostics(result.diagnostics, binding, frame));
          continue;
        }
        handled = true;
        diagnostics.push(...normalizeDiagnostics(result.diagnostics ?? [], binding, frame));
        for (const output of result.samples) {
          const normalized = normalizeOutput(output, registration.id, binding, frame);
          if ('diagnostic' in normalized) { diagnostics.push(normalized.diagnostic); continue; }
          decoded.push({ definition: normalized.definition, sample: normalized.sample });
          if (normalized.events.length) events.set(normalized.definition.id, normalized.events);
        }
      } catch (error) {
        diagnostics.push(pluginDiagnostic(binding.pluginId, binding.id, frame, 'PLUGIN_PROCESS_THROW', `Plugin threw while processing a frame: ${(error as Error).message}`));
      }
    }
    return { handled, decoded, events, diagnostics };
  }

  dispose(): void {
    for (const session of this.sessions.values()) if (!(session instanceof Error)) {
      try { session.dispose?.(); } catch { /* Plugin cleanup must not affect the Host. */ }
    }
    this.sessions.clear();
  }
}

export function validatePlugin(plugin: SigMixaPlugin): FrameSupport {
  if (!plugin || typeof plugin !== 'object') throw new Error('Plugin module must export a Plugin object.');
  if (!plugin.id?.trim() || !/^[a-z0-9][a-z0-9._-]*$/i.test(plugin.id)) throw new Error('Plugin ID must be a stable non-empty identifier.');
  if (!plugin.version?.trim()) throw new Error('Plugin version is required.');
  if (typeof plugin.processFrame !== 'function' || typeof plugin.getSupportedFrames !== 'function') throw new Error('Plugin must implement getSupportedFrames() and processFrame().');
  const support = plugin.getSupportedFrames();
  if (support?.type === 'any') return support;
  if (support?.type !== 'specific' || !Array.isArray(support.frames)) throw new Error('Plugin returned invalid Frame support.');
  for (const frame of support.frames) {
    const extended = frame.extended === true; const max = extended ? 0x1fffffff : 0x7ff;
    if (!Number.isInteger(frame.canId) || frame.canId < 0 || frame.canId > max) throw new Error(`Plugin declares an invalid ${extended ? 'extended' : 'standard'} CAN ID.`);
    if (frame.frameLength !== undefined && ![0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32, 48, 64].includes(frame.frameLength)) throw new Error('Plugin declares an invalid Classic CAN / CAN FD frame length.');
  }
  return support;
}

export function pluginCompatibilityDiagnostics(plugin: SigMixaPlugin, registration?: PluginRegistration): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const detail = { pluginId: plugin.id, hostApiVersion: PLUGIN_API_VERSION };
  if (!plugin.apiVersion) {
    diagnostics.push({ id: `plugin:${plugin.id}:api-missing`, source: 'plugin', code: 'PLUGIN_API_VERSION_MISSING', severity: 'warning', message: `Plugin does not declare apiVersion; Host API ${PLUGIN_API_VERSION} compatibility cannot be verified.`, details: detail });
  } else {
    const pluginMajor = major(plugin.apiVersion); const hostMajor = major(PLUGIN_API_VERSION);
    if (pluginMajor === undefined) diagnostics.push({ id: `plugin:${plugin.id}:api-invalid`, source: 'plugin', code: 'PLUGIN_API_VERSION_INVALID', severity: 'error', message: `Plugin apiVersion “${plugin.apiVersion}” is not a supported version string.`, details: { ...detail, pluginApiVersion: plugin.apiVersion } });
    else if (pluginMajor !== hostMajor) diagnostics.push({ id: `plugin:${plugin.id}:api-incompatible`, source: 'plugin', code: 'PLUGIN_API_INCOMPATIBLE', severity: 'error', message: `Plugin API ${plugin.apiVersion} is incompatible with Host API ${PLUGIN_API_VERSION}.`, details: { ...detail, pluginApiVersion: plugin.apiVersion } });
  }
  if (registration && registration.version !== plugin.version) {
    diagnostics.push({ id: `plugin:${plugin.id}:version-changed`, source: 'plugin', code: 'PLUGIN_VERSION_CHANGED', severity: 'warning', message: `Registered Plugin version ${registration.version} differs from loaded version ${plugin.version}. Review its configuration before relying on results.`, details: { ...detail, registeredVersion: registration.version, loadedVersion: plugin.version } });
  }
  const runtimeSchema = plugin.getConfigSchema?.()?.schemaVersion;
  if (registration?.configSchemaVersion && runtimeSchema && registration.configSchemaVersion !== runtimeSchema) {
    diagnostics.push({ id: `plugin:${plugin.id}:schema-changed`, source: 'plugin', code: 'PLUGIN_CONFIG_SCHEMA_CHANGED', severity: 'warning', message: `Plugin configuration schema changed from ${registration.configSchemaVersion} to ${runtimeSchema}.`, details: { ...detail, registeredSchemaVersion: registration.configSchemaVersion, runtimeSchemaVersion: runtimeSchema } });
  }
  return diagnostics;
}

function major(value: string): number | undefined {
  const match = /^(\d+)(?:\.|$)/.exec(value.trim());
  return match ? Number(match[1]) : undefined;
}

function readonlyFrame(frame: CanFrame): Readonly<CanFrame> {
  // A private payload copy prevents a Plugin from mutating the Store's frame bytes.
  return Object.freeze({ ...frame, data: frame.data.slice() });
}

function canKey(canId: number, extended: boolean): string { return `${extended ? 'e' : 's'}:${canId}`; }

function normalizeOutput(output: PluginSignalSampleOutput, pluginId: string, binding: PluginBinding, frame: CanFrame):
  | { definition: SignalDefinition; sample: SignalSample; events: SignalEvent[] }
  | { diagnostic: Diagnostic } {
  if (!output?.signalId?.trim() || !output.name?.trim() || !Number.isFinite(output.value)) {
    return { diagnostic: pluginDiagnostic(pluginId, binding.id, frame, 'PLUGIN_SAMPLE_INVALID', 'Plugin returned a Signal with an invalid ID, name, or value.') };
  }
  const id = `plugin:${encodeURIComponent(pluginId)}:${encodeURIComponent(binding.id)}:${encodeURIComponent(output.signalId)}`;
  const definition: SignalDefinition = { id, name: output.name.trim(), unit: output.unit?.trim() || undefined, group: output.group?.trim() || undefined, source: { type: 'plugin', pluginId, bindingId: binding.id }, frameRef: { canId: frame.canId, extended: frame.extended } };
  const sample: SignalSample = { timestamp: frame.timestamp, value: output.value, quality: output.quality };
  const signalEvents = (output.events ?? []).map((event) => ({ ...event, timestamp: frame.timestamp }));
  return { definition, sample, events: signalEvents };
}

function normalizeDiagnostics(input: readonly Diagnostic[], binding: PluginBinding, frame: CanFrame): Diagnostic[] {
  return input.map((item, index) => ({
    ...item,
    id: item.id || `plugin:${binding.pluginId}:${binding.id}:${frame.id}:${index}`,
    source: 'plugin',
    location: { sourceId: frame.sourceId, frameId: frame.id, ...item.location },
    details: { ...item.details, pluginId: binding.pluginId, bindingId: binding.id },
  }));
}

function pluginDiagnostic(pluginId: string, bindingId: string, frame: CanFrame, code: string, message: string): Diagnostic {
  return { id: `plugin:${pluginId}:${bindingId}:${frame.id}:${code}`, source: 'plugin', code, severity: 'error', message, location: { sourceId: frame.sourceId, frameId: frame.id }, details: { pluginId, bindingId } };
}
