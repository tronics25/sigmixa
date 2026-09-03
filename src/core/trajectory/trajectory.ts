import type { SignalSample } from '../signal/signal';
import { downsampleEven } from '../timeline/timeline';

export interface TrajectoryPoint { readonly timestamp: number; readonly x: number; readonly y: number; readonly z?: number; }
export interface TrajectoryViewTransform { readonly yaw: number; readonly pitch: number; readonly zoom: number; readonly panX: number; readonly panY: number; }
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
    const values = indexes.map((index, axis) => sources[axis][index].value); indexes.forEach((_, axis) => indexes[axis]++);
    if (!values.every(Number.isFinite)) continue;
    points.push({ timestamp: target, x: invert.x ? -values[0] : values[0], y: invert.y ? -values[1] : values[1], ...(z ? { z: invert.z ? -values[2] : values[2] } : {}) });
  }
  return downsampleEven(points, limit);
}

export function trailAt(points: readonly TrajectoryPoint[], current: number, trail: TrajectoryTrail): readonly TrajectoryPoint[] {
  if (trail.type === 'all') return points;
  const start = trail.type === 'last-seconds' ? current - Math.max(0, trail.seconds) : -Infinity;
  return points.filter((point) => point.timestamp >= start && point.timestamp <= current);
}

export function defaultTrajectoryView(): TrajectoryViewTransform { return { yaw: -Math.PI / 4, pitch: Math.atan(1 / Math.sqrt(2)), zoom: 1, panX: 0, panY: 0 }; }
export function presetTrajectoryView(preset: 'top' | 'front' | 'side' | 'reset'): TrajectoryViewTransform {
  if (preset === 'top') return { yaw: 0, pitch: Math.PI / 2, zoom: 1, panX: 0, panY: 0 };
  if (preset === 'front') return { yaw: 0, pitch: 0, zoom: 1, panX: 0, panY: 0 };
  if (preset === 'side') return { yaw: Math.PI / 2, pitch: 0, zoom: 1, panX: 0, panY: 0 };
  return defaultTrajectoryView();
}

export function projectPoint3d(point: { x: number; y: number; z: number }, view: TrajectoryViewTransform): { x: number; y: number; depth: number } {
  const cy = Math.cos(view.yaw); const sy = Math.sin(view.yaw); const cp = Math.cos(view.pitch); const sp = Math.sin(view.pitch);
  const x1 = point.x * cy - point.z * sy; const z1 = point.x * sy + point.z * cy;
  return { x: (x1 + view.panX) * view.zoom, y: (point.y * cp - z1 * sp + view.panY) * view.zoom, depth: point.y * sp + z1 * cp };
}

export function advancePlayback(current: number, elapsedSeconds: number, speed: number, range: { start: number; end: number }): { timestamp: number; ended: boolean } {
  const timestamp = Math.max(range.start, Math.min(range.end, current + Math.max(0, elapsedSeconds) * Math.max(0, speed)));
  return { timestamp, ended: timestamp >= range.end };
}
