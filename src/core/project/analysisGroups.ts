import type { ManualFrameDefinition } from '../manual/manualDefinition';
import type { AnalysisGroup, PluginRegistration, SigMixaProject } from './schema';

export function frameKey(frame: Pick<ManualFrameDefinition, 'canId' | 'extended'>): string {
  return `${frame.extended ? 'e' : 's'}:${frame.canId}`;
}

/** The levels from the one directly below the common definitions down to `groupId`. */
export function groupChain(project: SigMixaProject, groupId?: string): AnalysisGroup[] {
  const chain: AnalysisGroup[] = []; const seen = new Set<string>();
  let group = project.analysisGroups?.find((item) => item.id === groupId);
  while (group && !seen.has(group.id)) { chain.unshift(group); seen.add(group.id); group = group.parentId ? project.analysisGroups?.find((item) => item.id === group!.parentId) : undefined; }
  return chain;
}

/** Whole-frame overlays, level by level from the common definitions down to `groupId`; a level never mutates the ones above it. */
export function resolveGroupProject(project: SigMixaProject, groupId?: string): SigMixaProject {
  return groupChain(project, groupId).reduce(overlayGroup, project);
}

function overlayGroup(project: SigMixaProject, group: AnalysisGroup): SigMixaProject {
  const frames = new Map(project.frames.map((frame) => [frameKey(frame), frame]));
  for (const frame of group.frames) frames.set(frameKey(frame), frame);
  const resolved = [...frames.values()];
  const ids = new Set(resolved.map((frame) => frame.id));
  // A log must stay openable after the receiver changes or removes a Plugin: skip the group's bindings to it instead of failing.
  const required = group.definitionDependencies?.plugins ?? [];
  const unusable = new Set(unusablePackagePlugins(required, project.plugins).map((plugin) => plugin.id));
  const usable = resolvePackagePlugins(required.filter((plugin) => !unusable.has(plugin.id)), project.plugins);
  return {
    ...project,
    lookupTables: overlayById(project.lookupTables, group.definitionDependencies?.lookupTables ?? []),
    calculations: overlayById(project.calculations, group.definitionDependencies?.calculations ?? []),
    externalCsvSources: overlayById(project.externalCsvSources, group.definitionDependencies?.externalCsvSources ?? []),
    plugins: overlayById(project.plugins, usable),
    frames: resolved,
    pluginBindings: overlayById(project.pluginBindings, (group.definitionDependencies?.pluginBindings ?? []).filter((binding) => !unusable.has(binding.pluginId))).filter((binding) => ids.has(binding.frameId)),
  };
}

/**
 * The definition a new Frame in `groupId` would override: the one with the same CAN ID in the levels above it.
 * Its copy is the starting point of the override, so it starts with the same name, length and Signals (same Signal IDs,
 * so graphs and tables that show them keep working) and only the differences have to be edited.
 */
export function overrideTemplate(project: SigMixaProject, groupId: string, canId: number, extended: boolean, id: string): ManualFrameDefinition | undefined {
  const group = project.analysisGroups?.find((item) => item.id === groupId); if (!group) return undefined;
  const above = resolveGroupProject(project, group.parentId).frames.find((frame) => frame.canId === canId && frame.extended === extended);
  return above ? { ...structuredClone(above), id, origin: { type: 'manual' } } : undefined;
}

export function updateGroup(project: SigMixaProject, groupId: string, update: (group: AnalysisGroup) => AnalysisGroup): SigMixaProject {
  if (!project.analysisGroups?.some((group) => group.id === groupId)) throw new Error('Analysis group was not found.');
  return { ...project, analysisGroups: project.analysisGroups.map((group) => group.id === groupId ? update(group) : group) };
}

/** Only accepted Frames move. Callers confirm replacements before saving this result atomically. */
export function promoteGroupFrames(project: SigMixaProject, groupId: string, acceptedIds: readonly string[]): SigMixaProject {
  const group = project.analysisGroups?.find((item) => item.id === groupId);
  if (!group) throw new Error('Analysis group was not found.');
  // Promotion goes one level up: into the parent level when there is one, otherwise into the common definitions.
  const parent = group.parentId ? project.analysisGroups?.find((item) => item.id === group.parentId) : undefined;
  if (parent) {
    const asCommon: SigMixaProject = { ...project, frames: parent.frames, analysisGroups: [group], plugins: project.plugins,
      pluginBindings: parent.definitionDependencies?.pluginBindings ?? [], lookupTables: parent.definitionDependencies?.lookupTables ?? [],
      calculations: parent.definitionDependencies?.calculations ?? [], externalCsvSources: parent.definitionDependencies?.externalCsvSources ?? [] };
    const moved = promoteGroupFrames(asCommon, groupId, acceptedIds);
    const child = moved.analysisGroups![0];
    return { ...project, analysisGroups: project.analysisGroups!.map((item) => item.id === groupId ? child : item.id === parent.id ? { ...parent, frames: moved.frames,
      definitionDependencies: { plugins: parent.definitionDependencies?.plugins ?? [], pluginBindings: moved.pluginBindings, lookupTables: moved.lookupTables, calculations: moved.calculations, externalCsvSources: moved.externalCsvSources } } : item) };
  }
  const accepted = new Set(acceptedIds);
  const moving = group.frames.filter((frame) => accepted.has(frame.id));
  const keys = new Set(moving.map(frameKey));
  const frames = [...project.frames.filter((frame) => !keys.has(frameKey(frame))), ...moving];
  if (!moving.length) return project;
  const ids = new Set(frames.map((frame) => frame.id));
  if (ids.size !== frames.length) throw new Error('Frame ID conflicts with an unrelated common Frame.');
  const signalIds = frames.flatMap((frame) => [...frame.signals, ...(frame.derivedSignals ?? [])].map((signal) => signal.id));
  if (new Set(signalIds).size !== signalIds.length) throw new Error('Signal ID conflicts with another common Frame.');
  // Preserve calculation dependencies. A conflicting dependency is not covered by
  // the CAN-ID overwrite confirmation, so leave the project unchanged in that case.
  const lookupTables = mergeDependencies(project.lookupTables, group.definitionDependencies?.lookupTables ?? []);
  const calculations = mergeDependencies(project.calculations, group.definitionDependencies?.calculations ?? []);
  const externalCsvSources = mergeDependencies(project.externalCsvSources, group.definitionDependencies?.externalCsvSources ?? []);
  const localBindings = (group.definitionDependencies?.pluginBindings ?? []).filter(binding => accepted.has(binding.frameId));
  const requiredPlugins = new Set(localBindings.map(binding => binding.pluginId));
  resolvePackagePlugins((group.definitionDependencies?.plugins ?? []).filter(plugin => requiredPlugins.has(plugin.id)), project.plugins);
  const pluginBindings = mergeDependencies(project.pluginBindings.filter(binding => ids.has(binding.frameId)), localBindings);
  return updateGroup({ ...project, frames, lookupTables, calculations, externalCsvSources, pluginBindings }, groupId, (current) => ({ ...current, frames: current.frames.filter((frame) => !accepted.has(frame.id)),
    definitionDependencies: current.definitionDependencies ? { ...current.definitionDependencies, pluginBindings: current.definitionDependencies.pluginBindings.filter(binding => !accepted.has(binding.frameId)) } : undefined }));
}

/** Never trust a sender's executable path or change the receiver's shared Plugin runtime configuration. */
export function resolvePackagePlugins(required: readonly PluginRegistration[], installed: readonly PluginRegistration[]): PluginRegistration[] {
  return required.map(plugin => {
    const local = matchingPlugin(plugin, installed);
    if (!local) {
      throw new Error(`Plugin “${plugin.id}” (${plugin.version}): register and enable the same version and configuration in the Plugins pane before importing or using these definitions.`);
    }
    return { ...local, enabled: plugin.enabled };
  });
}
function matchingPlugin(plugin: PluginRegistration, installed: readonly PluginRegistration[]): PluginRegistration | undefined {
  const local = installed.find(candidate => candidate.id === plugin.id);
  return !local || local.version !== plugin.version || stable(local.config) !== stable(plugin.config) || local.configSchemaVersion !== plugin.configSchemaVersion || (plugin.enabled && !local.enabled) ? undefined : local;
}
/** The required Plugins that are not registered and enabled here with the same version and configuration. */
export function unusablePackagePlugins(required: readonly PluginRegistration[], installed: readonly PluginRegistration[]): PluginRegistration[] {
  return required.filter(plugin => !matchingPlugin(plugin, installed));
}
/** The Plugins an analysis group's own definitions need but cannot use; their group bindings are skipped. */
export function groupUnusablePlugins(project: SigMixaProject, groupId: string | undefined): PluginRegistration[] {
  const group = project.analysisGroups?.find((item) => item.id === groupId);
  return unusablePackagePlugins(group?.definitionDependencies?.plugins ?? [], project.plugins);
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])));
  return JSON.stringify(value) ?? 'undefined';
}

function overlayById<T extends { readonly id: string }>(common: readonly T[], local: readonly T[]): T[] {
  return [...new Map([...common, ...local].map((item) => [item.id, item])).values()];
}

function mergeDependencies<T extends { readonly id: string }>(common: readonly T[], local: readonly T[]): T[] {
  for (const item of local) {
    const existing = common.find((candidate) => candidate.id === item.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(item)) throw new Error(`Dependency “${item.id}” conflicts with a common definition. Resolve the dependency before promoting Frames.`);
  }
  return overlayById(common, local);
}
