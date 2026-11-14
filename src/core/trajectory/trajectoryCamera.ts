import { TRAJECTORY_FIT_MARGIN, TRAJECTORY_ZOOM_LIMITS, defaultTrajectoryView, fitTrajectoryView, type TrajectoryCoordinateSystem, type TrajectoryViewTransform } from './trajectory';

/**
 * The trajectory camera shared by the Visualize trajectory and the comparison trajectory card: the angle, zoom and pan,
 * whether they still follow the data ("fitted"), and how a drag, a zoom or a reset changes them.
 * The two views differ only in which events drive it and when they save; the camera arithmetic lives here once.
 */
export class TrajectoryCamera {
  private drag?: { x: number; y: number; readonly pan: boolean; moved: boolean; changed: boolean };

  /** `fitted`: zoom and pan follow the data, the drawing size and the angle until the user zooms or pans. */
  constructor(public view: TrajectoryViewTransform = defaultTrajectoryView(), public fitted = true) {}

  /** Takes a saved camera as it is. */
  restore(view: TrajectoryViewTransform, fitted: boolean): void { this.view = view; this.fitted = fitted; }
  /** A preset or Reset View: this angle, fitted to the data again. */
  reset(view: TrajectoryViewTransform): void { this.view = view; this.fitted = true; }

  get dragging(): boolean { return this.drag !== undefined; }
  /** Starts a drag at this pointer position (client pixels); `pan` moves the scene instead of turning it. */
  beginDrag(x: number, y: number, pan: boolean): void { this.drag = { x, y, pan, moved: false, changed: false }; }
  /**
   * Follows the pointer to (x, y). Panning keeps the scene under the cursor; a drag across `height` pixels turns the view
   * once around. A left-handed scene is the mirror image, so its yaw turns the other way to make a drag look the same in both.
   * Panning takes the camera over at any movement, also a slow drag of one-pixel steps. Rotating keeps a fitted camera fitted,
   * so zoom and position follow the new angle and the data cannot turn out of view. Returns false when there is no drag.
   */
  dragTo(x: number, y: number, options: { readonly pixelsPerUnit: number; readonly height: number; readonly coordinateSystem: TrajectoryCoordinateSystem }): boolean {
    const drag = this.drag; if (!drag) return false;
    const dx = x - drag.x; const dy = y - drag.y; drag.x = x; drag.y = y;
    if (Math.abs(dx) + Math.abs(dy) > 1) drag.moved = true;
    if (dx || dy) { drag.changed = true; if (drag.pan) this.fitted = false; }
    if (drag.pan) { const unitsPerPixel = 1 / (options.pixelsPerUnit * this.view.zoom); this.view = { ...this.view, panX: this.view.panX + dx * unitsPerPixel, panY: this.view.panY - dy * unitsPerPixel }; }
    else { const radiansPerPixel = 2 * Math.PI / Math.max(1, options.height); this.view = { ...this.view, yaw: this.view.yaw + (options.coordinateSystem === 'left' ? -dx : dx) * radiansPerPixel, pitch: clamp(this.view.pitch + dy * radiansPerPixel, -Math.PI / 2, Math.PI / 2) }; }
    return true;
  }
  /** Ends the drag. `moved`: it went further than a click's jitter; `changed`: the camera moved at all. Undefined when there was no drag. */
  endDrag(): { readonly moved: boolean; readonly changed: boolean } | undefined {
    const drag = this.drag; this.drag = undefined;
    return drag && { moved: drag.moved, changed: drag.changed };
  }

  /**
   * Zooms by `factor` within the zoom limits. With an anchor (its offset in pixels from the drawing's centre, y downwards,
   * and the drawing's pixels per data unit at zoom 1) the scene point under it stays in place; without one the centre stays.
   */
  zoom(factor: number, anchor?: { readonly dx: number; readonly dy: number; readonly pixelsPerUnit: number }): void {
    this.fitted = false; const zoom = clamp(this.view.zoom * factor, TRAJECTORY_ZOOM_LIMITS.minimum, TRAJECTORY_ZOOM_LIMITS.maximum);
    if (!anchor) { this.view = { ...this.view, zoom }; return; }
    const shift = 1 / zoom - 1 / this.view.zoom; const offsetX = anchor.dx / anchor.pixelsPerUnit; const offsetY = -anchor.dy / anchor.pixelsPerUnit;
    this.view = { ...this.view, zoom, panX: this.view.panX + offsetX * shift, panY: this.view.panY + offsetY * shift };
  }

  /**
   * The camera to draw with: a fitted camera is fitted again (by `fit`) to every size it is drawn at, the canvas after a
   * resize or an exported image. `keep` stores the result as the current camera (the on-screen drawing, not an export).
   */
  frame(fit: (view: TrajectoryViewTransform) => TrajectoryViewTransform, keep: boolean): TrajectoryViewTransform {
    const view = this.fitted ? fit(this.view) : this.view; if (keep) this.view = view; return view;
  }
}

/** Screen pixels per data unit at zoom 1: the widest extent of the data (`span`) spans 68% of the shorter side. */
export function trajectorySceneScale(span: number, width: number, height: number): number { return Math.max(1, Math.min(width, height)) * .68 / span; }

/**
 * `view` zoomed and moved so every point fills a `width` × `height` pixel drawing, less the fit margin, at `pixelsPerUnit`
 * (from `trajectorySceneScale`). Points are in data units; `center` is the scene point drawn at the centre before panning.
 */
export function fitTrajectoryScene(view: TrajectoryViewTransform, points: readonly { readonly x: number; readonly y: number; readonly z?: number }[], center: readonly [number, number, number], pixelsPerUnit: number, width: number, height: number, coordinateSystem: TrajectoryCoordinateSystem): TrajectoryViewTransform {
  const scene = points.map((point) => ({ x: point.x - center[0], y: point.y - center[1], z: (point.z ?? 0) - center[2] }));
  return fitTrajectoryView(view, scene, Math.max(1, width - 2 * TRAJECTORY_FIT_MARGIN) / pixelsPerUnit, Math.max(1, height - 2 * TRAJECTORY_FIT_MARGIN) / pixelsPerUnit, coordinateSystem);
}

function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }
