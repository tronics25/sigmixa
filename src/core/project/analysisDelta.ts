import type { SigMixaProject } from './schema';

export interface ManualAnalysisDelta {
  readonly frameIds: ReadonlySet<string>;
  readonly canRefs: readonly { readonly canId: number; readonly extended: boolean }[];
}

/**
 * Returns the manual CAN subset that can be safely rebuilt independently.
 * Stateful Plugin or External CSV changes deliberately request a full rebuild.
 */
export function manualAnalysisDelta(previous: SigMixaProject, next: SigMixaProject): ManualAnalysisDelta | undefined {
  if (JSON.stringify(previous.plugins) !== JSON.stringify(next.plugins)
    || JSON.stringify(previous.pluginBindings) !== JSON.stringify(next.pluginBindings)
    || JSON.stringify(previous.externalCsvSources) !== JSON.stringify(next.externalCsvSources)
    || pluginRoutingSignature(previous) !== pluginRoutingSignature(next)) return undefined;
  const before = new Map(previous.frames.map((frame) => [frame.id, frame]));
  const after = new Map(next.frames.map((frame) => [frame.id, frame]));
  const frameIds = new Set<string>();
  for (const id of new Set([...before.keys(), ...after.keys()])) if (JSON.stringify(before.get(id)) !== JSON.stringify(after.get(id))) frameIds.add(id);
  const refs = new Map<string, { readonly canId: number; readonly extended: boolean }>();
  for (const id of frameIds) for (const frame of [before.get(id), after.get(id)]) if (frame) refs.set(canKey(frame.canId, frame.extended), { canId: frame.canId, extended: frame.extended });
  return { frameIds, canRefs: [...refs.values()] };
}

function pluginRoutingSignature(project: SigMixaProject): string {
  const frames = new Map(project.frames.map((frame) => [frame.id, frame]));
  return JSON.stringify(project.pluginBindings.map((binding) => {
    const frame = frames.get(binding.frameId);
    return [binding.id, binding.pluginId, binding.frameId, binding.enabled, frame?.canId, frame?.extended];
  }));
}

function canKey(canId: number, extended: boolean): string { return `${extended ? 'e' : 's'}:${canId}`; }
