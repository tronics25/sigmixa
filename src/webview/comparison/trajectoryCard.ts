import { createLegendEntry } from '../shared/signalLegend';
import { clearLegend, fitCardTitle, placeCardTitle } from './cardTitle';
import { emphasizeSignal } from '../shared/signalEmphasis';
import { crossesSeriesGap } from '../shared/chartSeries';
import type { ComparisonGraphDefinition } from '../../core/project/comparison';
import type { SignalDefinition } from '../../core/signal/signal';
import { buildTrajectoryPoints, defaultTrajectoryView, projectPoint3d, trailAt, trajectoryAxisDisplayValue, trajectoryAxisScale, type TrajectoryPoint, type TrajectoryViewTransform } from '../../core/trajectory/trajectory';
import type { ComparisonSeriesDto } from '../../extension/comparison/comparisonProtocol';
import type { SignalGroupDto } from '../../extension/editors/rawLogProtocol';
import { chartWheelGesture } from '../shared/chartWheel';
import { t } from '../shared/i18n';
import { iconButton, viewActionGroup } from '../shared/iconButton';
import { bindPressRepeat } from '../shared/pressRepeat';
import { SIGNAL_COLOR_PRESETS } from '../shared/signalSelector';
import { createSvgCanvas } from '../shared/svgCanvas';
import type { SheetImage } from '../shared/imageSheet';
import { withBrandMark } from '../shared/brandMark';
import { buttonContextAction } from '../shared/viewContextAction';
import { bindCardResize, css, dashFor, format, type ComparisonCard, type GraphHost } from './graphCard';

const HEIGHT = 420;
const MIN_HEIGHT = 220;
const PAD = { left: 64, right: 24, top: 20, bottom: 40 };
interface Track { readonly targetId: string; readonly name: string; readonly index: number; readonly anchor: number; readonly points: readonly TrajectoryPoint[] }
interface Projected { readonly x: number; readonly y: number; readonly depth: number; readonly time: number; readonly track: Track }

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
  private readonly axisSelects: Record<'x' | 'y' | 'z', HTMLSelectElement>;
  private readonly buttons: Record<'zoomIn' | 'zoomOut' | 'reset' | 'image' | 'settings' | 'up' | 'copy' | 'trash', HTMLButtonElement>;
  private series = new Map<string, readonly ComparisonSeriesDto[]>();
  private latestRequest = 0;
  private pending = false;
  private view: TrajectoryViewTransform = defaultTrajectoryView();
  private projected: Projected[] = [];
  private definitions: readonly SignalDefinition[] = [];
  private groups: readonly SignalGroupDto[] = [];
  private drawScheduled = false;
  private drag?: { x: number; y: number; pan: boolean; moved: boolean };
  private pixelsPerUnit = 1;
  private highlightedTargetId?: string;
  private legendKey = '';
  private viewCommit?: ReturnType<typeof setTimeout>;

  constructor(private definitionValue: ComparisonGraphDefinition, private readonly host: GraphHost, list: HTMLElement, optionsHost: HTMLElement) {
    this.view = definitionValue.trajectoryView ?? defaultTrajectoryView();
    this.element = document.createElement('section'); this.element.className = 'visualize-card'; this.element.dataset.kind = 'trajectory';
    this.header = document.createElement('header'); this.header.className = 'visualize-card-header'; this.header.tabIndex = 0;
    this.title = document.createElement('input'); this.title.className = 'visualize-card-title'; this.title.value = definitionValue.name;
    this.title.setAttribute('aria-label', t('Graph name', 'グラフ名'));
    const make = (icon: string, label: string, run: () => void) => { const button = iconButton(document.createElement('button'), icon, label); button.type = 'button'; button.addEventListener('click', (event) => { event.stopPropagation(); run(); }); return button; };
    this.buttons = {
      zoomIn: make('zoom-in', t('Zoom in; hold to repeat', '拡大・長押しで連続'), () => undefined),
      zoomOut: make('zoom-out', t('Zoom out; hold to repeat', '縮小・長押しで連続'), () => undefined),
      reset: make('discard', t('Reset view', '表示をリセット'), () => { this.view = defaultTrajectoryView(); this.update({ trajectoryView: this.view }); this.draw(); }),
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
      viewActionGroup(t('Export', 'エクスポート'), this.buttons.image),
      viewActionGroup(t('Graph actions', 'グラフ操作'), this.buttons.settings, this.buttons.up, this.buttons.copy, this.buttons.trash),
    );
    this.header.append(this.title, actions); this.title.addEventListener('input', () => fitCardTitle(this.title));
    this.legend = document.createElement('div'); this.legend.className = 'chart-legend-group chart-legend-items';
    const wrap = document.createElement('div'); wrap.className = 'chart-canvas-wrap';
    this.canvas = document.createElement('canvas'); this.canvas.setAttribute('aria-label', t('Trajectory comparison. Drag to rotate (Shift+drag to move), Ctrl+wheel to zoom.', '軌跡の比較。ドラッグで回転（Shift+ドラッグで移動）、Ctrl+ホイールで拡大縮小。'));
    wrap.appendChild(this.canvas); this.element.append(this.header, this.legend, wrap); list.appendChild(this.element);

    this.options = document.createElement('section'); this.options.className = 'view-specific-options'; this.options.hidden = true;
    const settings = document.createElement('div'); settings.className = 'view-settings'; this.options.appendChild(settings);
    const display = document.createElement('details'); display.className = 'display-settings';
    display.innerHTML = `<summary>${t('Drawing settings', '描画設定')}</summary><div class="settings-row"><label class="chart-option"><input class="equal-aspect" type="checkbox">${t('Equal X/Y scale (2D)', 'X/Yの縮尺を揃える（2D）')}</label></div><div class="settings-row"><label class="chart-option"><input class="show-points" type="checkbox">${t('Show data points', 'データ点を表示')}</label></div>`;
    const aspect = display.querySelector<HTMLInputElement>('.equal-aspect')!; aspect.addEventListener('change', () => { this.update({ equalAspect: aspect.checked }); this.draw(); });
    const points = display.querySelector<HTMLInputElement>('.show-points')!; points.addEventListener('change', () => { this.update({ showPoints: points.checked }); this.draw(); });
    settings.appendChild(display);
    const axes = document.createElement('div'); axes.className = 'trajectory-axes';
    const axisSelect = (axis: 'x' | 'y' | 'z') => {
      const row = document.createElement('label'); row.className = 'trajectory-axis-row';
      const caption = document.createElement('span'); caption.textContent = axis === 'z' ? t('Z (optional)', 'Z（任意）') : axis.toUpperCase();
      const select = document.createElement('select'); select.setAttribute('aria-label', `${axis.toUpperCase()} Signal`);
      select.addEventListener('change', () => { this.update({ axes: { ...this.axes(), [axis]: select.value || undefined } }); this.request(); });
      row.append(caption, select); axes.appendChild(row); return select;
    };
    this.axisSelects = { x: axisSelect('x'), y: axisSelect('y'), z: axisSelect('z') };
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
  private get isConfigured(): boolean { return Boolean(this.axes().x && this.axes().y); }
  private axes() { return this.definitionValue.axes ?? {}; }
  private get is3d(): boolean { return Boolean(this.axes().z); }

  setDefinition(definition: ComparisonGraphDefinition): void {
    const axesChanged = JSON.stringify(definition.axes ?? {}) !== JSON.stringify(this.axes());
    if (JSON.stringify(definition.trajectoryView) !== JSON.stringify(this.definitionValue.trajectoryView)) this.view = definition.trajectoryView ?? defaultTrajectoryView();
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
  revealSignal(): void { this.axisSelects.x.focus(); }

  request(): void {
    const axes = this.axes(); const ids = [axes.x, axes.y, axes.z].filter((id): id is string => Boolean(id));
    this.series.clear(); this.pending = this.isConfigured;
    this.latestRequest = this.isConfigured ? this.host.requestSeries(this.id, ids, 10_000, true) : 0; this.draw();
  }

  receive(requestId: number, seriesByTarget: readonly { readonly targetId: string; readonly series: readonly ComparisonSeriesDto[] }[]): void {
    if (requestId !== this.latestRequest) return;
    this.series = new Map(seriesByTarget.map((item) => [item.targetId, item.series])); this.pending = false; this.draw();
  }

  private update(partial: Partial<ComparisonGraphDefinition>): void {
    const next = { ...this.definitionValue, ...partial }; const axes = next.axes ?? {};
    this.definitionValue = { ...next, signalIds: [axes.x, axes.y, axes.z].filter((id): id is string => Boolean(id)) }; this.host.changed(this);
  }

  private syncSettings(): void {
    const aspect = this.options.querySelector<HTMLInputElement>('.equal-aspect'); if (aspect) aspect.checked = this.definitionValue.equalAspect !== false;
    const points = this.options.querySelector<HTMLInputElement>('.show-points'); if (points) points.checked = this.definitionValue.showPoints === true;
    this.renderAxisOptions();
  }

  /** Numeric Signals, grouped like the Signal list (including "only in A" groups). */
  private renderAxisOptions(): void {
    const byId = new Map(this.definitions.map((definition) => [definition.id, definition]));
    for (const axis of ['x', 'y', 'z'] as const) {
      const select = this.axisSelects[axis]; const value = this.axes()[axis] ?? ''; select.replaceChildren();
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
      if (this.drag.pan) this.view = { ...this.view, panX: this.view.panX + dx / (this.pixelsPerUnit * this.view.zoom), panY: this.view.panY - dy / (this.pixelsPerUnit * this.view.zoom) };
      else { const perPixel = 2 * Math.PI / Math.max(1, this.canvas.clientHeight); this.view = { ...this.view, yaw: this.view.yaw + dx * perPixel, pitch: Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.view.pitch + dy * perPixel)) }; }
      this.scheduleDraw();
    });
    const end = (event: PointerEvent) => { if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId); if (this.drag?.moved) this.update({ trajectoryView: this.view }); this.drag = undefined; };
    this.canvas.addEventListener('pointerup', end); this.canvas.addEventListener('pointercancel', end);
    this.canvas.addEventListener('mouseleave', () => this.host.setHoverTime(undefined));
    this.canvas.addEventListener('wheel', (event) => { const gesture = chartWheelGesture(event, this.canvas.clientHeight); if (gesture.kind !== 'zoom') return; event.preventDefault(); this.zoom(Math.exp(-Math.max(-40, Math.min(40, gesture.delta)) * .01)); }, { passive: false });
  }

  /** Hovering a path shares that moment with every graph in the comparison. */
  private hover(event: MouseEvent): void {
    const rect = this.canvas.getBoundingClientRect(); const x = event.clientX - rect.left; const y = event.clientY - rect.top;
    let best: Projected | undefined; let distance = 12 * 12;
    for (const point of this.projected) { const d = (point.x - x) ** 2 + (point.y - y) ** 2; if (d < distance) { distance = d; best = point; } }
    this.host.setHoverTime(best ? best.time - best.track.anchor : undefined);
  }

  private bindCard(): void {
    let pressOpens = false;
    const opens = (event: MouseEvent) => { const target = event.target as Element; if (target.closest('button, select, input, textarea, label, a')) return false; return !this.isConfigured || target !== this.canvas; };
    this.element.addEventListener('pointerdown', (event) => { pressOpens = event.button === 0 && opens(event); });
    this.element.addEventListener('click', (event) => { const open = pressOpens && opens(event); pressOpens = false; if (!open || window.getSelection()?.toString()) return; this.host.select(this, true); if (!this.isConfigured) this.axisSelects.x.focus(); }, { capture: true });
    this.element.addEventListener('contextmenu', (event) => {
      event.preventDefault(); event.stopPropagation(); const rect = this.header.getBoundingClientRect();
      this.host.showMenu([
        { label: t('Show graph settings', 'グラフ設定を表示'), icon: 'settings-gear', run: () => this.host.select(this, true) }, null,
        buttonContextAction(this.buttons.zoomIn, t('Zoom in', '拡大')), buttonContextAction(this.buttons.zoomOut, t('Zoom out', '縮小')), buttonContextAction(this.buttons.reset), buttonContextAction(this.buttons.image), null,
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
    this.view = { ...this.view, zoom: Math.max(.1, Math.min(200, this.view.zoom * factor)) }; this.draw();
    clearTimeout(this.viewCommit); this.viewCommit = setTimeout(() => this.update({ trajectoryView: this.view }), 200);
  }

  // ---- data & drawing ---------------------------------------------------------------------------

  private tracks(): Track[] {
    const axes = this.axes(); if (!axes.x || !axes.y) return [];
    return this.host.targets().flatMap((target) => {
      const anchor = this.host.anchor(target.id); if (anchor === undefined || this.host.hidden(target.id)) return [];
      const series = this.series.get(target.id) ?? []; const samples = (id?: string) => series.find((item) => item.signalId === id)?.series.samples;
      const xs = samples(axes.x); const ys = samples(axes.y); const zs = axes.z ? samples(axes.z) : undefined;
      if (!xs || !ys || (axes.z && !zs)) return [];
      return [{ targetId: target.id, name: target.name, index: this.host.targetIndex(target.id), anchor, points: buildTrajectoryPoints(xs, ys, zs, this.definitionValue.invert ?? { x: false, y: false, z: false }, 10_000) }];
    });
  }

  private scales(tracks: readonly Track[]) {
    const all = tracks.flatMap((track) => track.points);
    return { x: trajectoryAxisScale(all.map((point) => point.x)), y: trajectoryAxisScale(all.map((point) => point.y)), z: trajectoryAxisScale(all.map((point) => point.z ?? 0)) };
  }

  /** Screen pixels per data unit at zoom 1 (3D: widest axis spans 68% of the shorter side). */
  private scale(width: number, height: number, tracks: readonly Track[]): number {
    const s = this.scales(tracks); const span = Math.max(s.x.maximum - s.x.minimum, s.y.maximum - s.y.minimum, this.is3d ? s.z.maximum - s.z.minimum : 0, 1e-9);
    return Math.max(1, Math.min(width, height)) * .68 / span;
  }

  scheduleDraw(): void { if (this.drawScheduled) return; this.drawScheduled = true; requestAnimationFrame(() => { this.drawScheduled = false; this.draw(); }); }

  draw(): void {
    this.element.classList.toggle('view-unconfigured', !this.isConfigured);
    this.header.removeAttribute('title');
    this.buttons.up.disabled = this.host.isFirst(this);
    const tracks = this.tracks(); this.renderLegend(tracks);
    const width = Math.max(320, this.canvas.parentElement!.clientWidth); const ratio = devicePixelRatio || 1;
    this.canvas.width = width * ratio; this.canvas.height = this.height * ratio; this.canvas.style.width = `${width}px`; this.canvas.style.height = `${this.height}px`;
    const context = this.canvas.getContext('2d')!; context.scale(ratio, ratio);
    this.buttons.image.disabled = !tracks.some((track) => track.points.length);
    this.projected = this.paint(context, width, this.height, 0, tracks, this.host.hoverTime());
  }

  private paint(context: CanvasRenderingContext2D, width: number, height: number, top: number, tracks: readonly Track[], hover: number | undefined): Projected[] {
    context.fillStyle = css('--vscode-editor-background', '#1e1e1e'); context.fillRect(0, top, width, height);
    if (!tracks.some((track) => track.points.length)) {
      context.fillStyle = css('--vscode-descriptionForeground', '#888'); context.font = '12px sans-serif';
      context.fillText(this.pending || this.host.targets().some((target) => target.status === 'loading') ? t('Loading trajectory…', '軌跡を読み込み中…') : this.isConfigured ? t('No trajectory in the selected files/Clips.', '選択したファイル／クリップに軌跡のデータがありません。') : t('Choose X and Y Signals in Graph settings.', 'グラフ設定でX・Yのシグナルを選択してください。'), 20, top + 30);
      return [];
    }
    const s = this.scales(tracks); const byId = new Map(this.definitions.map((definition) => [definition.id, definition])); const axes = this.axes();
    const label = (id?: string) => { const definition = id ? byId.get(id) : undefined; return definition ? `${definition.name}${definition.unit ? ` (${definition.unit})` : ''}` : ''; };
    let project: (point: TrajectoryPoint) => { x: number; y: number; depth: number };
    if (this.is3d) {
      const scale = this.scale(width, height, tracks); if (top === 0) this.pixelsPerUnit = scale; const center = [(s.x.minimum + s.x.maximum) / 2, (s.y.minimum + s.y.maximum) / 2, (s.z.minimum + s.z.maximum) / 2];
      project = (point) => { const value = projectPoint3d({ x: point.x - center[0], y: point.y - center[1], z: (point.z ?? 0) - center[2] }, this.view); return { x: width / 2 + value.x * scale, y: top + height / 2 - value.y * scale, depth: value.depth }; };
      this.paint3dAxes(context, s, project, label(axes.x), label(axes.y), label(axes.z));
    } else {
      const plotW = width - PAD.left - PAD.right; const plotH = height - PAD.top - PAD.bottom; const spanX = s.x.maximum - s.x.minimum || 1; const spanY = s.y.maximum - s.y.minimum || 1;
      let kx = plotW / spanX; let ky = plotH / spanY; if (this.definitionValue.equalAspect !== false) kx = ky = Math.min(kx, ky);
      if (top === 0) this.pixelsPerUnit = Math.min(kx, ky);
      const zoom = this.view.zoom; const cx = (s.x.minimum + s.x.maximum) / 2 - this.view.panX; const cy = (s.y.minimum + s.y.maximum) / 2 - this.view.panY;
      project = (point) => ({ x: PAD.left + plotW / 2 + (point.x - cx) * kx * zoom, y: top + PAD.top + plotH / 2 - (point.y - cy) * ky * zoom, depth: 0 });
      this.paint2dAxes(context, s, project, width, height, top, label(axes.x), label(axes.y));
    }
    const projected: Projected[] = [];
    for (const track of tracks) {
      const color = targetColor(track.index);
      const current = this.definitionValue.trajectoryCurrentTime ?? track.points[0]?.timestamp ?? 0;
      const visible = trailAt(track.points, current, this.definitionValue.trajectoryTrail ?? { type: 'all' });
      const items = visible.map((point) => ({ ...project(point), time: point.timestamp, track }));
      projected.push(...items);
      context.save(); context.strokeStyle = color; context.lineWidth = track.targetId === this.highlightedTargetId ? 3.2 : 1.8; context.setLineDash(dashFor(track.index)); context.beginPath();
      items.forEach((item, index) => {
        const gap = index > 0 && this.definitionValue.connectGaps === false && (this.series.get(track.targetId) ?? []).some((series) => crossesSeriesGap(series.series.gaps, items[index - 1].time, item.time));
        if (index === 0 || gap) context.moveTo(item.x, item.y); else context.lineTo(item.x, item.y);
      }); context.stroke(); context.restore();
      if (this.definitionValue.showPoints) { context.save(); context.fillStyle = color; context.globalAlpha = .55; const step = Math.max(1, Math.ceil(items.length / 600)); for (let index = 0; index < items.length; index += step) { context.beginPath(); context.arc(items[index].x, items[index].y, 1.8, 0, Math.PI * 2); context.fill(); } context.restore(); }
    }
    if (hover !== undefined) for (const track of tracks) {
      const time = track.anchor + hover; let best: TrajectoryPoint | undefined; let gap = Infinity;
      for (const point of track.points) { const d = Math.abs(point.timestamp - time); if (d < gap) { gap = d; best = point; } }
      const first = track.points[0]; const last = track.points[track.points.length - 1];
      if (!best || !first || time < first.timestamp || time > last.timestamp) continue;
      const position = project(best); context.save(); context.strokeStyle = targetColor(track.index); context.fillStyle = css('--vscode-editor-background', '#1e1e1e'); context.lineWidth = 2.5;
      context.beginPath(); context.arc(position.x, position.y, 6, 0, Math.PI * 2); context.fill(); context.stroke(); context.restore();
    }
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

  private paint3dAxes(context: CanvasRenderingContext2D, s: ReturnType<TrajectoryCard['scales']>, project: (point: TrajectoryPoint) => { x: number; y: number }, xLabel: string, yLabel: string, zLabel: string): void {
    const axis = (from: TrajectoryPoint, to: TrajectoryPoint, color: string, text: string) => { const a = project(from); const b = project(to); context.save(); context.strokeStyle = color; context.fillStyle = color; context.globalAlpha = .8; context.beginPath(); context.moveTo(a.x, a.y); context.lineTo(b.x, b.y); context.stroke(); context.font = '600 11px sans-serif'; context.fillText(text, b.x + 4, b.y - 4); context.restore(); };
    if (this.definitionValue.showGrid !== false) {
      context.save(); context.strokeStyle = css('--vscode-panel-border', '#555'); context.globalAlpha = .5;
      const grid = (from: TrajectoryPoint, to: TrajectoryPoint) => { const a = project(from); const b = project(to); context.beginPath(); context.moveTo(a.x, a.y); context.lineTo(b.x, b.y); context.stroke(); };
      for (const x of s.x.ticks) grid({ timestamp: 0, x, y: s.y.minimum, z: 0 }, { timestamp: 0, x, y: s.y.maximum, z: 0 });
      for (const y of s.y.ticks) grid({ timestamp: 0, x: s.x.minimum, y, z: 0 }, { timestamp: 0, x: s.x.maximum, y, z: 0 });
      context.globalAlpha = 1; context.font = '11px sans-serif'; context.fillStyle = css('--vscode-descriptionForeground', '#888');
      for (const dimension of ['x', 'y', 'z'] as const) for (const tick of s[dimension].ticks) {
        const point = project({ timestamp: 0, x: s.x.minimum, y: s.y.minimum, z: s.z.minimum, [dimension]: tick });
        context.fillText(format(trajectoryAxisDisplayValue(tick, this.definitionValue.invert?.[dimension] === true)), point.x + 4, point.y - 4);
      }
      context.restore();
    }
    const origin = { timestamp: 0, x: s.x.minimum, y: s.y.minimum, z: s.z.minimum };
    axis(origin, { ...origin, x: s.x.maximum }, css('--vscode-charts-red', '#f14c4c'), `X: ${xLabel}`);
    axis(origin, { ...origin, y: s.y.maximum }, css('--vscode-charts-green', '#89d185'), `Y: ${yLabel}`);
    axis(origin, { ...origin, z: s.z.maximum }, css('--vscode-charts-blue', '#3794ff'), `Z: ${zLabel}`);
  }

  private renderLegend(tracks: readonly Track[]): void {
    const targets = this.host.targets().filter((item) => item.status === 'ready' && !this.host.hidden(item.id));
    const key = JSON.stringify(targets.map((target) => [target.id, target.name, this.host.targetIndex(target.id), tracks.some((track) => track.targetId === target.id && track.points.length), this.pending, this.isConfigured]));
    // Redraws must keep the focused/hovered button alive.
    if (key === this.legendKey) return;
    this.legendKey = key; this.highlightedTargetId = undefined; clearLegend(this.legend, this.title); placeCardTitle(this.element, this.header, this.legend, this.title, targets.length > 0);
    for (const target of targets) {
      const index = this.host.targetIndex(target.id); const has = tracks.some((track) => track.targetId === target.id && track.points.length);
      const color = targetColor(index);
      const entry = createLegendEntry(target.name, color, (active) => {
        if (active) this.highlightedTargetId = target.id;
        else if (this.highlightedTargetId === target.id) this.highlightedTargetId = undefined;
        emphasizeSignal(entry, active, color); this.scheduleDraw();
      });
      entry.className = 'chart-legend-entry';
      const line = entry.querySelector('i')!;
      line.style.backgroundColor = 'transparent'; line.style.height = '0';
      line.style.borderTop = `3px ${index % 4 === 0 ? 'solid' : index % 4 === 2 ? 'dotted' : 'dashed'} ${color}`;
      if (!has && !this.pending && this.isConfigured) { const warn = document.createElement('span'); warn.className = 'codicon codicon-warning legend-warning'; entry.appendChild(warn); entry.title = t('This file/Clip has no data for the selected X/Y/Z Signals.', 'このファイル／クリップには選択したX/Y/Zのシグナルのデータがありません。'); }
      this.legend.appendChild(entry);
    }
  }

  private saveImage(): void { const image = this.renderImage(); if (!image) return; const marked = withBrandMark(image, css('--vscode-foreground', '#ddd')); this.host.saveImage(marked.pngDataUrl, marked.svg); }
  /** This graph as an export image (also used for the combined sheet). */
  renderImage(heading = `SigMixa · ${this.definitionValue.name}`, width = 1600): SheetImage | undefined {
    const tracks = this.tracks(); if (!tracks.some((track) => track.points.length)) return undefined;
    const height = Math.round(width * .625); const top = 70;
    const paintAll = (context: CanvasRenderingContext2D) => {
      context.fillStyle = css('--vscode-editor-background', '#1e1e1e'); context.fillRect(0, 0, width, height);
      context.fillStyle = css('--vscode-foreground', '#ddd'); context.font = '600 20px sans-serif'; context.fillText(heading, 24, 34);
      let x = 24; context.font = '12px sans-serif';
      for (const track of tracks) { context.save(); context.strokeStyle = targetColor(track.index); context.setLineDash(dashFor(track.index)); context.lineWidth = 2; context.beginPath(); context.moveTo(x, 54); context.lineTo(x + 24, 54); context.stroke(); context.restore(); context.fillStyle = css('--vscode-foreground', '#ddd'); context.fillText(track.name, x + 30, 58); x += 50 + context.measureText(track.name).width; }
      this.paint(context, width, height - top, top, tracks, undefined);
    };
    const png = document.createElement('canvas'); png.width = width; png.height = height; const context = png.getContext('2d'); if (!context) return undefined; paintAll(context);
    const vector = createSvgCanvas(width, height); paintAll(vector.context);
    return { canvas: png, pngDataUrl: png.toDataURL('image/png'), svg: vector.toSvg(), width, height };
  }
}
