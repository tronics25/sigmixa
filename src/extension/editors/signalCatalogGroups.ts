import type { SigMixaProject } from '../../core/project/schema';
import type { SignalDefinition } from '../../core/signal/signal';
import { formatCanId } from '../../core/frame/canId';
import type { SignalGroupDto } from './rawLogProtocol';

/**
 * Groups one log's Signal catalog by Frame, Plugin binding and External CSV source.
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
  const externalGroups = includeExternal ? sourceProject.externalCsvSources.map((source) => ({
    id: `external:${source.id}`, label: `External · ${source.fileName}`,
    signalIds: allDefinitions.filter((item) => item.source.type === 'external-csv' && item.source.sourceId === source.id).map((item) => item.id),
    remove: { type: 'external-csv' as const, sourceId: source.id },
  })).filter((group) => group.signalIds.length) : [];
  return [...manualGroups, ...pluginGroups, ...externalGroups];
}
