import type { ManualFrameDefinition } from '../manual/manualDefinition';
import { signalDefinitionFor } from '../manual/manualDefinition';
import type { SignalDefinition } from './signal';
import { formatCanId } from '../frame/canId';

export interface SignalTreeLeaf {
  readonly type: 'signal';
  readonly id: string;
  readonly definition: SignalDefinition;
}

export interface SignalTreeGroup {
  readonly type: 'group';
  readonly id: string;
  readonly label: string;
  readonly source: 'can' | 'calculated' | 'external';
  readonly children: readonly SignalTreeLeaf[];
}

export type SelectionState = 'none' | 'some' | 'all';

export function buildManualSignalTree(frames: readonly ManualFrameDefinition[]): readonly SignalTreeGroup[] {
  return frames.filter((frame) => frame.signals.length > 0 || Boolean(frame.derivedSignals?.length)).map((frame) => ({
    type: 'group',
    id: `frame:${frame.id}`,
    label: `${formatCanId(frame.canId, frame.extended)}${frame.name ? ` ${frame.name}` : ''}`,
    source: 'can',
    children: [...frame.signals, ...(frame.derivedSignals ?? [])].map((signal) => ({ type: 'signal' as const, id: signal.id, definition: signalDefinitionFor(frame, signal) })),
  }));
}

export function selectionState(group: SignalTreeGroup, selected: ReadonlySet<string>): SelectionState {
  const count = group.children.reduce((sum, child) => sum + (selected.has(child.id) ? 1 : 0), 0);
  return count === 0 ? 'none' : count === group.children.length ? 'all' : 'some';
}

export function toggleGroup(
  group: SignalTreeGroup,
  selected: ReadonlySet<string>,
  visibleSignalIds?: ReadonlySet<string>
): ReadonlySet<string> {
  const result = new Set(selected);
  const targets = group.children.filter((child) => !visibleSignalIds || visibleSignalIds.has(child.id));
  const shouldSelect = targets.some((child) => !selected.has(child.id));
  for (const child of targets) shouldSelect ? result.add(child.id) : result.delete(child.id);
  return result;
}
