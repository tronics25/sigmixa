import type { SignalDefinition } from '../../core/signal/signal';
import { resolveDisplayUnit } from '../../core/units/displayUnit';

export function signalAxisKey(unit: string | undefined): string {
  const value = unit?.trim();
  const conversion = resolveDisplayUnit(value);
  return conversion ? `family:${conversion.family}` : value ? `unit:${value.toLowerCase()}` : 'empty';
}

/** Keep every selection in its view; use one normalized axis beyond two unit systems. */
export function graphDisplayPolicy(selectedIds: readonly string[], definitions: readonly Pick<SignalDefinition, 'id' | 'unit'>[], requestedMode: 'raw' | 'normalized') {
  const selected = new Set(selectedIds);
  const axisKeys = [...new Set(definitions.filter((definition) => selected.has(definition.id)).map((definition) => signalAxisKey(definition.unit)))];
  const requiresNormalization = axisKeys.length > 2;
  return { axisKeys, requiresNormalization, mode: requiresNormalization ? 'normalized' as const : requestedMode };
}

/** Explicit actual-value switching only: preserve axis priority and keep missing references on the source. */
export function partitionActualGraphs(selectedIds: readonly string[], definitions: readonly Pick<SignalDefinition, 'id' | 'unit'>[], preferredAxes: readonly string[] = []) {
  const { axisKeys } = graphDisplayPolicy(selectedIds, definitions, 'raw');
  const orderedAxes = [...new Set([...preferredAxes.filter((key) => axisKeys.includes(key)), ...axisKeys])];
  const groups = Array.from({ length: Math.max(1, Math.ceil(orderedAxes.length / 2)) }, (_, index) => ({
    axisKeys: orderedAxes.slice(index * 2, index * 2 + 2), selectedIds: [] as string[],
  }));
  const axesById = new Map(definitions.map((definition) => [definition.id, signalAxisKey(definition.unit)]));
  for (const id of new Set(selectedIds)) {
    const axis = axesById.get(id);
    const index = axis === undefined ? 0 : Math.floor(orderedAxes.indexOf(axis) / 2);
    groups[index].selectedIds.push(id);
  }
  return groups;
}
