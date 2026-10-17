import type { ComparisonGraphDefinition } from '../../core/project/comparison';
import type { SignalDefinition } from '../../core/signal/signal';
import { normalizeValue } from '../../core/timeline/timeline';
import { convertDisplayUnit, preferredDisplayUnit, resolveDisplayUnit } from '../../core/units/displayUnit';
import type { ComparisonSeriesDto, ComparisonTargetStateDto } from '../../extension/comparison/comparisonProtocol';
import type { SignalGroupDto } from '../../extension/editors/rawLogProtocol';
import { layoutTimestampMarker, paintTimestampConnector, paintValueBoxes, type HoverLabelRect, type ValueBox } from '../shared/chartHoverLabels';
import { crossesSeriesGap, displaySeriesRange, interpolatedSeriesSample } from '../shared/chartSeries';
import { chartWheelGesture } from '../shared/chartWheel';
import { enhanceChoiceSelect } from '../shared/choiceGroup';
import { graphDisplayPolicy, partitionActualGraphs } from '../shared/graphDisplayPolicy';
import { t } from '../shared/i18n';
import { iconButton, viewActionGroup } from '../shared/iconButton';
import { MeasuredSamples, measuredValueLabel, nearestMeasuredTimestamp } from '../shared/measuredSamples';
import { bindPressRepeat } from '../shared/pressRepeat';
import { emphasizeSignal } from '../shared/signalEmphasis';
import { createLegendEntry } from '../shared/signalLegend';
import { SignalSelector } from '../shared/signalSelector';
import { clearLegend, fitCardTitle, placeCardTitle } from './cardTitle';
import { drawClipSpans, type ClipSpan } from '../shared/clipSpans';
import type { SharedTimeAxis } from '../../core/timeline/sharedTimeAxis';
import { createSvgCanvas } from '../shared/svgCanvas';
import type { SheetImage } from '../shared/imageSheet';
import { withBrandMark } from '../shared/brandMark';
import { buttonContextAction, type ViewContextAction } from '../shared/viewContextAction';

export const DASH_PATTERNS: readonly number[][] = [[], [8, 4], [2, 3], [10, 3, 2, 3]];
export const dashFor = (index: number): number[] => DASH_PATTERNS[index % DASH_PATTERNS.length];
const PLOT_HEIGHT = 300;
const MIN_PLOT_HEIGHT = 120;
const TOP = 28; const BOTTOM = 30;

export interface TimeRange { readonly start: number; readonly end: number }
interface Entry { readonly target: ComparisonTargetStateDto; readonly targetIndex: number; readonly anchor: number; readonly signalId: string; readonly series: ComparisonSeriesDto['series'] }
interface AxisGroup { readonly key: string; readonly label: string; readonly displayUnit?: string; readonly entries: readonly Entry[] }
interface Marker { readonly id: string; readonly time: number }
type HoverValue = ValueBox;

/** What the page needs from any card in the list, time-series or trajectory. */
export interface ComparisonCard {
  readonly id: string;
  readonly element: HTMLElement;
  readonly options: HTMLElement;
  readonly definition: ComparisonGraphDefinition;
  readonly name: string;
  setDefinition(definition: ComparisonGraphDefinition): void;
  setCatalog(definitions: readonly SignalDefinition[], groups: readonly SignalGroupDto[], measuredIds?: readonly string[]): void;
  request(): void;
  receive(requestId: number, seriesByTarget: readonly { readonly targetId: string; readonly series: readonly ComparisonSeriesDto[] }[]): void;
  draw(): void;
  scheduleDraw(): void;
  setEditing(editing: boolean): void;
  focusHeader(): void;
  dispose(): void;
  highlight(): void;
  markerQueries(): { slot: string; sourceId: string; timestamp: number; signalIds: string[] }[];
  revealSignal(signalId: string): void;
  renderImage(heading?: string, width?: number): SheetImage | undefined;
}

/** What a card needs from the page: shared targets, catalog, colours, hover time and persistence. */
export interface GraphHost {
  /** The time range selected by dragging on any graph; undefined when none. */
  selection(): TimeRange | undefined;
  setSelection(range: TimeRange | undefined): void;
  /** Clips to mark on the graphs, already on the comparison's time axis. Empty except in the report of one log. */
  clipSpans(): readonly ClipSpan[];
  /** The time axis every time-series graph of the comparison shares. */
  time: SharedTimeAxis;
  targets(): readonly ComparisonTargetStateDto[];
  targetIndex(targetId: string): number;
  anchor(targetId: string): number | undefined;
  hidden(targetId: string): boolean;
  definitions(): readonly SignalDefinition[];
  groups(): readonly SignalGroupDto[];
  colors: Map<string, string>;
  color(signalId: string): string;
  measured: MeasuredSamples;
  refreshMeasured(): void;
  hoverTime(): number | undefined;
  setHoverTime(time: number | undefined): void;
  requestSeries(graphId: string, signalIds: readonly string[], maxPoints?: number, joined?: boolean): number;
  changed(graph: ComparisonCard): void;
  colorsChanged(): void;
  select(graph: ComparisonCard, reveal: boolean): void;
  selectedGraph(): ComparisonCard | undefined;
  optionsOpen(): boolean;
  duplicate(graph: ComparisonCard): void;
  move(graph: ComparisonCard, direction: -1 | 1): void;
  remove(graph: ComparisonCard): void;
  insertAfter(graph: ComparisonCard, definitions: readonly ComparisonGraphDefinition[]): void;
  showMenu(actions: readonly (ViewContextAction | null)[], label: string, x: number, y: number, returnFocus: HTMLElement): void;
  saveImage(pngDataUrl: string, svg: string): void;
  highlight(signalId: string | undefined): void;
  highlighted(): string | undefined;
  isFirst(graph: ComparisonCard): boolean;
  isLast(graph: ComparisonCard): boolean;
}

/** One graph in a comparison: one plot, its own Signals, zoom and markers — the Visualize graph card. */
export class GraphCard implements ComparisonCard {
  readonly element: HTMLElement;
  readonly options: HTMLElement;
  private readonly header: HTMLElement;
  private readonly title: HTMLInputElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly legend: HTMLElement;
  private readonly notice: HTMLElement;
  private readonly selector: SignalSelector;
  private readonly selected: Set<string>;
  private readonly buttons: Record<'clear' | 'image' | 'settings' | 'up' | 'copy' | 'trash', HTMLButtonElement>;
  /** The selected time range belongs to the whole comparison, like the time axis: every graph shows it. */
  private get selection(): TimeRange | undefined { return this.host.selection(); }
  private press?: { x: number; time: number };
  private suppressClick = false;
  private series = new Map<string, readonly ComparisonSeriesDto[]>();
  private latestRequest = 0;
  private pending = false;
  private viewRange?: TimeRange;
  private fullRange?: TimeRange;
  private readonly markers = new Map<string, Marker>();
  private markerCounter = 0;
  private plotLeft = 72; private plotWidth = 1;
  private drawScheduled = false;
  private viewportTimer?: number;

  constructor(private definitionValue: ComparisonGraphDefinition, private readonly host: GraphHost, list: HTMLElement, optionsHost: HTMLElement) {
    this.selected = new Set(definitionValue.signalIds);
    this.element = document.createElement('section'); this.element.className = 'visualize-card'; this.element.dataset.kind = 'graph';
    this.header = document.createElement('header'); this.header.className = 'visualize-card-header'; this.header.tabIndex = 0;
    this.title = document.createElement('input'); this.title.className = 'visualize-card-title'; this.title.value = definitionValue.name;
    this.title.setAttribute('aria-label', t('Graph name', 'グラフ名'));
    const actions = document.createElement('div'); actions.className = 'visualize-card-actions';
    const make = (icon: string, label: string, run: () => void) => { const button = iconButton(document.createElement('button'), icon, label); button.type = 'button'; button.addEventListener('click', (event) => { event.stopPropagation(); run(); }); return button; };
    this.buttons = {
      clear: make('clear-all', t('Clear markers', 'マーカーを全解除'), () => { this.markers.clear(); this.draw(); }),
      image: make('export', t('Save image', '画像を保存'), () => this.saveImage()),
      settings: make('settings-gear', t('Show graph settings', 'グラフ設定を表示'), () => this.host.select(this, true)),
      up: make('arrow-up', t('Move graph up', 'グラフを上へ移動'), () => this.host.move(this, -1)),
      copy: make('copy', t('Duplicate graph', 'グラフを複製'), () => this.host.duplicate(this)),
      trash: make('trash', t('Delete graph', 'グラフを削除'), () => this.host.remove(this)),
    };
    actions.append(
      viewActionGroup(t('Analysis', '解析'), this.buttons.clear),
      viewActionGroup(t('Export', 'エクスポート'), this.buttons.image),
      viewActionGroup(t('Graph actions', 'グラフ操作'), this.buttons.settings, this.buttons.up, this.buttons.copy, this.buttons.trash),
    );
    this.header.append(this.title, actions); this.title.addEventListener('input', () => fitCardTitle(this.title));
    this.notice = document.createElement('div'); this.notice.className = 'graph-notice'; this.notice.hidden = true;
    this.legend = document.createElement('div'); this.legend.className = 'chart-legend-group chart-legend-items';
    const wrap = document.createElement('div'); wrap.className = 'chart-canvas-wrap';
    this.canvas = document.createElement('canvas'); this.canvas.setAttribute('aria-label', t('Comparison graph. Click to add a marker.', '比較グラフ。クリックでマーカーを追加。'));
    wrap.appendChild(this.canvas);
    this.element.append(this.header, this.notice, this.legend, wrap); list.appendChild(this.element);

    this.options = document.createElement('section'); this.options.className = 'view-specific-options'; this.options.hidden = true;
    const settings = document.createElement('div'); settings.className = 'view-settings'; this.options.appendChild(settings);
    settings.appendChild(this.displaySettings());
    const selectorHost = document.createElement('div'); settings.appendChild(selectorHost);
    this.selector = new SignalSelector({
      host: selectorHost, selected: this.selected, colors: host.colors,
      onSelectionChange: () => this.selectionChanged(), onColorChange: () => this.host.colorsChanged(), onHighlightChange: (id) => this.host.highlight(id),
    });
    optionsHost.appendChild(this.options);

    this.title.addEventListener('change', () => { const name = this.title.value.trim() || this.definitionValue.name; this.title.value = name; this.update({ name }); });
    this.title.addEventListener('keydown', (event) => { if (event.isComposing) return; if (event.key === 'Enter') { event.preventDefault(); this.title.blur(); } if (event.key === 'Escape') { event.preventDefault(); this.title.value = this.definitionValue.name; this.title.blur(); } });
    this.bindCanvas();
    this.bindCardClicks();
    bindCardResize(this.element, () => this.plotHeight, PLOT_HEIGHT, MIN_PLOT_HEIGHT, (height, done) => { this.definitionValue = { ...this.definitionValue, height }; this.draw(); if (done) this.host.changed(this); });
    new ResizeObserver(() => this.scheduleDraw()).observe(wrap);
  }

  private get plotHeight(): number { return Math.max(MIN_PLOT_HEIGHT, this.definitionValue.height ?? PLOT_HEIGHT); }
  get id(): string { return this.definitionValue.id; }
  get definition(): ComparisonGraphDefinition { return this.definitionValue; }
  get name(): string { return this.definitionValue.name; }
  get isConfigured(): boolean { return this.selected.size > 0; }

  setDefinition(definition: ComparisonGraphDefinition): void {
    const signalsChanged = definition.signalIds.join('\n') !== [...this.selected].join('\n');
    this.definitionValue = definition; this.title.value = definition.name;
    if (signalsChanged) { this.selected.clear(); definition.signalIds.forEach((id) => this.selected.add(id)); this.selector.render(); this.request(); }
    this.syncSettings(); this.draw();
  }

  setCatalog(definitions: readonly SignalDefinition[], groups: readonly SignalGroupDto[], measuredIds?: readonly string[]): void { this.selector.setCatalog(definitions, groups, { measuredIds }); }
  revealSignal(signalId: string): void { this.selector.reveal(signalId); }
  setEditing(editing: boolean): void { this.element.classList.toggle('options-editing', editing); this.options.hidden = !(this.host.selectedGraph() === this); }
  focusHeader(): void { this.header.focus({ preventScroll: true }); }
  dispose(): void { this.host.time.report(this.id, undefined); this.element.remove(); this.options.remove(); }

  /** Asks the extension for this graph's samples in every target. */
  request(): void {
    this.series.clear(); this.pending = this.selected.size > 0;
    this.latestRequest = this.selected.size ? this.host.requestSeries(this.id, [...this.selected]) : 0;
    this.draw();
  }

  receive(requestId: number, seriesByTarget: readonly { readonly targetId: string; readonly series: readonly ComparisonSeriesDto[] }[]): void {
    if (requestId !== this.latestRequest) return;
    this.series = new Map(seriesByTarget.map((item) => [item.targetId, item.series])); this.pending = false;
    this.fullRange = undefined; this.draw();
  }

  private update(partial: Partial<ComparisonGraphDefinition>): void { this.definitionValue = { ...this.definitionValue, ...partial }; this.host.changed(this); }

  private selectionChanged(): void {
    const signalIds = [...this.selected];
    const policy = graphDisplayPolicy(signalIds, this.host.definitions(), this.definitionValue.mode ?? 'raw');
    this.update({ signalIds, ...(policy.requiresNormalization ? { mode: 'normalized' as const } : {}) });
    this.syncSettings(); this.request();
  }

  private displaySettings(): HTMLElement {
    const details = document.createElement('details'); details.className = 'display-settings';
    details.innerHTML = `<summary>${t('Drawing settings', '描画設定')}</summary>
      <div class="settings-row"><div class="choice-group" role="group" aria-label="${t('Display mode', '表示形式')}"><button type="button" class="mode-raw">${t('Actual (converted units)', '実値（単位換算）')}</button><button type="button" class="mode-normalized">${t('Normalized 0–100%', '正規化 0–100%')}</button></div></div>
      <div class="settings-row"><label class="chart-option"><input class="connect-gaps" type="checkbox">${t('Connect gaps', '欠損を補完')}</label></div>
      <div class="settings-row axis-settings"><label class="axis-mode">${t('Y axis', 'Y軸')}<select class="axis-range-mode"><option value="visible">${t('Visible interval', '表示区間')}</option><option value="global">${t('All data', '全データ')}</option></select></label><label class="chart-option"><input class="axis-include-zero" type="checkbox">${t('Include 0', '0を含める')}</label></div>`;
    details.querySelector('.mode-raw')!.addEventListener('click', () => this.switchToActual());
    details.querySelector('.mode-normalized')!.addEventListener('click', () => { this.update({ mode: 'normalized' }); this.syncSettings(); this.draw(); });
    const gaps = details.querySelector<HTMLInputElement>('.connect-gaps')!; gaps.addEventListener('change', () => { this.update({ connectGaps: gaps.checked }); this.draw(); });
    const axis = details.querySelector<HTMLSelectElement>('.axis-range-mode')!; axis.addEventListener('change', () => { this.update({ axisRange: { ...this.axisRange(), mode: axis.value === 'global' ? 'global' : 'visible' } }); this.draw(); });
    enhanceChoiceSelect(axis);
    const zero = details.querySelector<HTMLInputElement>('.axis-include-zero')!; zero.addEventListener('change', () => { this.update({ axisRange: { ...this.axisRange(), includeZero: zero.checked } }); this.draw(); });
    queueMicrotask(() => this.syncSettings());
    return details;
  }

  private axisRange() { return this.definitionValue.axisRange ?? { mode: 'visible' as const }; }
  private get normalized(): boolean { return this.effectiveMode() === 'normalized'; }
  private effectiveMode(): 'raw' | 'normalized' { return graphDisplayPolicy([...this.selected], this.host.definitions(), this.definitionValue.mode ?? 'raw').mode; }
  private get connectGaps(): boolean { return this.definitionValue.connectGaps !== false; }

  private syncSettings(): void {
    const normalized = this.normalized; const requiresSplit = graphDisplayPolicy([...this.selected], this.host.definitions(), 'raw').requiresNormalization;
    const raw = this.options.querySelector<HTMLButtonElement>('.mode-raw'); const norm = this.options.querySelector<HTMLButtonElement>('.mode-normalized');
    if (raw && norm) {
      raw.classList.toggle('primary', !normalized); norm.classList.toggle('primary', normalized); raw.setAttribute('aria-pressed', String(!normalized)); norm.setAttribute('aria-pressed', String(normalized));
      raw.title = requiresSplit ? t('Split into actual-value graphs', '実値のグラフに分割') : '';
    }
    const gaps = this.options.querySelector<HTMLInputElement>('.connect-gaps'); if (gaps) gaps.checked = this.connectGaps;
    const axis = this.options.querySelector<HTMLSelectElement>('.axis-range-mode'); if (axis) axis.value = this.axisRange().mode;
    const zero = this.options.querySelector<HTMLInputElement>('.axis-include-zero'); if (zero) zero.checked = this.axisRange().includeZero === true;
    const axisRow = this.options.querySelector<HTMLElement>('.axis-settings'); if (axisRow) axisRow.hidden = normalized;
    const unitCount = graphDisplayPolicy([...this.selected], this.host.definitions(), 'raw').axisKeys.length;
    this.notice.hidden = !requiresSplit;
    if (requiresSplit) {
      this.notice.replaceChildren(document.createTextNode(t(`${unitCount} unit systems are overlaid on a normalized 0–100% axis.`, `単位系が ${unitCount} つあるため、0–100% の正規化で重ねて表示しています。`)));
      const spacer = document.createElement('span'); spacer.className = 'spacer';
      const split = document.createElement('button'); split.type = 'button'; split.textContent = t('Split into actual-value graphs', '実値のグラフに分割（2単位系ずつ）');
      split.addEventListener('click', (event) => { event.stopPropagation(); this.switchToActual(); });
      this.notice.append(spacer, split);
    }
  }

  /** Beyond two unit systems, actual values need more graphs: keep the first two here and add the rest below. */
  private switchToActual(): void {
    const signalIds = [...this.selected];
    if (!graphDisplayPolicy(signalIds, this.host.definitions(), 'raw').requiresNormalization) { this.update({ mode: 'raw' }); this.syncSettings(); this.draw(); return; }
    const groups = partitionActualGraphs(signalIds, this.host.definitions());
    this.selected.clear(); groups[0].selectedIds.forEach((id) => this.selected.add(id));
    this.update({ signalIds: groups[0].selectedIds, mode: 'raw' }); this.selector.render(); this.syncSettings(); this.request();
    this.host.insertAfter(this, groups.slice(1).map((group, index) => ({ ...structuredClone(this.definitionValue), id: crypto.randomUUID(), name: `${this.definitionValue.name} (${index + 2})`, signalIds: group.selectedIds, mode: 'raw' })));
  }

  contextActions(pointer?: { clientX: number; clientY: number }): (ViewContextAction | null)[] {
    const items: (ViewContextAction | null)[] = [];
    const time = pointer ? this.timeAt(pointer.clientX, pointer.clientY) : undefined;
    if (!this.selection && time !== undefined) items.push({ label: t('Fix marker here', 'ここにマーカーを固定'), icon: 'pin', run: () => this.addMarker(time) });
    if (this.markers.size) items.push(buttonContextAction(this.buttons.clear));
    items.push(buttonContextAction(this.buttons.image));
    return items;
  }

  // ---- interaction ----------------------------------------------------------------------------

  private bindCanvas(): void {
    this.canvas.addEventListener('mousemove', (event) => { const time = this.timeAt(event.clientX, event.clientY); this.host.setHoverTime(time); });
    this.canvas.addEventListener('mouseleave', () => this.host.setHoverTime(undefined));
    // Drag to select a range (like the time-series graph in Visualize); a click clears it, or adds a marker.
    this.canvas.addEventListener('mousedown', (event) => { const time = event.button === 0 ? this.timeAt(event.clientX, event.clientY) : undefined; this.press = time === undefined ? undefined : { x: event.clientX, time }; });
    this.canvas.addEventListener('mousemove', (event) => {
      if (!this.press || Math.abs(event.clientX - this.press.x) <= 6) return;
      const time = this.clampedTime(event.clientX); this.host.setSelection({ start: Math.min(this.press.time, time), end: Math.max(this.press.time, time) }); this.suppressClick = true;
    });
    window.addEventListener('mouseup', () => { this.press = undefined; });
    this.canvas.addEventListener('click', (event) => {
      if (this.suppressClick) { this.suppressClick = false; return; }
      if (this.selection) { this.host.setSelection(undefined); return; }
      const time = this.timeAt(event.clientX, event.clientY); if (time !== undefined) this.addMarker(time);
    });
    this.canvas.addEventListener('wheel', (event) => {
      if (!this.fullRange || !this.viewRange) return;
      const gesture = chartWheelGesture(event, this.canvas.clientWidth); if (gesture.kind === 'scroll' || !gesture.delta) return;
      event.preventDefault(); if (this.viewportTimer !== undefined) window.clearTimeout(this.viewportTimer);
      const center = gesture.kind === 'zoom' ? this.timeAt(event.clientX, event.clientY) : undefined;
      this.viewportTimer = window.setTimeout(() => { this.viewportTimer = undefined; if (gesture.kind === 'zoom') this.zoom(gesture.delta < 0 ? 1 / 1.5 : 1.5, center); else this.pan(gesture.delta < 0 ? -1 : 1); }, 70);
    }, { passive: false });
  }

  /** Outside the plot a click opens this graph's settings; a legend entry also jumps to its Signal. */
  private bindCardClicks(): void {
    let pressOpens = false;
    const opens = (event: MouseEvent) => {
      const target = event.target as Element;
      if (target.closest('.chart-legend-entry')) return true;
      if (target.closest('button, select, input, textarea, label, a')) return false;
      return !this.isConfigured || !this.isPlotTarget(event);
    };
    this.element.addEventListener('pointerdown', (event) => { pressOpens = event.button === 0 && opens(event); });
    this.element.addEventListener('click', (event) => {
      const open = pressOpens && opens(event); pressOpens = false;
      if (!open || window.getSelection()?.toString()) return;
      if (!this.isConfigured) event.stopPropagation();
      this.host.select(this, true);
      const signalId = (event.target as Element).closest<HTMLElement>('.chart-legend-entry')?.dataset.signalId;
      if (signalId) this.revealSignal(signalId);
    }, { capture: true });
    this.element.addEventListener('contextmenu', (event) => {
      event.preventDefault(); event.stopPropagation();
      const rect = this.header.getBoundingClientRect(); const pointer = event.clientX || event.clientY ? { clientX: event.clientX, clientY: event.clientY } : undefined;
      this.host.showMenu([
        { label: t('Show graph settings', 'グラフ設定を表示'), icon: 'settings-gear', run: () => this.host.select(this, true) }, null,
        ...this.contextActions(pointer), null,
        { label: t('Rename graph', 'グラフ名を変更'), icon: 'edit', run: () => { this.title.focus(); this.title.select(); } },
        { label: t('Duplicate graph', 'グラフを複製'), icon: 'copy', run: () => this.host.duplicate(this) },
        { label: t('Move graph up', 'グラフを上へ移動'), icon: 'arrow-up', enabled: !this.host.isFirst(this), run: () => this.host.move(this, -1) },
        { label: t('Move graph down', 'グラフを下へ移動'), icon: 'arrow-down', enabled: !this.host.isLast(this), run: () => this.host.move(this, 1) },
        null, { label: t('Delete graph', 'グラフを削除'), icon: 'trash', run: () => this.host.remove(this) },
      ], this.definitionValue.name, event.clientX || rect.left + 12, event.clientY || rect.bottom, this.header);
    });
    this.header.addEventListener('keydown', (event) => {
      if (event.target === this.header && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); this.host.select(this, true); }
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); this.element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })); }
    });
  }

  private isPlotTarget(event: MouseEvent): boolean { return event.target === this.canvas && this.timeAt(event.clientX, event.clientY) !== undefined; }

  private timeAt(clientX: number, clientY: number): number | undefined {
    if (!this.viewRange) return undefined; const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left; const y = clientY - rect.top;
    if (x < this.plotLeft || x > this.plotLeft + this.plotWidth || y < TOP || y > TOP + this.plotHeight - BOTTOM) return undefined;
    return this.viewRange.start + (x - this.plotLeft) / this.plotWidth * (this.viewRange.end - this.viewRange.start);
  }

  private clampedTime(clientX: number): number {
    const range = this.viewRange!; const x = Math.max(this.plotLeft, Math.min(this.plotLeft + this.plotWidth, clientX - this.canvas.getBoundingClientRect().left));
    return range.start + (x - this.plotLeft) / this.plotWidth * (range.end - range.start);
  }

  private addMarker(time: number): void { const id = `m${++this.markerCounter}`; this.markers.set(id, { id, time }); this.host.setHoverTime(undefined); this.draw(); }

  private zoom(factor: number, center?: number): void { this.host.time.zoom(factor, center); }
  private pan(direction: -1 | 1): void { this.host.time.pan(direction); }

  // ---- data -------------------------------------------------------------------------------------

  private entries(): Entry[] {
    return this.host.targets().flatMap((target) => {
      const anchor = this.host.anchor(target.id); if (anchor === undefined || this.host.hidden(target.id)) return [];
      const targetIndex = this.host.targetIndex(target.id);
      return (this.series.get(target.id) ?? []).filter((item) => this.selected.has(item.signalId)).map((item) => ({ target, targetIndex, anchor, signalId: item.signalId, series: item.series }));
    });
  }

  private axisGroups(entries: readonly Entry[]): AxisGroup[] {
    if (this.normalized) return entries.length ? [{ key: 'normalized', label: '0–100%', entries }] : [];
    const groups = new Map<string, { key: string; order: number; entries: Entry[] }>();
    for (const entry of entries) {
      const unit = entry.series.definition.unit?.trim(); const conversion = resolveDisplayUnit(unit);
      const key = conversion ? `family:${conversion.family}` : unit ? `unit:${unit.toLowerCase()}` : 'empty';
      const group = groups.get(key) ?? { key, order: conversion?.order ?? (unit ? 10_000 : 20_000), entries: [] }; group.entries.push(entry); groups.set(key, group);
    }
    const result = [...groups.values()].map((group) => { const displayUnit = preferredDisplayUnit(group.entries.map((entry) => entry.series.definition.unit)); return { ...group, displayUnit, label: displayUnit ?? t('(no unit)', '(単位なし)') }; }).sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
    // A mapped Signal can bring a third unit system; overlay on one normalized axis rather than hide it.
    return result.length > 2 ? [{ key: 'normalized', label: '0–100%', entries }] : result;
  }

  private value(entry: Entry, value: number, displayUnit: string | undefined, normalized: boolean): number {
    return normalized ? normalizeValue(value, entry.series.globalMinimum ?? value, entry.series.globalMaximum ?? value) : convertDisplayUnit(value, entry.series.definition.unit, displayUnit);
  }

  private valueLabel(entry: Entry, value: number, displayUnit: string | undefined, normalized: boolean): string {
    const unit = (normalized ? entry.series.definition.unit : displayUnit)?.trim(); const actual = normalized ? value : convertDisplayUnit(value, entry.series.definition.unit, displayUnit);
    return `${format(actual)}${unit ? ` ${unit}` : ''}`;
  }

  private availableRange(entries: readonly Entry[]): TimeRange | undefined {
    let start = Infinity; let end = -Infinity;
    for (const entry of entries) for (const sample of entry.series.samples) { if (!Number.isFinite(sample.value)) continue; const time = sample.timestamp - entry.anchor; start = Math.min(start, time); end = Math.max(end, time); }
    if (!Number.isFinite(start)) return undefined; return { start, end: end === start ? start + 1 : end };
  }

  private groupRange(group: AxisGroup, visible: TimeRange, normalized: boolean): { minimum: number; maximum: number } {
    if (normalized) return { minimum: 0, maximum: 100 };
    const axis = this.axisRange();
    if (axis.mode === 'global') return displaySeriesRange(group.entries.map((entry) => entry.series), axis, undefined, group.displayUnit);
    let minimum = Infinity; let maximum = -Infinity;
    for (const entry of group.entries) for (const sample of entry.series.samples) {
      const time = sample.timestamp - entry.anchor; if (time < visible.start || time > visible.end || (sample.quality !== undefined && sample.quality !== 'valid')) continue;
      const value = this.value(entry, sample.value, group.displayUnit, false); if (!Number.isFinite(value)) continue; minimum = Math.min(minimum, value); maximum = Math.max(maximum, value);
    }
    if (!Number.isFinite(minimum)) return displaySeriesRange(group.entries.map((entry) => entry.series), axis, undefined, group.displayUnit);
    if (axis.includeZero) { minimum = Math.min(0, minimum); maximum = Math.max(0, maximum); }
    return { minimum, maximum };
  }

  /** Marker sample queries for this graph; the page merges every graph's into the shared store. */
  markerQueries(): { slot: string; sourceId: string; timestamp: number; signalIds: string[] }[] {
    const entries = this.entries();
    return [...this.markers.values()].flatMap((marker) => {
      const byTarget = new Map<string, { anchor: number; ids: Set<string> }>();
      for (const entry of entries) { const value = byTarget.get(entry.target.id) ?? { anchor: entry.anchor, ids: new Set<string>() }; value.ids.add(entry.signalId); byTarget.set(entry.target.id, value); }
      return [...byTarget].map(([targetId, value]) => ({ slot: `marker:${this.id}:${marker.id}:${targetId}`, sourceId: targetId, timestamp: value.anchor + marker.time, signalIds: [...value.ids] }));
    });
  }

  private markerTime(marker: Marker, entries: readonly Entry[]): number | undefined {
    const slots = [...new Set(entries.map((entry) => entry.target.id))].map((targetId) => `marker:${this.id}:${marker.id}:${targetId}`);
    if (slots.some((slot) => !this.host.measured.ready(slot))) return undefined;
    return nearestMeasuredTimestamp(marker.time, entries.flatMap((entry) => { const sample = this.host.measured.sample(`marker:${this.id}:${marker.id}:${entry.target.id}`, entry.signalId); return sample ? [sample.timestamp - entry.anchor] : []; }));
  }

  // ---- drawing ----------------------------------------------------------------------------------

  scheduleDraw(): void { if (this.drawScheduled) return; this.drawScheduled = true; requestAnimationFrame(() => { this.drawScheduled = false; this.draw(); }); }

  draw(): void {
    const entries = this.entries(); const own = this.availableRange(entries);
    // Time belongs to the whole comparison: this graph says what its own data spans and shows the part every graph shows.
    this.host.time.report(this.id, own);
    const full = own ? this.host.time.full : undefined; this.viewRange = own ? this.host.time.view : undefined; this.fullRange = full;
    this.element.classList.toggle('view-unconfigured', !this.isConfigured);
    this.header.removeAttribute('title');
    this.renderLegend();
    this.buttons.clear.disabled = !this.markers.size; this.buttons.up.disabled = this.host.isFirst(this);
    this.host.refreshMeasured();
    this.buttons.image.disabled = !full || !entries.length || this.host.measured.pendingMarkers();
    const width = Math.max(320, this.canvas.parentElement!.clientWidth); const groups = this.axisGroups(entries);
    const ratio = devicePixelRatio || 1; this.canvas.width = width * ratio; this.canvas.height = this.plotHeight * ratio; this.canvas.style.width = `${width}px`; this.canvas.style.height = `${this.plotHeight}px`;
    const context = this.canvas.getContext('2d')!; context.scale(ratio, ratio);
    context.fillStyle = css('--vscode-editor-background', '#1e1e1e'); context.fillRect(0, 0, width, this.plotHeight);
    if (!full || !this.viewRange || !groups.length) {
      context.fillStyle = css('--vscode-descriptionForeground', '#888'); context.font = '12px sans-serif';
      context.fillText(this.pending || this.host.targets().some((target) => target.status === 'loading') ? t('Loading selected Signals…', '選択したシグナルを読み込んでいます…') : this.selected.size ? t('No comparable samples for the selected Signals.', '選択したシグナルに比較可能なサンプルがありません。') : t('Select Signals in Graph settings.', 'グラフ設定でシグナルを選択してください。'), 20, 30);
      return;
    }
    this.paint(context, width, 0, groups, this.viewRange, true);
  }

  private paint(context: CanvasRenderingContext2D, width: number, top: number, groups: readonly AxisGroup[], range: TimeRange, interactive: boolean): void {
    const normalized = groups.length === 1 && groups[0].key === 'normalized';
    const left = 72; const right = groups.length > 1 ? 72 : 24; const plotW = Math.max(32, width - left - right);
    if (interactive) { this.plotLeft = left; this.plotWidth = plotW; }
    const laneTop = top + TOP; const laneHeight = this.plotHeight - TOP - BOTTOM;
    const xMin = range.start; const xMax = range.end === range.start ? range.start + 1 : range.end; const x = (time: number) => left + (time - xMin) / (xMax - xMin) * plotW;
    const highlighted = interactive ? this.host.highlighted() : undefined;
    context.font = '11px sans-serif'; context.lineWidth = 1; context.strokeStyle = css('--vscode-panel-border', '#777'); context.strokeRect(left, laneTop, plotW, laneHeight);
    for (let tick = 0; tick <= 5; tick++) {
      const value = xMin + (xMax - xMin) * tick / 5; const label = `${format(value)} s`; const px = x(value);
      context.globalAlpha = .48; context.beginPath(); context.moveTo(px, laneTop); context.lineTo(px, laneTop + laneHeight); context.stroke(); context.globalAlpha = 1;
      context.fillStyle = css('--vscode-descriptionForeground', '#888'); context.fillText(label, Math.max(left, Math.min(width - right - context.measureText(label).width, px - context.measureText(label).width / 2)), laneTop + laneHeight + 18);
    }
    drawClipSpans(context, this.host.clipSpans(), { start: xMin, end: xMax }, x, laneTop, laneHeight, css('--vscode-charts-green', '#89d185'));
    context.font = '11px sans-serif'; context.textAlign = 'start'; context.textBaseline = 'alphabetic';
    if (interactive && this.selection) {
      const x0 = Math.max(left, x(this.selection.start)); const x1 = Math.min(left + plotW, x(this.selection.end));
      if (x1 > x0) { context.save(); context.fillStyle = css('--vscode-focusBorder', '#007acc'); context.globalAlpha = .16; context.fillRect(x0, laneTop, x1 - x0, laneHeight); context.globalAlpha = .8; context.strokeStyle = css('--vscode-focusBorder', '#007acc'); context.beginPath(); context.moveTo(x0, laneTop); context.lineTo(x0, laneTop + laneHeight); context.moveTo(x1, laneTop); context.lineTo(x1, laneTop + laneHeight); context.stroke(); context.restore(); }
    }
    const hover = interactive ? this.host.hoverTime() : undefined; const hoverValues: HoverValue[] = []; const markerValues = new Map<string, HoverValue[]>();
    const markers = [...this.markers.values()].flatMap((marker) => { const time = this.markerTime(marker, groups.flatMap((group) => group.entries)); return time === undefined ? [] : [{ ...marker, time }]; }).filter((marker) => marker.time >= xMin && marker.time <= xMax);
    groups.forEach((group, axisIndex) => {
      const raw = this.groupRange(group, range, normalized); let yMin = raw.minimum; let yMax = raw.maximum; if (yMin === yMax) { const pad = Math.abs(yMin) * .05 || 1; yMin -= pad; yMax += pad; }
      const y = (value: number) => laneTop + (1 - (value - yMin) / (yMax - yMin)) * laneHeight; const rightAxis = axisIndex === 1;
      context.save(); context.font = '600 11px sans-serif'; context.textAlign = rightAxis ? 'right' : 'left'; context.fillStyle = css('--vscode-foreground', '#ddd');
      context.fillText(group.label, rightAxis ? left + plotW : left, laneTop - 8); context.restore();
      for (let tick = 0; tick <= 4; tick++) {
        const value = yMax - (yMax - yMin) * tick / 4; const py = y(value);
        if (axisIndex === 0) { context.strokeStyle = css('--vscode-panel-border', '#777'); context.globalAlpha = .55; context.beginPath(); context.moveTo(left, py); context.lineTo(left + plotW, py); context.stroke(); context.globalAlpha = 1; }
        const label = format(value); context.fillStyle = css('--vscode-descriptionForeground', '#888');
        context.fillText(label, rightAxis ? left + plotW + 7 : Math.max(4, left - context.measureText(label).width - 7), Math.min(laneTop + laneHeight - 2, py + 4));
      }
      for (const entry of group.entries) {
        const color = this.host.color(entry.signalId);
        context.save(); context.beginPath(); context.rect(left, laneTop, plotW, laneHeight); context.clip(); context.setLineDash(dashFor(entry.targetIndex)); context.strokeStyle = color;
        context.lineWidth = highlighted === entry.signalId ? 3 : 1.5; context.beginPath(); let started = false; let previous: number | undefined;
        for (const sample of entry.series.samples) {
          const value = this.value(entry, sample.value, group.displayUnit, normalized); const usable = Number.isFinite(value) && (sample.quality === undefined || sample.quality === 'valid');
          if (!usable) { if (!this.connectGaps) started = false; continue; }
          const separated = !this.connectGaps && previous !== undefined && crossesSeriesGap(entry.series.gaps, previous, sample.timestamp);
          const px = x(sample.timestamp - entry.anchor); const py = y(value); started && !separated ? context.lineTo(px, py) : context.moveTo(px, py); started = true; previous = sample.timestamp;
        }
        context.stroke(); context.restore();
        if (hover !== undefined && hover >= xMin && hover <= xMax) {
          const sample = interpolatedSeriesSample(entry.series, entry.anchor + hover, this.connectGaps);
          if (sample) { const py = y(this.value(entry, sample.value, group.displayUnit, normalized)); if (Number.isFinite(py)) hoverValues.push({ y: Math.max(laneTop, Math.min(laneTop + laneHeight, py)), sampleY: py, sampleX: x(hover), text: `${this.valueLabel(entry, sample.value, group.displayUnit, normalized)}${sample.valueLabel ? ` (${sample.valueLabel})` : ''}`, color, lineDash: dashFor(entry.targetIndex), emphasized: highlighted === entry.signalId }); }
        }
        for (const marker of markers) {
          const sample = this.host.measured.sample(`marker:${this.id}:${marker.id}:${entry.target.id}`, entry.signalId); if (!sample) continue;
          const py = y(this.value(entry, sample.value, group.displayUnit, normalized)); const time = sample.timestamp - entry.anchor; if (!Number.isFinite(py)) continue;
          const values = markerValues.get(marker.id) ?? []; values.push({ y: Math.max(laneTop, Math.min(laneTop + laneHeight, py)), sampleY: py, sampleX: x(time), text: measuredValueLabel(`${this.valueLabel(entry, sample.value, group.displayUnit, normalized)}${sample.valueLabel ? ` (${sample.valueLabel})` : ''}`, time, marker.time), color, lineDash: dashFor(entry.targetIndex), emphasized: highlighted === entry.signalId }); markerValues.set(marker.id, values);
        }
      }
    });
    context.setLineDash([]);
    for (const marker of markers) { const px = x(marker.time); context.strokeStyle = css('--vscode-focusBorder', '#007acc'); context.beginPath(); context.moveTo(px, laneTop); context.lineTo(px, laneTop + laneHeight); context.stroke(); }
    const showHover = hover !== undefined && hover >= xMin && hover <= xMax;
    if (showHover) { const px = x(hover!); context.strokeStyle = css('--vscode-editorCursor-foreground', '#fff'); context.beginPath(); context.moveTo(px, laneTop); context.lineTo(px, laneTop + laneHeight); context.stroke(); }
    const occupied: HoverLabelRect[] = [];
    const fixed = markers.map((marker) => { const box = timestampBox(context, x(marker.time), `${marker.time >= 0 ? '+' : ''}${format(marker.time)} s`, left, left + plotW, laneTop + laneHeight, occupied, laneTop); occupied.push(box.rect); return box; });
    const hoverBox = showHover ? timestampBox(context, x(hover!), `${hover! >= 0 ? '+' : ''}${format(hover!)} s`, left, left + plotW, laneTop + laneHeight, occupied, laneTop) : undefined; if (hoverBox) occupied.push(hoverBox.rect);
    for (const marker of markers) paintValues(context, x(marker.time), markerValues.get(marker.id) ?? [], left, left + plotW, laneTop, laneTop + laneHeight, occupied);
    if (hoverBox) paintValues(context, x(hover!), hoverValues, left, left + plotW, laneTop, laneTop + laneHeight, occupied);
    context.save(); context.strokeStyle = css('--vscode-descriptionForeground', '#888'); for (const box of [...fixed, ...(hoverBox ? [hoverBox] : [])]) paintTimestampConnector(context, box.cursorX, box.bottom, box.rect); context.restore();
    for (const box of [...fixed, ...(hoverBox ? [hoverBox] : [])]) paintTimestampBox(context, box, box === hoverBox);
  }

  private renderLegend(): void {
    clearLegend(this.legend, this.title); placeCardTitle(this.element, this.header, this.legend, this.title, this.selected.size > 0);
    const entries = this.entries(); const bySignal = new Map<string, Entry[]>();
    for (const entry of entries) bySignal.set(entry.signalId, [...(bySignal.get(entry.signalId) ?? []), entry]);
    const definitions = new Map(this.host.definitions().map((definition) => [definition.id, definition]));
    const readyTargets = this.host.targets().filter((target) => target.status === 'ready' && !this.host.hidden(target.id));
    for (const signalId of this.selected) {
      const definition = definitions.get(signalId); const color = this.host.color(signalId);
      const entry = createLegendEntry(`${definition?.name ?? signalId}${definition?.unit ? ` (${definition.unit})` : ''}`, color, (active) => this.host.highlight(active ? signalId : undefined));
      entry.className = 'chart-legend-entry'; entry.dataset.signalId = signalId;
      const missing = this.pending ? [] : readyTargets.filter((target) => !(bySignal.get(signalId) ?? []).some((item) => item.target.id === target.id));
      if (missing.length) {
        const warn = document.createElement('span'); warn.className = 'codicon codicon-warning legend-warning'; warn.setAttribute('aria-hidden', 'true'); entry.appendChild(warn);
        entry.title = t(`Not in: ${missing.map((item) => item.name).join(', ')}`, `このシグナルがない対象: ${missing.map((item) => item.name).join('、')}`);
      }
      emphasizeSignal(entry, this.host.highlighted() === signalId, color);
      this.legend.appendChild(entry);
    }
  }

  highlight(): void {
    this.legend.querySelectorAll<HTMLElement>('.chart-legend-entry').forEach((element) => emphasizeSignal(element, element.dataset.signalId === this.host.highlighted(), this.host.color(element.dataset.signalId ?? '')));
    this.options.querySelectorAll<HTMLElement>('.selector-signal').forEach((element) => emphasizeSignal(element, element.dataset.signalId === this.host.highlighted(), this.host.color(element.dataset.signalId ?? '')));
    this.scheduleDraw();
  }

  private saveImage(): void { const image = this.renderImage(); if (!image) return; const marked = withBrandMark(image, css('--vscode-foreground', '#ddd')); this.host.saveImage(marked.pngDataUrl, marked.svg); }
  /** This graph as an export image (also used for the combined sheet). */
  renderImage(heading = `SigMixa · ${this.definitionValue.name}`, width = 1600): SheetImage | undefined {
    const entries = this.entries(); const groups = this.axisGroups(entries); if (!this.viewRange || !groups.length) return undefined;
    const targets = this.host.targets().filter((target) => target.status === 'ready' && !this.host.hidden(target.id));
    const legendRows = 1 + Math.ceil(targets.length / Math.max(1, Math.floor(width / 533))) + Math.ceil(this.selected.size / Math.max(1, Math.floor(width / 400))); const header = 60 + legendRows * 20; const height = header + this.plotHeight + 20;
    const paintAll = (context: CanvasRenderingContext2D) => {
      context.fillStyle = css('--vscode-editor-background', '#1e1e1e'); context.fillRect(0, 0, width, height);
      context.fillStyle = css('--vscode-foreground', '#ddd'); context.font = '600 20px sans-serif'; context.fillText(heading, 24, 34);
      context.font = '12px sans-serif'; context.fillStyle = css('--vscode-descriptionForeground', '#999'); const range = `${format(this.viewRange!.start)}–${format(this.viewRange!.end)} s`; context.fillText(range, width - context.measureText(range).width - 24, 32);
      let y = 60; let x = 24; const definitions = new Map(this.host.definitions().map((definition) => [definition.id, definition]));
      for (const signalId of this.selected) { const label = definitions.get(signalId)?.name ?? signalId; if (x > width - 320) { x = 24; y += 20; } context.fillStyle = this.host.color(signalId); context.fillRect(x, y - 6, 16, 3); context.fillStyle = css('--vscode-foreground', '#ddd'); context.fillText(label, x + 22, y); x += 30 + context.measureText(label).width + 16; }
      y += 20; x = 24;
      for (const target of targets) { const label = `${target.name} (${target.rangeLabel})`; if (x > width - 420) { x = 24; y += 20; } context.save(); context.setLineDash(dashFor(this.host.targetIndex(target.id))); context.strokeStyle = css('--vscode-foreground', '#ddd'); context.lineWidth = 2; context.beginPath(); context.moveTo(x, y - 4); context.lineTo(x + 24, y - 4); context.stroke(); context.restore(); context.fillStyle = css('--vscode-foreground', '#ddd'); context.fillText(label, x + 30, y); x += 40 + context.measureText(label).width + 16; }
      this.paint(context, width, header, groups, this.viewRange!, false);
    };
    const png = document.createElement('canvas'); png.width = width; png.height = height; const context = png.getContext('2d'); if (!context) return undefined; paintAll(context);
    const vector = createSvgCanvas(width, height); paintAll(vector.context);
    return { canvas: png, pngDataUrl: png.toDataURL('image/png'), svg: vector.toSvg(), width, height };
  }
}

interface TimestampBox { readonly cursorX: number; readonly bottom: number; readonly text: string; readonly rect: HoverLabelRect }
function timestampBox(context: CanvasRenderingContext2D, cursorX: number, text: string, left: number, right: number, bottom: number, occupied: readonly HoverLabelRect[], top: number): TimestampBox {
  context.save(); context.font = `600 11px ${css('--vscode-editor-font-family', 'monospace')}`; const width = context.measureText(text).width + 12; context.restore();
  return { cursorX, bottom, text, rect: layoutTimestampMarker(cursorX, width, 18, left, right, bottom, occupied, top) };
}
function paintTimestampBox(context: CanvasRenderingContext2D, box: TimestampBox, hover: boolean): void {
  context.save(); context.font = `600 11px ${css('--vscode-editor-font-family', 'monospace')}`; context.textAlign = 'center'; context.textBaseline = 'middle';
  context.fillStyle = css('--vscode-editorHoverWidget-background', '#252526'); context.fillRect(box.rect.x, box.rect.y, box.rect.width, box.rect.height);
  context.strokeStyle = hover ? css('--vscode-editorCursor-foreground', '#fff') : css('--vscode-focusBorder', '#007acc'); context.strokeRect(box.rect.x, box.rect.y, box.rect.width, box.rect.height);
  context.fillStyle = css('--vscode-editor-foreground', '#ddd'); context.fillText(box.text, box.rect.x + box.rect.width / 2, box.rect.y + box.rect.height / 2); context.restore();
}
function paintValues(context: CanvasRenderingContext2D, cursorX: number, values: readonly HoverValue[], left: number, right: number, top: number, bottom: number, occupied: HoverLabelRect[]): void {
  paintValueBoxes(context, cursorX, values, { left, right, top, bottom }, occupied, { family: css('--vscode-editor-font-family', 'monospace'), background: css('--vscode-editorHoverWidget-background', '#252526') });
}
export function css(name: string, fallback: string): string { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback; }
export function format(value: number): string { return Number(value.toPrecision(7)).toString(); }

/**
 * The resize handle under each card, as in Visualize: drag or ↑/↓ to change the plot height,
 * double-click to restore the default.
 */
export function bindCardResize(card: HTMLElement, current: () => number, defaultHeight: number, minimum: number, apply: (height: number, done: boolean) => void): void {
  const handle = document.createElement('div'); handle.className = 'view-resizer'; handle.tabIndex = 0;
  handle.setAttribute('role', 'separator'); handle.setAttribute('aria-orientation', 'horizontal'); handle.setAttribute('aria-label', t('Graph height', 'グラフの高さ'));

  card.appendChild(handle);
  const set = (height: number, done: boolean) => { const value = Math.max(minimum, Math.round(height)); handle.setAttribute('aria-valuenow', String(value)); apply(value, done); };
  let drag: { y: number; height: number; id: number } | undefined;
  handle.addEventListener('pointerdown', (event) => { if (event.button !== 0) return; event.preventDefault(); event.stopPropagation(); drag = { y: event.clientY, height: current(), id: event.pointerId }; handle.setPointerCapture(event.pointerId); });
  handle.addEventListener('pointermove', (event) => { if (drag && event.pointerId === drag.id) set(drag.height + event.clientY - drag.y, false); });
  const finish = () => { if (!drag) return; drag = undefined; set(current(), true); };
  handle.addEventListener('pointerup', finish); handle.addEventListener('pointercancel', finish); handle.addEventListener('lostpointercapture', finish);
  handle.addEventListener('click', (event) => event.stopPropagation());
  handle.addEventListener('dblclick', () => set(defaultHeight, true));
  handle.addEventListener('keydown', (event) => { if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return; event.preventDefault(); set(current() + (event.key === 'ArrowUp' ? -20 : 20), true); });
}
