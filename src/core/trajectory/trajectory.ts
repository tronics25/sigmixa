import type { SignalSample } from '../signal/signal';
import { downsampleEven } from '../timeline/timeline';

export interface TrajectoryPoint { readonly timestamp: number; readonly x: number; readonly y: number; readonly z?: number; }
export interface TrajectoryMeasurement {
  readonly first: TrajectoryPoint;
  readonly second: TrajectoryPoint;
  readonly deltaTime: number;
  readonly deltaX: number;
  readonly deltaY: number;
  readonly deltaZ?: number;
  readonly straightDistance: number;
  readonly pathLength: number;
  readonly averageSpeed?: number;
}
export interface TrajectoryViewTransform { readonly yaw: number; readonly pitch: number; readonly zoom: number; readonly panX: number; readonly panY: number; readonly mirrorHorizontal?: boolean; }
export type TrajectoryTrail = { readonly type: 'all' } | { readonly type: 'to-current' } | { readonly type: 'last-seconds'; readonly seconds: number };

export function buildTrajectoryPoints(
  x: readonly SignalSample[], y: readonly SignalSample[], z: readonly SignalSample[] | undefined,
  invert: { readonly x: boolean; readonly y: boolean; readonly z: boolean }, limit = 4000
): readonly TrajectoryPoint[] {
  const sources = z ? [x, y, z] : [x, y]; const indexes = new Array(sources.length).fill(0); const points: TrajectoryPoint[] = [];
  while (indexes.every((index, axis) => index < sources[axis].length)) {
    const times = indexes.map((index, axis) => sources[axis][index].timestamp); const target = Math.max(...times);
    let aligned = true;
    for (let axis = 0; axis < sources.length; axis++) {
      while (indexes[axis] < sources[axis].length && sources[axis][indexes[axis]].timestamp < target) indexes[axis]++;
      if (indexes[axis] >= sources[axis].length || sources[axis][indexes[axis]].timestamp !== target) aligned = false;
    }
    if (!aligned) continue;
    const alignedSamples = indexes.map((index, axis) => sources[axis][index]); indexes.forEach((_, axis) => indexes[axis]++);
    if (!alignedSamples.every((sample) => Number.isFinite(sample.value) && (sample.quality === undefined || sample.quality === 'valid'))) continue;
    const values = alignedSamples.map((sample) => sample.value);
    points.push({ timestamp: target, x: invert.x ? -values[0] : values[0], y: invert.y ? -values[1] : values[1], ...(z ? { z: invert.z ? -values[2] : values[2] } : {}) });
  }
  return downsampleEven(points, limit);
}

export function trailAt(points: readonly TrajectoryPoint[], current: number, trail: TrajectoryTrail): readonly TrajectoryPoint[] {
  if (trail.type === 'all') return points;
  const start = trail.type === 'last-seconds' ? current - Math.max(0, trail.seconds) : -Infinity;
  return points.filter((point) => point.timestamp >= start && point.timestamp <= current);
}

export function defaultTrajectoryView(): TrajectoryViewTransform { return { yaw: Math.PI / 4, pitch: Math.atan(1 / Math.sqrt(2)), zoom: 1, panX: 0, panY: 0 }; }
export function presetTrajectoryView(preset: 'top' | 'front' | 'side' | 'reset'): TrajectoryViewTransform {
  if (preset === 'top') return { yaw: Math.PI, pitch: Math.PI / 2, zoom: 1, panX: 0, panY: 0, mirrorHorizontal: true };
  if (preset === 'front') return { yaw: 0, pitch: 0, zoom: 1, panX: 0, panY: 0, mirrorHorizontal: true };
  if (preset === 'side') return { yaw: Math.PI / 2, pitch: 0, zoom: 1, panX: 0, panY: 0, mirrorHorizontal: true };
  return defaultTrajectoryView();
}

export function projectPoint3d(point: { x: number; y: number; z: number }, view: TrajectoryViewTransform): { x: number; y: number; depth: number } {
  const cy = Math.cos(view.yaw); const sy = Math.sin(view.yaw); const cp = Math.cos(view.pitch); const sp = Math.sin(view.pitch);
  const horizontal = point.y * cy - point.x * sy; const depthHorizontal = point.x * cy + point.y * sy;
  return { x: ((view.mirrorHorizontal ? -horizontal : horizontal) + view.panX) * view.zoom, y: (point.z * cp - depthHorizontal * sp + view.panY) * view.zoom, depth: point.z * sp + depthHorizontal * cp };
}

/** Produces stable, human-readable tick values while keeping zero visible as the coordinate origin. */
export function trajectoryAxisScale(values: readonly number[], targetTickCount = 6): { readonly minimum: number; readonly maximum: number; readonly ticks: readonly number[] } {
  const finite = values.filter(Number.isFinite);
  let minimum = Math.min(0, ...finite); let maximum = Math.max(0, ...finite);
  if (!finite.length) { minimum = -1; maximum = 1; }
  if (minimum === maximum) { const pad = Math.abs(minimum) * .1 || 1; minimum -= pad; maximum += pad; }
  const rawStep = (maximum - minimum) / Math.max(2, targetTickCount);
  const magnitude = 10 ** Math.floor(Math.log10(rawStep)); const normalized = rawStep / magnitude;
  const step = (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude;
  const first = Math.floor(minimum / step) * step; const last = Math.ceil(maximum / step) * step; const ticks: number[] = [];
  for (let value = first; value <= last + step * 1e-9 && ticks.length < 100; value += step) ticks.push(Math.abs(value) < step * 1e-9 ? 0 : Number(value.toPrecision(12)));
  return { minimum: first, maximum: last, ticks };
}

export function trajectoryAxisEndpoints(minimum: number, maximum: number, inverted: boolean): { readonly start: number; readonly end: number } {
  return inverted ? { start: maximum, end: minimum } : { start: minimum, end: maximum };
}

/** Converts a plotted coordinate back to the Signal value shown on an axis. */
export function trajectoryAxisDisplayValue(value: number, inverted: boolean): number {
  const displayed = inverted ? -value : value;
  return Object.is(displayed, -0) ? 0 : displayed;
}

export function measureTrajectory(points: readonly TrajectoryPoint[], firstTimestamp: number, secondTimestamp: number): TrajectoryMeasurement | undefined {
  const firstIndex = points.findIndex((point) => point.timestamp === firstTimestamp); const secondIndex = points.findIndex((point) => point.timestamp === secondTimestamp);
  if (firstIndex < 0 || secondIndex < 0) return undefined;
  const first = points[firstIndex]; const second = points[secondIndex]; const deltaZ = first.z === undefined || second.z === undefined ? undefined : second.z - first.z;
  const straightDistance = Math.hypot(second.x - first.x, second.y - first.y, deltaZ ?? 0); let pathLength = 0;
  const start = Math.min(firstIndex, secondIndex); const end = Math.max(firstIndex, secondIndex);
  for (let index = start + 1; index <= end; index++) { const before = points[index - 1]; const after = points[index]; pathLength += Math.hypot(after.x - before.x, after.y - before.y, before.z === undefined || after.z === undefined ? 0 : after.z - before.z); }
  const deltaTime = second.timestamp - first.timestamp; const duration = Math.abs(deltaTime);
  return { first, second, deltaTime, deltaX: second.x - first.x, deltaY: second.y - first.y, ...(deltaZ === undefined ? {} : { deltaZ }), straightDistance, pathLength, ...(duration > 0 ? { averageSpeed: pathLength / duration } : {}) };
}

export function advancePlayback(current: number, elapsedSeconds: number, speed: number, range: { start: number; end: number }): { timestamp: number; ended: boolean } {
  const timestamp = Math.max(range.start, Math.min(range.end, current + Math.max(0, elapsedSeconds) * Math.max(0, speed)));
  return { timestamp, ended: timestamp >= range.end };
}
