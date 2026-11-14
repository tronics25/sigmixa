import type { SigMixaProject } from '../../core/project/schema';
import type { SignalDefinition } from '../../core/signal/signal';
import { formatCanId } from '../../core/frame/canId';
import type { SignalGroupDto } from './rawLogProtocol';

/**
 * Groups one log's Signal catalog by Frame, Plugin binding and MF4/MDF/CSV channel group.
 * `sourceProject` contains the log's resolved definitions and dependencies (common → analysis group).
 */
export function signalCatalogGroups(allDefinitions: readonly SignalDefinition[], sourceProject: SigMixaProject, includeExternal: boolean): SignalGroupDto[] {
  const manualGroups = sourceProject.frames.filter((frame) => frame.signals.length || frame.derivedSignals?.length).map((frame) => ({
    id: `frame:${frame.id}`,
    label: `${formatCanId(frame.canId, frame.extended)}${frame.name ? ` ${frame.name}` : ''}`,
    signalIds: [...frame.signals, ...(frame.derivedSignals ?? [])].map((signal) => signal.id),
  }));
  const pluginGroups = sourceProject.pluginBindings.flatMap((binding) => {
    const frame = sourceProject.frames.find((item) => item.id === binding.frameId);
    const byGroup = new Map<string, string[]>();
    for (const definition of allDefinitions.filter((item) => item.source.type === 'plugin' && item.source.bindingId === binding.id)) {
      const list = byGroup.get(definition.group ?? '') ?? []; list.push(definition.id); byGroup.set(definition.group ?? '', list);
    }
    return [...byGroup].map(([group, signalIds]) => ({
      id: `plugin:${binding.id}:${encodeURIComponent(group)}`,
      label: `Plugin ${binding.pluginId}${frame ? ` · ${formatCanId(frame.canId, frame.extended)}` : ''}${group ? ` · ${group}` : ''}`,
      signalIds,
    }));
  }).filter((group) => group.signalIds.length);
  const mdfGroups = new Map<string, { label: string; signalIds: string[] }>();
  if (includeExternal) for (const definition of allDefinitions) if (definition.source.type === 'mdf-channel') {
    const entry = mdfGroups.get(definition.source.group) ?? { label: definition.source.group ? `${definition.source.format ?? 'MF4'} · ${definition.source.group}` : definition.source.format ?? 'MF4', signalIds: [] };
    entry.signalIds.push(definition.id); mdfGroups.set(definition.source.group, entry);
  }
  const measuredGroups = [...mdfGroups].map(([group, { label, signalIds }]) => ({ id: `mdf:${encodeURIComponent(group)}`, label, signalIds, ...(group ? {} : { unnamed: true }) }));
  return [...manualGroups, ...pluginGroups, ...measuredGroups];
}
