import type { SignalSample } from '../signal/signal';
import { downsampleExtremes } from '../timeline/timeline';
import { tickStep, tickValue } from '../chart/axisTicks';

export interface TrajectoryPoint {
  readonly timestamp: number; readonly x: number; readonly y: number; readonly z?: number;
  /** The position held from before a Clip's range: where the path starts from, not a measured point. */
  readonly carried?: boolean;
}
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
/** Where the 3D camera is. It only moves the camera: the handedness of the scene is `TrajectoryCoordinateSystem`. */
export interface TrajectoryViewTransform { readonly yaw: number; readonly pitch: number; readonly zoom: number; readonly panX: number; readonly panY: number; }
/** Handedness of the X/Y/Z axes, a setting of the graph. Left-handed shows every view as the mirror image of the right-handed one. */
export type TrajectoryCoordinateSystem = 'right' | 'left';
export type TrajectoryViewPreset = 'x' | 'y' | 'z' | 'reset';
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
    points.push({ timestamp: target, x: invert.x ? -values[0] : values[0], y: invert.y ? -values[1] : values[1], ...(z ? { z: invert.z ? -values[2] : values[2] } : {}), ...(alignedSamples.some((sample) => sample.carried) ? { carried: true } : {}) });
  }
  // Thinned with each axis's extremes kept, so the turning points of the path stay where they were.
  return downsampleExtremes(points, limit, (point) => [point.x, point.y, point.z ?? 0]);
}

export function trailAt(points: readonly TrajectoryPoint[], current: number, trail: TrajectoryTrail): readonly TrajectoryPoint[] {
  if (trail.type === 'all') return points;
  const start = trail.type === 'last-seconds' ? current - Math.max(0, trail.seconds) : -Infinity;
  return points.filter((point) => point.timestamp >= start && point.timestamp <= current);
}

export function defaultTrajectoryView(): TrajectoryViewTransform { return { yaw: Math.PI / 4, pitch: Math.atan(1 / Math.sqrt(2)), zoom: 1, panX: 0, panY: 0 }; }
/** Looks from the + side of the axis, with its − side going away. Right-handed: X shows Y right and Z up, Y shows X left and Z up, Z shows X right and Y up (as in 2D). */
export function presetTrajectoryView(preset: TrajectoryViewPreset): TrajectoryViewTransform {
  if (preset === 'x') return { yaw: 0, pitch: 0, zoom: 1, panX: 0, panY: 0 };
  if (preset === 'y') return { yaw: Math.PI / 2, pitch: 0, zoom: 1, panX: 0, panY: 0 };
  if (preset === 'z') return { yaw: -Math.PI / 2, pitch: Math.PI / 2, zoom: 1, panX: 0, panY: 0 };
  return defaultTrajectoryView();
}

/**
 * Where a 3D scene is centred and how large it is at zoom 1: the middle and the widest extent of the data itself.
 * (Not the rounded axis ranges, which always reach 0 and so shrank data far from the origin.)
 */
export function trajectorySceneFrame(points: readonly { x: number; y: number; z?: number }[]): { readonly center: readonly [number, number, number]; readonly span: number } {
  if (!points.length) return { center: [0, 0, 0], span: 1 };
  const extent = (value: (point: { x: number; y: number; z?: number }) => number) => { let minimum = Infinity; let maximum = -Infinity; for (const point of points) { const item = value(point); if (item < minimum) minimum = item; if (item > maximum) maximum = item; } return [minimum, maximum] as const; };
  const [x, y, z] = [extent((point) => point.x), extent((point) => point.y), extent((point) => point.z ?? 0)];
  const span = Math.max(x[1] - x[0], y[1] - y[0], z[1] - z[0]);
  return { center: [(x[0] + x[1]) / 2, (y[0] + y[1]) / 2, (z[0] + z[1]) / 2], span: span > 0 ? span : 1 };
}

/** Zoom range of the 3D camera, for the user's zoom and for fitting alike: wide enough to fill the view with a long, thin path seen end-on. */
export const TRAJECTORY_ZOOM_LIMITS = { minimum: .1, maximum: 10_000 } as const;

/** Screen pixels left free around a fitted trajectory, for the axis labels and the point labels at its edges. */
export const TRAJECTORY_FIT_MARGIN = 48;

/**
 * Zooms and pans `view` so the projected points just fill an area of `width` × `height` scene units (at zoom 1), centred on them.
 * The angle is kept. Without a spread to fit (one point, or all on one line seen end-on) only the pan centres them.
 */
export function fitTrajectoryView(view: TrajectoryViewTransform, points: readonly { x: number; y: number; z: number }[], width: number, height: number, coordinateSystem: TrajectoryCoordinateSystem = 'right'): TrajectoryViewTransform {
  if (!points.length || !(width > 0) || !(height > 0)) return view;
  const camera = { ...view, zoom: 1, panX: 0, panY: 0 }; let left = Infinity; let right = -Infinity; let bottom = Infinity; let top = -Infinity;
  for (const point of points) { const value = projectPoint3d(point, camera, coordinateSystem); left = Math.min(left, value.x); right = Math.max(right, value.x); bottom = Math.min(bottom, value.y); top = Math.max(top, value.y); }
  const spanX = right - left; const spanY = top - bottom; const fits = [spanX > 1e-12 ? width / spanX : Infinity, spanY > 1e-12 ? height / spanY : Infinity];
  const zoom = Math.min(...fits); return { ...view, zoom: Number.isFinite(zoom) ? Math.max(TRAJECTORY_ZOOM_LIMITS.minimum, Math.min(TRAJECTORY_ZOOM_LIMITS.maximum, zoom)) : view.zoom, panX: -(left + right) / 2, panY: -(bottom + top) / 2 };
}

/** Views saved by older versions may carry `mirrorHorizontal` from the old presets: only the camera is kept. */
export function trajectoryViewFrom(saved: { readonly yaw?: unknown; readonly pitch?: unknown; readonly zoom?: unknown; readonly panX?: unknown; readonly panY?: unknown } | undefined): TrajectoryViewTransform {
  const fallback = defaultTrajectoryView(); if (!saved) return fallback;
  const value = (key: keyof TrajectoryViewTransform) => { const item = saved[key]; return typeof item === 'number' && Number.isFinite(item) ? item : fallback[key]; };
  return { yaw: value('yaw'), pitch: value('pitch'), zoom: value('zoom'), panX: value('panX'), panY: value('panY') };
}

/** Screen x grows to the right and y upwards; a larger depth is nearer the viewer. Pan is in screen units, so it moves the same way in both coordinate systems. */
export function projectPoint3d(point: { x: number; y: number; z: number }, view: TrajectoryViewTransform, coordinateSystem: TrajectoryCoordinateSystem = 'right'): { x: number; y: number; depth: number } {
  const cy = Math.cos(view.yaw); const sy = Math.sin(view.yaw); const cp = Math.cos(view.pitch); const sp = Math.sin(view.pitch);
  const horizontal = point.y * cy - point.x * sy; const depthHorizontal = point.x * cy + point.y * sy;
  return { x: ((coordinateSystem === 'left' ? -horizontal : horizontal) + view.panX) * view.zoom, y: (point.z * cp - depthHorizontal * sp + view.panY) * view.zoom, depth: point.z * sp + depthHorizontal * cp };
}

/** Produces stable, human-readable tick values while keeping zero visible as the coordinate origin. */
export function trajectoryAxisScale(values: readonly number[], targetTickCount = 6): { readonly minimum: number; readonly maximum: number; readonly ticks: readonly number[] } {
  const finite = values.filter(Number.isFinite);
  let minimum = Math.min(0, ...finite); let maximum = Math.max(0, ...finite);
  if (!finite.length) { minimum = -1; maximum = 1; }
  if (minimum === maximum) { const pad = Math.abs(minimum) * .1 || 1; minimum -= pad; maximum += pad; }
  const step = tickStep((maximum - minimum) / Math.max(2, targetTickCount), [1, 2, 5]) ?? { mantissa: 1, exponent: 0, size: 1 };
  let firstIndex = Math.floor(minimum / step.size); let lastIndex = Math.ceil(maximum / step.size);
  // Decimal-exact bounds can land one ulp inside the data; step out so the scale still encloses it.
  if (tickValue(firstIndex, step) > minimum) firstIndex--; if (tickValue(lastIndex, step) < maximum) lastIndex++;
  const first = tickValue(firstIndex, step); const last = tickValue(lastIndex, step); const ticks: number[] = [];
  for (let index = firstIndex; index <= lastIndex && ticks.length < 100; index++) ticks.push(tickValue(index, step));
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
