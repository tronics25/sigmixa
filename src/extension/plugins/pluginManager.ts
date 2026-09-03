import { createRequire } from 'module';
import * as path from 'path';
import * as vscode from 'vscode';
import type { Diagnostic } from '../../core/diagnostics/diagnostic';
import { PluginRegistry, pluginCompatibilityDiagnostics, validatePlugin } from '../../core/plugin/pluginHost';
import { addPluginBinding, installPlugin, setPluginBindingEnabled, setPluginEnabled, synchronizePluginSupport, uninstallPlugin } from '../../core/plugin/pluginProject';
import type { PluginRegistration } from '../../core/project/schema';
import type { SigMixaPlugin, ConfigSchema, FrameSupport } from '../../plugin-sdk';
import type { ProjectStore } from '../storage/projectStore';

export interface PluginRuntimeStatus {
  readonly id: string;
  readonly loaded: boolean;
  readonly message?: string;
  readonly schema?: ConfigSchema;
  readonly diagnostics: readonly Diagnostic[];
  readonly support?: FrameSupport;
}

export class PluginManager implements vscode.Disposable {
  readonly registry = new PluginRegistry();
  private readonly runtimeChanges = new vscode.EventEmitter<string>();
  readonly onDidChangeRuntime = this.runtimeChanges.event;
  private readonly statuses = new Map<string, PluginRuntimeStatus>();
  private readonly loadedSignatures = new Map<string, string>();
  private syncChain = Promise.resolve();
  private disposed = false;

  constructor(private readonly store: ProjectStore) {}

  sync(): Promise<void> {
    this.syncChain = this.syncChain.then(async () => {
      if (this.disposed) return;
      const active = new Set(this.store.current.plugins.map((item) => item.id));
      for (const loaded of this.registry.entries()) if (!active.has(loaded.plugin.id)) { this.registry.remove(loaded.plugin.id); this.loadedSignatures.delete(loaded.plugin.id); }
      for (const registration of this.store.current.plugins) if (this.loadedSignatures.get(registration.id) !== signature(registration)) await this.loadRegistration(registration);
    });
    return this.syncChain;
  }

  status(id: string): PluginRuntimeStatus { return this.statuses.get(id) ?? { id, loaded: false, message: 'Plugin has not been loaded.', diagnostics: [] }; }
  runtimeConfig(id: string): unknown { return this.registry.get(id)?.plugin.getConfig?.(); }

  async registerSource(sourceUri: vscode.Uri): Promise<string> {
    const root = this.store.requireWorkspace(); if (!root) throw new Error('A workspace folder is required.');
    const portableSource = sourceUri.scheme === 'file' && sourceUri.fsPath.startsWith(root.fsPath + path.sep) ? path.relative(root.fsPath, sourceUri.fsPath) : sourceUri.fsPath;
    const plugin = this.loadModule(sourceUri.fsPath, true); const support = validatePlugin(plugin);
    const schema = plugin.getConfigSchema?.(); const config = plugin.getConfig?.() ?? defaults(schema);
    const diagnostics = [...pluginCompatibilityDiagnostics(plugin), ...normalizeConfigDiagnostics(plugin.validateConfig?.(config) ?? [], plugin.id)];
    if (diagnostics.some((item) => item.severity === 'error')) throw new Error(diagnostics.map((item) => item.message).join('\n'));
    const registration: PluginRegistration = { id: plugin.id, version: plugin.version, source: portableSource, enabled: true, config, configSchemaVersion: schema?.schemaVersion };
    await this.store.update((project) => installPlugin(project, registration, support));
    await this.loadRegistration(registration, plugin);
    return plugin.id;
  }

  async reload(id: string): Promise<void> {
    const registration = this.store.current.plugins.find((item) => item.id === id); if (!registration) throw new Error('Plugin is not registered.');
    await this.loadRegistration(registration, undefined, true);
    this.runtimeChanges.fire(id);
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> { await this.store.update((project) => setPluginEnabled(project, id, enabled)); }
  async setBindingEnabled(id: string, enabled: boolean): Promise<void> { await this.store.update((project) => setPluginBindingEnabled(project, id, enabled)); }
  async addBinding(pluginId: string, frameId: string): Promise<void> { await this.store.update((project) => addPluginBinding(project, pluginId, frameId)); }

  async setConfig(id: string, config: unknown): Promise<readonly Diagnostic[]> {
    const registration = this.store.current.plugins.find((item) => item.id === id); const loaded = this.registry.get(id);
    if (!registration || !loaded) return [{ id: `plugin:${id}:not-loaded`, source: 'plugin', code: 'PLUGIN_NOT_LOADED', severity: 'error', message: 'Plugin is not loaded.' }];
    const diagnostics = normalizeConfigDiagnostics(loaded.plugin.validateConfig?.(config) ?? [], id);
    if (diagnostics.some((item) => item.severity === 'error')) return diagnostics;
    const previous = loaded.plugin.getConfig?.();
    let support: FrameSupport;
    try {
      loaded.plugin.setConfig?.(config);
      support = validatePlugin(loaded.plugin);
      await this.store.update((project) => synchronizePluginSupport({ ...project, plugins: project.plugins.map((item) => item.id === id ? { ...item, config, configSchemaVersion: loaded.plugin.getConfigSchema?.()?.schemaVersion } : item) }, id, support));
    } catch (error) {
      try { if (previous !== undefined) loaded.plugin.setConfig?.(previous); } catch { /* Preserve the original operation error. */ }
      return [{ id: `plugin:${id}:config`, source: 'plugin', code: 'PLUGIN_CONFIG_FAILED', severity: 'error', message: (error as Error).message, details: { pluginId: id } }];
    }
    this.statuses.set(id, { ...this.status(id), diagnostics, support }); this.loadedSignatures.set(id, signature({ ...registration, config }));
    return diagnostics;
  }

  async unregister(id: string): Promise<void> {
    await this.store.update((project) => uninstallPlugin(project, id)); this.registry.remove(id); this.statuses.delete(id); this.loadedSignatures.delete(id);
  }

  dispose(): void { this.disposed = true; this.registry.clear(); this.statuses.clear(); this.runtimeChanges.dispose(); }

  private async loadRegistration(registration: PluginRegistration, supplied?: SigMixaPlugin, bustCache = false): Promise<void> {
    let compatibilityFailure: Diagnostic[] | undefined;
    try {
      const plugin = supplied ?? this.loadModule(this.resolveSource(registration.source), bustCache);
      validatePlugin(plugin); if (plugin.id !== registration.id) throw new Error(`Source exports Plugin “${plugin.id}”, expected “${registration.id}”.`);
      const config = registration.config ?? defaults(plugin.getConfigSchema?.());
      const diagnostics = [...pluginCompatibilityDiagnostics(plugin, registration), ...normalizeConfigDiagnostics(plugin.validateConfig?.(config) ?? [], plugin.id)];
      if (!diagnostics.some((item) => item.severity === 'error')) plugin.setConfig?.(config);
      else {
        compatibilityFailure = diagnostics;
        throw new Error(diagnostics.filter((item) => item.severity === 'error').map((item) => item.message).join('\n'));
      }
      const support = validatePlugin(plugin);
      this.registry.register(plugin, registration.source);
      this.loadedSignatures.set(plugin.id, signature(registration));
      this.statuses.set(plugin.id, { id: plugin.id, loaded: true, schema: plugin.getConfigSchema?.(), diagnostics, support });
    } catch (error) {
      this.registry.remove(registration.id);
      this.loadedSignatures.delete(registration.id);
      this.statuses.set(registration.id, { id: registration.id, loaded: false, message: (error as Error).message, diagnostics: compatibilityFailure ?? [{ id: `plugin:${registration.id}:load`, source: 'plugin', code: 'PLUGIN_LOAD_FAILED', severity: 'error', message: (error as Error).message, details: { pluginId: registration.id } }] });
    }
  }

  private resolveSource(source: string): string {
    if (path.isAbsolute(source)) return source;
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath; if (!root) throw new Error('A workspace is required to resolve the Plugin source.');
    return path.resolve(root, source);
  }

  private loadModule(source: string, bustCache: boolean): SigMixaPlugin {
    const runtimeRequire = createRequire(__filename); const resolved = runtimeRequire.resolve(source);
    if (bustCache) delete runtimeRequire.cache[resolved];
    const moduleValue = runtimeRequire(resolved) as { default?: unknown; plugin?: unknown } | SigMixaPlugin;
    const candidate = (moduleValue as { default?: unknown }).default ?? (moduleValue as { plugin?: unknown }).plugin ?? moduleValue;
    return candidate as SigMixaPlugin;
  }
}

function defaults(schema: ConfigSchema | undefined): Record<string, unknown> {
  return Object.fromEntries(Object.entries(schema?.properties ?? {}).filter(([, value]) => 'default' in value && value.default !== undefined).map(([key, value]) => [key, 'default' in value ? value.default : undefined]));
}

function normalizeConfigDiagnostics(diagnostics: readonly Diagnostic[], pluginId: string): Diagnostic[] {
  return diagnostics.map((item, index) => ({ ...item, id: item.id || `plugin:${pluginId}:config:${index}`, source: 'plugin', details: { ...item.details, pluginId } }));
}

function signature(registration: PluginRegistration): string { return JSON.stringify([registration.source, registration.version, registration.config]); }
