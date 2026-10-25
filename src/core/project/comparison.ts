/**
 * Comparisons (R6). A comparison is opened from the selected log files and Clips and is not saved;
 * it references them by ID/path only and never copies CAN data or definitions. Each target has its own time shift.
 */

import type { TrajectoryCoordinateSystem, TrajectoryTrail, TrajectoryViewTransform } from '../trajectory/trajectory';

export type ComparisonTargetKind = 'file' | 'clip';

export interface ComparisonTarget {
  readonly id: string;
  readonly kind: ComparisonTargetKind;
  /** Portable log path (workspace-relative when possible) for `file` targets. */
  readonly sourcePath?: string;
  /** Clip ID for `clip` targets. */
  readonly clipId?: string;
  /** The place (analysis group, '' = where the log is) the log or Clip was selected in, which decides its definitions. */
  readonly level?: string;
  /** Time shift: seconds after the target's start that line up with comparison time 0. Any target can shift. */
  readonly offset: number;
}

export interface ComparisonAxisRange { readonly mode: 'visible' | 'global'; readonly includeZero?: boolean }

export interface ComparisonGraphDefinition {
  readonly id: string;
  /** Time-series graph (default) or trajectory; a trajectory uses `axes` and draws one path per target. */
  readonly kind?: 'graph' | 'trajectory';
  readonly name: string;
  readonly axes?: { readonly x?: string; readonly y?: string; readonly z?: string };
  readonly equalAspect?: boolean;
  readonly showPoints?: boolean;
  readonly showGrid?: boolean;
  readonly invert?: { readonly x: boolean; readonly y: boolean; readonly z: boolean };
  readonly trajectoryView?: TrajectoryViewTransform;
  /** Zoom and pan follow the data and the canvas size; true when no camera is saved. */
  readonly trajectoryViewFit?: boolean;
  /** Right-handed when absent. */
  readonly coordinateSystem?: TrajectoryCoordinateSystem;
  readonly trajectoryTrail?: TrajectoryTrail;
  /** Absolute source time captured when exporting a log/Clip report. */
  readonly trajectoryCurrentTime?: number;
  /** Signal IDs; a target that has no such Signal simply has no line for it. */
  readonly signalIds: readonly string[];
  readonly mode?: 'raw' | 'normalized';
  readonly connectGaps?: boolean;
  readonly axisRange?: ComparisonAxisRange;
  readonly height?: number;
}

export interface ComparisonDefinition {
  readonly id: string;
  readonly name: string;
  readonly targets: readonly ComparisonTarget[];
  readonly graphs: readonly ComparisonGraphDefinition[];
  readonly colors?: Readonly<Record<string, string>>;
  readonly hiddenTargetIds?: readonly string[];
}

/** Identity used to stop the same file or Clip being added twice. Different Clips of one log stay distinct. */
export function comparisonTargetKey(target: Pick<ComparisonTarget, 'kind' | 'sourcePath' | 'clipId' | 'level'>): string {
  return target.kind === 'clip' ? `clip:${target.level ?? ''}:${target.sourcePath ?? ''}:${target.clipId ?? ''}` : `file:${target.level ?? ''}:${target.sourcePath ?? ''}`;
}

/** Builds the target list from a selection: the same file or Clip is kept once, in selection order. */
export function uniqueComparisonTargets(targets: readonly ComparisonTarget[]): ComparisonTarget[] {
  const seen = new Set<string>();
  return targets.filter((target) => { const key = comparisonTargetKey(target); if (seen.has(key)) return false; seen.add(key); return true; });
}

/** Reorders targets by ID; unknown IDs are ignored and targets missing from `order` keep their place at the end. */
export function reorderComparisonTargets(comparison: ComparisonDefinition, order: readonly string[]): ComparisonDefinition {
  const byId = new Map(comparison.targets.map((target) => [target.id, target]));
  const ordered = order.flatMap((id) => { const target = byId.get(id); byId.delete(id); return target ? [target] : []; });
  return { ...comparison, targets: [...ordered, ...byId.values()] };
}

export function removeComparisonTarget(comparison: ComparisonDefinition, targetId: string): ComparisonDefinition {
  return { ...comparison, targets: comparison.targets.filter((target) => target.id !== targetId), hiddenTargetIds: (comparison.hiddenTargetIds ?? []).filter((id) => id !== targetId) };
}

export function setComparisonTargetOffset(comparison: ComparisonDefinition, targetId: string, offset: number): ComparisonDefinition {
  if (!Number.isFinite(offset)) return comparison;
  return { ...comparison, targets: comparison.targets.map((target) => target.id === targetId ? { ...target, offset } : target) };
}

/** The frame times of one log, as the time shift needs them. */
export interface FrameTimes {
  readonly first: number;
  readonly last: number;
  adjacent(timestamp: number, direction: -1 | 1): number | undefined;
  nearest(timestamp: number): number | undefined;
}

/**
 * Time shifts snap to the target's own frames, so a frame lands exactly on comparison time 0. Beyond the log's first or
 * last frame there is no frame to snap to; there the frames are mirrored around that end, so a target moves both ways
 * with steps of its own frame spacing and never stops at an end.
 */
export function snapAnchor(times: FrameTimes, timestamp: number): number {
  if (timestamp < times.first) return 2 * times.first - (times.nearest(2 * times.first - timestamp) ?? times.first);
  if (timestamp > times.last) return 2 * times.last - (times.nearest(2 * times.last - timestamp) ?? times.last);
  return times.nearest(timestamp) ?? timestamp;
}
/** `FrameTimes` over a sorted list of times, for where only the times themselves are at hand (a report's samples). */
export function sampleTimes(sorted: readonly number[]): FrameTimes {
  const lowerBound = (timestamp: number) => { let low = 0; let high = sorted.length; while (low < high) { const middle = (low + high) >> 1; if (sorted[middle] < timestamp) low = middle + 1; else high = middle; } return low; };
  return {
    first: sorted[0] ?? 0, last: sorted[sorted.length - 1] ?? 0,
    nearest: (timestamp) => { if (!sorted.length) return undefined; const index = lowerBound(timestamp); const after = sorted[index]; const before = sorted[index - 1]; return after === undefined ? before : before !== undefined && timestamp - before <= after - timestamp ? before : after; },
    adjacent: (timestamp, direction) => { const index = lowerBound(timestamp); return direction > 0 ? sorted[sorted[index] === timestamp ? index + 1 : index] : sorted[index - 1]; },
  };
}
/** The next snapped position from `anchor` (already snapped) in `direction`. */
export function stepAnchor(times: FrameTimes, anchor: number, direction: -1 | 1): number {
  if (anchor < times.first || (anchor === times.first && direction < 0)) {
    const mirrored = times.adjacent(times.nearest(2 * times.first - anchor) ?? 2 * times.first - anchor, direction < 0 ? 1 : -1);
    return mirrored === undefined ? anchor : 2 * times.first - mirrored;
  }
  if (anchor > times.last || (anchor === times.last && direction > 0)) {
    const mirrored = times.adjacent(times.nearest(2 * times.last - anchor) ?? 2 * times.last - anchor, direction < 0 ? 1 : -1);
    return mirrored === undefined ? anchor : 2 * times.last - mirrored;
  }
  return times.adjacent(anchor, direction) ?? anchor;
}

export interface SignalListGroup { readonly id: string; readonly label: string; readonly signalIds: readonly string[] }

/**
 * Splits Signal groups by which targets have each Signal, so targets with different Frame definitions
 * (e.g. different analysis groups) list "only in A" / "only in B" separately. Signals every target has
 * keep their plain group and come first. `targets` is in comparison order.
 */
export function splitSignalGroupsByTarget(groups: readonly SignalListGroup[], targets: readonly { readonly id: string; readonly name: string; readonly signalIds: ReadonlySet<string> }[], onlyIn: (names: string) => string, notIn: (names: string) => string = onlyIn): SignalListGroup[] {
  const common: SignalListGroup[] = []; const partial: { order: number; group: SignalListGroup }[] = [];
  for (const group of groups) {
    const byOwners = new Map<string, string[]>();
    for (const id of group.signalIds) {
      const owners = targets.filter((target) => target.signalIds.has(id)).map((target) => target.id);
      if (!owners.length) continue;
      const key = owners.length === targets.length ? '' : owners.join('\n');
      byOwners.set(key, [...(byOwners.get(key) ?? []), id]);
    }
    for (const [key, signalIds] of byOwners) {
      if (!key) { common.push({ ...group, signalIds }); continue; }
      const owners = key.split('\n'); const names = owners.map((id) => targets.find((target) => target.id === id)?.name ?? id);
      const missing = targets.filter((target) => !owners.includes(target.id)).map((target) => target.name);
      // Name the shorter side: "only in A" for a few owners, "not in C" when only a few targets lack it.
      const order = Math.min(...owners.map((id) => targets.findIndex((target) => target.id === id))) * 1000 + owners.length;
      partial.push({ order, group: { id: `${group.id}|${key}`, label: `${missing.length < owners.length ? notIn(missing.join('・')) : onlyIn(names.join('・'))} · ${group.label}`, signalIds } });
    }
  }
  return [...common, ...partial.sort((a, b) => a.order - b.order).map((item) => item.group)];
}
