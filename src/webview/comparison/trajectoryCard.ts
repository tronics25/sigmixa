import { createLegendEntry } from '../shared/signalLegend';
import { clearLegend, fitCardTitle, placeCardTitle } from './cardTitle';
import { emphasizeSignal } from '../shared/signalEmphasis';
import { crossesSeriesGap } from '../shared/chartSeries';
import type { ComparisonGraphDefinition, ComparisonTrajectorySeries } from '../../core/project/comparison';
import type { SignalDefinition } from '../../core/signal/signal';
import { TRAJECTORY_FIT_MARGIN, TRAJECTORY_ZOOM_LIMITS, buildTrajectoryPoints, clipTrajectoryEdges, measureTrajectory, trajectorySceneFrame, defaultTrajectoryView, fitTrajectoryView, projectPoint3d, trailAt, trajectoryAxisDisplayValue, trajectoryAxisScale, trajectoryViewFrom, type TrajectoryCoordinateSystem, type TrajectoryPoint, type TrajectoryViewTransform } from '../../core/trajectory/trajectory';
import type { ComparisonSeriesDto } from '../../extension/comparison/comparisonProtocol';
import type { SignalGroupDto } from '../../extension/editors/rawLogProtocol';
import { commonDisplayUnit, convertDisplayUnit } from '../../core/units/displayUnit';
import { chartWheelGesture } from '../shared/chartWheel';
import { t } from '../shared/i18n';
import { enhanceChoiceSelect, syncChoiceSelect } from '../shared/choiceGroup';
import { iconButton, viewActionGroup } from '../shared/iconButton';
import { bindPressRepeat } from '../shared/pressRepeat';
import { SIGNAL_COLOR_PRESETS } from '../shared/signalSelector';
import { createSvgCanvas } from '../shared/svgCanvas';
import type { SheetImage } from '../shared/imageSheet';
import { withBrandMark } from '../shared/brandMark';
import { placeTickLabel, separateTitles, type LabelBox } from '../shared/trajectoryLabels';
import { buttonContextAction } from '../shared/viewContextAction';
import { bindCardResize, css, dashFor, format, type ComparisonCard, type GraphHost } from './graphCard';

const HEIGHT = 420;
const MIN_HEIGHT = 220;
const PAD = { left: 64, right: 24, top: 20, bottom: 40 };
/** One path: a target's, or with several series a series of a target. `key` is what its legend entry highlights. */
interface Track { readonly key: string; readonly targetId: string; readonly name: string; readonly color: string; readonly index: number; readonly anchor: number; readonly signalIds: readonly string[]; readonly points: readonly TrajectoryPoint[] }
interface Projected { readonly x: number; readonly y: number; readonly depth: number; readonly time: number; readonly track: Track }

/** A definition without a saved camera is fitted; a saved camera stays as saved unless it was fitted. */
const fittedFrom = (definition: ComparisonGraphDefinition): boolean => definition.trajectoryView ? definition.trajectoryViewFit === true : true;

/** The graph's paths; without `trajectorySeries` one unnamed path over `axes`. */
const seriesOf = (definition: ComparisonGraphDefinition): readonly ComparisonTrajectorySeries[] => definition.trajectorySeries ?? [{ id: '', name: '', color: '', axes: definition.axes ?? {} }];
const axisIds = (axes: ComparisonTrajectorySeries['axes']): string[] => [axes.x, axes.y, axes.z].filter((id): id is string => Boolean(id));

/** Colour per compared file/Clip (the line style also follows it, as in the time-series graphs). */
export const targetColor = (index: number): string => SIGNAL_COLOR_PRESETS[index % SIGNAL_COLOR_PRESETS.length];

/**
 * A trajectory in a comparison: the same X/Y(/Z) Signals drawn once per file/Clip on one plot.
 * The shared hover time marks where every target is at the same (time-shifted) moment.
 */
export class TrajectoryCard implements ComparisonCard {
  readonly element: HTMLElement;
  readonly options: HTMLElement;
  private readonly header: HTMLElement;
  private readonly title: HTMLInputElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly legend: HTMLElement;
  /** The X/Y/Z lists of each series, in `seriesOf` order. */
  private readonly axisSelects: Record<'x' | 'y' | 'z', HTMLSelectElement>[];
  private readonly buttons: Record<'zoomIn' | 'zoomOut' | 'reset' | 'measure' | 'clearMeasure' | 'image' | 'settings' | 'up' | 'copy' | 'trash', HTMLButtonElement>;
  /** Two-point measurement, as in the Visualize trajectory: A and B are points of one path (track), by their own time. */
  private measuring = false;
  private measurement?: { readonly key: string; readonly targetId: string; readonly times: readonly number[] };
  private readonly measurementPanel: HTMLElement;
  private readonly measurementValue: HTMLElement;
  private samples = new Map<string, readonly ComparisonSeriesDto[]>();
  private latestRequest = 0;
  private pending = false;
  private view: TrajectoryViewTransform = defaultTrajectoryView();
  /** Zoom and pan follow the data and the canvas size until the user zooms, pans or rotates. */
  private fitted = true;
  private projected: Projected[] = [];
  private definitions: readonly SignalDefinition[] = [];
  private groups: readonly SignalGroupDto[] = [];
  private drawScheduled = false;
  private drag?: { x: number; y: number; pan: boolean; moved: boolean; changed?: boolean };
  private pixelsPerUnit = 1;
  private highlightedKey?: string;
  private legendKey = '';
  private viewCommit?: ReturnType<typeof setTimeout>;

  constructor(private definitionValue: ComparisonGraphDefinition, private readonly host: GraphHost, list: HTMLElement, optionsHost: HTMLElement) {
    this.view = trajectoryViewFrom(definitionValue.trajectoryView); this.fitted = fittedFrom(definitionValue);
    this.element = document.createElement('section'); this.element.className = 'visualize-card'; this.element.dataset.kind = 'trajectory';
    this.header = document.createElement('header'); this.header.className = 'visualize-card-header'; this.header.tabIndex = 0;
    this.title = document.createElement('input'); this.title.className = 'visualize-card-title'; this.title.value = definitionValue.name;
    this.title.setAttribute('aria-label', t('Graph name', 'グラフ名'));
    const make = (icon: string, label: string, run: () => void) => { const button = iconButton(document.createElement('button'), icon, label); button.type = 'button'; button.addEventListener('click', (event) => { event.stopPropagation(); run(); }); return button; };
    this.buttons = {
      zoomIn: make('zoom-in', t('Zoom in; hold to repeat', '拡大・長押しで連続'), () => undefined),
      zoomOut: make('zoom-out', t('Zoom out; hold to repeat', '縮小・長押しで連続'), () => undefined),
      reset: make('discard', t('Reset view', '表示をリセット'), () => { clearTimeout(this.viewCommit); this.view = defaultTrajectoryView(); this.fitted = true; this.update({ trajectoryView: this.view, trajectoryViewFit: true }); this.draw(); }),
      // Leaving measurement removes A and B, so no half-made selection is left on screen (as in Visualize).
      measure: make('symbol-ruler', t('Measure two points', '2点計測'), () => { this.measuring = !this.measuring; if (!this.measuring) this.measurement = undefined; this.draw(); }),
      clearMeasure: make('clear-all', t('Clear measurement', '計測を解除'), () => { this.measurement = undefined; this.draw(); }),
      image: make('export', t('Save image', '画像を保存'), () => this.saveImage()),
      settings: make('settings-gear', t('Show graph settings', 'グラフ設定を表示'), () => this.host.select(this, true)),
      up: make('arrow-up', t('Move graph up', 'グラフを上へ移動'), () => this.host.move(this, -1)),
      copy: make('copy', t('Duplicate graph', 'グラフを複製'), () => this.host.duplicate(this)),
      trash: make('trash', t('Delete graph', 'グラフを削除'), () => this.host.remove(this)),
    };
    bindPressRepeat(this.buttons.zoomIn, () => this.zoom(1.5), { intervalMs: 180 });
    bindPressRepeat(this.buttons.zoomOut, () => this.zoom(1 / 1.5), { intervalMs: 180 });
    const actions = document.createElement('div'); actions.className = 'visualize-card-actions';
    actions.append(
      viewActionGroup(t('Adjust display', '表示調整'), this.buttons.zoomIn, this.buttons.zoomOut, this.buttons.reset),
      viewActionGroup(t('Analysis', '解析'), this.buttons.measure, this.buttons.clearMeasure),
      viewActionGroup(t('Export', 'エクスポート'), this.buttons.image),
      viewActionGroup(t('Graph actions', 'グラフ操作'), this.buttons.settings, this.buttons.up, this.buttons.copy, this.buttons.trash),
    );
    this.header.append(this.title, actions); this.title.addEventListener('input', () => fitCardTitle(this.title));
    this.legend = document.createElement('div'); this.legend.className = 'chart-legend-group chart-legend-items';
    const wrap = document.createElement('div'); wrap.className = 'chart-canvas-wrap';
    this.canvas = document.createElement('canvas'); this.canvas.setAttribute('aria-label', t('Trajectory comparison. Drag to rotate (Shift+drag to move), Ctrl+wheel to zoom.', '軌跡の比較。ドラッグで回転（Shift+ドラッグで移動）、Ctrl+ホイールで拡大縮小。'));
    wrap.appendChild(this.canvas);
    this.measurementPanel = document.createElement('div'); this.measurementPanel.className = 'trajectory-measurement'; this.measurementPanel.hidden = true;
    const measurementLabel = document.createElement('strong'); measurementLabel.textContent = 'A → B';
    this.measurementValue = document.createElement('span'); this.measurementValue.className = 'trajectory-measurement-value';
    this.measurementPanel.append(measurementLabel, this.measurementValue);
    this.element.append(this.header, this.legend, this.measurementPanel, wrap); list.appendChild(this.element);

    this.options = document.createElement('section'); this.options.className = 'view-specific-options'; this.options.hidden = true;
    const settings = document.createElement('div'); settings.className = 'view-settings'; this.options.appendChild(settings);
    const display = document.createElement('details'); display.className = 'display-settings';
    display.innerHTML = `<summary>${t('Drawing settings', '描画設定')}</summary><div class="settings-row"><label class="chart-option"><input class="equal-aspect" type="checkbox">${t('Equal X/Y scale (2D)', 'X/Yの縮尺を揃える（2D）')}</label></div><div class="settings-row"><label class="chart-option"><input class="show-points" type="checkbox">${t('Show data points', 'データ点を表示')}</label></div><div class="settings-row coordinate-system-row"><label class="axis-mode">${t('Coordinate system', '座標系')}<select class="coordinate-system"><option value="right">${t('Right-handed', '右手系')}</option><option value="left">${t('Left-handed', '左手系')}</option></select></label></div>`;
    const aspect = display.querySelector<HTMLInputElement>('.equal-aspect')!; aspect.addEventListener('change', () => { this.update({ equalAspect: aspect.checked }); this.draw(); });
    const points = display.querySelector<HTMLInputElement>('.show-points')!; points.addEventListener('change', () => { this.update({ showPoints: points.checked }); this.draw(); });
    const handedness = display.querySelector<HTMLSelectElement>('.coordinate-system')!; enhanceChoiceSelect(handedness, t('Coordinate system', '座標系'));
    handedness.addEventListener('change', () => { this.update({ coordinateSystem: handedness.value === 'left' ? 'left' : 'right' }); this.draw(); });
    settings.appendChild(display);
    const axes = document.createElement('div'); axes.className = 'trajectory-axes';
    const axisSelect = (index: number, axis: 'x' | 'y' | 'z') => {
      const row = document.createElement('label'); row.className = 'trajectory-axis-row';
      const caption = document.createElement('span'); caption.textContent = axis === 'z' ? t('Z (optional)', 'Z（任意）') : axis.toUpperCase();
      const select = document.createElement('select'); select.setAttribute('aria-label', `${axis.toUpperCase()} Signal`);
      select.addEventListener('change', () => { this.setAxis(index, axis, select.value || undefined); this.request(); });
      row.append(caption, select); axes.appendChild(row); return select;
    };
    this.axisSelects = seriesOf(definitionValue).map((series, index) => {
      if (definitionValue.trajectorySeries) { const name = document.createElement('div'); name.className = 'trajectory-series-name'; const swatch = document.createElement('i'); swatch.style.background = series.color; name.append(swatch, series.name); axes.appendChild(name); }
      return { x: axisSelect(index, 'x'), y: axisSelect(index, 'y'), z: axisSelect(index, 'z') };
    });
    settings.appendChild(axes);
    optionsHost.appendChild(this.options);

    this.title.addEventListener('change', () => { const name = this.title.value.trim() || this.definitionValue.name; this.title.value = name; this.update({ name }); });
    this.title.addEventListener('keydown', (event) => { if (event.isComposing) return; if (event.key === 'Enter') { event.preventDefault(); this.title.blur(); } if (event.key === 'Escape') { event.preventDefault(); this.title.value = this.definitionValue.name; this.title.blur(); } });
    this.bindCanvas(); this.bindCard(); this.syncSettings();
    bindCardResize(this.element, () => this.height, HEIGHT, MIN_HEIGHT, (height, done) => { this.definitionValue = { ...this.definitionValue, height }; this.draw(); if (done) this.host.changed(this); });
    new ResizeObserver(() => this.scheduleDraw()).observe(wrap);
  }

  private get height(): number { return Math.max(MIN_HEIGHT, this.definitionValue.height ?? HEIGHT); }
  get id(): string { return this.definitionValue.id; }
  get definition(): ComparisonGraphDefinition { return this.definitionValue; }
  get name(): string { return this.definitionValue.name; }
  private get series(): readonly ComparisonTrajectorySeries[] { return seriesOf(this.definitionValue); }
  private get drawnSeries(): readonly ComparisonTrajectorySeries[] { return this.series.filter((item) => item.axes.x && item.axes.y); }
  private get isConfigured(): boolean { return this.drawnSeries.length > 0; }
  /** The axes named on the plot: those of the first series drawn, as Visualize names those of its active series. */
  private axes() { return (this.drawnSeries[0] ?? this.series[0]).axes; }
  private get is3d(): boolean { return this.series.some((item) => item.axes.z); }
  /** Axes in different units of one kind share a scale only after conversion, as in Visualize (one series or several). */
  private get commonUnit(): string | undefined { return commonDisplayUnit(this.drawnSeries.flatMap((item) => axisIds(item.axes)).map((id) => this.definitions.find((definition) => definition.id === id)?.unit))?.unit; }
  private get coordinateSystem(): TrajectoryCoordinateSystem { return this.definitionValue.coordinateSystem === 'left' ? 'left' : 'right'; }

  setDefinition(definition: ComparisonGraphDefinition): void {
    const axesChanged = JSON.stringify(seriesOf(definition).map((item) => item.axes)) !== JSON.stringify(this.series.map((item) => item.axes));
    if (JSON.stringify(definition.trajectoryView) !== JSON.stringify(this.definitionValue.trajectoryView) || fittedFrom(definition) !== fittedFrom(this.definitionValue)) { this.view = trajectoryViewFrom(definition.trajectoryView); this.fitted = fittedFrom(definition); }
    this.definitionValue = definition; this.title.value = definition.name; this.syncSettings();
    if (axesChanged) this.request(); else this.draw();
  }

  private measured: ReadonlySet<string> | undefined;
  setCatalog(definitions: readonly SignalDefinition[], groups: readonly SignalGroupDto[], measuredIds?: readonly string[]): void { this.definitions = definitions; this.groups = groups; this.measured = measuredIds ? new Set(measuredIds) : undefined; this.renderAxisOptions(); }
  setEditing(editing: boolean): void { this.element.classList.toggle('options-editing', editing); this.options.hidden = !(this.host.selectedGraph() === this); }
  focusHeader(): void { this.header.focus({ preventScroll: true }); }
  dispose(): void { clearTimeout(this.viewCommit); this.element.remove(); this.options.remove(); }
  highlight(): void { /* Trajectories are coloured per target, not per Signal. */ }
  markerQueries(): { slot: string; sourceId: string; timestamp: number; signalIds: string[] }[] { return []; }
  revealSignal(): void { this.axisSelects[0].x.focus(); }

  request(): void {
    this.measurement = undefined;
    const ids = [...new Set(this.series.flatMap((item) => axisIds(item.axes)))];
    this.samples.clear(); this.pending = this.isConfigured;
    this.latestRequest = this.isConfigured ? this.host.requestSeries(this.id, ids, 10_000, true) : 0; this.draw();
  }

  receive(requestId: number, seriesByTarget: readonly { readonly targetId: string; readonly series: readonly ComparisonSeriesDto[] }[]): void {
    if (requestId !== this.latestRequest) return;
    this.samples = new Map(seriesByTarget.map((item) => [item.targetId, item.series])); this.pending = false; this.draw();
  }

  private update(partial: Partial<ComparisonGraphDefinition>): void {
    const next = { ...this.definitionValue, ...partial };
    this.definitionValue = { ...next, signalIds: [...new Set(seriesOf(next).flatMap((item) => axisIds(item.axes)))] }; this.host.changed(this);
  }

  private setAxis(index: number, axis: 'x' | 'y' | 'z', signalId: string | undefined): void {
    if (this.definitionValue.trajectorySeries) this.update({ trajectorySeries: this.definitionValue.trajectorySeries.map((item, itemIndex) => itemIndex === index ? { ...item, axes: { ...item.axes, [axis]: signalId } } : item) });
    else this.update({ axes: { ...this.definitionValue.axes, [axis]: signalId } });
  }

  private syncSettings(): void {
    const aspect = this.options.querySelector<HTMLInputElement>('.equal-aspect'); if (aspect) aspect.checked = this.definitionValue.equalAspect !== false;
    const points = this.options.querySelector<HTMLInputElement>('.show-points'); if (points) points.checked = this.definitionValue.showPoints === true;
    const handedness = this.options.querySelector<HTMLSelectElement>('.coordinate-system'); if (handedness) { handedness.value = this.coordinateSystem; syncChoiceSelect(handedness); }
    this.renderAxisOptions();
  }

  /** Numeric Signals, grouped like the Signal list (including "only in A" groups). */
  private renderAxisOptions(): void {
    const byId = new Map(this.definitions.map((definition) => [definition.id, definition]));
    for (const [index, selects] of this.axisSelects.entries()) for (const axis of ['x', 'y', 'z'] as const) {
      const select = selects[axis]; const value = this.series[index]?.axes[axis] ?? ''; select.replaceChildren();
      const none = document.createElement('option'); none.value = ''; none.textContent = axis === 'z' ? t('None (2D)', 'なし（2D）') : t('Choose a Signal', 'シグナルを選択'); select.appendChild(none);
      for (const group of this.groups) {
        const optgroup = document.createElement('optgroup'); optgroup.label = group.label;
        for (const id of group.signalIds) { const definition = byId.get(id); if (!definition || (this.measured && id !== value && !this.measured.has(id))) continue; const option = document.createElement('option'); option.value = id; option.textContent = `${definition.name}${definition.unit ? ` (${definition.unit})` : ''}`; optgroup.appendChild(option); }
        if (optgroup.childElementCount) select.appendChild(optgroup);
      }
      select.value = value;
    }
  }

  // ---- interaction ----------------------------------------------------------------------------

  private bindCanvas(): void {
    this.canvas.addEventListener('pointerdown', (event) => { if (event.button !== 0 && event.button !== 1) return; this.drag = { x: event.clientX, y: event.clientY, pan: event.button === 1 || event.shiftKey || !this.is3d, moved: false }; this.canvas.setPointerCapture(event.pointerId); });
    this.canvas.addEventListener('pointermove', (event) => {
      if (!this.drag) { this.hover(event); return; }
      const dx = event.clientX - this.drag.x; const dy = event.clientY - this.drag.y; this.drag.x = event.clientX; this.drag.y = event.clientY; if (Math.abs(dx) + Math.abs(dy) > 1) this.drag.moved = true;
      // Any movement takes the camera over, also a slow drag made of one-pixel steps.
      if (dx || dy) { this.fitted = false; this.drag.changed = true; }
      if (this.drag.pan) this.view = { ...this.view, panX: this.view.panX + dx / (this.pixelsPerUnit * this.view.zoom), panY: this.view.panY - dy / (this.pixelsPerUnit * this.view.zoom) };
      // A left-handed scene is the mirror image, so its yaw turns the other way to make a drag look the same in both.
      else { const perPixel = 2 * Math.PI / Math.max(1, this.canvas.clientHeight); this.view = { ...this.view, yaw: this.view.yaw + (this.coordinateSystem === 'left' ? -dx : dx) * perPixel, pitch: Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.view.pitch + dy * perPixel)) }; }
      this.scheduleDraw();
    });
    const end = (event: PointerEvent) => { if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId); if (this.drag?.changed) this.update({ trajectoryView: this.view, trajectoryViewFit: false }); const click = event.type === 'pointerup' && this.drag && !this.drag.moved; this.drag = undefined; if (click && this.measuring) this.pick(event); };
    this.canvas.addEventListener('pointerup', end); this.canvas.addEventListener('pointercancel', end);
    this.canvas.addEventListener('mouseleave', () => this.host.setHoverTime(undefined));
    this.canvas.addEventListener('wheel', (event) => { const gesture = chartWheelGesture(event, this.canvas.clientHeight); if (gesture.kind !== 'zoom') return; event.preventDefault(); this.zoom(Math.exp(-Math.max(-40, Math.min(40, gesture.delta)) * .01)); }, { passive: false });
  }

  /** The drawn point under the pointer (within 12 px), if any. */
  private pointAt(event: MouseEvent): Projected | undefined {
    const rect = this.canvas.getBoundingClientRect(); const x = event.clientX - rect.left; const y = event.clientY - rect.top;
    let best: Projected | undefined; let distance = 12 * 12;
    for (const point of this.projected) { const d = (point.x - x) ** 2 + (point.y - y) ** 2; if (d < distance) { distance = d; best = point; } }
    return best;
  }

  /** Hovering a path shares that moment with every graph in the comparison. */
  private hover(event: MouseEvent): void { const best = this.pointAt(event); this.host.setHoverTime(best ? best.time - best.track.anchor : undefined); }

  /** In measurement: the first click sets A, the next one on the same path B; a click on another path or on A starts again from A. */
  private pick(event: MouseEvent): void {
    const point = this.pointAt(event); if (!point) return;
    const current = this.measurement;
    this.measurement = current && current.key === point.track.key && current.targetId === point.track.targetId && current.times.length === 1 && current.times[0] !== point.time
      ? { ...current, times: [current.times[0], point.time] }
      : { key: point.track.key, targetId: point.track.targetId, times: [point.time] };
    this.draw();
  }

  private bindCard(): void {
    let pressOpens = false;
    const opens = (event: MouseEvent) => { const target = event.target as Element; if (target.closest('button, select, input, textarea, label, a')) return false; return !this.isConfigured || target !== this.canvas; };
    this.element.addEventListener('pointerdown', (event) => { pressOpens = event.button === 0 && opens(event); });
    this.element.addEventListener('click', (event) => { const open = pressOpens && opens(event); pressOpens = false; if (!open || window.getSelection()?.toString()) return; this.host.select(this, true); if (!this.isConfigured) this.axisSelects[0].x.focus(); }, { capture: true });
    this.element.addEventListener('contextmenu', (event) => {
      event.preventDefault(); event.stopPropagation(); const rect = this.header.getBoundingClientRect();
      this.host.showMenu([
        { label: t('Show graph settings', 'グラフ設定を表示'), icon: 'settings-gear', run: () => this.host.select(this, true) }, null,
        buttonContextAction(this.buttons.zoomIn, t('Zoom in', '拡大')), buttonContextAction(this.buttons.zoomOut, t('Zoom out', '縮小')), buttonContextAction(this.buttons.reset), null,
        buttonContextAction(this.buttons.measure), ...(this.measurement ? [buttonContextAction(this.buttons.clearMeasure)] : []), buttonContextAction(this.buttons.image), null,
        { label: t('Rename graph', 'グラフ名を変更'), icon: 'edit', run: () => { this.title.focus(); this.title.select(); } },
        { label: t('Duplicate graph', 'グラフを複製'), icon: 'copy', run: () => this.host.duplicate(this) },
        { label: t('Move graph up', 'グラフを上へ移動'), icon: 'arrow-up', enabled: !this.host.isFirst(this), run: () => this.host.move(this, -1) },
        { label: t('Move graph down', 'グラフを下へ移動'), icon: 'arrow-down', enabled: !this.host.isLast(this), run: () => this.host.move(this, 1) },
        null, { label: t('Delete graph', 'グラフを削除'), icon: 'trash', run: () => this.host.remove(this) },
      ], this.definitionValue.name, event.clientX || rect.left + 12, event.clientY || rect.bottom, this.header);
    });
    this.header.addEventListener('keydown', (event) => { if (event.target === this.header && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); this.host.select(this, true); } });
  }

  /** Wheel and press-repeat zoom fire many times in a row: redraw each time, but report the view once it settles. */
  private zoom(factor: number): void {
    this.fitted = false; this.view = { ...this.view, zoom: Math.max(TRAJECTORY_ZOOM_LIMITS.minimum, Math.min(TRAJECTORY_ZOOM_LIMITS.maximum, this.view.zoom * factor)) }; this.draw();
    clearTimeout(this.viewCommit); this.viewCommit = setTimeout(() => this.update({ trajectoryView: this.view, trajectoryViewFit: false }), 200);
  }

  // ---- data & drawing ---------------------------------------------------------------------------

  private tracks(): Track[] {
    const drawn = this.drawnSeries; if (!drawn.length) return [];
    const overlaid = Boolean(this.definitionValue.trajectorySeries); const unit = this.commonUnit;
    return this.host.targets().flatMap((target) => {
      const anchor = this.host.anchor(target.id); if (anchor === undefined || this.host.hidden(target.id)) return [];
      const series = this.samples.get(target.id) ?? []; const index = this.host.targetIndex(target.id);
      const samples = (id?: string) => { const found = series.find((item) => item.signalId === id)?.series; return found && unit ? found.samples.map((sample) => ({ ...sample, value: convertDisplayUnit(sample.value, found.definition.unit, unit) })) : found?.samples; };
      return drawn.flatMap((item) => {
        const { axes } = item; const xs = samples(axes.x); const ys = samples(axes.y); const zs = axes.z ? samples(axes.z) : undefined;
        if (!xs || !ys || (axes.z && !zs)) return [];
        // A Clip's path ends at the Clip's edges, as in Visualize.
        const bounds = target.kind === 'clip' && target.start !== undefined && target.end !== undefined ? { start: target.start, end: target.end } : undefined;
        return [{ key: overlaid ? item.id : target.id, targetId: target.id, name: overlaid ? item.name : target.name, color: overlaid ? item.color : targetColor(index), index, anchor, signalIds: axisIds(axes), points: clipTrajectoryEdges(buildTrajectoryPoints(xs, ys, zs, this.definitionValue.invert ?? { x: false, y: false, z: false }, 10_000), bounds) }];
      });
    });
  }

  private scales(tracks: readonly Track[]) {
    // Only the extremes decide a scale, and several series can hold more points than one call takes as arguments.
    const scale = (value: (point: TrajectoryPoint) => number) => { let minimum = Infinity; let maximum = -Infinity; for (const track of tracks) for (const point of track.points) { const item = value(point); if (item < minimum) minimum = item; if (item > maximum) maximum = item; } return trajectoryAxisScale(minimum <= maximum ? [minimum, maximum] : []); };
    return { x: scale((point) => point.x), y: scale((point) => point.y), z: scale((point) => point.z ?? 0) };
  }


  scheduleDraw(): void { if (this.drawScheduled) return; this.drawScheduled = true; requestAnimationFrame(() => { this.drawScheduled = false; this.draw(); }); }

  draw(): void {
    this.element.classList.toggle('view-unconfigured', !this.isConfigured);
    this.header.removeAttribute('title');
    this.buttons.up.disabled = this.host.isFirst(this);
    const handedness = this.options.querySelector<HTMLElement>('.coordinate-system-row'); if (handedness) handedness.hidden = !this.is3d;
    const tracks = this.tracks(); this.renderLegend(tracks);
    const width = Math.max(320, this.canvas.parentElement!.clientWidth); const ratio = devicePixelRatio || 1;
    this.canvas.width = width * ratio; this.canvas.height = this.height * ratio; this.canvas.style.width = `${width}px`; this.canvas.style.height = `${this.height}px`;
    const context = this.canvas.getContext('2d')!; context.scale(ratio, ratio);
    this.buttons.image.disabled = !tracks.some((track) => track.points.length);
    this.projected = this.paint(context, width, this.height, 0, tracks, this.host.hoverTime());
    this.updateMeasurement(tracks);
  }

  // ---- two-point measurement (as in the Visualize trajectory) ------------------------------------

  private measuredTrack(tracks: readonly Track[]): Track | undefined { const value = this.measurement; return value ? tracks.find((track) => track.key === value.key && track.targetId === value.targetId) : undefined; }

  private updateMeasurement(tracks: readonly Track[]): void {
    const count = this.measurement?.times.length ?? 0;
    this.buttons.measure.classList.toggle('primary', this.measuring); this.buttons.measure.setAttribute('aria-pressed', String(this.measuring));
    this.buttons.clearMeasure.hidden = !count; this.canvas.classList.toggle('measurement-mode', this.measuring);
    this.measurementPanel.hidden = !this.measuring && !count;
    const track = this.measuredTrack(tracks);
    if (!count) this.measurementValue.textContent = t('Select point A on the trajectory.', '軌跡上の始点Aを選択してください。');
    else if (count === 1) this.measurementValue.textContent = `${this.pointText('A', track, this.measurement!.times[0])} · ${t('Select point B.', '終点Bを選択してください。')}`;
    else this.measurementValue.textContent = this.measurementSummary(track) ?? '—';
  }

  private axisUnit(track: Track, axis: 0 | 1 | 2): string | undefined { return this.commonUnit ?? this.definitions.find((definition) => definition.id === track.signalIds[axis])?.unit; }
  private invertOf(axis: 0 | 1 | 2): boolean { const invert = this.definitionValue.invert; return axis === 0 ? invert?.x === true : axis === 1 ? invert?.y === true : invert?.z === true; }
  private coordinate(track: Track, axis: 0 | 1 | 2, value: number): string { const unit = this.axisUnit(track, axis); return `${'XYZ'[axis]} ${format(trajectoryAxisDisplayValue(value, this.invertOf(axis)))}${unit ? ` ${unit}` : ''}`; }
  private delta(track: Track, axis: 0 | 1 | 2, value: number): string { const unit = this.axisUnit(track, axis); return `Δ${'XYZ'[axis]} ${format(trajectoryAxisDisplayValue(value, this.invertOf(axis)))}${unit ? ` ${unit}` : ''}`; }
  /** "A +1.2 s (X 10 m, Y 2 m)": a point's comparison time and coordinates. */
  private pointText(name: 'A' | 'B', track: Track | undefined, time: number): string {
    const point = track?.points.find((item) => item.timestamp === time); const shown = track ? time - track.anchor : time;
    const coordinates = point && track ? [this.coordinate(track, 0, point.x), this.coordinate(track, 1, point.y), ...(point.z === undefined ? [] : [this.coordinate(track, 2, point.z)])].join(', ') : '';
    return `${name} ${shown >= 0 ? '+' : ''}${format(shown)} s${coordinates ? ` (${coordinates})` : ''}`;
  }
  private measurementSummary(track: Track | undefined): string | undefined {
    const times = this.measurement?.times; if (!track || !times || times.length !== 2) return undefined;
    const measurement = measureTrajectory(track.points, times[0], times[1]); if (!measurement) return undefined;
    const parts = [this.pointText('A', track, measurement.first.timestamp), this.pointText('B', track, measurement.second.timestamp), `Δt ${format(measurement.deltaTime)} s`, this.delta(track, 0, measurement.deltaX), this.delta(track, 1, measurement.deltaY)];
    if (measurement.deltaZ !== undefined) parts.push(this.delta(track, 2, measurement.deltaZ));
    const unit = this.commonUnit;
    if (unit) {
      const start = Math.min(measurement.first.timestamp, measurement.second.timestamp); const end = Math.max(measurement.first.timestamp, measurement.second.timestamp);
      const incomplete = this.definitionValue.connectGaps === false && (this.samples.get(track.targetId) ?? []).some((series) => track.signalIds.includes(series.signalId) && crossesSeriesGap(series.series.gaps, start, end));
      parts.push(`${t('Straight', '直線距離')} ${format(measurement.straightDistance)} ${unit}`);
      parts.push(incomplete ? `${t('Path', '軌跡長')} — (${t('contains gaps', '欠損あり')})` : `${t('Path', '軌跡長')} ${format(measurement.pathLength)} ${unit}`);
      if (!incomplete && measurement.averageSpeed !== undefined) parts.push(`${t('Average speed', '平均速度')} ${format(measurement.averageSpeed)} ${unit}/s`);
    }
    return parts.join(' · ');
  }

  private paintMeasurement(context: CanvasRenderingContext2D, projected: readonly Projected[]): void {
    const value = this.measurement; if (!value) return;
    const selected = value.times.map((time) => projected.find((item) => item.track.key === value.key && item.track.targetId === value.targetId && item.time === time)).filter((item): item is Projected => Boolean(item)); if (!selected.length) return;
    context.save();
    if (selected.length === 2) { context.strokeStyle = css('--vscode-charts-orange', '#d18616'); context.lineWidth = 1.2; context.setLineDash([]); context.beginPath(); context.moveTo(selected[0].x, selected[0].y); context.lineTo(selected[1].x, selected[1].y); context.stroke(); }
    selected.forEach((point, index) => { const color = index === 0 ? css('--vscode-charts-orange', '#d18616') : css('--vscode-charts-blue', '#75beff'); context.fillStyle = css('--vscode-editor-background', '#1e1e1e'); context.strokeStyle = color; context.lineWidth = 2.5; context.setLineDash([]); context.beginPath(); context.arc(point.x, point.y, 7, 0, Math.PI * 2); context.fill(); context.stroke(); context.font = `600 11px ${css('--vscode-font-family', 'sans-serif')}`; context.fillStyle = color; context.textAlign = 'center'; context.textBaseline = 'bottom'; context.fillText(index === 0 ? 'A' : 'B', point.x, point.y - 9); });
    context.restore();
  }

  private paint(context: CanvasRenderingContext2D, width: number, height: number, top: number, tracks: readonly Track[], hover: number | undefined): Projected[] {
    context.fillStyle = css('--vscode-editor-background', '#1e1e1e'); context.fillRect(0, top, width, height);
    if (!tracks.some((track) => track.points.length)) {
      context.fillStyle = css('--vscode-descriptionForeground', '#888'); context.font = '12px sans-serif';
      context.fillText(this.pending || this.host.targets().some((target) => target.status === 'loading') ? t('Loading trajectory…', '軌跡を読み込み中…') : this.isConfigured ? t('No trajectory in the selected files/Clips.', '選択したファイル／クリップに軌跡のデータがありません。') : t('Choose X and Y Signals in Graph settings.', 'グラフ設定でX・Yのシグナルを選択してください。'), 20, top + 30);
      return [];
    }
    const s = this.scales(tracks); const byId = new Map(this.definitions.map((definition) => [definition.id, definition])); const axes = this.axes();
    const unit = this.commonUnit;
    const label = (id?: string) => { const definition = id ? byId.get(id) : undefined; const shown = unit ?? definition?.unit; return definition ? `${definition.name}${shown ? ` (${shown})` : ''}` : ''; };
    let project: (point: TrajectoryPoint) => { x: number; y: number; depth: number };
    if (this.is3d) {
      // Centred on the data, whose widest extent spans 68% of the shorter side at zoom 1.
      const frame = trajectorySceneFrame(tracks.flatMap((track) => track.points)); const center = frame.center;
      const scale = Math.max(1, Math.min(width, height)) * .68 / frame.span; if (top === 0) this.pixelsPerUnit = scale;
      // A fitted camera is fitted again to every size it is drawn at: the card after a resize, or an exported image.
      const view = this.fitted ? fitTrajectoryView(this.view, tracks.flatMap((track) => track.points).map((point) => ({ x: point.x - center[0], y: point.y - center[1], z: (point.z ?? 0) - center[2] })), Math.max(1, width - 2 * TRAJECTORY_FIT_MARGIN) / scale, Math.max(1, height - 2 * TRAJECTORY_FIT_MARGIN) / scale, this.coordinateSystem) : this.view;
      if (top === 0) this.view = view;
      project = (point) => { const value = projectPoint3d({ x: point.x - center[0], y: point.y - center[1], z: (point.z ?? 0) - center[2] }, view, this.coordinateSystem); return { x: width / 2 + value.x * scale, y: top + height / 2 - value.y * scale, depth: value.depth }; };
      this.paint3dAxes(context, s, project, label(axes.x), label(axes.y), label(axes.z), width, height, top);
    } else {
      const plotW = width - PAD.left - PAD.right; const plotH = height - PAD.top - PAD.bottom; const spanX = s.x.maximum - s.x.minimum || 1; const spanY = s.y.maximum - s.y.minimum || 1;
      let kx = plotW / spanX; let ky = plotH / spanY; if (this.definitionValue.equalAspect !== false) kx = ky = Math.min(kx, ky);
      if (top === 0) this.pixelsPerUnit = Math.min(kx, ky);
      // In 2D the whole plot already fits at zoom 1.
      const view2d = this.fitted ? { ...this.view, zoom: 1, panX: 0, panY: 0 } : this.view; if (top === 0) this.view = view2d;
      const zoom = view2d.zoom; const cx = (s.x.minimum + s.x.maximum) / 2 - view2d.panX; const cy = (s.y.minimum + s.y.maximum) / 2 - view2d.panY;
      project = (point) => ({ x: PAD.left + plotW / 2 + (point.x - cx) * kx * zoom, y: top + PAD.top + plotH / 2 - (point.y - cy) * ky * zoom, depth: 0 });
      this.paint2dAxes(context, s, project, width, height, top, label(axes.x), label(axes.y));
    }
    const projected: Projected[] = [];
    for (const track of tracks) {
      const color = track.color;
      const current = this.definitionValue.trajectoryCurrentTime ?? track.points[0]?.timestamp ?? 0;
      const visible = trailAt(track.points, current, this.definitionValue.trajectoryTrail ?? { type: 'all' });
      const items = visible.map((point) => ({ ...project(point), time: point.timestamp, track }));
      projected.push(...items);
      context.save(); context.strokeStyle = color; context.lineWidth = track.key === this.highlightedKey ? 3.2 : 1.8; context.setLineDash(dashFor(track.index)); context.beginPath();
      items.forEach((item, index) => {
        const gap = index > 0 && this.definitionValue.connectGaps === false && (this.samples.get(track.targetId) ?? []).some((series) => track.signalIds.includes(series.signalId) && crossesSeriesGap(series.series.gaps, items[index - 1].time, item.time));
        if (index === 0 || gap) context.moveTo(item.x, item.y); else context.lineTo(item.x, item.y);
      }); context.stroke(); context.restore();
      if (this.definitionValue.showPoints) { context.save(); context.fillStyle = color; context.globalAlpha = .55; const step = Math.max(1, Math.ceil(items.length / 600)); for (let index = 0; index < items.length; index += step) { context.beginPath(); context.arc(items[index].x, items[index].y, 1.8, 0, Math.PI * 2); context.fill(); } context.restore(); }
    }
    if (hover !== undefined) for (const track of tracks) {
      const time = track.anchor + hover; let best: TrajectoryPoint | undefined; let gap = Infinity;
      for (const point of track.points) { const d = Math.abs(point.timestamp - time); if (d < gap) { gap = d; best = point; } }
      const first = track.points[0]; const last = track.points[track.points.length - 1];
      if (!best || !first || time < first.timestamp || time > last.timestamp) continue;
      const position = project(best); context.save(); context.strokeStyle = track.color; context.fillStyle = css('--vscode-editor-background', '#1e1e1e'); context.lineWidth = 2.5;
      context.beginPath(); context.arc(position.x, position.y, 6, 0, Math.PI * 2); context.fill(); context.stroke(); context.restore();
    }
    this.paintMeasurement(context, projected);
    if (hover !== undefined) { context.save(); context.font = `600 11px ${css('--vscode-editor-font-family', 'monospace')}`; context.fillStyle = css('--vscode-foreground', '#ddd'); const text = `${hover >= 0 ? '+' : ''}${format(hover)} s`; context.fillText(text, width - context.measureText(text).width - 12, top + 18); context.restore(); }
    return projected;
  }

  private paint2dAxes(context: CanvasRenderingContext2D, s: ReturnType<TrajectoryCard['scales']>, project: (point: TrajectoryPoint) => { x: number; y: number }, width: number, height: number, top: number, xLabel: string, yLabel: string): void {
    context.save(); context.strokeStyle = css('--vscode-panel-border', '#555'); context.fillStyle = css('--vscode-descriptionForeground', '#888'); context.font = '11px sans-serif'; context.globalAlpha = .7;
    for (const tick of this.definitionValue.showGrid === false ? [] : s.x.ticks) { const p = project({ timestamp: 0, x: tick, y: s.y.minimum }); const q = project({ timestamp: 0, x: tick, y: s.y.maximum }); context.beginPath(); context.moveTo(p.x, p.y); context.lineTo(q.x, q.y); context.stroke(); context.fillText(format(trajectoryAxisDisplayValue(tick, this.definitionValue.invert?.x === true)), p.x - 10, Math.min(top + height - 22, p.y + 14)); }
    for (const tick of this.definitionValue.showGrid === false ? [] : s.y.ticks) { const p = project({ timestamp: 0, x: s.x.minimum, y: tick }); const q = project({ timestamp: 0, x: s.x.maximum, y: tick }); context.beginPath(); context.moveTo(p.x, p.y); context.lineTo(q.x, q.y); context.stroke(); context.fillText(format(trajectoryAxisDisplayValue(tick, this.definitionValue.invert?.y === true)), Math.max(4, p.x - context.measureText(format(tick)).width - 6), p.y + 4); }
    context.globalAlpha = 1; context.fillStyle = css('--vscode-foreground', '#ddd'); context.font = '600 11px sans-serif';
    context.fillText(`X: ${xLabel}`, width / 2 - context.measureText(`X: ${xLabel}`).width / 2, top + height - 8); context.fillText(`Y: ${yLabel}`, 8, top + 14); context.restore();
  }

  private paint3dAxes(context: CanvasRenderingContext2D, s: ReturnType<TrajectoryCard['scales']>, project: (point: TrajectoryPoint) => { x: number; y: number }, xLabel: string, yLabel: string, zLabel: string, width: number, height: number, top: number): void {
    const axis = (from: TrajectoryPoint, to: TrajectoryPoint, color: string, text: string, title: LabelBox) => { const a = project(from); const b = project(to); context.save(); context.strokeStyle = color; context.fillStyle = color; context.globalAlpha = .8; context.beginPath(); context.moveTo(a.x, a.y); context.lineTo(b.x, b.y); context.stroke(); context.font = '600 11px sans-serif'; context.fillText(text, title.x, title.y + 11); context.restore(); };
    const origin = { timestamp: 0, x: s.x.minimum, y: s.y.minimum, z: s.z.minimum };
    const axisEnds = [{ end: { ...origin, x: s.x.maximum }, color: css('--vscode-charts-red', '#f14c4c'), text: `X: ${xLabel}` }, { end: { ...origin, y: s.y.maximum }, color: css('--vscode-charts-green', '#89d185'), text: `Y: ${yLabel}` }, { end: { ...origin, z: s.z.maximum }, color: css('--vscode-charts-blue', '#3794ff'), text: `Z: ${zLabel}` }];
    context.save(); context.font = '600 11px sans-serif';
    // A title stays at its axis's end; an end past the plot's edge holds it at the edge, so it can still be read.
    const titles = separateTitles(axisEnds.map(({ end, text }): LabelBox => { const point = project(end); const titleWidth = context.measureText(text).width; return { x: Math.max(4, Math.min(point.x + 4, Math.max(4, width - titleWidth - 4))), y: Math.max(top + 4, Math.min(point.y - 15, Math.max(top + 4, top + height - 18))), width: titleWidth, height: 14 }; }), top + 4, top + height - 4);
    context.restore();
    if (this.definitionValue.showGrid !== false) {
      context.save(); context.strokeStyle = css('--vscode-panel-border', '#555'); context.globalAlpha = .5;
      const grid = (from: TrajectoryPoint, to: TrajectoryPoint) => { const a = project(from); const b = project(to); context.beginPath(); context.moveTo(a.x, a.y); context.lineTo(b.x, b.y); context.stroke(); };
      for (const x of s.x.ticks) grid({ timestamp: 0, x, y: s.y.minimum, z: 0 }, { timestamp: 0, x, y: s.y.maximum, z: 0 });
      for (const y of s.y.ticks) grid({ timestamp: 0, x: s.x.minimum, y, z: 0 }, { timestamp: 0, x: s.x.maximum, y, z: 0 });
      context.globalAlpha = 1; context.font = '11px sans-serif'; context.fillStyle = css('--vscode-descriptionForeground', '#888');
      const occupied = [...titles];
      for (const dimension of ['x', 'y', 'z'] as const) for (const tick of s[dimension].ticks) {
        const point = project({ timestamp: 0, x: s.x.minimum, y: s.y.minimum, z: s.z.minimum, [dimension]: tick });
        const text = format(trajectoryAxisDisplayValue(tick, this.definitionValue.invert?.[dimension] === true));
        if (placeTickLabel(context, text, point.x + 4, point.y - 4, occupied)) context.fillText(text, point.x + 4, point.y - 4);
      }
      context.restore();
    }
    axisEnds.forEach(({ end, color, text }, index) => axis(origin, end, color, text, titles[index]));
  }

  private renderLegend(tracks: readonly Track[]): void {
    const targets = this.host.targets().filter((item) => item.status === 'ready' && !this.host.hidden(item.id));
    // Several series: an entry per series, as in Visualize. Otherwise an entry per target, with its line style.
    const entries = this.definitionValue.trajectorySeries
      ? this.drawnSeries.map((item) => ({ key: item.id, name: item.name, color: item.color, index: 0, title: this.seriesTitle(item) }))
      : targets.map((target) => ({ key: target.id, name: target.name, color: targetColor(this.host.targetIndex(target.id)), index: this.host.targetIndex(target.id), title: undefined }));
    const key = JSON.stringify([entries, entries.map((entry) => tracks.some((track) => track.key === entry.key && track.points.length)), this.pending, this.isConfigured]);
    // Redraws must keep the focused/hovered button alive.
    if (key === this.legendKey) return;
    this.legendKey = key; this.highlightedKey = undefined; clearLegend(this.legend, this.title); placeCardTitle(this.element, this.header, this.legend, this.title, entries.length > 0);
    for (const { key: id, name, color, index, title } of entries) {
      const has = tracks.some((track) => track.key === id && track.points.length);
      const entry = createLegendEntry(name, color, (active) => {
        if (active) this.highlightedKey = id;
        else if (this.highlightedKey === id) this.highlightedKey = undefined;
        emphasizeSignal(entry, active, color); this.scheduleDraw();
      });
      if (title) entry.title = title;
      entry.className = 'chart-legend-entry';
      const line = entry.querySelector('i')!;
      line.style.backgroundColor = 'transparent'; line.style.height = '0';
      line.style.borderTop = `3px ${index % 4 === 0 ? 'solid' : index % 4 === 2 ? 'dotted' : 'dashed'} ${color}`;
      if (!has && !this.pending && this.isConfigured) { const warn = document.createElement('span'); warn.className = 'codicon codicon-warning legend-warning'; entry.appendChild(warn); entry.title = t('This file/Clip has no data for the selected X/Y/Z Signals.', 'このファイル／クリップには選択したX/Y/Zのシグナルのデータがありません。'); }
      this.legend.appendChild(entry);
    }
  }

  /** A series' Signals, for its legend entry. */
  private seriesTitle(series: ComparisonTrajectorySeries): string {
    const parts = (['x', 'y', 'z'] as const).flatMap((axis) => { const id = series.axes[axis]; if (!id) return []; const definition = this.definitions.find((item) => item.id === id); return [`${axis.toUpperCase()}: ${definition?.name ?? id}${definition?.unit ? ` (${definition.unit})` : ''}`]; });
    return `${series.name}\n${parts.join(' · ')}`;
  }

  private saveImage(): void { const image = this.renderImage(); if (!image) return; const marked = withBrandMark(image, css('--vscode-foreground', '#ddd')); this.host.saveImage(marked.pngDataUrl, marked.svg); }
  /** This graph as an export image (also used for the combined sheet). */
  renderImage(heading = `SigMixa · ${this.definitionValue.name}`, width = 1600): SheetImage | undefined {
    const tracks = this.tracks(); if (!tracks.some((track) => track.points.length)) return undefined;
    const height = Math.round(width * .625);
    const png = document.createElement('canvas'); png.width = width; png.height = height; const pngContext = png.getContext('2d'); if (!pngContext) return undefined;
    // One entry per series or target; rows wrap so that a long legend stays on the image, and the plot starts below them.
    pngContext.font = '12px sans-serif'; let legendX = 24; let legendY = 54;
    const legend = [...new Map(tracks.map((track) => [track.key, track])).values()].map((track) => { const step = 50 + pngContext.measureText(track.name).width; if (legendX > 24 && legendX + step > width - 24) { legendX = 24; legendY += 20; } const place = { track, x: legendX, y: legendY }; legendX += step; return place; });
    const top = legendY + 16;
    const paintAll = (context: CanvasRenderingContext2D) => {
      context.fillStyle = css('--vscode-editor-background', '#1e1e1e'); context.fillRect(0, 0, width, height);
      context.fillStyle = css('--vscode-foreground', '#ddd'); context.font = '600 20px sans-serif'; context.fillText(heading, 24, 34);
      context.font = '12px sans-serif';
      for (const { track, x, y } of legend) { context.save(); context.strokeStyle = track.color; context.setLineDash(dashFor(track.index)); context.lineWidth = 2; context.beginPath(); context.moveTo(x, y); context.lineTo(x + 24, y); context.stroke(); context.restore(); context.fillStyle = css('--vscode-foreground', '#ddd'); context.fillText(track.name, x + 30, y + 4); }
      // Clipped to the plot: a fitted camera can carry the axis lines past it, over the heading and legend.
      context.save(); context.beginPath(); context.rect(0, top, width, height - top); context.clip();
      this.paint(context, width, height - top, top, tracks, undefined); context.restore();
    };
    paintAll(pngContext);
    const vector = createSvgCanvas(width, height); paintAll(vector.context);
    return { canvas: png, pngDataUrl: png.toDataURL('image/png'), svg: vector.toSvg(), width, height };
  }
}
