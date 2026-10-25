import { attachNumberStepper } from '../shared/numberStepper';
import { createLegendEntry } from '../shared/signalLegend';
import { emphasizeSignal } from '../shared/signalEmphasis';
import { enhanceChoiceSelect, syncChoiceSelect } from '../shared/choiceGroup';
import { buttonContextAction, type ViewContextAction } from '../shared/viewContextAction';
import { ViewElements } from '../shared/viewElements';
import { TRAJECTORY_FIT_MARGIN, TRAJECTORY_ZOOM_LIMITS, buildTrajectoryPoints, trajectorySceneFrame, fitTrajectoryView, measureTrajectory, presetTrajectoryView, projectPoint3d, trajectoryViewFrom, trailAt, trajectoryAxisDisplayValue, trajectoryAxisEndpoints, trajectoryAxisScale, type TrajectoryPoint as CoreTrajectoryPoint, type TrajectoryCoordinateSystem, type TrajectoryViewTransform } from '../../core/trajectory/trajectory';
import type { TrajectorySeriesDefinition, LogViewState, SignalGroupDto, SignalSeriesDto, ToExtensionMessage, ToWebviewMessage } from '../../extension/editors/rawLogProtocol';
import type { SignalDefinition } from '../../core/signal/signal';
import type { TimelineController } from '../shared/timelineController';
import { t } from '../shared/i18n';
import { crossesSeriesGap } from '../shared/chartSeries';
import { chartWheelGesture } from '../shared/chartWheel';
import { bindPressRepeat } from '../shared/pressRepeat';
import { commonDisplayUnit, convertDisplayUnit, type CommonDisplayUnit } from '../../core/units/displayUnit';
import { downsampleExtremes } from '../../core/timeline/timeline';
import { createSvgCanvas } from '../shared/svgCanvas';
import type { SheetImage } from '../shared/imageSheet';
import { withBrandMark } from '../shared/brandMark';
import { iconButton, secondaryToolbar, textIconButton, viewActionGroup, type ViewCardState } from '../shared/iconButton';

type TrajectoryPoint = CoreTrajectoryPoint & { readonly seriesId?: string };

export class TrajectoryView {
  private readonly elements: ViewElements;
  private tracks: TrajectorySeriesDefinition[] = [];
  private activeTrack = 0;
  private highlightedTrackId?: string;
  private readonly lifetime = new AbortController();
  private resizeObserver?: ResizeObserver;
  private unsubscribeTimeline?: () => void;
  private unsubscribePosition?: () => void;
  private unsubscribeVisibility?: () => void;
  private unsubscribeRange?: () => void;
  private readonly timelineSource = crypto.randomUUID();
  get isConfigured(): boolean { return this.tracks.some((track) => Boolean(track.xId && track.yId)); }
  dispose(): void { this.hide(); this.lifetime.abort(); this.resizeObserver?.disconnect(); this.unsubscribeTimeline?.(); this.unsubscribePosition?.(); this.unsubscribeVisibility?.(); this.unsubscribeRange?.(); }
  private listenWindow<K extends keyof WindowEventMap>(type: K, listener: (event: WindowEventMap[K]) => void): void { window.addEventListener(type, listener, { signal: this.lifetime.signal }); }
  private definitions = new Map<string, SignalDefinition>(); private groups: readonly SignalGroupDto[] = []; private groupBySignal = new Map<string, string>();
  private xId?: string; private yId?: string; private zId?: string; private invert: { x: boolean; y: boolean; z: boolean }; private equalAspect: boolean;
  private connectGaps: boolean; private showGrid: boolean; private showPoints: boolean;
  private trail: 'all' | 'to-current' | 'last-seconds'; private trailSeconds: number; private view: TrajectoryViewTransform; private viewFitted: boolean; private coordinateSystem: TrajectoryCoordinateSystem;
  private readonly canvas: HTMLCanvasElement; private readonly search: HTMLInputElement; private series: readonly SignalSeriesDto[] = []; private analysisPoints: readonly TrajectoryPoint[] = []; private points: readonly TrajectoryPoint[] = [];
  /** The Signals the log has samples of; the axis lists offer these, what is chosen, and the rest only on request. */
  private measured: ReadonlySet<string> | undefined; private unmeasuredOption = false; private showUnmeasured = false;
  private listed(id: string): boolean { return !this.measured || this.measured.has(id) || (this.unmeasuredOption && this.showUnmeasured); }
  private visible = false; private catalogRequest = 0; private seriesRequest = 0; private counter = 300_000; private current?: number;
  private projectedPoints: readonly ProjectedTrajectoryPoint[] = []; private hoverTimestamp?: number; private canvasDragging = false; private canvasDragMoved = false;
  private coordinateDisplayUnit?: CommonDisplayUnit; private measurementMode = false; private exporting = false;
  /** The point under each series' Trace cursor in the last drawing; a series without a drawn cursor has no entry. */
  private readonly cursorPoints = new Map<string, CoreTrajectoryPoint>(); private measurementTimestamps: number[] = [];

  constructor(private readonly host: HTMLElement, initial: LogViewState | undefined, private readonly post: (message: ToExtensionMessage) => void, private readonly save: (partial: Partial<LogViewState>) => void, private readonly timeline: TimelineController, optionsHost?: HTMLElement, actionsHost?: HTMLElement) {
    this.elements = new ViewElements(host, optionsHost, actionsHost);
    this.tracks = initial?.trajectorySeries?.length ? structuredClone([...initial.trajectorySeries]) : [{ id: crypto.randomUUID(), name: t('Series 1', '系列1'), xId: initial?.trajectoryXId, yId: initial?.trajectoryYId, zId: initial?.trajectoryZId }];
    this.xId = initial?.trajectoryXId; this.yId = initial?.trajectoryYId; this.zId = initial?.trajectoryZId; this.invert = { x: false, y: false, z: false, ...initial?.trajectoryInvert };
    this.xId = this.tracks[0].xId; this.yId = this.tracks[0].yId; this.zId = this.tracks[0].zId;
    this.equalAspect = initial?.trajectoryEqualAspect ?? true; this.connectGaps = initial?.trajectoryConnectGaps !== false; this.showGrid = initial?.trajectoryShowGrid !== false; this.showPoints = initial?.trajectoryShowPoints !== false; this.trail = initial?.trajectoryTrail ?? 'all'; this.trailSeconds = initial?.trajectoryTrailSeconds ?? 10; this.view = trajectoryViewFrom(initial?.trajectoryView); this.viewFitted = initial?.trajectoryView ? initial.trajectoryViewFit === true : true; this.coordinateSystem = initial?.trajectoryCoordinateSystem === 'left' ? 'left' : 'right';
    host.innerHTML = `<div class="trajectory-layout"><aside class="trajectory-pane"><div class="trajectory-search-row" style="display:flex;align-items:center;gap:var(--sm-space-xs);min-width:0"><input class="trajectory-search" style="flex:1 1 auto;min-width:0" type="search" placeholder="${t('Search Signals…', 'シグナルを検索…')}" aria-label="${t('Search trajectory Signals', '軌跡用シグナルを検索')}"><button class="icon-button trajectory-unmeasured" type="button" hidden style="flex:0 0 auto"></button></div><div class="trajectory-tracks"></div><button class="trajectory-add-track" type="button"><span class="codicon codicon-add" aria-hidden="true"></span> ${t('Add series', '系列を追加')}</button><div class="trajectory-checks"><label><input class="invert-x" type="checkbox"> ${t('Invert X', 'Xを反転')}</label><label><input class="invert-y" type="checkbox"> ${t('Invert Y', 'Yを反転')}</label><label class="invert-z-label"><input class="invert-z" type="checkbox"> ${t('Invert Z', 'Zを反転')}</label><label class="coordinate-system-label">${t('Coordinate system', '座標系')}<select class="trajectory-coordinate-system"><option value="right">${t('Right-handed', '右手系')}</option><option value="left">${t('Left-handed', '左手系')}</option></select></label><label class="equal-aspect-label"><input class="equal-aspect" type="checkbox"> ${t('Equal aspect', '縦横比を統一')}</label><label><input class="show-grid" type="checkbox"> ${t('Grid values', '数値グリッド')}</label><label><input class="show-points" type="checkbox"> ${t('Data points', 'データ点')}</label></div><label>${t('Trail', '軌跡範囲')}<select class="trail-mode"><option value="all">${t('All', 'すべて')}</option><option value="to-current">${t('To current time', '現在時刻まで')}</option><option value="last-seconds">${t('Last N seconds', '直近N秒')}</option></select></label><label class="trail-seconds-label">${t('Trail seconds', '軌跡の秒数')}<input class="trail-seconds" type="number" min="0" step="1"></label></aside><section class="trajectory-main"><div class="view-toolbar"><strong class="trajectory-mode">2D</strong><label class="chart-option"><input class="trajectory-connect-gaps" type="checkbox">${t('Connect gaps', '欠損区間を接続')}</label><span class="trajectory-camera-controls"><button class="trajectory-zoom-in"></button><button class="trajectory-zoom-out"></button><button class="preset-x"></button><button class="preset-y"></button><button class="preset-z"></button><button class="preset-reset">${t('Reset View', '表示をリセット')}</button></span><button class="save-trajectory-image">${t('Save Image…', '画像を保存…')}</button><span class="trajectory-interaction-hint muted" hidden>${t('Drag: rotate · Shift+drag: pan · Ctrl/Cmd+wheel: zoom', 'ドラッグ: 回転 · Shift+ドラッグ: 移動 · Ctrl/Cmd＋ホイール: 拡大縮小')}</span><span class="spacer"></span><span class="trajectory-status muted">${t('Choose X and Y Signals', 'XとYのシグナルを選択')}</span></div><div class="trajectory-legend" role="group" aria-label="${t('Trajectory legend', '軌跡の凡例')}"></div><div class="trajectory-canvas-wrap"><canvas aria-label="${t('Trajectory. Hover a point to inspect it; click to move the playback position.', '軌跡。点にマウスを合わせて値を確認、クリックで再生位置を移動。')}"></canvas></div></section></div>`;
    this.elements.querySelector('.save-trajectory-image')!.insertAdjacentHTML('beforebegin', `<button class="trajectory-measure-toggle" aria-pressed="false">${t('Measure 2 Points', '2点計測')}</button>`);
    this.elements.querySelector('.trajectory-canvas-wrap')!.insertAdjacentHTML('beforebegin', `<div class="trajectory-measurement" hidden><strong>A → B</strong><span class="trajectory-measurement-value"></span><span class="spacer"></span><button class="trajectory-measure-clear">${t('Clear Measurement', '計測を解除')}</button></div>`);
    this.elements.querySelector('.trajectory-add-track')!.addEventListener('click', () => {
      this.storeActiveTrack();
      let number = this.tracks.length + 1;
      while (this.tracks.some((track) => track.name === `${t('Series', '系列')}${number}`)) number++;
      this.tracks.push({ id: crypto.randomUUID(), name: `${t('Series', '系列')}${number}` });
      this.activateTrack(this.tracks.length - 1); this.renderTrackControls(); this.persist();
      const name = this.elements.querySelectorAll<HTMLInputElement>('.trajectory-track-name')[this.activeTrack];
      name.focus(); name.select();
    });
    this.canvas = this.elements.querySelector('canvas')!; this.search = this.elements.querySelector('.trajectory-search')!; this.bind(); enhanceChoiceSelect(this.elements.querySelector<HTMLSelectElement>('.trail-mode')!, t('Trail interval', '軌跡の表示範囲')); enhanceChoiceSelect(this.elements.querySelector<HTMLSelectElement>('.trajectory-coordinate-system')!, t('Coordinate system', '座標系')); this.applyControls(); this.renderTrackControls(); this.updateMode(); this.updateMeasurementControls();
    const toolbar = this.elements.querySelector<HTMLElement>('.trajectory-main>.view-toolbar')!; iconButton(this.elements.querySelector<HTMLButtonElement>('.preset-reset')!, 'discard', t('Reset view', '表示をリセット')); const measure = iconButton(this.elements.querySelector<HTMLButtonElement>('.trajectory-measure-toggle')!, 'symbol-ruler', t('Measure two points', '2点計測')); const saveImage = iconButton(this.elements.querySelector<HTMLButtonElement>('.save-trajectory-image')!, 'export', t('Save image', '画像を保存')); const secondary = secondaryToolbar(measure, saveImage); secondary.setAttribute('aria-label', t('Secondary actions', '補助操作')); toolbar.appendChild(secondary); this.elements.querySelector('.trajectory-interaction-hint')?.remove(); this.updateMode(); this.updateMeasurementControls();
    this.unsubscribeTimeline = this.timeline.subscribe((timestamp, source) => { if (source === this.timelineSource) return; this.hoverTimestamp = timestamp; this.draw(); });
    this.unsubscribePosition = this.timeline.subscribePosition((timestamp) => { this.current = timestamp; this.draw(); });
    this.unsubscribeRange = this.timeline.subscribeRange(() => this.draw());
    this.unsubscribeVisibility = this.timeline.subscribePositionVisibility(() => this.draw());
    (this.resizeObserver = new ResizeObserver(() => this.draw())).observe(this.elements.querySelector('.trajectory-canvas-wrap')!);
    if (optionsHost) {
      const pane = this.elements.querySelector<HTMLElement>('.trajectory-pane')!;
      const settings = document.createElement('details'); settings.className = 'display-settings';
      const summary = document.createElement('summary'); summary.textContent = t('Drawing settings', '描画設定'); settings.appendChild(summary);
      const group = (caption: string, selectors: string[], className?: string) => {
        const section = document.createElement('fieldset'); section.className = `trajectory-drawing-group ${className ?? ''}`;
        const legend = document.createElement('legend'); legend.textContent = caption; section.append(legend);
        for (const selector of selectors) {
          const input = this.elements.querySelector<HTMLElement>(selector)!;
          section.append(input.parentElement!);
        }
        settings.append(section);
      };
      group(t('Axes and aspect', '軸の向き・比率'), ['.invert-x', '.invert-y', '.invert-z', '.trajectory-coordinate-system', '.equal-aspect'], 'trajectory-axis-settings');
      group(t('Data and grid', 'データ・グリッド'), ['.show-points', '.show-grid', '.trajectory-connect-gaps'], 'trajectory-data-settings');
      group(t('Trail interval', '軌跡の表示範囲'), ['.trail-mode', '.trail-seconds']);
      this.elements.querySelector('.trajectory-checks')!.remove();
      settings.appendChild(toolbar);
      optionsHost.append(settings, pane);
      this.elements.querySelector<HTMLElement>('.trajectory-mode')!.hidden = true;
      this.elements.querySelector<HTMLElement>('.trajectory-status')!.hidden = true;
    }
    if (actionsHost) {
      const camera = this.elements.querySelector<HTMLElement>('.trajectory-camera-controls')!;
      camera.classList.add('view-action-group'); camera.setAttribute('role', 'group'); camera.setAttribute('aria-label', t('Adjust display', '表示調整'));
      const clear = iconButton(this.elements.querySelector<HTMLButtonElement>('.trajectory-measure-clear')!, 'clear-all', t('Clear measurement', '計測を解除'));
      actionsHost.append(camera, viewActionGroup(t('Analysis', '解析'), measure, clear), viewActionGroup(t('Export', 'エクスポート'), saveImage));
      secondary.remove();
    }
  }

  contextActions(): (ViewContextAction | null)[] {
    const action = (selector: string, label?: string) => buttonContextAction(this.elements.querySelector<HTMLButtonElement>(selector)!, label);
    const items: (ViewContextAction | null)[] = [action('.trajectory-measure-toggle')];
    if (this.measurementTimestamps.length) items.push(action('.trajectory-measure-clear', t('Clear measurement', '計測を解除')));
    if (this.is3d()) items.push(null, action('.trajectory-zoom-in', t('Zoom in', '拡大')), action('.trajectory-zoom-out', t('Zoom out', '縮小')), ...(['x', 'y', 'z'] as const).map((axis) => action(`.preset-${axis}`)), action('.preset-reset'));
    items.push(action('.save-trajectory-image')); return items;
  }
  show(): void { const wasVisible = this.visible; this.visible = true; if (!this.catalogRequest) { this.catalogRequest = ++this.counter; this.post({ type: 'signalCatalogRequest', requestId: this.catalogRequest, view: 'trajectory' }); } else if (!wasVisible) this.request(); this.draw(); }
  hide(): void { this.visible = false; }
  handle(message: ToWebviewMessage): void {
    if (message.type === 'signalCatalog' && message.requestId === this.catalogRequest) { this.measured = message.measuredIds ? new Set(message.measuredIds) : undefined; this.unmeasuredOption = message.unmeasuredOption === true; this.setCatalog(message.definitions, message.groups); this.request(); }
    else if (message.type === 'signalSeries' && message.requestId === this.seriesRequest) { this.series = message.series; this.rebuildPoints(); }
    else if (message.type === 'definitionsChanged') { this.catalogRequest = 0; this.seriesRequest = 0; this.series = []; this.analysisPoints = []; this.points = []; if (this.visible) this.show(); }
  }

  private bind(): void {
    this.search.addEventListener('input', () => this.renderAxisOptions());
    this.elements.querySelector<HTMLButtonElement>('.trajectory-unmeasured')!.addEventListener('click', () => { this.showUnmeasured = !this.showUnmeasured; this.renderAxisOptions(); });
    for (const axis of ['x', 'y', 'z'] as const) (this.elements.querySelector(`.invert-${axis}`) as HTMLInputElement).addEventListener('change', (event) => { this.invert[axis] = (event.target as HTMLInputElement).checked; this.persist(); this.rebuildPoints(); });
    (this.elements.querySelector('.equal-aspect') as HTMLInputElement).addEventListener('change', (event) => { this.equalAspect = (event.target as HTMLInputElement).checked; this.persist(); this.draw(); });
    (this.elements.querySelector('.trajectory-connect-gaps') as HTMLInputElement).addEventListener('change', (event) => { this.connectGaps = (event.target as HTMLInputElement).checked; this.persist(); this.updateMeasurementControls(); this.draw(); });
    (this.elements.querySelector('.show-grid') as HTMLInputElement).addEventListener('change', (event) => { this.showGrid = (event.target as HTMLInputElement).checked; this.persist(); this.draw(); });
    (this.elements.querySelector('.show-points') as HTMLInputElement).addEventListener('change', (event) => { this.showPoints = (event.target as HTMLInputElement).checked; this.persist(); this.draw(); });
    (this.elements.querySelector('.trail-mode') as HTMLSelectElement).addEventListener('change', (event) => { this.trail = (event.target as HTMLSelectElement).value as typeof this.trail; this.applyControls(); this.persist(); this.draw(); });
    attachNumberStepper(this.elements.querySelector('.trail-seconds') as HTMLInputElement);
    (this.elements.querySelector('.trail-seconds') as HTMLInputElement).addEventListener('change', (event) => { this.trailSeconds = Math.max(0, Number((event.target as HTMLInputElement).value) || 0); this.persist(); this.draw(); });
    for (const [selector, icon, label, factor] of [
      ['.trajectory-zoom-out', 'zoom-out', t('Zoom out; hold to repeat', '縮小・長押しで連続'), 1 / 1.5],
      ['.trajectory-zoom-in', 'zoom-in', t('Zoom in; hold to repeat', '拡大・長押しで連続'), 1.5],
    ] as const) {
      const button = iconButton(this.elements.querySelector<HTMLButtonElement>(selector)!, icon, label);
      bindPressRepeat(button, () => this.zoom(factor), { intervalMs: 180 });
    }
    for (const axis of ['x', 'y', 'z'] as const) textIconButton(this.elements.querySelector<HTMLButtonElement>(`.preset-${axis}`)!, axis.toUpperCase(), viewAlongLabel(axis));
    (this.elements.querySelector('.trajectory-coordinate-system') as HTMLSelectElement).addEventListener('change', (event) => { this.coordinateSystem = (event.target as HTMLSelectElement).value === 'left' ? 'left' : 'right'; this.persist(); this.draw(); });
    for (const preset of ['x', 'y', 'z', 'reset'] as const) this.elements.querySelector(`.preset-${preset}`)!.addEventListener('click', () => { this.view = presetTrajectoryView(preset); this.viewFitted = true; this.persist(); this.draw(); });
    this.elements.querySelector('.trajectory-measure-toggle')!.addEventListener('click', () => { this.measurementMode = !this.measurementMode; /* Leaving measurement removes A and B, so no half-made selection is left on screen. */ if (!this.measurementMode) { this.measurementTimestamps = []; this.draw(); } this.updateMeasurementControls(); });
    this.elements.querySelector('.trajectory-measure-clear')!.addEventListener('click', () => { this.measurementTimestamps = []; this.updateMeasurementControls(); this.draw(); });
    this.elements.querySelector('.save-trajectory-image')!.addEventListener('click', () => this.saveImage());
    let previous = { x: 0, y: 0 }; let panning = false;
    this.canvas.addEventListener('mousedown', (event) => { if (!this.is3d() || (event.button !== 0 && event.button !== 1)) return; event.preventDefault(); this.canvasDragging = true; this.canvasDragMoved = false; panning = event.button === 1 || event.shiftKey; previous = { x: event.clientX, y: event.clientY }; this.canvas.classList.add('dragging'); });
    this.canvas.addEventListener('mousemove', (event) => { if (!this.canvasDragging) this.updateHover(event); });
    this.canvas.addEventListener('mouseleave', () => { if (!this.canvasDragging && this.hoverTimestamp !== undefined) { this.hoverTimestamp = undefined; this.timeline.set(undefined, this.timelineSource); this.canvas.classList.remove('point-hover'); this.draw(); } });
    this.canvas.addEventListener('click', () => { if (this.canvasDragMoved) { this.canvasDragMoved = false; return; } if (this.hoverTimestamp === undefined) return; if (this.measurementMode) { this.measurementTimestamps = this.measurementTimestamps.length === 1 && this.measurementTimestamps[0] !== this.hoverTimestamp ? [this.measurementTimestamps[0], this.hoverTimestamp] : [this.hoverTimestamp]; this.updateMeasurementControls(); this.draw(); } else this.seek(this.hoverTimestamp); });
    this.listenWindow('mousemove', (event) => { if (!this.canvasDragging) return; const dx = event.clientX - previous.x; const dy = event.clientY - previous.y; previous = { x: event.clientX, y: event.clientY }; if (Math.abs(dx) + Math.abs(dy) > 1) this.canvasDragMoved = true; if (dx || dy) this.viewFitted = false;
      // Panning keeps the scene under the cursor; a drag across the canvas height turns the view once around.
      // A left-handed scene is the mirror image, so its yaw turns the other way to make a drag look the same in both.
      const unitsPerPixel = 1 / (this.sceneScale(this.canvas.clientWidth, this.canvas.clientHeight) * this.view.zoom); const radiansPerPixel = 2 * Math.PI / Math.max(1, this.canvas.clientHeight);
      this.view = panning ? { ...this.view, panX: this.view.panX + dx * unitsPerPixel, panY: this.view.panY - dy * unitsPerPixel } : { ...this.view, yaw: this.view.yaw + (this.coordinateSystem === 'left' ? -dx : dx) * radiansPerPixel, pitch: clamp(this.view.pitch + dy * radiansPerPixel, -Math.PI / 2, Math.PI / 2) }; this.hoverTimestamp = undefined; this.draw(); });
    this.listenWindow('mouseup', () => { if (this.canvasDragging) this.persist(); this.canvasDragging = false; this.canvas.classList.remove('dragging'); });
    this.canvas.addEventListener('wheel', (event) => {
      if (!this.is3d()) return;
      const gesture = chartWheelGesture(event, this.canvas.clientHeight);
      if (gesture.kind !== 'zoom') return;
      // One mouse-wheel notch zooms about 1.5×, like the time-series graph; trackpad pinches send small deltas and stay smooth.
      event.preventDefault(); const rect = this.canvas.getBoundingClientRect();
      this.zoom(Math.exp(-clamp(gesture.delta, -40, 40) * .01), { x: event.clientX - rect.left, y: event.clientY - rect.top });
    }, { passive: false });
  }

  /** Zooms, keeping the scene point under `anchor` (canvas pixels) in place; without an anchor the canvas centre stays. */
  private zoom(factor: number, anchor?: { x: number; y: number }): void {
    if (!this.is3d()) return;
    this.viewFitted = false; const zoom = clamp(this.view.zoom * factor, TRAJECTORY_ZOOM_LIMITS.minimum, TRAJECTORY_ZOOM_LIMITS.maximum); const width = this.canvas.clientWidth; const height = this.canvas.clientHeight;
    const scale = this.sceneScale(width, height); const shift = 1 / zoom - 1 / this.view.zoom;
    const offsetX = anchor ? (anchor.x - width / 2) / scale : 0; const offsetY = anchor ? (height / 2 - anchor.y) / scale : 0;
    this.view = { ...this.view, zoom, panX: this.view.panX + offsetX * shift, panY: this.view.panY + offsetY * shift }; this.persist(); this.draw();
  }
  /** The view zoomed and moved so every point of the trajectory (all series, not only the trail) fills a scene of this size. */
  private fitView(view: TrajectoryViewTransform, width: number, height: number): TrajectoryViewTransform {
    const scale = this.sceneScale(width, height); const centers = this.sceneCenters();
    // The unthinned points: a selected time range draws these, and thinning keeps only each axis's extremes, not those of every viewing angle.
    const points = (this.analysisPoints.length ? this.analysisPoints : this.points).map((point) => ({ x: point.x - centers[0], y: point.y - centers[1], z: (point.z ?? 0) - centers[2] }));
    return fitTrajectoryView(view, points, Math.max(1, width - 2 * TRAJECTORY_FIT_MARGIN) / scale, Math.max(1, height - 2 * TRAJECTORY_FIT_MARGIN) / scale, this.coordinateSystem);
  }
  /** The scene point drawn at the canvas centre before panning: the middle of the data. */
  private sceneCenters(): readonly [number, number, number] { return trajectorySceneFrame(this.points).center; }
  /** Screen pixels per data unit at zoom 1: the widest extent of the data spans 68% of the shorter canvas side. */
  private sceneScale(width: number, height: number): number { return Math.max(1, Math.min(width, height)) * .68 / trajectorySceneFrame(this.points).span; }

  /** True when the pointer is over the trajectory canvas, which owns hover, rotation, zoom and measurement. */
  isPlotTarget(event: MouseEvent): boolean { return event.target === this.canvas; }
  /** Scrolls the graph settings to one series and focuses its X axis. */
  revealOption(trackId: string): void {
    const card = Array.from(this.elements.querySelectorAll<HTMLElement>('.trajectory-track-card')).find((item) => item.dataset.trackId === trackId); if (!card) return;
    card.scrollIntoView({ block: 'nearest' });
    card.querySelector<HTMLSelectElement>('select')?.focus({ preventScroll: true, focusVisible: true } as FocusOptions);
    card.classList.remove('option-revealed'); void card.offsetWidth; card.classList.add('option-revealed');
  }
  private storeActiveTrack(): void { this.tracks[this.activeTrack] = { ...this.tracks[this.activeTrack], xId: this.xId, yId: this.yId, zId: this.zId }; }
  private loadActiveTrack(): void { const track = this.tracks[this.activeTrack]; this.xId = track.xId; this.yId = track.yId; this.zId = track.zId; }
  private activateTrack(index: number): void {
    if (index === this.activeTrack) return;
    this.storeActiveTrack(); this.activeTrack = index; this.loadActiveTrack();
    this.measurementTimestamps = []; this.updateMeasurementControls(); this.draw();
  }
  private renderTrackControls(): void {
    const container = this.elements.querySelector<HTMLElement>('.trajectory-tracks')!; container.replaceChildren();
    this.tracks.forEach((track, index) => {
      const card = document.createElement('section'); card.className = 'trajectory-track-card'; card.dataset.trackId = track.id;
      const header = document.createElement('div'); header.className = 'trajectory-track-header';
      const swatch = document.createElement('span'); swatch.className = 'trajectory-track-color'; swatch.style.background = trackColor(index); swatch.setAttribute('aria-hidden', 'true');
      const name = document.createElement('input'); name.className = 'trajectory-track-name'; name.value = track.name; name.setAttribute('aria-label', t('Series name', '系列名')); name.title = t('Edit series name', '系列名を編集');
      name.addEventListener('change', () => { const value = name.value.trim() || this.tracks[index].name; name.value = value; this.tracks[index] = { ...this.tracks[index], name: value }; this.persist(); });
      name.addEventListener('keydown', (event) => {
        if (event.isComposing) return;
        if (event.key === 'Enter') { event.preventDefault(); name.blur(); }
        if (event.key === 'Escape') { event.preventDefault(); name.value = this.tracks[index].name; name.blur(); }
      });
      const remove = iconButton(document.createElement('button'), 'trash', t('Remove this series', 'この系列を削除')); remove.disabled = this.tracks.length < 2;
      remove.addEventListener('click', () => {
        this.storeActiveTrack(); this.tracks.splice(index, 1); this.activeTrack = Math.min(this.activeTrack, this.tracks.length - 1); this.loadActiveTrack();
        this.measurementTimestamps = []; this.updateMeasurementControls(); this.renderTrackControls(); this.persist(); this.request();
        this.elements.querySelectorAll<HTMLInputElement>('.trajectory-track-name')[this.activeTrack]?.focus();
      });
      header.append(swatch, name, remove); card.appendChild(header);
      card.addEventListener('focusin', () => this.activateTrack(index));
      for (const axis of ['x', 'y', 'z'] as const) {
        const label = document.createElement('label'); label.className = 'trajectory-axis-row';
        const caption = document.createElement('span'); caption.textContent = axis.toUpperCase(); caption.style.color = axisColor(axis);
        const select = document.createElement('select'); select.className = `axis-${axis}`; select.setAttribute('aria-label', `${axis.toUpperCase()} ${t('Signal', 'シグナル')}`);
        select.addEventListener('change', () => {
          this.activateTrack(index); this.setAxisId(axis, select.value || undefined);
          if (axis === 'x') this.clearIncompatibleAxes();
          this.storeActiveTrack(); this.renderAxisOptions(); this.persist(); this.request();
        });
        label.append(caption, select); card.appendChild(label);
      }
      container.appendChild(card);
    });
    this.renderAxisOptions();
  }
  private legendEntries(): { id: string; name: string; color: string; detail: string }[] {
    return this.tracks.flatMap((track, index) => {
      if (!track.xId || !track.yId) return [];
      const detail = (['x', 'y', 'z'] as const).flatMap((axis) => {
        const id = track[`${axis}Id`]; if (!id) return [];
        const definition = this.definitions.get(id);
        return [`${axis.toUpperCase()}: ${definition?.name ?? id}${definition?.unit ? ` (${definition.unit})` : ''}`];
      }).join(' · ');
      return [{ id: track.id, name: track.name, color: trackColor(index), detail }];
    });
  }
  /** The card's title, shown at the start of the legend row so title and legend share one flow. */
  private legendLead?: HTMLElement;
  private inlineTitle = false;
  onCardState?: (state: ViewCardState) => void;
  setLegendLead(lead: HTMLElement): void { this.legendLead = lead; this.renderLegend(); }
  private renderLegend(): void {
    const legend = this.elements.querySelector<HTMLElement>('.trajectory-legend')!;
    const lead = this.legendLead as HTMLInputElement | undefined; const editing = !!lead && document.activeElement === lead; const caret = editing ? [lead!.selectionStart, lead!.selectionEnd] as const : undefined;
    legend.replaceChildren(); this.highlightedTrackId = undefined;
    const entries = this.legendEntries(); const inline = !!lead && entries.length > 0;
    if (inline) legend.append(lead!);
    for (const item of this.legendEntries()) {
      const entry = createLegendEntry(item.name, item.color, (active) => {
        this.highlightedTrackId = active ? item.id : undefined;
        emphasizeSignal(entry, active, item.color); this.draw();
      });
      entry.className = 'trajectory-legend-entry'; entry.dataset.trackId = item.id;
      entry.setAttribute('aria-label', `${item.name} · ${item.detail}`); entry.title = `${item.name}\n${item.detail}`;
      legend.append(entry);
    }
    if (inline !== this.inlineTitle) { this.inlineTitle = inline; this.onCardState?.({ inlineTitle: inline, noData: false }); }
    if (editing && lead!.isConnected) { lead!.focus(); if (caret) lead!.setSelectionRange(caret[0], caret[1]); }
  }
  private paintExportLegend(context: CanvasRenderingContext2D, width: number): number {
    const items = this.legendEntries(); if (!items.length) return 0;
    context.save(); context.font = '12px sans-serif'; context.textAlign = 'left'; context.textBaseline = 'middle';
    let x = 24; let y = 72;
    for (const item of items) {
      let label = item.name;
      while (label.length > 1 && context.measureText(label).width > width - 82) label = label.slice(0, -2) + '…';
      const itemWidth = context.measureText(label).width + 34;
      if (x > 24 && x + itemWidth > width - 24) { x = 24; y += 24; }
      context.fillStyle = item.color; context.fillRect(x, y - 2, 14, 3);
      context.fillStyle = css('--vscode-foreground', '#ddd'); context.fillText(label, x + 20, y); x += itemWidth;
    }
    context.restore(); return y - 60 + 16;
  }
  private is3d(): boolean { return this.tracks.some((track) => !!track.zId); }
  private setCatalog(definitions: readonly SignalDefinition[], groups: readonly SignalGroupDto[]): void { this.definitions = new Map(definitions.map((item) => [item.id, item])); this.groups = groups.filter((group) => !group.remove); this.groupBySignal.clear(); for (const group of this.groups) for (const id of group.signalIds) this.groupBySignal.set(id, group.id); this.renderAxisOptions(); }
  private clearIncompatibleAxes(): void { const group = this.xId ? this.groupBySignal.get(this.xId) : undefined; if (this.yId && this.groupBySignal.get(this.yId) !== group) this.yId = undefined; if (this.zId && this.groupBySignal.get(this.zId) !== group) this.zId = undefined; }
  private renderAxisOptions(): void {
    const measured = this.measured; const hiddenCount = measured ? [...this.definitions.keys()].filter((id) => !measured.has(id)).length : 0;
    const filterToggle = this.elements.querySelector<HTMLButtonElement>('.trajectory-unmeasured')!; filterToggle.hidden = !(this.unmeasuredOption && hiddenCount > 0);
    iconButton(filterToggle, 'filter', this.showUnmeasured
      ? t('Showing every Signal. Click to show only the Signals in this log.', 'すべてのシグナルを表示中。クリックでこのログにあるシグナルだけに絞り込みます。')
      : t('Only Signals in this log', 'このログのシグナルだけ表示'));
    filterToggle.setAttribute('aria-pressed', String(!this.showUnmeasured));
    const query = this.search.value.trim().toLowerCase();
    this.elements.querySelectorAll<HTMLElement>('.trajectory-track-card').forEach((card, index) => {
      const track = this.tracks[index]; const xGroup = track.xId ? this.groupBySignal.get(track.xId) : undefined;
      for (const axis of ['x', 'y', 'z'] as const) {
        const select = card.querySelector<HTMLSelectElement>(`.axis-${axis}`)!; const selected = track[`${axis}Id`]; select.replaceChildren();
        const blank = document.createElement('option'); blank.value = ''; blank.textContent = axis === 'z' ? t('None — 2D', 'なし（2D）') : t('Choose Signal…', 'シグナルを選択…'); select.appendChild(blank);
        for (const group of this.groups) {
          if (axis !== 'x' && xGroup && group.id !== xGroup) continue;
          const options = group.signalIds.map((id) => this.definitions.get(id)).filter((item): item is SignalDefinition => Boolean(item) && (item!.id === selected || this.listed(item!.id)) && (item!.id === selected || !query || `${item!.name} ${item!.unit ?? ''}`.toLowerCase().includes(query)));
          if (!options.length) continue;
          const optgroup = document.createElement('optgroup'); optgroup.label = group.label;
          for (const definition of options) { const option = document.createElement('option'); option.value = definition.id; option.textContent = `${definition.name}${definition.unit ? ` (${definition.unit})` : ''}`; optgroup.appendChild(option); }
          select.appendChild(optgroup);
        }
        if (selected && !Array.from(select.options).some((option) => option.value === selected)) {
          const missing = document.createElement('option'); missing.value = selected; missing.textContent = `${t('Unavailable', '未取得')}: ${this.definitions.get(selected)?.name ?? selected}`; select.appendChild(missing);
        }
        select.value = selected ?? '';
      }
    });
    this.updateMode(); this.renderLegend();
  }
  private axisId(axis: 'x' | 'y' | 'z'): string | undefined { return axis === 'x' ? this.xId : axis === 'y' ? this.yId : this.zId; }
  private setAxisId(axis: 'x' | 'y' | 'z', value: string | undefined): void { if (axis === 'x') this.xId = value; else if (axis === 'y') this.yId = value; else this.zId = value; }
  /**
   * A Clip's path starts and ends where the object was at the Clip's start and end times: on the line between the
   * nearest point outside the Clip and the first/last point in it. These two points are not measured data, so they stay marked `carried`.
   */
  private clipEdges(points: readonly CoreTrajectoryPoint[]): readonly CoreTrajectoryPoint[] {
    const bounds = this.timeline.bounds; const result = [...points];
    const between = (outside: CoreTrajectoryPoint, inside: CoreTrajectoryPoint | undefined, time: number | undefined): CoreTrajectoryPoint | undefined => {
      if (!inside || inside.carried || time === undefined || outside.timestamp === inside.timestamp || (time - outside.timestamp) * (time - inside.timestamp) > 0) return undefined;
      const ratio = (time - outside.timestamp) / (inside.timestamp - outside.timestamp); const mix = (a: number, b: number) => a + (b - a) * ratio;
      return { timestamp: time, x: mix(outside.x, inside.x), y: mix(outside.y, inside.y), ...(outside.z !== undefined && inside.z !== undefined ? { z: mix(outside.z, inside.z) } : {}), carried: true };
    };
    if (result.at(-1)?.carried && result.length > 1) { const edge = between(result.at(-1)!, result.at(-2), bounds?.end); result.pop(); if (edge) result.push(edge); }
    else if (result.length === 1 && result[0].carried) return [];
    if (result[0]?.carried) { const edge = between(result[0], result[1], bounds?.start); result.shift(); if (edge) result.unshift(edge); }
    return result;
  }
  private request(): void { if (!this.visible || !this.tracks.some((track) => track.xId && track.yId)) { this.seriesRequest = ++this.counter; this.series = []; this.analysisPoints = []; this.points = []; this.draw(); return; } this.elements.querySelector('.trajectory-status')!.textContent = t('Loading trajectory…', '軌跡を読み込み中…'); this.storeActiveTrack(); const selectedIds = [...new Set(this.tracks.flatMap((track) => [track.xId, track.yId, track.zId]).filter((id): id is string => !!id))]; this.seriesRequest = ++this.counter; this.post({ type: 'signalSeriesRequest', requestId: this.seriesRequest, selectedIds, maxPoints: 10_000, joined: true }); }
  private rebuildPoints(): void {
    const byId = new Map(this.series.map((item) => [item.definition.id, item.samples])); const axisIds = this.tracks.flatMap((track) => [track.xId, track.yId, track.zId]).filter((id): id is string => Boolean(id));
    this.coordinateDisplayUnit = commonDisplayUnit(axisIds.map((id) => this.definitions.get(id)?.unit));
    const samples = (id: string | undefined) => { const source = id ? byId.get(id) ?? [] : []; const unit = id ? this.definitions.get(id)?.unit : undefined; return this.coordinateDisplayUnit ? source.map((sample) => ({ ...sample, value: convertDisplayUnit(sample.value, unit, this.coordinateDisplayUnit!.unit) })) : source; };
    const tracks = this.tracks.map((track) => ({ id: track.id, points: track.xId && track.yId ? this.clipEdges(buildTrajectoryPoints(samples(track.xId), samples(track.yId), track.zId ? samples(track.zId) : undefined, this.invert, 10_000)).map((point) => ({ ...point, seriesId: track.id })) : [] }));
    this.analysisPoints = tracks.flatMap((track) => track.points).sort((a,b) => a.timestamp - b.timestamp);
    this.points = tracks.flatMap((track) => downsampleExtremes(track.points, 4000, (point) => [point.x, point.y, point.z ?? 0])).sort((a,b) => a.timestamp - b.timestamp);
    this.measurementTimestamps = this.measurementTimestamps.filter((timestamp) => this.points.some((point) => point.timestamp === timestamp));
    if (this.points.length) { this.current = this.timeline.position ?? this.points[0].timestamp; } else this.current = undefined;
    this.updateMode(); this.updateMeasurementControls(); this.draw();
  }
  private updateMode(): void { const is3d = this.is3d(); this.elements.querySelector('.trajectory-mode')!.textContent = is3d ? '3D' : '2D'; (this.elements.querySelector('.trajectory-camera-controls') as HTMLElement).hidden = !is3d; (this.elements.querySelector('.invert-z-label') as HTMLElement).hidden = !is3d; (this.elements.querySelector('.coordinate-system-label') as HTMLElement).hidden = !is3d; (this.elements.querySelector('.equal-aspect-label') as HTMLElement).hidden = is3d; this.canvas.classList.toggle('mode-3d', is3d); this.canvas.title = is3d ? t('Drag to rotate · Shift+drag to pan · Ctrl/Cmd+wheel to zoom', 'ドラッグで回転 · Shift+ドラッグで移動 · Ctrl/Cmd＋ホイールで拡大縮小') : t('Hover a point to inspect it; click to move playback', '点にマウスを合わせて確認 · クリックで再生位置を移動'); }
  private applyControls(): void { for (const axis of ['x', 'y', 'z'] as const) (this.elements.querySelector(`.invert-${axis}`) as HTMLInputElement).checked = this.invert[axis]; (this.elements.querySelector('.equal-aspect') as HTMLInputElement).checked = this.equalAspect; (this.elements.querySelector('.trajectory-connect-gaps') as HTMLInputElement).checked = this.connectGaps; (this.elements.querySelector('.show-grid') as HTMLInputElement).checked = this.showGrid; (this.elements.querySelector('.show-points') as HTMLInputElement).checked = this.showPoints; (this.elements.querySelector('.trajectory-coordinate-system') as HTMLSelectElement).value = this.coordinateSystem; syncChoiceSelect(this.elements.querySelector<HTMLSelectElement>('.trajectory-coordinate-system')!); (this.elements.querySelector('.trail-mode') as HTMLSelectElement).value = this.trail; syncChoiceSelect(this.elements.querySelector<HTMLSelectElement>('.trail-mode')!); (this.elements.querySelector('.trail-seconds') as HTMLInputElement).value = String(this.trailSeconds); (this.elements.querySelector('.trail-seconds-label') as HTMLElement).hidden = this.trail !== 'last-seconds'; }
  private seek(timestamp: number | undefined): void { if (timestamp !== undefined) this.timeline.setPosition(timestamp, this.timelineSource); }
  private draw(): void {
    if (!this.visible) return; const wrap = this.canvas.parentElement!; const width = Math.max(1, wrap.clientWidth); const height = Math.max(1, wrap.clientHeight); const ratio = devicePixelRatio || 1; this.canvas.width = width * ratio; this.canvas.height = height * ratio; this.canvas.style.width = `${width}px`; this.canvas.style.height = `${height}px`; const context = this.canvas.getContext('2d')!; context.scale(ratio, ratio); context.clearRect(0, 0, width, height);
    const saveButton = this.elements.querySelector<HTMLButtonElement>('.save-trajectory-image')!; saveButton.disabled = !this.points.length || this.current === undefined;
    if (!this.points.length || this.current === undefined) { this.projectedPoints = []; this.hoverTimestamp = undefined; this.timeline.set(undefined, this.timelineSource); this.canvas.classList.remove('point-hover'); context.fillStyle = css('--vscode-descriptionForeground', '#888'); context.fillText(this.xId && this.yId ? t('Selected Signals have no exact shared timestamps.', '選択したシグナルに一致する時刻がありません。') : t('Choose synchronized X and Y Signals.', '時刻が同期したXとYのシグナルを選択してください。'), 20, 30); return; }
    const trail = this.timeline.range ? this.analysisPoints : trailAt(this.points, this.current, this.trail === 'last-seconds' ? { type: 'last-seconds', seconds: this.trailSeconds } : { type: this.trail }); this.is3d() ? this.draw3d(context, trail, width, height) : this.draw2d(context, trail, width, height); const point = nearest(this.points, this.current);
    this.elements.querySelector('.trajectory-status')!.textContent = point ? `${fmt(point.timestamp)} s · ${this.coordinateStatus('x', point.x)} · ${this.coordinateStatus('y', point.y)}${point.z === undefined ? '' : ` · ${this.coordinateStatus('z', point.z)}`}` : t('No current point', '現在位置なし');
  }
  private draw2d(context: CanvasRenderingContext2D, points: readonly TrajectoryPoint[], width: number, height: number): void {
    const pad = { left: 72, right: 32, top: 32, bottom: 56 }; const xScale = trajectoryAxisScale(this.points.map((point) => point.x)); const yScale = trajectoryAxisScale(this.points.map((point) => point.y)); const spanX = xScale.maximum - xScale.minimum; const spanY = yScale.maximum - yScale.minimum; const plotW = Math.max(1, width - pad.left - pad.right); const plotH = Math.max(1, height - pad.top - pad.bottom); const sx = plotW / spanX; const sy = plotH / spanY; const scale = this.equalAspect ? Math.min(sx, sy) : 1; const usedW = this.equalAspect ? spanX * scale : plotW; const usedH = this.equalAspect ? spanY * scale : plotH; const left = pad.left + (plotW - usedW) / 2; const top = pad.top + (plotH - usedH) / 2; const px = (value: number) => left + (value - xScale.minimum) * (this.equalAspect ? scale : sx); const py = (value: number) => top + usedH - (value - yScale.minimum) * (this.equalAspect ? scale : sy);
    this.draw2dAxes(context, xScale, yScale, px, py, left, top, usedW, usedH); const projected = points.map((point) => ({ x: px(point.x), y: py(point.y), depth: 0, t: point.timestamp, point })); this.projectedPoints = projected; this.strokePath(context, projected); if (this.showPoints) paintDataPoints(context, this.pointsInRange(projected)); this.paintMeasurement(context); this.paintHover(context, width, height); this.paintTracePosition(context, width, height);
  }
  private draw2dAxes(context: CanvasRenderingContext2D, xScale: AxisScale, yScale: AxisScale, px: (value: number) => number, py: (value: number) => number, left: number, top: number, width: number, height: number): void {
    context.save(); context.font = `10px ${css('--vscode-editor-font-family', 'monospace')}`; context.fillStyle = css('--vscode-descriptionForeground', '#888'); context.strokeStyle = css('--vscode-panel-border', '#555'); context.lineWidth = 1;
    if (this.showGrid) {
      context.globalAlpha = .52; for (const tick of xScale.ticks) { const x = px(tick); context.beginPath(); context.moveTo(x, top); context.lineTo(x, top + height); context.stroke(); } for (const tick of yScale.ticks) { const y = py(tick); context.beginPath(); context.moveTo(left, y); context.lineTo(left + width, y); context.stroke(); } context.globalAlpha = 1;
      context.textAlign = 'center'; for (const tick of xScale.ticks) context.fillText(fmt(trajectoryAxisDisplayValue(tick, this.invert.x)), px(tick), top + height + 18); context.textAlign = 'right'; context.textBaseline = 'middle'; for (const tick of yScale.ticks) context.fillText(fmt(trajectoryAxisDisplayValue(tick, this.invert.y)), left - 8, py(tick));
    }
    const xEndpoints = trajectoryAxisEndpoints(xScale.minimum, xScale.maximum, this.invert.x); const yEndpoints = trajectoryAxisEndpoints(yScale.minimum, yScale.maximum, this.invert.y); drawArrow(context, px(xEndpoints.start), py(0), px(xEndpoints.end), py(0), axisColor('x')); drawArrow(context, px(0), py(yEndpoints.start), px(0), py(yEndpoints.end), axisColor('y')); paintAxisLabel(context, px(xEndpoints.end), py(0), this.axisLabel('x'), axisColor('x'), 'x', width + left, height + top); paintAxisLabel(context, px(0), py(yEndpoints.end), this.axisLabel('y'), axisColor('y'), 'y', width + left, height + top); context.restore();
  }
  private draw3d(context: CanvasRenderingContext2D, points: readonly TrajectoryPoint[], width: number, height: number): void {
    const scales = { x: trajectoryAxisScale(this.points.map((point) => point.x)), y: trajectoryAxisScale(this.points.map((point) => point.y)), z: trajectoryAxisScale(this.points.map((point) => point.z ?? 0)) }; const centers = this.sceneCenters(); const scale = this.sceneScale(width, height);
    // A fitted camera is fitted again to every size it is drawn at: the canvas after a resize, or an exported image.
    const view = this.viewFitted ? this.fitView(this.view, width, height) : this.view; if (!this.exporting) this.view = view;
    const project = (x: number, y: number, z: number): ProjectedPoint => { const value = projectPoint3d({ x: x - centers[0], y: y - centers[1], z: z - centers[2] }, view, this.coordinateSystem); return { x: width / 2 + value.x * scale, y: height / 2 - value.y * scale, depth: value.depth, t: 0 }; };
    this.draw3dAxes(context, scales, project, width, height); const projected = points.map((point) => ({ ...project(point.x, point.y, point.z ?? 0), t: point.timestamp, point })); this.projectedPoints = projected; this.strokePath(context, projected); if (this.showPoints) paintDataPoints(context, this.pointsInRange(projected).sort((left, right) => left.depth - right.depth)); this.paintMeasurement(context); this.paintHover(context, width, height); this.paintTracePosition(context, width, height);
  }
  private draw3dAxes(context: CanvasRenderingContext2D, scales: Record<'x' | 'y' | 'z', AxisScale>, project: (x: number, y: number, z: number) => ProjectedPoint, width: number, height: number): void {
    context.save(); context.font = `10px ${css('--vscode-editor-font-family', 'monospace')}`; const gridColor = css('--vscode-panel-border', '#555');
    if (this.showGrid) {
      context.strokeStyle = gridColor; context.globalAlpha = .48; for (const tick of scales.x.ticks) drawLine(context, project(tick, scales.y.minimum, 0), project(tick, scales.y.maximum, 0)); for (const tick of scales.y.ticks) drawLine(context, project(scales.x.minimum, tick, 0), project(scales.x.maximum, tick, 0)); context.globalAlpha = 1;
    }
    const xEndpoints = trajectoryAxisEndpoints(scales.x.minimum, scales.x.maximum, this.invert.x); const yEndpoints = trajectoryAxisEndpoints(scales.y.minimum, scales.y.maximum, this.invert.y); const zEndpoints = trajectoryAxisEndpoints(scales.z.minimum, scales.z.maximum, this.invert.z); const axes = [
      { axis: 'x' as const, start: project(xEndpoints.start, 0, 0), end: project(xEndpoints.end, 0, 0), ticks: scales.x.ticks.map((value) => ({ value, point: project(value, 0, 0) })) },
      { axis: 'y' as const, start: project(0, yEndpoints.start, 0), end: project(0, yEndpoints.end, 0), ticks: scales.y.ticks.map((value) => ({ value, point: project(0, value, 0) })) },
      { axis: 'z' as const, start: project(0, 0, zEndpoints.start), end: project(0, 0, zEndpoints.end), ticks: scales.z.ticks.map((value) => ({ value, point: project(0, 0, value) })) },
    ];
    for (const axis of axes) { drawArrow(context, axis.start.x, axis.start.y, axis.end.x, axis.end.y, axisColor(axis.axis)); if (this.showGrid) { context.fillStyle = axisColor(axis.axis); context.textAlign = 'left'; for (const tick of axis.ticks) { if (tick.value === 0 && axis.axis !== 'x') continue; context.fillText(fmt(trajectoryAxisDisplayValue(tick.value, this.invert[axis.axis])), tick.point.x + 4, tick.point.y - 4); } } paintAxisLabel(context, axis.end.x, axis.end.y, this.axisLabel(axis.axis), axisColor(axis.axis), axis.axis, width, height); }
    const origin = project(0, 0, 0); context.fillStyle = css('--vscode-foreground', '#ddd'); context.beginPath(); context.arc(origin.x, origin.y, 3, 0, Math.PI * 2); context.fill(); context.restore();
  }
  private axisUnit(axis: 'x' | 'y' | 'z'): string | undefined { return this.coordinateDisplayUnit?.unit ?? this.definitions.get(this.axisId(axis) ?? '')?.unit; }
  private axisLabel(axis: 'x' | 'y' | 'z'): string { const definition = this.definitions.get(this.axisId(axis) ?? ''); const unit = this.axisUnit(axis); return `${axis.toUpperCase()} · ${definition?.name ?? axis.toUpperCase()}${unit ? ` (${unit})` : ''}`; }
  private coordinateStatus(axis: 'x' | 'y' | 'z', value: number): string { const unit = this.axisUnit(axis); return `${axis.toUpperCase()} ${fmt(trajectoryAxisDisplayValue(value, this.invert[axis]))}${unit ? ` ${unit}` : ''}`; }
  /** While a time range is selected, data points outside it are hidden, as the faded path is. */
  private pointsInRange<T extends { readonly t: number }>(points: readonly T[]): T[] {
    const range = this.timeline.range; return range ? points.filter((point) => point.t >= range.start && point.t <= range.end) : [...points];
  }
  private strokePath(context: CanvasRenderingContext2D, points: readonly ProjectedTrajectoryPoint[]): void {
    this.cursorPoints.clear();
    for (const [trackIndex, track] of this.tracks.entries()) {
      const items = points.filter((point) => point.point.seriesId === track.id); const ids = [track.xId, track.yId, track.zId];
      for (let index = 1; index < items.length; index++) {
        if (!this.connectGaps && this.series.filter((series) => ids.includes(series.definition.id)).some((series) => crossesSeriesGap(series.gaps, items[index - 1].t, items[index].t))) continue;
        const range = this.timeline.range;
        const selected = range && items[index - 1].t >= range.start && items[index].t <= range.end;
        context.strokeStyle = trackColor(trackIndex); context.lineWidth = selected || this.highlightedTrackId === track.id ? 3.5 : 1.8; context.globalAlpha = range && !selected ? .2 : 1;
        context.beginPath(); context.moveTo(items[index - 1].x, items[index - 1].y); context.lineTo(items[index].x, items[index].y); context.stroke();
      }
      context.globalAlpha = 1;
      const range = this.timeline.range;
      if (range) { context.fillStyle = trackColor(trackIndex); for (const point of items) if (point.t >= range.start && point.t <= range.end) { context.beginPath(); context.arc(point.x, point.y, 2.5, 0, Math.PI * 2); context.fill(); } }
      // The cursor sits on the last measured point at or before the Trace position, and stays on the final one to the end of the Trace.
      const current = this.current === undefined ? undefined : items.filter((item) => !item.point.carried && item.t <= this.current!).at(-1);
      if (this.timeline.positionVisible && !this.timeline.beforeFirstFrame && current) {
        this.cursorPoints.set(track.id, current.point);
        context.save(); context.strokeStyle = css('--sm-trace-color', '#d18616'); context.fillStyle = css('--vscode-editor-background', '#1e1e1e'); context.lineWidth = 2.5;
        context.beginPath(); context.arc(current.x, current.y, 6, 0, Math.PI * 2); context.fill(); context.stroke(); context.restore();
      }
      const hover = this.hoverTimestamp === undefined || this.hoverTimestamp < (items[0]?.t ?? Infinity) || this.hoverTimestamp > (items.at(-1)?.t ?? -Infinity) ? undefined : nearestProjected(items, this.hoverTimestamp);
      if (hover) dot(context, hover.x, hover.y);
    }
  }
  private updateHover(event: MouseEvent): void { const bounds = this.canvas.getBoundingClientRect(); if (!bounds.width || !bounds.height || !this.projectedPoints.length) return; const x = (event.clientX - bounds.left) * (this.canvas.clientWidth / bounds.width); const y = (event.clientY - bounds.top) * (this.canvas.clientHeight / bounds.height); let closest: ProjectedTrajectoryPoint | undefined; let distance = 18 * 18; for (const point of this.projectedPoints) { const next = (point.x - x) ** 2 + (point.y - y) ** 2; if (next <= distance) { closest = point; distance = next; } } const timestamp = closest?.t; if (timestamp === this.hoverTimestamp) return; this.hoverTimestamp = timestamp; this.timeline.set(timestamp, this.timelineSource); this.canvas.classList.toggle('point-hover', timestamp !== undefined); this.draw(); }
  private paintMeasurement(context: CanvasRenderingContext2D): void { const selected = this.measurementTimestamps.map((timestamp) => this.projectedPoints.find((item) => item.t === timestamp)).filter((item): item is ProjectedTrajectoryPoint => Boolean(item)); if (!selected.length) return; context.save(); if (selected.length === 2) { context.strokeStyle = css('--vscode-charts-orange', '#d18616'); context.lineWidth = 1.2; context.setLineDash([]); context.beginPath(); context.moveTo(selected[0].x, selected[0].y); context.lineTo(selected[1].x, selected[1].y); context.stroke(); context.setLineDash([]); } selected.forEach((point, index) => { const color = index === 0 ? css('--vscode-charts-orange', '#d18616') : css('--vscode-charts-blue', '#75beff'); context.fillStyle = css('--vscode-editor-background', '#1e1e1e'); context.strokeStyle = color; context.lineWidth = 2.5; context.beginPath(); context.arc(point.x, point.y, 7, 0, Math.PI * 2); context.fill(); context.stroke(); context.font = `600 11px ${css('--vscode-font-family', 'sans-serif')}`; context.fillStyle = color; context.textAlign = 'center'; context.textBaseline = 'bottom'; context.fillText(index === 0 ? 'A' : 'B', point.x, point.y - 9); }); context.restore(); }
  private updateMeasurementControls(): void { const toggle = this.elements.querySelector<HTMLButtonElement>('.trajectory-measure-toggle')!; const panel = this.elements.querySelector<HTMLElement>('.trajectory-measurement')!; const value = this.elements.querySelector<HTMLElement>('.trajectory-measurement-value')!; const clear = this.elements.querySelector<HTMLButtonElement>('.trajectory-measure-clear')!; toggle.classList.toggle('primary', this.measurementMode); toggle.setAttribute('aria-pressed', String(this.measurementMode)); this.canvas.classList.toggle('measurement-mode', this.measurementMode); panel.hidden = !this.measurementMode && !this.measurementTimestamps.length; clear.hidden = !this.measurementTimestamps.length; if (!this.measurementTimestamps.length) value.textContent = t('Select point A on the trajectory.', '軌跡上の始点Aを選択してください。'); else if (this.measurementTimestamps.length === 1) value.textContent = `${this.measurementPointText('A', this.measurementTimestamps[0])} · ${t('Select point B.', '終点Bを選択してください。')}`; else value.textContent = this.measurementSummary() ?? '—'; }
  /** "A 1.2 s (X 10 m, Y 2 m)": a measured point's time and coordinates. */
  private measurementPointText(name: 'A' | 'B', timestamp: number): string {
    const point = this.analysisPoints.find((item) => item.seriesId === this.tracks[this.activeTrack].id && item.timestamp === timestamp);
    const coordinates = point ? [this.coordinateStatus('x', point.x), this.coordinateStatus('y', point.y), ...(point.z === undefined ? [] : [this.coordinateStatus('z', point.z)])].join(', ') : '';
    return `${name} ${fmt(timestamp)} s${coordinates ? ` (${coordinates})` : ''}`;
  }
  private measurementSummary(): string | undefined { if (this.measurementTimestamps.length !== 2) return undefined; const measurement = measureTrajectory(this.analysisPoints.filter((point) => point.seriesId === this.tracks[this.activeTrack].id), this.measurementTimestamps[0], this.measurementTimestamps[1]); if (!measurement) return undefined; const parts = [this.measurementPointText('A', measurement.first.timestamp), this.measurementPointText('B', measurement.second.timestamp), `Δt ${fmt(measurement.deltaTime)} s`, `ΔX ${fmt(trajectoryAxisDisplayValue(measurement.deltaX, this.invert.x))}${this.axisUnit('x') ? ` ${this.axisUnit('x')}` : ''}`, `ΔY ${fmt(trajectoryAxisDisplayValue(measurement.deltaY, this.invert.y))}${this.axisUnit('y') ? ` ${this.axisUnit('y')}` : ''}`]; if (measurement.deltaZ !== undefined) parts.push(`ΔZ ${fmt(trajectoryAxisDisplayValue(measurement.deltaZ, this.invert.z))}${this.axisUnit('z') ? ` ${this.axisUnit('z')}` : ''}`); if (this.coordinateDisplayUnit) { const unit = this.coordinateDisplayUnit.unit; const start = Math.min(measurement.first.timestamp, measurement.second.timestamp); const end = Math.max(measurement.first.timestamp, measurement.second.timestamp); const incomplete = !this.connectGaps && this.series.some((item) => crossesSeriesGap(item.gaps, start, end)); parts.push(`${t('Straight', '直線距離')} ${fmt(measurement.straightDistance)} ${unit}`); parts.push(incomplete ? `${t('Path', '軌跡長')} — (${t('contains gaps', '欠損あり')})` : `${t('Path', '軌跡長')} ${fmt(measurement.pathLength)} ${unit}`); if (!incomplete && measurement.averageSpeed !== undefined) parts.push(`${t('Average speed', '平均速度')} ${fmt(measurement.averageSpeed)} ${unit}/s`); } return parts.join(' · '); }
  /**
   * The Trace position in the bottom-right corner (not on exported images): the time, then one row per series with its
   * own X/Y/Z, in aligned columns, so several series can be compared at a glance.
   */
  private paintTracePosition(context: CanvasRenderingContext2D, width: number, height: number): void {
    // Shown only for the Trace cursors actually drawn: the same points, so the box never appears without a cursor.
    if (this.exporting || !this.cursorPoints.size) return;
    const rows = this.tracks.flatMap((track, index) => {
      const point = this.cursorPoints.get(track.id); if (!point) return [];
      const axes = (['x', 'y', 'z'] as const).filter((axis) => point[axis] !== undefined);
      return [{ name: track.name || `${t('Series', '系列')} ${index + 1}`, color: trackColor(index), time: point.timestamp, cells: axes.map((axis) => ({ text: this.coordinateStatus(axis, point[axis]!), color: axisColor(axis) })) }];
    });
    if (!rows.length) return;
    context.save(); context.font = `11px ${css('--vscode-editor-font-family', 'monospace')}`; context.textAlign = 'left'; context.textBaseline = 'middle';
    const gap = 12; const rowHeight = 17; const swatch = 10; const showNames = true;
    const nameWidth = showNames ? Math.max(...rows.map((row) => context.measureText(row.name).width)) + swatch + 6 + gap : 0;
    const columnWidths = [0, 1, 2].map((column) => Math.max(0, ...rows.map((row) => row.cells[column] ? context.measureText(row.cells[column].text).width : 0)));
    const heading = `${fmt(this.current ?? rows[0].time)} s`;
    const contentWidth = Math.max(context.measureText(heading).width, nameWidth + columnWidths.filter((value) => value > 0).reduce((sum, value) => sum + value + gap, -gap));
    const boxWidth = contentWidth + 16; const boxHeight = (rows.length + 1) * rowHeight + 10; const boxX = width - boxWidth - 8; const boxY = height - boxHeight - 8;
    // No box: it hid the path and axis labels behind it. Each text gets a thin outline in the background colour instead, so it stays readable over lines.
    context.lineJoin = 'round'; context.lineWidth = 3; context.strokeStyle = css('--vscode-editor-background', '#1e1e1e');
    const write = (text: string, x: number, y: number, color: string) => { context.strokeText(text, x, y); context.fillStyle = color; context.fillText(text, x, y); };
    write(heading, boxX + 8, boxY + 5 + rowHeight / 2, css('--vscode-foreground', '#ddd'));
    rows.forEach((row, index) => {
      const y = boxY + 5 + rowHeight * (index + 1) + rowHeight / 2; let x = boxX + 8;
      if (showNames) { context.fillStyle = row.color; context.fillRect(x, y - 1.5, swatch, 3); write(row.name, x + swatch + 6, y, css('--vscode-foreground', '#ddd')); x += nameWidth; }
      row.cells.forEach((cell, column) => { write(cell.text, x, y, cell.color); x += columnWidths[column] + gap; });
    });
    context.restore();
  }
  private paintHover(context: CanvasRenderingContext2D, width: number, height: number): void {
    const projected = this.hoverTimestamp === undefined ? undefined : this.projectedPoints.find((item) => item.t === this.hoverTimestamp);
    if (!projected) return; const lines = [
    { text: `${fmt(projected.t)} s`, color: css('--vscode-foreground', '#ddd') },
    { text: this.coordinateStatus('x', projected.point.x), color: axisColor('x') },
    { text: this.coordinateStatus('y', projected.point.y), color: axisColor('y') },
    ...(projected.point.z === undefined ? [] : [{ text: this.coordinateStatus('z', projected.point.z), color: axisColor('z') }]),
  ]; context.save(); context.font = `11px ${css('--vscode-editor-font-family', 'monospace')}`; const boxWidth = Math.max(...lines.map((line) => context.measureText(line.text).width)) + 16; const boxHeight = lines.length * 17 + 10; const desiredX = projected.x + 14 + boxWidth <= width - 6 ? projected.x + 14 : projected.x - boxWidth - 14; const boxX = clamp(desiredX, 6, Math.max(6, width - boxWidth - 6)); const boxY = clamp(projected.y - boxHeight / 2, 6, Math.max(6, height - boxHeight - 6)); context.fillStyle = css('--vscode-editorHoverWidget-background', '#252526'); context.globalAlpha = .94; context.fillRect(boxX, boxY, boxWidth, boxHeight); context.globalAlpha = 1; context.strokeStyle = css('--vscode-editorHoverWidget-border', '#555'); context.strokeRect(boxX, boxY, boxWidth, boxHeight); context.fillStyle = css('--vscode-editorCursor-foreground', '#fff'); context.beginPath(); context.arc(projected.x, projected.y, 5, 0, Math.PI * 2); context.fill(); context.strokeStyle = '#0009'; context.stroke(); context.textAlign = 'left'; context.textBaseline = 'middle'; lines.forEach((line, index) => { context.fillStyle = line.color; context.fillText(line.text, boxX + 8, boxY + 10 + index * 17 + 8.5); }); context.restore(); }
  private saveImage(): void { const image = this.renderImage(); if (image) this.post({ type: 'saveTrajectoryImage', ...withBrandMark(image, css('--vscode-foreground', '#ddd')) }); }
  /** This trajectory as an export image; `heading` is the title written on it. */
  renderImage(heading = 'SigMixa · Trajectory', width = 1600): SheetImage | undefined {
    if (!this.points.length || this.current === undefined) return undefined;
 const canvas = document.createElement('canvas'); canvas.width = width;
    const context = canvas.getContext('2d'); if (!context) return undefined;
    const legendHeight = this.paintExportLegend(context, width); const sceneTop = 60 + legendHeight; const height = Math.max(Math.round(width * .625), sceneTop + 400); const sceneHeight = height - sceneTop;
    canvas.height = height;
    const current = nearest(this.points, this.current); const summary = `${this.is3d() ? '3D' : '2D'}${current ? ` · ${fmt(current.timestamp)} s` : ''}`;
    this.paintExportHeader(context, width, height, summary, heading); this.paintExportLegend(context, width);
    const trail = this.timeline.range ? this.analysisPoints : trailAt(this.points, this.current, this.trail === 'last-seconds' ? { type: 'last-seconds', seconds: this.trailSeconds } : { type: this.trail });
    const savedHover = this.hoverTimestamp; const savedHighlight = this.highlightedTrackId; this.hoverTimestamp = undefined; this.highlightedTrackId = undefined; this.exporting = true;
    // Clipped to the scene: a fitted camera can carry the axis lines past it, over the heading and legend.
    const paintScene = (target: CanvasRenderingContext2D) => { target.save(); target.translate(0, sceneTop); target.beginPath(); target.rect(0, 0, width, sceneHeight); target.clip(); this.is3d() ? this.draw3d(target, trail, width, sceneHeight) : this.draw2d(target, trail, width, sceneHeight); target.restore(); };
    paintScene(context);
    const vector = createSvgCanvas(width, height); this.paintExportHeader(vector.context, width, height, summary, heading); this.paintExportLegend(vector.context, width); paintScene(vector.context);
    this.hoverTimestamp = savedHover; this.highlightedTrackId = savedHighlight; this.exporting = false;
    this.draw(); return { canvas, pngDataUrl: canvas.toDataURL('image/png'), svg: vector.toSvg(), width, height };
  }
  private paintExportHeader(context: CanvasRenderingContext2D, width: number, height: number, summary: string, heading: string): void { context.fillStyle = css('--vscode-editor-background', '#1e1e1e'); context.fillRect(0, 0, width, height); context.fillStyle = css('--vscode-foreground', '#ddd'); context.font = '600 22px sans-serif'; context.fillText(heading, 24, 34); context.font = '12px sans-serif'; context.fillStyle = css('--vscode-descriptionForeground', '#999'); context.fillText(summary, width - context.measureText(summary).width - 24, 32); }
  private persist(): void { this.storeActiveTrack(); this.renderLegend(); this.save({ trajectorySeries: this.tracks, trajectoryXId: this.xId, trajectoryYId: this.yId, trajectoryZId: this.zId, trajectoryInvert: this.invert, trajectoryEqualAspect: this.equalAspect, trajectoryConnectGaps: this.connectGaps, trajectoryShowGrid: this.showGrid, trajectoryShowPoints: this.showPoints, trajectoryTrail: this.trail, trajectoryTrailSeconds: this.trailSeconds, trajectoryView: this.view, trajectoryViewFit: this.viewFitted, trajectoryCoordinateSystem: this.coordinateSystem }); }
}

/** The X/Y/Z camera buttons' name, also used by their context-menu items. */
export function viewAlongLabel(axis: 'x' | 'y' | 'z'): string { const letter = axis.toUpperCase(); return t(`View along ${letter}`, `${letter}軸方向から表示`); }

function nearest(points: readonly TrajectoryPoint[], timestamp: number): TrajectoryPoint | undefined { return points.reduce<TrajectoryPoint | undefined>((best, point) => !best || Math.abs(point.timestamp - timestamp) < Math.abs(best.timestamp - timestamp) ? point : best, undefined); }
function nearestProjected(points: readonly { x: number; y: number; t: number }[], timestamp: number) { return points.reduce<typeof points[number] | undefined>((best, point) => !best || Math.abs(point.t - timestamp) < Math.abs(best.t - timestamp) ? point : best, undefined); }
function dot(context: CanvasRenderingContext2D, x: number, y: number): void { context.fillStyle = css('--vscode-editorCursor-foreground', '#fff'); context.beginPath(); context.arc(x, y, 5, 0, Math.PI * 2); context.fill(); context.strokeStyle = '#0008'; context.stroke(); }
type AxisScale = ReturnType<typeof trajectoryAxisScale>;
interface ProjectedPoint { readonly x: number; readonly y: number; readonly depth: number; readonly t: number; }
interface ProjectedTrajectoryPoint extends ProjectedPoint { readonly point: TrajectoryPoint; }
function axisColor(axis: 'x' | 'y' | 'z'): string { return axis === 'x' ? css('--vscode-charts-red', '#f14c4c') : axis === 'y' ? css('--vscode-charts-green', '#89d185') : css('--vscode-charts-blue', '#75beff'); }
function drawLine(context: CanvasRenderingContext2D, start: { readonly x: number; readonly y: number }, end: { readonly x: number; readonly y: number }): void { context.beginPath(); context.moveTo(start.x, start.y); context.lineTo(end.x, end.y); context.stroke(); }
function drawArrow(context: CanvasRenderingContext2D, startX: number, startY: number, endX: number, endY: number, color: string): void {
  const angle = Math.atan2(endY - startY, endX - startX); context.save(); context.strokeStyle = color; context.fillStyle = color; context.lineWidth = 1.7; context.beginPath(); context.moveTo(startX, startY); context.lineTo(endX, endY); context.stroke(); context.beginPath(); context.moveTo(endX, endY); context.lineTo(endX - Math.cos(angle - Math.PI / 6) * 8, endY - Math.sin(angle - Math.PI / 6) * 8); context.lineTo(endX - Math.cos(angle + Math.PI / 6) * 8, endY - Math.sin(angle + Math.PI / 6) * 8); context.closePath(); context.fill(); context.restore();
}
function paintAxisLabel(context: CanvasRenderingContext2D, x: number, y: number, text: string, color: string, axis: 'x' | 'y' | 'z', width: number, height: number): void {
  context.save(); context.font = `600 11px ${css('--vscode-font-family', 'sans-serif')}`; const boxWidth = context.measureText(text).width + 10; const boxHeight = 18; const desiredX = x + 7; const desiredY = axis === 'y' ? y - boxHeight - 7 : y + 7; const boxX = clamp(desiredX, 4, Math.max(4, width - boxWidth - 4)); const boxY = clamp(desiredY, 4, Math.max(4, height - boxHeight - 4)); context.globalAlpha = .9; context.fillStyle = css('--vscode-editorHoverWidget-background', '#252526'); context.fillRect(boxX, boxY, boxWidth, boxHeight); context.globalAlpha = 1; context.strokeStyle = color; context.strokeRect(boxX, boxY, boxWidth, boxHeight); context.fillStyle = color; context.textAlign = 'left'; context.textBaseline = 'middle'; context.fillText(text, boxX + 5, boxY + boxHeight / 2); context.restore();
}
function paintDataPoints(context: CanvasRenderingContext2D, points: readonly { readonly x: number; readonly y: number }[]): void {
  if (!points.length) return; const step = Math.max(1, Math.ceil(points.length / 600)); context.save(); context.fillStyle = css('--vscode-charts-purple', '#b180d7'); context.globalAlpha = .62; context.beginPath(); for (let index = 0; index < points.length; index += step) { const point = points[index]; context.moveTo(point.x + 2, point.y); context.arc(point.x, point.y, 2, 0, Math.PI * 2); } context.fill(); context.restore();
}
function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }
function fmt(value: number): string { return Number(value.toPrecision(7)).toString(); }
function css(name: string, fallback: string): string { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback; }

function trackColor(index: number): string { return `hsl(${210 + index * 83 % 360} 75% 60%)`; }
