import { isTextEditing } from '../shared/keyboard';
import { chartTicks } from '../shared/chartAxes';
import { onTimeDisplayChange, timeLabel, timeRangeLabel, timeTicks } from '../shared/timeDisplay';
import { suggestCsvTimeBase } from '../../core/external/csv';
import type { ExternalCsvTimeBase } from '../../core/project/schema';
import { enhanceChoiceSelect, focusChoiceSelect } from '../shared/choiceGroup';
import { buttonContextAction, type ViewContextAction } from '../shared/viewContextAction';
import { signalAxisKey, graphDisplayPolicy, partitionActualGraphs } from '../shared/graphDisplayPolicy';
import { chartAxisGeometry } from '../shared/chartAxes';
import { ViewElements } from '../shared/viewElements';
import { normalizeValue } from '../../core/timeline/timeline';
import type { SignalDefinition, SignalSample } from '../../core/signal/signal';
import type { ChartAxisRangeSetting, ExternalCsvPreviewDto, LogViewState, SignalSeriesDto, ToExtensionMessage, ToWebviewMessage } from '../../extension/editors/rawLogProtocol';
import { SIGNAL_COLOR_PRESETS, SignalSelector } from '../shared/signalSelector';
import { bindPressRepeat } from '../shared/pressRepeat';
import type { TimelineController } from '../shared/timelineController';
import { dragClipEdge } from '../../core/project/clipRangeEdit';
import { drawClipSpans } from '../shared/clipSpans';
import { t } from '../shared/i18n';
import { convertDisplayUnit, preferredDisplayUnit, resolveDisplayUnit } from '../../core/units/displayUnit';
import { crossesSeriesGap, displaySeriesRange, interpolatedSeriesSample } from '../shared/chartSeries';
import { MeasuredSamples, measuredValueLabel, type MeasuredSampleQuery } from '../shared/measuredSamples';
import { chartWheelGesture } from '../shared/chartWheel';
import { createLegendEntry } from '../shared/signalLegend';
import { emphasizeSignal } from '../shared/signalEmphasis';
import { arrangeSingleChartGroups, findGraphIndexBySignals, type ChartGroupLayout } from '../shared/chartLayout';
import { layoutHoverLabelBoxes, layoutTimestampMarker, timestampGutter, paintTimestampConnector, type HoverLabelRect, paintValueBoxes, type ValueBox } from '../shared/chartHoverLabels';
import { createSvgCanvas } from '../shared/svgCanvas';
import { createLaneToggle, laneIndexAt, laneRuns, lanesHeight, paintChartLanes, placeLaneToggle, type ChartLane } from '../shared/chartLanes';
import type { SheetImage } from '../shared/imageSheet';
import { withBrandMark } from '../shared/brandMark';
import { viewActionGroup, iconButton, secondaryToolbar, type ViewCardState } from '../shared/iconButton';

interface ChartMarker { readonly id: string; readonly timestamp: number; readonly signalIds: readonly string[]; }
interface TimeSeriesGroup { readonly key: string; readonly label: string; readonly displayUnit?: string; readonly items: readonly SignalSeriesDto[]; }
type CanvasHoverValue = ValueBox;
interface CanvasTimestampMarker { readonly cursorX: number; readonly bottom: number; readonly text: string; readonly rect: HoverLabelRect; readonly emphasized?: boolean; readonly color?: string; }

const GRAPH_HEIGHT = 320;

export class TimeSeriesView {
  private readonly elements: ViewElements;
  private readonly lifetime = new AbortController();
  private plotHeight = GRAPH_HEIGHT;
  setPlotHeight(height: number): void { this.plotHeight = Math.max(120, height); this.draw(); }
  private resizeObserver?: ResizeObserver;
  private unsubscribeTimeline?: () => void;
  private unsubscribePosition?: () => void;
  private unsubscribeVisibility?: () => void;
  private unsubscribeRange?: () => void;
  private readonly timelineSource = crypto.randomUUID();
  get isConfigured(): boolean { return this.shown.length > 0; }
  /** The selected Signals the graph can show (those shown checked). */
  private get shown(): string[] { return this.selector.shownSelection(); }
  dispose(): void { this.hide(); this.lifetime.abort(); this.resizeObserver?.disconnect(); this.unsubscribeTimeline?.(); this.unsubscribeTimeDisplay?.(); this.unsubscribePosition?.(); this.unsubscribeVisibility?.(); this.unsubscribeRange?.(); this.unsubscribeViewRange?.(); this.unsubscribeClipRanges?.(); }
  private listenWindow<K extends keyof WindowEventMap>(type: K, listener: (event: WindowEventMap[K]) => void): void { window.addEventListener(type, listener, { signal: this.lifetime.signal }); }
  private readonly selected: Set<string>;
  private readonly colors: Map<string, string>;
  private mode: 'raw' | 'normalized';
  private connectGaps: boolean;
  private axisRange: ChartAxisRangeSetting;
  private groupLayout: string[][] | undefined;
  private catalogDefinitions: readonly SignalDefinition[] = [];
  private highlightedSignalId: string | undefined;
  private paneWidth: number;
  private paneCollapsed: boolean;
  private lanesExpanded: boolean;
  private readonly laneToggle: HTMLButtonElement;
  /** Where the lanes start in the canvas (the graph's bottom), in CSS pixels; undefined while the graph has no lanes. */
  private lanesTop: number | undefined;
  private readonly selector: SignalSelector;
  private readonly canvas: HTMLCanvasElement;
  private readonly pane: HTMLElement;
  private readonly separator: HTMLElement;
  private series: readonly SignalSeriesDto[] = [];
  private fullRange: { start: number; end: number } | undefined;
  private viewRange: { start: number; end: number } | undefined;
  private counter = 200_000;
  private latestSeriesRequest = 0;
  private refreshTimer: number | undefined;
  private viewportRequestTimer: number | undefined;
  private requestedViewRange: { start: number; end: number } | undefined;
  private catalogRequested = false;
  private latestCatalogRequest = 0;
  private visible = false;
  private cursorTimestamp: number | undefined;
  private hoverGraphIndex: number | undefined;
  private hoverDrawScheduled = false;
  private selectionAnchor: number | undefined;
  private selectionAnchorClientX: number | undefined;
  private selectionGraphIndex: number | undefined;
  private rangeSignalIds: readonly string[] = [];
  private activeRangeEdge: 'start' | 'end' | undefined;
  private rangeDragged = false;
  private suppressNextClick = false;
  private selectedRange: { start: number; end: number } | undefined;
  private readonly markers = new Map<string, ChartMarker>();
  private readonly measured: MeasuredSamples;
  private legendHeights: readonly number[] = [];
  private axisGutters: readonly number[] = [];
  private markerCounter = 0;
  private seriesPending = false;
  private latestRangeRequest = 0;
  private rangePending = false;
  private unsubscribeViewRange?: () => void;
  private unsubscribeClipRanges?: () => void;
  private unsubscribeTimeDisplay?: () => void;
  /** Where each Clip's span marker was last drawn, in canvas CSS pixels. */
  private clipMarkers: { id: string; name: string; left: number; right: number; top: number; bottom: number; start: number; end: number; startsHere: boolean; endsHere: boolean }[] = [];
  /** An edge of a Clip being dragged to a new time. The Clips as they were are kept, to put back on Escape. */
  private clipEdit: { id: string; name: string; edge: 'start' | 'end'; range: { start: number; end: number }; original: NonNullable<TimelineController['clipRanges']>; anchorX: number; moved: boolean } | undefined;
  /** The start or end bar of a Clip's span marker under the pointer: the handle that changes the Clip's range. */
  private clipEdgeAt(event: MouseEvent): { marker: TimeSeriesView['clipMarkers'][number]; edge: 'start' | 'end' } | undefined {
    if (event.target !== this.canvas) return undefined; const rect = this.canvas.getBoundingClientRect(); const px = event.clientX - rect.left; const py = event.clientY - rect.top;
    for (const marker of this.clipMarkers) {
      if (py < marker.top || py > marker.bottom) continue;
      // Narrow spans keep both handles reachable: each edge owns at most a third of the span, plus the same outside it.
      const reach = Math.min(5, Math.max(2, (marker.right - marker.left) / 3));
      if (marker.startsHere && px >= marker.left - 5 && px <= marker.left + reach) return { marker, edge: 'start' };
      if (marker.endsHere && px >= marker.right - reach && px <= marker.right + 5) return { marker, edge: 'end' };
    }
    return undefined;
  }
  private beginClipEdit(event: MouseEvent, hit: { marker: TimeSeriesView['clipMarkers'][number]; edge: 'start' | 'end' }): void {
    if (event.button !== 0 || !this.timeline) return;
    this.clipEdit = { id: hit.marker.id, name: hit.marker.name, edge: hit.edge, range: { start: hit.marker.start, end: hit.marker.end }, original: this.timeline.clipRanges, anchorX: event.clientX, moved: false };
    event.preventDefault(); event.stopPropagation();
  }
  private updateClipEdit(event: MouseEvent): void {
    const edit = this.clipEdit; if (!edit || !this.viewRange || !this.timeline) return;
    if (!edit.moved) { if (Math.abs(event.clientX - edit.anchorX) <= 3) return; edit.moved = true; }
    const rect = this.canvas.getBoundingClientRect(); const { left, plotWidth: width } = this.axisGeometry(rect.width); if (!(width > 0)) return;
    const span = this.viewRange.end - this.viewRange.start; const time = this.viewRange.start + Math.max(0, Math.min(1, (event.clientX - rect.left - left) / width)) * span;
    const base = edit.original.find((clip) => clip.id === edit.id); if (!base) return;
    // The edge follows the pointer inside the shown span, never past the other edge: a Clip stays at least four pixels long.
    edit.range = dragClipEdge({ start: base.start, end: base.end }, edit.edge, time, this.fullRange ?? this.viewRange, span / width * 4);
    this.timeline.setClipRanges(edit.original.map((clip) => clip.id === edit.id ? { ...clip, ...edit.range } : clip));
    this.cursorTimestamp = edit.range[edit.edge]; this.timeline.set(this.cursorTimestamp, this.timelineSource); this.scheduleInteractionDraw();
  }
  private endClipEdit(event: MouseEvent | undefined): void {
    const edit = this.clipEdit; if (!edit) return; this.clipEdit = undefined; this.canvas.style.cursor = '';
    // A press without a drag changes nothing. Escape (no event) puts the Clips back as they were.
    if (!event || !edit.moved) { if (edit.moved) this.timeline?.setClipRanges(edit.original); return; }
    this.suppressNextClick = event.target === this.canvas;
    this.post({ type: 'updateClipRange', clipId: edit.id, startTimestamp: edit.range.start, endTimestamp: edit.range.end });
  }
  private clipMarkerAt(event: MouseEvent): { id: string; name: string } | undefined {
    if (event.target !== this.canvas) return undefined; const rect = this.canvas.getBoundingClientRect(); const px = event.clientX - rect.left; const py = event.clientY - rect.top;
    return this.clipMarkers.find((marker) => px >= marker.left && px <= marker.right && py >= marker.top && py <= marker.bottom);
  }
  /** The card's title, shown at the start of the legend row so title and legend share one flow. */
  private legendLead?: HTMLElement;
  private cardState: ViewCardState = { inlineTitle: false, noData: false };
  /** Set by the card that holds this view. */
  onCardState?: (state: ViewCardState) => void;
  setLegendLead(lead: HTMLElement): void { this.legendLead = lead; }
  /** No selected Signal has a single sample in this log, so there is nothing a graph could show. */
  private get noData(): boolean { return this.shown.length > 0 && !this.seriesPending && !!this.fullRangeKnown && this.series.every((item) => item.globalMinimum === undefined && !item.samples.length); }
  private fullRangeKnown = false;
  private reportCardState(inlineTitle: boolean): void {
    const next = { inlineTitle, noData: this.noData }; if (next.inlineTitle === this.cardState.inlineTitle && next.noData === this.cardState.noData) return;
    this.cardState = next; this.onCardState?.(next);
  }
  private readonly status: HTMLElement;
  private readonly saveImageButton: HTMLButtonElement;
  private pendingImport: (ExternalCsvPreviewDto & { timestampColumn: string; timestampUnit: 'seconds' | 'milliseconds' | 'microseconds'; timeBase: ExternalCsvTimeBase; timeBaseChosen: boolean; selectedColumns: Set<string>; units: Map<string, string> }) | undefined;

  constructor(
    private readonly host: HTMLElement,
    initial: LogViewState | undefined,
    private readonly post: (message: ToExtensionMessage) => void,
    private readonly save: (partial: Partial<LogViewState>) => void,
    private readonly timeline?: TimelineController,
    private readonly optionsHost?: HTMLElement,
    private readonly actionsHost?: HTMLElement,
    private readonly insertActualViews?: (settings: Partial<LogViewState>[]) => void
  ) {
    this.elements = new ViewElements(host, optionsHost, actionsHost);
    this.selectedRange = this.timeline?.range;
    this.unsubscribeClipRanges = this.timeline?.subscribeClipRanges(() => { if (this.visible) this.draw(false); });
    this.unsubscribeTimeDisplay = onTimeDisplayChange(() => { const range = this.selectedRange; if (range) this.elements.querySelector('.clip-range')!.textContent = `${timeRangeLabel(range.start, range.end, formatSeconds)} · ${formatNumber(range.end - range.start)} s`; this.updateZoomControls(); if (this.visible) this.draw(false); });
    this.unsubscribeViewRange = this.timeline?.subscribeViewRange((_range, source) => { if (source !== this.timelineSource && this.shown.length) this.requestSeries(this.fullRange); });
    this.unsubscribeRange = this.timeline?.subscribeRange((range, source) => { if (source === this.timelineSource) return; if (!range) { this.latestRangeRequest = ++this.counter; this.rangePending = false; } this.selectedRange = range; this.updateRangeControls(); this.draw(false); });
    this.measured = new MeasuredSamples((requestId, query) => this.post({ type: 'measuredSignalsRequest', requestId, selectedIds: query.signalIds, timestamp: query.timestamp }), () => this.scheduleInteractionDraw());
    this.selected = new Set(initial?.chartSelectedIds ?? []);
    this.colors = new Map(Object.entries(initial?.chartColors ?? {}));
    this.mode = initial?.chartMode ?? 'raw'; this.connectGaps = initial?.chartConnectGaps !== false; this.axisRange = initialAxisRange(initial); this.groupLayout = normalizeChartGroupLayout(initial?.chartGroupLayout); this.paneWidth = initial?.chartPaneWidth ?? 250; this.paneCollapsed = initial?.chartPaneCollapsed ?? false; this.lanesExpanded = initial?.chartLanesExpanded === true;
    host.innerHTML = `<div class="chart-layout"><aside class="signal-pane chart-pane"><div class="chart-source-actions"><button class="import-external-csv">+ ${t('External CSV…', '外部CSV…')}</button></div><div class="external-import-host"></div><div class="chart-selector"></div></aside><div class="pane-separator"></div><section class="signal-main chart-main"><div class="view-toolbar"><button class="pane-toggle">${t('Signals', 'シグナル')}</button><div class="segmented choice-group" role="group" aria-label="${t('Display mode', '表示形式')}"><button class="mode-raw">${t('Actual (converted units)', '実値（単位換算）')}</button><button class="mode-normalized">${t('Normalized 0–100%', '正規化 0–100%')}</button></div><label class="chart-option"><input class="connect-gaps" type="checkbox">${t('Connect gaps', '欠損区間を接続')}</label><span class="chart-axis-global"><label class="chart-axis-mode">${t('Y axis', 'Y軸')}<select class="axis-range-mode" aria-label="${t('Y-axis range', 'Y軸範囲')}"><option value="visible">${t('Visible interval', '表示区間')}</option><option value="global">${t('All data', '全データ')}</option></select></label><label class="chart-option"><input class="axis-include-zero" type="checkbox">${t('Include 0', '0を含める')}</label></span><button class="save-chart-image">${t('Save Image…', '画像を保存…')}</button><span class="spacer"></span><span class="chart-status muted">${t('Select Signals', 'シグナルを選択')}</span><button class="analysis-cancel" hidden>${t('Cancel analysis', '解析を中止')}</button></div><div class="view-toolbar chart-navigation"><div class="segmented"><button class="zoom-out">−</button><button class="zoom-in">＋</button></div><button class="zoom-reset" disabled>${t('Reset Zoom', 'ズームをリセット')}</button><span class="view-range muted"></span><span class="spacer"></span><button class="chart-marker-clear" disabled>${t('Clear Markers', 'マーカーを全解除')}</button></div><div class="view-toolbar range-controls" hidden><strong>${t('Selected range', '選択範囲')}</strong><span class="clip-range muted"></span><span class="spacer"></span><span class="range-edge"><span class="clip-edge-label">${t('Start', '開始')}</span><span class="segmented"><button class="clip-start-prev" title="${t('Previous CAN Timestamp', '前のCANタイムスタンプ')}">◀</button><button class="clip-start-next" title="${t('Next CAN Timestamp', '次のCANタイムスタンプ')}">▶</button></span></span><span class="range-edge"><span class="clip-edge-label">${t('End', '終了')}</span><span class="segmented"><button class="clip-end-prev" title="${t('Previous CAN Timestamp', '前のCANタイムスタンプ')}">◀</button><button class="clip-end-next" title="${t('Next CAN Timestamp', '次のCANタイムスタンプ')}">▶</button></span></span><div class="range-actions segmented"><button class="range-zoom primary">${t('Zoom to Range', '選択範囲を拡大')}</button><button class="clip-create">${t('Create Clip', 'クリップ作成')}</button></div><button class="clip-clear" title="${t('Clear selected range', '選択範囲を解除')}" aria-label="${t('Clear selected range', '選択範囲を解除')}">×</button></div><div class="chart-canvas-wrap"><canvas aria-label="${t('Time-series graph. Click to add a marker; drag to select a range.', '時系列グラフ。クリックでマーカー追加、ドラッグで範囲選択。')}"></canvas><div class="chart-legend"></div><div class="chart-markers"></div></div></section></div>`;
    this.canvas = this.elements.querySelector('canvas')!; this.pane = this.elements.querySelector('.chart-pane')!; this.separator = this.elements.querySelector('.pane-separator')!; this.status = this.elements.querySelector('.chart-status')!; this.saveImageButton = this.elements.querySelector('.save-chart-image')!;
    const mainToolbar = this.elements.querySelector<HTMLElement>('.chart-main>.view-toolbar')!; const paneToggle = iconButton(this.elements.querySelector<HTMLButtonElement>('.pane-toggle')!, 'layout-sidebar-left', t('Toggle Signal selection', 'シグナル選択を表示／非表示')); iconButton(this.saveImageButton, 'export', t('Save image', '画像を保存')); const secondary = secondaryToolbar(paneToggle, this.saveImageButton); secondary.setAttribute('aria-label', t('Secondary actions', '補助操作')); mainToolbar.appendChild(secondary);
    this.laneToggle = createLaneToggle(() => { this.lanesExpanded = !this.lanesExpanded; this.persist(); this.draw(false); });
    this.elements.querySelector('.chart-canvas-wrap')!.appendChild(this.laneToggle);
    this.selector = new SignalSelector({
      host: this.elements.querySelector('.chart-selector')!, selected: this.selected, colors: this.colors,
      grouping: initial?.chartSignalGrouping, onGroupingChange: () => this.persist(),
      onSelectionChange: () => this.selectionChanged(), onColorChange: () => { this.persist(); this.draw(); },
      onRemoveSignal: (definition, group) => this.removeExternalSignal(definition, group),
      onHighlightChange: (id) => this.highlightSignal(id),
    });
    this.elements.querySelector('.pane-toggle')!.addEventListener('click', () => { this.paneCollapsed = !this.paneCollapsed; this.applyPane(); this.persist(); });
    this.elements.querySelector('.mode-raw')!.addEventListener('click', () => this.switchToActual());
    this.elements.querySelector('.mode-normalized')!.addEventListener('click', () => { this.mode = 'normalized'; this.persist(); this.updateModeButtons(); this.draw(); });
    const connectGaps = this.elements.querySelector<HTMLInputElement>('.connect-gaps')!; connectGaps.checked = this.connectGaps; connectGaps.addEventListener('change', () => { this.connectGaps = connectGaps.checked; this.persist(); this.draw(); });
    const axisMode = this.elements.querySelector<HTMLSelectElement>('.axis-range-mode')!; axisMode.value = this.axisRange.mode === 'global' ? 'global' : 'visible'; axisMode.addEventListener('change', () => { this.axisRange = { ...this.axisRange, mode: axisMode.value as 'visible' | 'global' }; this.persist(); this.draw(); });
    enhanceChoiceSelect(axisMode);
    const includeZero = this.elements.querySelector<HTMLInputElement>('.axis-include-zero')!; includeZero.checked = this.axisRange.includeZero === true; includeZero.addEventListener('change', () => { this.axisRange = { ...this.axisRange, includeZero: includeZero.checked }; this.persist(); this.draw(); });
    this.saveImageButton.addEventListener('click', () => this.saveImage());
    for (const [selector, label, action] of [['.zoom-in', t('Zoom in; hold to repeat', '拡大・長押しで連続'), () => this.zoom(1 / 1.5)], ['.zoom-out', t('Zoom out; hold to repeat', '縮小・長押しで連続'), () => this.zoom(1.5)]] as const) { const button = this.elements.querySelector<HTMLButtonElement>(selector)!; iconButton(button, selector === '.zoom-in' ? 'zoom-in' : 'zoom-out', label); bindPressRepeat(button, action, { intervalMs: 180 }); }
    const zoomReset = this.elements.querySelector<HTMLButtonElement>('.zoom-reset')!; iconButton(zoomReset, 'discard', t('Reset zoom', 'ズームをリセット')); this.elements.querySelector('.chart-navigation .segmented')!.appendChild(zoomReset); zoomReset.addEventListener('click', () => this.requestSeries(this.fullRange, true));
    iconButton(this.elements.querySelector<HTMLButtonElement>('.chart-marker-clear')!, 'clear-all', t('Clear markers', 'マーカーを全解除'));
    this.elements.querySelector('.analysis-cancel')!.addEventListener('click', () => this.post({ type: 'cancelAnalysis' }));
    this.elements.querySelector('.import-external-csv')!.addEventListener('click', () => this.beginExternalImport());
    iconButton(this.elements.querySelector<HTMLButtonElement>('.clip-clear')!, 'close', t('Clear selected range', '選択範囲を解除'));
    this.elements.querySelector('.clip-clear')!.addEventListener('click', () => this.clearRangeSelection());
    const rangeZoom = this.elements.querySelector<HTMLButtonElement>('.range-zoom')!; iconButton(rangeZoom, 'zoom-in', t('Zoom to selected range', '選択範囲を拡大')); rangeZoom.classList.remove('primary'); rangeZoom.addEventListener('click', () => this.zoomToSelectedRange());
    this.elements.querySelector('.chart-marker-clear')!.addEventListener('click', () => { this.markers.clear(); this.updateMarkerControls(); this.draw(false); });
    const clipCreate = this.elements.querySelector<HTMLButtonElement>('.clip-create')!; iconButton(clipCreate, 'new-file', t('Create Clip', 'クリップ作成')); clipCreate.addEventListener('click', () => { if (this.selectedRange) this.post({ type: 'createClip', startTimestamp: this.selectedRange.start, endTimestamp: this.selectedRange.end, signalIds: [...this.selected] }); });
    for (const [selector, label] of [['.clip-start-prev', t('Move start to previous CAN Timestamp', '開始を前のCANタイムスタンプへ移動')], ['.clip-start-next', t('Move start to next CAN Timestamp', '開始を次のCANタイムスタンプへ移動')], ['.clip-end-prev', t('Move end to previous CAN Timestamp', '終了を前のCANタイムスタンプへ移動')], ['.clip-end-next', t('Move end to next CAN Timestamp', '終了を次のCANタイムスタンプへ移動')]] as const) iconButton(this.elements.querySelector<HTMLButtonElement>(selector)!, selector.endsWith('prev') ? 'chevron-left' : 'chevron-right', label);
    for (const [selector, edge, direction] of [['.clip-start-prev', 'start', -1], ['.clip-start-next', 'start', 1], ['.clip-end-prev', 'end', -1], ['.clip-end-next', 'end', 1]] as const) bindPressRepeat(this.elements.querySelector<HTMLButtonElement>(selector)!, () => this.adjustRange(edge, direction));
    this.separator.addEventListener('mousedown', (event) => this.startPaneResize(event));
    this.canvas.addEventListener('wheel', (event) => this.handleWheel(event), { passive: false });
    // A Clip's span marker is a link to that Clip: pressing it neither starts a range selection nor adds a marker.
    this.canvas.addEventListener('mousedown', (event) => { const edge = this.clipEdgeAt(event); if (edge) { this.beginClipEdit(event, edge); return; } if (this.clipMarkerAt(event)) return; this.beginRangeSelection(event); });
    this.canvas.addEventListener('mousemove', (event) => {
      if (this.selectionAnchor !== undefined) { this.updateRangeSelection(event); return; }
      if (this.clipEdit) return;
      const edge = this.clipEdgeAt(event); const clip = edge?.marker ?? this.clipMarkerAt(event); this.canvas.style.cursor = edge ? 'ew-resize' : clip ? 'pointer' : '';
      const tip = edge ? '' : clip ? t(`Open Clip “${clip.name}”`, `クリップ「${clip.name}」を開く`) : ''; if (this.canvas.title !== tip) this.canvas.title = tip;
      if (!clip) this.hover(event);
    });
    this.canvas.addEventListener('mouseup', (event) => this.endRangeSelection(event));
    this.canvas.addEventListener('click', (event) => { if (this.suppressNextClick) { this.suppressNextClick = false; event.stopPropagation(); return; } const clip = this.clipMarkerAt(event); if (clip) { event.stopPropagation(); this.post({ type: 'openClip', clipId: clip.id }); return; } this.addMarker(event); });
    this.canvas.addEventListener('mouseleave', () => { if (this.selectionAnchor !== undefined || this.clipEdit) return; this.cursorTimestamp = undefined; this.timeline?.set(undefined, this.timelineSource); this.hoverGraphIndex = undefined; this.draw(false); });
    this.listenWindow('mouseup', (event) => { if (this.selectionAnchor !== undefined && event.target !== this.canvas) this.endRangeSelection(event); });
    this.listenWindow('mousemove', (event) => this.updateClipEdit(event));
    this.listenWindow('mouseup', (event) => this.endClipEdit(event));
    this.listenWindow('keydown', (event) => { if (event.key !== 'Escape' || event.defaultPrevented) return; if (this.clipEdit) { event.preventDefault(); this.endClipEdit(undefined); } else if (this.visible && (this.selectedRange || this.selectionAnchor !== undefined) && !isTextEditing(event.target)) { event.preventDefault(); this.selectionAnchor = undefined; this.selectionAnchorClientX = undefined; this.clearSelectedRange(); } });
    (this.resizeObserver = new ResizeObserver(() => this.draw())).observe(this.elements.querySelector('.chart-canvas-wrap')!);
    this.applyPane(); this.updateModeButtons(); this.updateRangeControls(); this.updateMarkerControls(); this.updateStatus();
    this.unsubscribeTimeline = this.timeline?.subscribe((timestamp, source) => { if (source === this.timelineSource) return; this.cursorTimestamp = timestamp; if (this.visible && this.shown.length) this.scheduleInteractionDraw(); });
    this.unsubscribePosition = this.timeline?.subscribePosition(() => { if (this.visible) this.scheduleInteractionDraw(); });
    this.unsubscribeVisibility = this.timeline?.subscribePositionVisibility(() => { if (this.visible) this.scheduleInteractionDraw(); });
    if (optionsHost) {
      const settings = document.createElement('details'); settings.className = 'display-settings';
      const summary = document.createElement('summary'); summary.textContent = t('Drawing settings', '描画設定'); settings.append(summary, mainToolbar);
      const sourceActions = this.elements.querySelector('.chart-source-actions')!;
      this.pane.append(sourceActions, this.elements.querySelector('.external-import-host')!);
      optionsHost.append(settings, this.pane);
      this.status.hidden = true;
      const cancel = this.elements.querySelector('.analysis-cancel')!;
      this.pane.append(cancel);
      this.pane.style.width = '100%'; this.pane.style.display = 'block';
      this.separator.hidden = true;
      (this.elements.querySelector('.pane-toggle') as HTMLElement).hidden = true;
    }
    if (actionsHost) {
      const navigation = this.elements.querySelector<HTMLElement>('.chart-navigation')!;
      const markerClear = this.elements.querySelector<HTMLElement>('.chart-marker-clear')!;
      const ranges = this.elements.querySelector<HTMLElement>('.range-controls')!;
      // In Visualize, time belongs to the whole log: every graph shows the same span, and zooming, the selected range's edges,
      // Clip creation and clearing are all in Visualize's top bar. A graph's header has no time controls of its own.
      navigation.querySelector('.segmented')!.append(this.elements.querySelector('.zoom-in')!, this.elements.querySelector('.zoom-out')!, zoomReset);
      ranges.querySelector('.range-actions')!.append(rangeZoom, clipCreate);
      navigation.hidden = true;
      actionsHost.append(
        viewActionGroup(t('Analysis', '解析'), markerClear),
        viewActionGroup(t('Export', 'エクスポート'), this.saveImageButton),
      );
    }
  }

  /** True when the pointer is over the plotting area, where hover shows the cursor line and clicks add markers. */
  isPlotTarget(event: MouseEvent): boolean {
    if (this.clipMarkerAt(event)) return true;
    if (event.target !== this.canvas || !this.series.length || this.timestampAt(event) === undefined) return false;
    if (this.inLanes(event)) return true;
    return graphIndexAtOffset(event.clientY - this.canvas.getBoundingClientRect().top, this.legendHeights, this.axisGutters, this.plotHeight) !== undefined;
  }
  /** Scrolls the graph settings to one Signal and focuses it. */
  revealOption(signalId: string): void { this.selector.reveal(signalId); }

  contextActions(pointer?: { clientX: number; clientY: number }): (ViewContextAction | null)[] {
    const action = (selector: string, label?: string) => buttonContextAction(this.elements.querySelector<HTMLButtonElement>(selector)!, label);
    const items: (ViewContextAction | null)[] = [];
    if (this.selectedRange) items.push(action('.range-zoom'), action('.clip-create'), action('.clip-clear'), null);
    else if (pointer) {
      const timestamp = this.timestampAt(pointer); const rect = this.canvas.getBoundingClientRect();
      const graphIndex = this.graphIndexAt(pointer.clientY);
      if (timestamp !== undefined && graphIndex !== undefined && this.series.length) items.push({ label: t('Fix marker here', 'ここにマーカーを固定'), icon: 'pin', run: () => this.addMarkerAt(timestamp, graphIndex) });
    }
    items.push(action('.zoom-in', t('Zoom in', '拡大')), action('.zoom-out', t('Zoom out', '縮小')), action('.zoom-reset'));
    if (this.markers.size) items.push(action('.chart-marker-clear'));
    items.push(action('.save-chart-image'));
    return items;
  }
  show(): void {
    const wasVisible = this.visible; this.visible = true;
    if (!this.catalogRequested) { this.catalogRequested = true; this.latestCatalogRequest = ++this.counter; this.post({ type: 'signalCatalogRequest', requestId: this.latestCatalogRequest, view: 'timeSeries' }); }
    else if (!wasVisible && this.shown.length) this.requestSeries();
    this.draw();
  }
  hide(): void { this.visible = false; this.cursorTimestamp = undefined; this.hoverGraphIndex = undefined; this.measured.update([]); }

  handle(message: ToWebviewMessage): void {
    if (message.type === 'measuredSignals') {
      this.measured.receive(message.requestId, message.samples);
    } else if (message.type === 'externalCsvPreview') {
      this.pendingImport = { ...message, timestampColumn: message.suggestedTimestampColumn ?? message.headers[0] ?? '', timestampUnit: message.suggestedTimestampUnit, timeBase: message.logStartKnown || message.suggestedTimeBase === 'datetime' ? message.suggestedTimeBase : 'relative', timeBaseChosen: false, selectedColumns: new Set(), units: new Map() };
      this.renderImportWizard();
    } else if (message.type === 'signalCatalog' && message.requestId === this.latestCatalogRequest) {
      message.definitions.forEach((definition, index) => { if (!this.colors.has(definition.id)) this.colors.set(definition.id, SIGNAL_COLOR_PRESETS[index % SIGNAL_COLOR_PRESETS.length]); });
      this.catalogDefinitions = message.definitions; this.applyDisplayPolicy();
      this.selector.setCatalog(message.definitions, message.groups, message); this.persist(); this.requestSeries();
    } else if (message.type === 'signalSeries' && message.requestId === this.latestSeriesRequest) {
      this.measured.invalidate();
      this.seriesPending = false; this.series = message.series; this.fullRange = message.fullRange; this.fullRangeKnown = true;
      // The card collapses or expands before the graph is drawn into it.
      this.reportCardState(this.cardState.inlineTitle && !this.noData);
      this.viewRange = reconcileViewRange(this.requestedViewRange ?? this.viewRange, this.fullRange); this.requestedViewRange = undefined;
      this.updateStatus(); this.updateZoomControls();
      this.draw();
    } else if (message.type === 'analysisProgress') {
      const percent = message.total ? Math.floor(message.processed / message.total * 100) : 100; this.status.textContent = `${t('Analyzing', '解析中')} ${percent}% · ${message.processed.toLocaleString()} ${t('frames', 'フレーム')}`; (this.elements.querySelector('.analysis-cancel') as HTMLButtonElement).hidden = false;
    } else if (message.type === 'analysisComplete') {
      (this.elements.querySelector('.analysis-cancel') as HTMLButtonElement).hidden = true; if (this.visible && this.shown.length) this.requestSeries(); else this.updateStatus();
    } else if (message.type === 'definitionsChanged') {
      this.measured.invalidate();
      this.catalogRequested = false; this.selector.expectCatalog(); this.latestSeriesRequest = 0; this.seriesPending = this.shown.length > 0; this.series = []; this.fullRange = undefined; this.viewRange = undefined; this.requestedViewRange = undefined; this.updateStatus(); this.updateZoomControls(); if (this.visible) this.show();
    } else if (message.type === 'clipCreated') {
      this.clearRangeSelection();
    } else if (message.type === 'timeRangeAdjusted' && message.requestId === this.latestRangeRequest) {
      this.rangePending = false; this.selectedRange = { start: message.startTimestamp, end: message.endTimestamp }; const edge = this.activeRangeEdge; if (edge) this.cursorTimestamp = this.selectedRange[edge]; this.hoverGraphIndex = findGraphIndexBySignals(timeSeriesGraphSignalIds(timeSeriesGraphs(this.series, this.mode, this.groupLayout)), this.rangeSignalIds); this.updateRangeControls(); this.draw(false);
    } else if (message.type === 'progress' && this.visible && this.shown.length) this.scheduleSeriesRefresh();
    else if (message.type === 'parseComplete' && this.visible && this.shown.length) this.requestSeries();
  }

  private selectionChanged(): void { this.series = []; this.applyDisplayPolicy(); this.persist(); this.updateRangeControls(); this.requestSeries(); }
  private switchToActual(): void {
    const groups = partitionActualGraphs([...this.selected], this.catalogDefinitions, this.groupLayout?.flat());
    if (groups.length > 1 && this.insertActualViews) {
      const settings = this.snapshot();
      this.selected.clear();
      for (const id of groups[0].selectedIds) this.selected.add(id);
      this.groupLayout = [groups[0].axisKeys];
      this.mode = 'raw';
      this.selector.render();
      this.selectionChanged();
      this.insertActualViews(groups.slice(1).map((group) => ({ ...structuredClone(settings), chartMode: 'raw', chartSelectedIds: group.selectedIds, chartGroupLayout: [group.axisKeys] })));
    } else {
      this.mode = 'raw'; this.applyDisplayPolicy(); this.persist(); this.draw();
    }
  }
  private applyDisplayPolicy(): void {
    const policy = graphDisplayPolicy([...this.selected], this.catalogDefinitions, this.mode);
    this.mode = policy.mode;
    const prior = this.groupLayout?.flat() ?? [];
    this.groupLayout = [[...new Set([...prior.filter((key) => policy.axisKeys.includes(key)), ...policy.axisKeys])]];
    this.updateModeButtons();
  }
  private beginExternalImport(): void {
    if (this.pendingImport) this.post({ type: 'cancelExternalCsvImport', importId: this.pendingImport.importId });
    this.pendingImport = undefined; this.renderImportWizard(); this.post({ type: 'importExternalCsv' });
  }
  /** The import choice that rebuilt the dialog, to keep keyboard focus on it. */
  private importFocus?: 'timeBase' | 'unit';
  private renderImportWizard(): void {
    const host = this.elements.querySelector('.external-import-host')!; host.replaceChildren(); const pending = this.pendingImport;
    if (!pending) return;
    const box = document.createElement('section'); box.className = 'external-import-card';
    const title = document.createElement('strong'); title.textContent = pending.fileName; title.title = pending.fileName; box.appendChild(title);
    box.appendChild(fieldLabel(t('Timestamp column', '時刻列')));
    const timestamp = document.createElement('select'); timestamp.setAttribute('aria-label', t('CSV Timestamp column', 'CSVの時刻列'));
    for (const header of pending.headers) { const option = document.createElement('option'); option.value = header; option.textContent = header || t('(unnamed column)', '(名前なしの列)'); option.selected = header === pending.timestampColumn; timestamp.appendChild(option); }
    timestamp.addEventListener('change', () => { pending.timestampColumn = timestamp.value; pending.selectedColumns.delete(timestamp.value); this.renderImportWizard(); }); box.appendChild(timestamp);
    // One choice of how the CSV's times are written; a unit only where they are numbers. Proposed from the first row until chosen.
    const firstTime = pending.firstRow?.[pending.headers.indexOf(pending.timestampColumn)];
    if (!pending.timeBaseChosen) { const suggested = suggestCsvTimeBase(firstTime, pending.timestampUnit); pending.timeBase = pending.logStartKnown || suggested === 'datetime' ? suggested : 'relative'; }
    box.appendChild(fieldLabel(t('Time format', '時刻の形式')));
    const timeBase = document.createElement('select'); timeBase.setAttribute('aria-label', t('How the CSV times are written', 'CSVの時刻の書き方'));
    // `log` (the log's own time) stays readable for CSVs added by older versions, but is not offered: it is the elapsed time of a log without a start, and of no use otherwise.
    for (const [value, label] of [['datetime', t('Date and time', '日時')], ['relative', t('Elapsed from start', '開始からの経過時間')], ['unix', t('Unix time', 'Unix時刻')]] as const) { const option = document.createElement('option'); option.value = value; option.textContent = label; option.disabled = !pending.logStartKnown && value !== 'relative'; option.selected = value === pending.timeBase; timeBase.appendChild(option); }
    timeBase.title = pending.logStartKnown ? (firstTime ? `${t('First time in the CSV', 'CSVの最初の時刻')}: ${firstTime}` : '') : t('This log does not record its start date and time, so CSV dates, times and Unix times cannot be placed on it.', 'このログには計測開始日時が記録されていないため、CSVの日時・Unix時刻は合わせられません。');
    timeBase.addEventListener('change', () => { pending.timeBase = timeBase.value as ExternalCsvTimeBase; pending.timeBaseChosen = true; this.importFocus = 'timeBase'; this.renderImportWizard(); }); box.appendChild(timeBase); enhanceChoiceSelect(timeBase); if (this.importFocus === 'timeBase') focusChoiceSelect(timeBase);
    if (pending.timeBase !== 'datetime') {
      box.appendChild(fieldLabel(t('Unit', '単位')));
      const timestampUnit = document.createElement('select'); timestampUnit.setAttribute('aria-label', t('CSV Timestamp unit', 'CSVの時刻単位'));
      for (const [value, label] of [['seconds', 'seconds (s)'], ['milliseconds', 'milliseconds (ms)'], ['microseconds', 'microseconds (µs)']] as const) { const option = document.createElement('option'); option.value = value; option.textContent = label; option.selected = value === pending.timestampUnit; timestampUnit.appendChild(option); }
      timestampUnit.addEventListener('change', () => { pending.timestampUnit = timestampUnit.value as typeof pending.timestampUnit; if (!pending.timeBaseChosen) { this.importFocus = 'unit'; this.renderImportWizard(); } }); box.appendChild(timestampUnit); enhanceChoiceSelect(timestampUnit); if (this.importFocus === 'unit') focusChoiceSelect(timestampUnit);
    }
    this.importFocus = undefined;
    const columnsLabel = fieldLabel(t('Value columns and units', '値の列と単位')); columnsLabel.classList.add('external-columns-label'); box.appendChild(columnsLabel);
    const columns = document.createElement('div'); columns.className = 'external-column-list'; box.appendChild(columns);
    const actions = document.createElement('div'); actions.className = 'external-import-actions';
    const add = document.createElement('button'); add.type = 'button'; add.className = 'primary'; add.textContent = t('Add to graph', 'グラフへ追加');
    const updateAdd = () => { add.disabled = pending.selectedColumns.size === 0 || !pending.timestampColumn || (!pending.logStartKnown && (pending.timeBase === 'datetime' || pending.timeBase === 'unix')); }; updateAdd();
    for (const header of pending.headers) {
      if (header === pending.timestampColumn) continue;
      const row = document.createElement('div'); row.className = 'external-column-row'; const label = document.createElement('label');
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = pending.selectedColumns.has(header);
      checkbox.addEventListener('change', () => { checkbox.checked ? pending.selectedColumns.add(header) : pending.selectedColumns.delete(header); updateAdd(); });
      const name = document.createElement('span'); name.textContent = header || t('(unnamed column)', '(名前なしの列)'); name.title = name.textContent; label.append(checkbox, name);
      const unit = document.createElement('input'); unit.type = 'text'; unit.placeholder = t('Unit', '単位'); unit.setAttribute('aria-label', t(`Unit for ${header}`, `${header}の単位`)); unit.value = pending.units.get(header) ?? '';
      unit.addEventListener('input', () => pending.units.set(header, unit.value)); row.append(label, unit); columns.appendChild(row);
    }
    add.addEventListener('click', () => {
      this.post({ type: 'commitExternalCsv', importId: pending.importId, timestampColumn: pending.timestampColumn, timestampUnit: pending.timestampUnit, timeBase: pending.timeBase, valueColumns: [...pending.selectedColumns].map((column) => ({ column, name: column, unit: pending.units.get(column)?.trim() || undefined })) });
      this.pendingImport = undefined; this.renderImportWizard();
    });
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = t('Cancel', 'キャンセル'); cancel.addEventListener('click', () => { this.post({ type: 'cancelExternalCsvImport', importId: pending.importId }); this.pendingImport = undefined; this.renderImportWizard(); });
    actions.append(add, cancel); box.appendChild(actions);
    const note = document.createElement('p'); note.className = 'muted external-import-note'; note.textContent = t('Original timestamps are retained and normalized to seconds.', '元の時刻を保持し、秒単位へ正規化します。'); box.appendChild(note); host.appendChild(box);
  }
  private removeExternalSignal(definition: SignalDefinition, group: { readonly remove?: { readonly type: 'external-csv'; readonly sourceId: string } }): void {
    if (group.remove?.type !== 'external-csv' || definition.source.type !== 'external-csv') return;
    this.selected.delete(definition.id); this.colors.delete(definition.id);
    this.series = this.series.filter((item) => item.definition.id !== definition.id);
    this.persist(); this.draw(); this.post({ type: 'removeExternalCsvSignal', sourceId: group.remove.sourceId, column: definition.source.column });
  }
  /**
   * Requests the series for a time span. Every graph shows the same span (one time axis for the whole log): a navigation
   * (`navigate`: zoom, pan, reset) publishes it to the other graphs, and any other request adopts the shared span.
   */
  private requestSeries(range = this.viewRange, navigate = false): void {
    if (navigate) this.timeline?.setViewRange(range && this.fullRange && range.start <= this.fullRange.start && range.end >= this.fullRange.end ? undefined : range, this.timelineSource);
    else range = this.timeline?.viewRange ?? range;
    if (!this.shown.length) { this.seriesPending = false; this.series = []; this.fullRange = undefined; this.viewRange = undefined; this.requestedViewRange = undefined; this.updateStatus(); this.updateZoomControls(); this.draw(); return; } this.seriesPending = true; this.requestedViewRange = range ? { ...range } : undefined; this.updateStatus(); this.updateExportAction(); this.latestSeriesRequest = ++this.counter; this.post({ type: 'signalSeriesRequest', requestId: this.latestSeriesRequest, selectedIds: this.shown, range: this.requestedViewRange, maxPoints: 4000 }); if (!this.series.length) this.draw(); }
  private scheduleSeriesRefresh(): void { if (this.refreshTimer !== undefined) return; this.refreshTimer = window.setTimeout(() => { this.refreshTimer = undefined; if (this.visible) this.requestSeries(); }, 250); }

  private zoom(factor: number, centerTimestamp?: number): void {
    if (!this.fullRange) return; const current = this.requestedViewRange ?? this.viewRange ?? this.fullRange; const fullSpan = this.fullRange.end - this.fullRange.start || 1; const center = (current.start + current.end) / 2; const span = Math.max(fullSpan * 0.005, Math.min(fullSpan, (current.end - current.start || fullSpan) * factor));
    const pivot = centerTimestamp ?? center; const ratio = (pivot - current.start) / (current.end - current.start || 1); let start = pivot - span * ratio; let end = start + span; if (start < this.fullRange.start) { start = this.fullRange.start; end = start + span; } if (end > this.fullRange.end) { end = this.fullRange.end; start = end - span; }
    this.requestSeries({ start, end }, true);
  }

  private handleWheel(event: WheelEvent): void {
    if (!this.fullRange || !this.viewRange) return; const gesture = chartWheelGesture(event, this.canvas.clientWidth);
    if (gesture.kind === 'scroll') return;
    if (!gesture.delta) return;
    if (gesture.kind === 'zoom') { event.preventDefault(); const timestamp = this.timestampAt(event as unknown as MouseEvent); const factor = gesture.delta < 0 ? 1 / 1.5 : 1.5; this.scheduleViewportNavigation(() => this.zoom(factor, timestamp)); return; }
    const fullSpan = this.fullRange.end - this.fullRange.start; const span = this.viewRange.end - this.viewRange.start; if (span >= fullSpan - 1e-12) return; event.preventDefault(); const direction = Math.sign(gesture.delta); this.scheduleViewportNavigation(() => this.panStep(direction));
  }

  private panStep(direction: number): void {
    if (!this.fullRange || !this.viewRange || !direction) return; const span = this.viewRange.end - this.viewRange.start; const shift = Math.sign(direction) * span * .18; let start = this.viewRange.start + shift; let end = this.viewRange.end + shift; if (start < this.fullRange.start) { start = this.fullRange.start; end = start + span; } if (end > this.fullRange.end) { end = this.fullRange.end; start = end - span; } this.requestSeries({ start, end }, true);
  }

  private scheduleViewportNavigation(action: () => void): void { window.clearTimeout(this.viewportRequestTimer); this.viewportRequestTimer = window.setTimeout(() => { this.viewportRequestTimer = undefined; if (this.visible) action(); }, 100); }

  private timestampAt(event: Pick<MouseEvent, 'clientX'>): number | undefined {
    if (!this.viewRange) return undefined; const rect = this.canvas.getBoundingClientRect(); const { left, plotWidth: width } = this.axisGeometry(rect.width);
    if (event.clientX < rect.left + left || event.clientX > rect.left + left + width) return undefined;
    const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left - left) / width));
    return this.viewRange.start + fraction * (this.viewRange.end - this.viewRange.start);
  }
  private beginRangeSelection(event: MouseEvent): void {
    if (event.button !== 0) return; const timestamp = this.timestampAt(event); if (timestamp === undefined) return;
    const graphIndex = this.graphIndexAt(event.clientY); if (graphIndex === undefined) return;
    const signalIds = timeSeriesGraphSignalIds(timeSeriesGraphs(this.series, this.mode, this.groupLayout))[graphIndex]; if (!signalIds?.length) return;
    // A press is only a possible drag. Do not create range labels or resize
    // the chart until the movement threshold is crossed.
    this.selectionAnchor = timestamp; this.selectionAnchorClientX = event.clientX; this.selectionGraphIndex = graphIndex; this.rangeDragged = false; event.preventDefault();
  }
  private updateRangeSelection(event: MouseEvent): void {
    const timestamp = this.timestampAt(event); if (timestamp === undefined || this.selectionAnchor === undefined) return;
    if (!this.rangeDragged) {
      if (this.selectionAnchorClientX === undefined || Math.abs(event.clientX - this.selectionAnchorClientX) <= 6) return;
      this.rangeDragged = true; this.rangePending = false; this.latestRangeRequest = ++this.counter;
      this.rangeSignalIds = timeSeriesGraphSignalIds(timeSeriesGraphs(this.series, this.mode, this.groupLayout))[this.selectionGraphIndex!] ?? [];
    }
    this.selectedRange = { start: Math.min(this.selectionAnchor, timestamp), end: Math.max(this.selectionAnchor, timestamp) }; this.activeRangeEdge = timestamp < this.selectionAnchor ? 'start' : 'end'; this.cursorTimestamp = timestamp; this.hoverGraphIndex = this.selectionGraphIndex; this.timeline?.set(timestamp, this.timelineSource); this.scheduleInteractionDraw();
  }
  private endRangeSelection(event: MouseEvent): void {
    if (this.selectionAnchor === undefined) return; this.updateRangeSelection(event); this.suppressNextClick = this.rangeDragged && event.target === this.canvas; this.selectionAnchor = undefined; this.selectionAnchorClientX = undefined;
    if (!this.rangeDragged) { this.selectionGraphIndex = undefined; return; }
    if (this.selectedRange) { this.rangePending = true; this.latestRangeRequest = ++this.counter; this.post({ type: 'snapTimeRangeRequest', requestId: this.latestRangeRequest, startTimestamp: this.selectedRange.start, endTimestamp: this.selectedRange.end }); }
    this.selectionGraphIndex = undefined;
    this.updateRangeControls(); this.draw();
  }
  private updateRangeControls(): void {
    this.canvas.setAttribute('aria-label', this.selectedRange ? t('Time-series graph. Click to clear the selected range; drag to replace it.', '時系列グラフ。クリックで範囲選択を解除、ドラッグで選択範囲を変更。') : t('Time-series graph. Click to add a marker; drag to select a range.', '時系列グラフ。クリックでマーカー追加、ドラッグで範囲選択。'));
    this.timeline?.setRange(this.selectedRange, this.timelineSource);
    const range = this.selectedRange; const valid = Boolean(range && range.end > range.start && this.shown.length && !this.rangePending);
    const controls = this.elements.querySelector<HTMLElement>('.range-controls')!; const visible = Boolean(range && this.selectionAnchor === undefined); controls.hidden = this.actionsHost ? true : !visible;
    this.elements.querySelector<HTMLElement>('.chart-navigation')!.hidden = this.actionsHost ? true : visible;
    (this.elements.querySelector('.range-zoom') as HTMLButtonElement).disabled = !valid;
    (this.elements.querySelector('.clip-create') as HTMLButtonElement).disabled = !valid;
    this.elements.querySelectorAll<HTMLButtonElement>('.clip-start-prev,.clip-start-next,.clip-end-prev,.clip-end-next').forEach((button) => { button.disabled = !range || this.rangePending; });
    if (range) this.elements.querySelector('.clip-range')!.textContent = `${timeRangeLabel(range.start, range.end, formatSeconds)} · ${formatNumber(range.end - range.start)} s`;
  }

  // ---- Used by Visualize's top bar, which acts on every graph and on the range they share ----
  /** Zooms this graph's time axis in (factor < 1) or out. */
  zoomBy(factor: number): void { this.zoom(factor); }
  resetZoom(): void { this.requestSeries(this.fullRange, true); }
  /** True once this graph has data, so it can drive the shared time axis. */
  get canZoom(): boolean { return !!this.fullRange; }
  /** Shows exactly `range` on the time axis, keeping the selection. */
  zoomToRange(range: { start: number; end: number }): void { if (range.end > range.start && this.shown.length) this.requestSeries({ ...range }, true); }
  adjustSelectedRange(edge: 'start' | 'end', direction: -1 | 1): void { this.adjustRange(edge, direction); }
  clearSelectedRange(): void { this.clearRangeSelection(); }
  createClipFromSelectedRange(): void { if (this.selectedRange && this.selectedRange.end > this.selectedRange.start && !this.rangePending) this.post({ type: 'createClip', startTimestamp: this.selectedRange.start, endTimestamp: this.selectedRange.end, signalIds: [] }); }

  private zoomToSelectedRange(): void {
    const range = this.selectedRange; if (!range || !(range.end > range.start)) return;
    const target = { ...range }; this.clearRangeSelection(false); this.draw(false); this.requestSeries(target, true);
  }

  private clearRangeSelection(redraw = true): void {
    this.latestRangeRequest = ++this.counter; this.rangePending = false; this.selectedRange = undefined; this.selectionAnchor = undefined; this.selectionAnchorClientX = undefined; this.selectionGraphIndex = undefined; this.rangeSignalIds = []; this.activeRangeEdge = undefined; this.rangeDragged = false; this.cursorTimestamp = undefined; this.hoverGraphIndex = undefined; this.updateRangeControls(); if (redraw) this.draw(false);
  }

  private adjustRange(edge: 'start' | 'end', direction: -1 | 1): void { if (!this.selectedRange || this.rangePending) return; this.rangePending = true; this.activeRangeEdge = edge; this.cursorTimestamp = this.selectedRange[edge]; this.hoverGraphIndex = findGraphIndexBySignals(timeSeriesGraphSignalIds(timeSeriesGraphs(this.series, this.mode, this.groupLayout)), this.rangeSignalIds); this.updateRangeControls(); this.draw(false); this.latestRangeRequest = ++this.counter; this.post({ type: 'adjustTimeRangeRequest', requestId: this.latestRangeRequest, edge, direction, startTimestamp: this.selectedRange.start, endTimestamp: this.selectedRange.end }); }

  private scheduleInteractionDraw(): void {
    if (this.hoverDrawScheduled) return;
    this.hoverDrawScheduled = true;
    requestAnimationFrame(() => { this.hoverDrawScheduled = false; if (this.visible) this.draw(false); });
  }

  private draw(renderControls = true): void {
    this.updateMeasuredSamples();
    if (!this.visible) return; const wrapper = this.canvas.parentElement!; const width = Math.max(1, wrapper.clientWidth); const graphCount = Math.max(1, timeSeriesGraphs(this.series, this.mode, this.groupLayout).length); if (renderControls || this.legendHeights.length !== graphCount) this.legendHeights = this.renderLegend(width); this.axisGutters = this.measureAxisGutters(width, true); let legendTop = 0; this.elements.querySelectorAll<HTMLElement>('.chart-legend-group').forEach((row, index) => { row.style.top = `${legendTop}px`; legendTop += (this.legendHeights[index] ?? 0) + this.plotHeight + (this.axisGutters[index] ?? 0); }); const contentHeight = this.axisGutters.reduce((a, b) => a + b, 0) + graphCount * this.plotHeight + this.legendHeights.reduce((sum, value) => sum + value, 0); const lanes = this.series.length && this.viewRange ? this.laneItems() : []; this.lanesTop = lanes.length ? contentHeight : undefined; const height = contentHeight + (this.lanesExpanded ? lanesHeight(lanes.length) : 0); placeLaneToggle(this.laneToggle, lanes.length, this.lanesExpanded, contentHeight); const ratio = window.devicePixelRatio || 1; this.canvas.width = width * ratio; this.canvas.height = height * ratio; this.canvas.style.width = `${width}px`; this.canvas.style.height = `${height}px`; const context = this.canvas.getContext('2d')!; context.scale(ratio, ratio); context.clearRect(0, 0, width, height); context.fillStyle = css('--vscode-editor-background', '#1e1e1e'); context.fillRect(0, 0, width, height); if (renderControls) this.updateZoomControls();
    if (!this.series.length || !this.viewRange) { context.font = '12px sans-serif'; context.fillStyle = css('--vscode-descriptionForeground', '#888'); context.fillText(this.seriesPending ? t('Loading selected Signals…', '選択したシグナルを読み込んでいます…') : this.shown.length ? t('No samples in this range.', 'この範囲にサンプルがありません。') : this.optionsHost ? t('Select Signals in Graph settings.', 'グラフ設定でシグナルを選択してください。') : t('Select Signals from the left pane.', '左側からシグナルを選択してください。'), 24, 34); this.updateExportAction(); return; }
    this.paintChart(context, width, height, 0, height - contentHeight, true, this.legendHeights); if (this.lanesExpanded) this.paintLanes(context, width, contentHeight, true); this.updateExportAction();
  }

  /** Every shown Signal in legend order, each with the display unit of its axis. */
  private laneItems(): readonly { readonly item: SignalSeriesDto; readonly displayUnit?: string }[] {
    return timeSeriesGraphs(this.series, this.mode, this.groupLayout).flatMap((graph) => graph.flatMap((group) => group.items.map((item) => ({ item, displayUnit: group.displayUnit }))));
  }
  /** The graph under the pointer. The lanes belong to the graph above them: a click there adds its marker, a drag selects its range. */
  private graphIndexAt(clientY: number): number | undefined {
    return graphIndexAtOffset(clientY - this.canvas.getBoundingClientRect().top, this.legendHeights, this.axisGutters, this.plotHeight) ?? (this.inLanes({ clientY }) ? 0 : undefined);
  }
  /** True when the pointer is over an open lane. */
  private inLanes(event: Pick<MouseEvent, 'clientY'>): boolean {
    if (this.lanesTop === undefined || !this.lanesExpanded) return false;
    return laneIndexAt(event.clientY - this.canvas.getBoundingClientRect().top - this.lanesTop, this.laneItems().length) !== undefined;
  }

  /** The lanes under the graph from `top`; `interactions` adds the cursor, its values and the emphasized Signal (not in images). */
  private paintLanes(context: CanvasRenderingContext2D, width: number, top: number, interactions: boolean): void {
    const view = this.viewRange; if (!view) return;
    const cursor = interactions ? this.cursorTimestamp : undefined;
    const markerTimes = [...this.markers.values()].flatMap((marker) => { const timestamp = this.measured.referenceTimestamp(`marker:${marker.id}`); return timestamp === undefined ? [] : [{ id: marker.id, timestamp }]; });
    const lanes: ChartLane[] = this.laneItems().map(({ item, displayUnit }) => {
      const sample = cursor === undefined ? undefined : interpolatedSeriesSample(item, cursor, this.connectGaps);
      // Each marker's value as the graph labels it: the measured sample nearest the marker.
      const markers = markerTimes.flatMap(({ id, timestamp }) => { const measured = this.measured.sample(`marker:${id}`, item.definition.id); if (!measured) return []; const value = seriesDisplayValue(item, measured.value, this.mode, displayUnit); return Number.isFinite(value) ? [{ time: timestamp, sampleTime: measured.timestamp, value, text: measuredValueLabel(`${displayValueLabel(item, measured.value, this.mode, displayUnit)}${measured.valueLabel ? ` (${measured.valueLabel})` : ''}`, measured.timestamp, timestamp) }] : []; });
      return { markers, name: item.definition.name, color: this.color(item.definition.id), emphasized: interactions && item.definition.id === this.highlightedSignalId,
        lines: [{ runs: laneRuns(item, (value) => seriesDisplayValue(item, value, this.mode, displayUnit), this.connectGaps) }],
        value: sample ? `${displayValueLabel(item, sample.value, this.mode, displayUnit)}${sample.valueLabel ? ` (${sample.valueLabel})` : ''}` : undefined };
    });
    // The Trace line follows the graph's rule: from the first real sample on, while it is shown.
    const traceTime = this.timeline?.position; const firstMeasured = Math.min(...this.series.map((series) => series.samples.find((sample) => !sample.carried)?.timestamp ?? Infinity));
    const trace = traceTime !== undefined && this.timeline?.positionVisible !== false && !this.timeline?.beforeFirstFrame && traceTime >= firstMeasured ? { time: traceTime, color: css('--sm-trace-color', '#d18616') } : undefined;
    const { left, plotWidth } = this.axisGeometry(width);
    paintChartLanes(context, lanes, { left, width: plotWidth, top }, view, { cursor, markers: markerTimes.map((marker) => marker.timestamp), trace, selection: this.selectedRange });
  }

  private updateMeasuredSamples(): void {
    const queries: MeasuredSampleQuery[] = [];
    if (this.visible && this.viewRange && this.series.length) {
      const graphIds = timeSeriesGraphSignalIds(timeSeriesGraphs(this.series, this.mode, this.groupLayout));
      for (const marker of this.markers.values()) {
        const graph = findGraphIndexBySignals(graphIds, marker.signalIds);
        if (graph === undefined || marker.timestamp < this.viewRange.start || marker.timestamp > this.viewRange.end) continue;
        queries.push({ slot: `marker:${marker.id}`, timestamp: marker.timestamp, signalIds: graphIds[graph] });
      }
    }
    this.measured.update(queries);
  }

  private paintChart(context: CanvasRenderingContext2D, width: number, height: number, top: number, bottom: number, interactions: boolean, legendHeights: readonly number[], gutters = this.axisGutters ?? []): ChartGeometry | undefined {
    if (interactions) this.clipMarkers = [];
    if (!this.series.length || !this.viewRange) return undefined; const { left, right, plotWidth: plotW, axisWidth } = this.axisGeometry(width); const plotH = Math.max(1, height - top - bottom); const x = (timestamp: number) => left + (timestamp - this.viewRange!.start) / (this.viewRange!.end - this.viewRange!.start || 1) * plotW;
    const graphs = timeSeriesGraphs(this.series, this.mode, this.groupLayout); const graphSignalIds = timeSeriesGraphSignalIds(graphs); const rangeGraphIndex = findGraphIndexBySignals(graphSignalIds, this.rangeSignalIds); const graphCount = Math.max(1, graphs.length); let precedingHeight = 0; context.font = '11px sans-serif'; context.lineWidth = 1;
    const cursorTimestamp = this.cursorTimestamp;
    const markers = [...this.markers.values()].flatMap((marker) => { const timestamp = this.measured.referenceTimestamp(`marker:${marker.id}`); return timestamp === undefined ? [] : [{ ...marker, timestamp }]; });
    for (let graphIndex = 0; graphIndex < graphCount; graphIndex++) {
      const legendHeight = legendHeights[graphIndex] ?? 0; const blockTop = top + precedingHeight; const graphTop = blockTop + legendHeight; const laneTop = graphTop + 30; const laneHeight = (interactions ? this.plotHeight : GRAPH_HEIGHT) - 58; const pair = graphs[graphIndex] ?? []; const hoverValues: CanvasHoverValue[] = []; const markerValues = new Map<string, CanvasHoverValue[]>(); if (!interactions) this.paintGraphLegend(context, pair, width, blockTop); precedingHeight += legendHeight + (interactions ? this.plotHeight : GRAPH_HEIGHT) + (gutters[graphIndex] ?? 0);
      context.strokeStyle = css('--vscode-panel-border', '#777'); context.strokeRect(left, laneTop, plotW, laneHeight);
      for (const { timestamp, label } of timeTicks(this.viewRange.start, this.viewRange.end, Math.max(1, Math.min(5, Math.floor(plotW / 100))))) { const px = x(timestamp); context.globalAlpha = .48; context.beginPath(); context.moveTo(px, laneTop); context.lineTo(px, laneTop + laneHeight); context.stroke(); context.globalAlpha = 1; const labelWidth = context.measureText(label).width; context.fillStyle = css('--vscode-descriptionForeground', '#888'); context.fillText(label, Math.max(left, Math.min(left + plotW - labelWidth, px - labelWidth / 2)), laneTop + laneHeight + 20); }
      pair.forEach((group, axisIndex) => {
        const range = this.mode === 'normalized' ? { minimum: 0, maximum: 100 } : displaySeriesRange(group.items, this.axisRange, this.viewRange, group.displayUnit); let { minimum, maximum } = range; if (minimum === maximum) { const pad = Math.abs(minimum) * .05 || 1; minimum -= pad; maximum += pad; }
        const y = (value: number) => laneTop + (1 - (value - minimum) / (maximum - minimum)) * laneHeight; const rightAxis = axisIndex % 2 === 1; const axisX = rightAxis ? left + plotW + Math.floor(axisIndex / 2) * axisWidth : left - Math.floor(axisIndex / 2) * axisWidth;
        const axisColor = this.color(group.items[0].definition.id);
        context.save(); context.font = '600 11px sans-serif'; context.textAlign = rightAxis ? 'left' : 'right'; context.fillStyle = axisColor;
        context.fillText(ellipsize(context, group.label, Math.max(1, axisWidth - 14)), axisX + (rightAxis ? 7 : -7), graphTop + 16);
        context.strokeStyle = axisColor; context.beginPath(); context.moveTo(axisX, laneTop); context.lineTo(axisX, laneTop + laneHeight); context.stroke();
        context.font = '11px sans-serif';
        for (const value of chartTicks(minimum, maximum, 4)) {
          const py = y(value);
          if (axisIndex === 0) { context.save(); context.strokeStyle = css('--vscode-panel-border', '#777'); context.globalAlpha = .58; context.beginPath(); context.moveTo(left, py); context.lineTo(left + plotW, py); context.stroke(); context.restore(); }
          context.beginPath(); context.moveTo(axisX, py); context.lineTo(axisX + (rightAxis ? 4 : -4), py); context.stroke();
          const label = String(value);
          context.save(); context.translate(axisX + (rightAxis ? 7 : -7), Math.min(laneTop + laneHeight - 2, py + 4));
          context.scale(Math.min(1, Math.max(1, axisWidth - 14) / Math.max(1, context.measureText(label).width)), 1);
          context.fillText(label, 0, 0); context.restore();
        }
        context.restore();
        context.save(); context.beginPath(); context.rect(left, laneTop, plotW, laneHeight); context.clip();
        for (const item of group.items) {
          const color = this.color(item.definition.id); context.strokeStyle = color; context.lineWidth = interactions && item.definition.id === this.highlightedSignalId ? 3 : 1.5;
          context.beginPath(); let started = false; let previousTimestamp: number | undefined;
          for (const sample of item.samples) {
            const value = seriesDisplayValue(item, sample.value, this.mode, group.displayUnit); const usable = Number.isFinite(value) && (sample.quality === undefined || sample.quality === 'valid');
            if (!usable) { if (!this.connectGaps) started = false; continue; }
            const separated = !this.connectGaps && previousTimestamp !== undefined && crossesSeriesGap(item.gaps, previousTimestamp, sample.timestamp); const px = x(sample.timestamp); const py = y(value);
            started && !separated ? context.lineTo(px, py) : context.moveTo(px, py); started = true; previousTimestamp = sample.timestamp;
          }
          context.stroke(); context.lineWidth = 1.5; this.drawEvents(context, item, x, y, group.displayUnit);
        }
        context.restore();
        if (interactions && cursorTimestamp !== undefined && this.hoverGraphIndex === graphIndex) for (const item of group.items) {
          const sample = interpolatedSeriesSample(item, cursorTimestamp, this.connectGaps); if (!sample) continue;
          const value = seriesDisplayValue(item, sample.value, this.mode, group.displayUnit); const py = y(value);
          if (Number.isFinite(py)) hoverValues.push({ y: Math.max(laneTop, Math.min(laneTop + laneHeight, py)), sampleY: py, sampleX: x(cursorTimestamp), text: `${displayValueLabel(item, sample.value, this.mode, group.displayUnit)}${sample.valueLabel ? ` (${sample.valueLabel})` : ''}`, color: this.color(item.definition.id), emphasized: interactions && item.definition.id === this.highlightedSignalId });
        }
        for (const marker of markers) {
          if (findGraphIndexBySignals(graphSignalIds, marker.signalIds) !== graphIndex) continue;
          for (const item of group.items) {
          const sample = this.measured.sample(`marker:${marker.id}`, item.definition.id); if (!sample) continue;
          const value = seriesDisplayValue(item, sample.value, this.mode, group.displayUnit); const py = y(value); if (!Number.isFinite(py)) continue;
          const values = markerValues.get(marker.id) ?? []; values.push({ y: Math.max(laneTop, Math.min(laneTop + laneHeight, py)), sampleY: py, sampleX: x(sample.timestamp), text: measuredValueLabel(`${displayValueLabel(item, sample.value, this.mode, group.displayUnit)}${sample.valueLabel ? ` (${sample.valueLabel})` : ''}`, sample.timestamp, marker.timestamp), color: this.color(item.definition.id), emphasized: interactions && item.definition.id === this.highlightedSignalId }); markerValues.set(marker.id, values);
          }
        }
      });
      // The log's Clips: a faint band and a span marker |← name →| above the plot.
      const drawnClips = drawClipSpans(context, this.timeline?.clipRanges ?? [], this.viewRange, x, laneTop, laneHeight, css('--vscode-charts-green', '#89d185'));
      if (interactions) this.clipMarkers.push(...drawnClips);
      // The selection is see-through: the lines under it stay visible, so its edges can be set against them.
      if (this.selectedRange) { const rangeStart = Math.max(this.viewRange.start, this.selectedRange.start); const rangeEnd = Math.min(this.viewRange.end, this.selectedRange.end); if (rangeEnd >= rangeStart) { const start = x(rangeStart); const end = x(rangeEnd); context.save(); context.fillStyle = css('--vscode-focusBorder', '#007acc'); context.globalAlpha = .16; context.fillRect(start, laneTop, end - start, laneHeight); context.globalAlpha = .8; context.strokeStyle = css('--vscode-focusBorder', '#007acc'); context.strokeRect(start, laneTop, end - start, laneHeight); context.restore(); } }
      const visibleMarkers = markers.filter((marker) => findGraphIndexBySignals(graphSignalIds, marker.signalIds) === graphIndex && marker.timestamp >= this.viewRange!.start && marker.timestamp <= this.viewRange!.end);
      for (const marker of visibleMarkers) { context.strokeStyle = css('--vscode-focusBorder', '#007acc'); context.beginPath(); const px = x(marker.timestamp); context.moveTo(px, laneTop); context.lineTo(px, laneTop + laneHeight); context.stroke(); }
      const traceTime = this.timeline?.position;
      // The Trace line shows once the first real sample has been reached and stays to the end of the Trace: after the last sample the values still hold.
      // A Clip's carried edge samples only draw the lines to its edges; they are not data.
      const firstMeasured = Math.min(...this.series.map((series) => series.samples.find((sample) => !sample.carried)?.timestamp ?? Infinity));
      const traceVisible = this.timeline?.positionVisible !== false && !this.timeline?.beforeFirstFrame && traceTime !== undefined && traceTime >= firstMeasured && traceTime >= this.viewRange.start && traceTime <= this.viewRange.end;
      const traceColor = css('--sm-trace-color', '#d18616');
      if (traceVisible) {
        context.save(); const px = x(traceTime); context.strokeStyle = traceColor; context.lineWidth = 1; context.setLineDash([]);
        context.beginPath(); context.moveTo(px, laneTop); context.lineTo(px, laneTop + laneHeight); context.stroke(); context.restore();
      }
      if (interactions && cursorTimestamp !== undefined && cursorTimestamp >= this.viewRange.start && cursorTimestamp <= this.viewRange.end && (this.hoverGraphIndex === undefined || this.hoverGraphIndex === graphIndex)) { context.strokeStyle = css('--vscode-editorCursor-foreground', '#fff'); context.beginPath(); const px = x(cursorTimestamp); context.moveTo(px, laneTop); context.lineTo(px, laneTop + laneHeight); context.stroke(); }
      const occupiedLabels: HoverLabelRect[] = [];
      const fixedTimestampMarkers = visibleMarkers.map((marker) => {
        const timestampMarker = this.createTimestampMarker(context, x(marker.timestamp), timeLabel(marker.timestamp, formatSeconds), left, left + plotW, laneTop + laneHeight, occupiedLabels, laneTop);
        occupiedLabels.push(timestampMarker.rect); return timestampMarker;
      });
      const rangeTimestampMarkers: CanvasTimestampMarker[] = [];
      if (this.selectedRange && rangeGraphIndex === graphIndex) {
        for (const edge of ['start', 'end'] as const) {
          const timestamp = this.selectedRange[edge]; if (timestamp < this.viewRange.start || timestamp > this.viewRange.end) continue;
          const marker = this.createTimestampMarker(context, x(timestamp), `${edge === 'start' ? t('Start', '開始') : t('End', '終了')} ${timeLabel(timestamp, formatSeconds)}`, left, left + plotW, laneTop + laneHeight, occupiedLabels, laneTop, this.activeRangeEdge === edge);
          occupiedLabels.push(marker.rect); rangeTimestampMarkers.push(marker);
        }
      }
      const traceTimestampMarker = traceVisible
        ? { ...this.createTimestampMarker(context, x(traceTime), timeLabel(traceTime, formatSeconds), left, left + plotW, laneTop + laneHeight, occupiedLabels, laneTop), color: traceColor }
        : undefined;
      if (traceTimestampMarker) occupiedLabels.push(traceTimestampMarker.rect);
      const cursorMatchesRangeEdge = this.selectedRange && this.activeRangeEdge && cursorTimestamp === this.selectedRange[this.activeRangeEdge] && rangeGraphIndex === graphIndex;
      const timestampMarker = interactions && cursorTimestamp !== undefined && this.hoverGraphIndex === graphIndex && !cursorMatchesRangeEdge
        ? this.createTimestampMarker(context, x(cursorTimestamp), timeLabel(cursorTimestamp, formatSeconds), left, left + plotW, laneTop + laneHeight, occupiedLabels, laneTop)
        : undefined;
      if (timestampMarker) occupiedLabels.push(timestampMarker.rect);
      for (const marker of visibleMarkers) this.paintHoverValues(context, x(marker.timestamp), markerValues.get(marker.id) ?? [], left, left + plotW, laneTop, laneTop + laneHeight, occupiedLabels);
      if (interactions && cursorTimestamp !== undefined && this.hoverGraphIndex === graphIndex) this.paintHoverValues(context, x(cursorTimestamp), hoverValues, left, left + plotW, laneTop, laneTop + laneHeight, occupiedLabels);
      context.save(); context.strokeStyle = css('--vscode-descriptionForeground', '#888'); for (const marker of [...fixedTimestampMarkers, ...rangeTimestampMarkers, ...(traceTimestampMarker ? [traceTimestampMarker] : []), ...(timestampMarker ? [timestampMarker] : [])]) { context.strokeStyle = marker.color ?? css('--vscode-descriptionForeground', '#888'); paintTimestampConnector(context, marker.cursorX, marker.bottom, marker.rect); } context.restore();
      for (const fixedTimestampMarker of fixedTimestampMarkers) this.paintTimestampMarker(context, fixedTimestampMarker);
      for (const rangeTimestampMarker of rangeTimestampMarkers) this.paintTimestampMarker(context, rangeTimestampMarker);
      if (traceTimestampMarker) this.paintTimestampMarker(context, traceTimestampMarker);
      if (timestampMarker) this.paintTimestampMarker(context, timestampMarker);
    }
    return { left, right, top: top + (legendHeights[0] ?? 0) + 30, bottom: top + plotH - 28, width: plotW, x };
  }

  private drawEvents(context: CanvasRenderingContext2D, item: SignalSeriesDto, x: (t: number) => number, y: (v: number) => number, displayUnit?: string): void {
    context.fillStyle = this.color(item.definition.id);
    for (const event of item.events) {
      const points = event.endTimestamp === undefined || event.endTimestamp === event.timestamp ? [event.timestamp] : [event.timestamp, event.endTimestamp];
      points.forEach((timestamp, index) => { const sample = nearestFromSlice(item.samples, timestamp); if (!sample) return; const value = seriesDisplayValue(item, sample.value, this.mode, displayUnit); const px = x(timestamp); const py = y(value); context.beginPath(); if (points.length === 1) { context.moveTo(px, py - 5); context.lineTo(px + 5, py); context.lineTo(px, py + 5); context.lineTo(px - 5, py); } else { const direction = index === 0 ? 1 : -1; context.moveTo(px, py); context.lineTo(px - 5, py + 7 * direction); context.lineTo(px + 5, py + 7 * direction); } context.closePath(); context.fill(); });
    }
  }

  private paintHoverValues(context: CanvasRenderingContext2D, cursorX: number, values: readonly CanvasHoverValue[], left: number, right: number, top: number, bottom: number, occupied: HoverLabelRect[] = []): void {
    paintValueBoxes(context, cursorX, values, { left, right, top, bottom }, occupied, { family: css('--vscode-editor-font-family', 'monospace'), background: css('--vscode-editorHoverWidget-background', '#252526') });
  }


  private createTimestampMarker(context: CanvasRenderingContext2D, cursorX: number, text: string, left: number, right: number, bottom: number, occupied: readonly HoverLabelRect[] = [], top = 0, emphasized = false): CanvasTimestampMarker {
    context.save(); context.font = `600 11px ${css('--vscode-editor-font-family', 'monospace')}`; const width = context.measureText(text).width + 12; context.restore();
    return { text, cursorX, bottom, rect: layoutTimestampMarker(cursorX, width, 18, left, right, bottom, occupied, top), emphasized };
  }

  private paintTimestampMarker(context: CanvasRenderingContext2D, marker: CanvasTimestampMarker): void {
    context.save(); context.font = `600 11px ${css('--vscode-editor-font-family', 'monospace')}`; context.textAlign = 'center'; context.textBaseline = 'middle'; context.fillStyle = css('--vscode-editorHoverWidget-background', '#252526'); context.fillRect(marker.rect.x, marker.rect.y, marker.rect.width, marker.rect.height); context.strokeStyle = marker.color ?? (marker.emphasized ? css('--vscode-focusBorder', '#007acc') : css('--vscode-editorCursor-foreground', '#fff')); context.lineWidth = marker.emphasized ? 2 : 1; context.strokeRect(marker.rect.x, marker.rect.y, marker.rect.width, marker.rect.height); context.fillStyle = marker.color ?? css('--vscode-editor-foreground', '#ddd'); context.fillText(marker.text, marker.rect.x + marker.rect.width / 2, marker.rect.y + marker.rect.height / 2); context.restore();
  }

  private hover(event: MouseEvent): void {
    if (!this.viewRange || !this.shown.length) return;
    const timestamp = this.timestampAt(event);
    if (timestamp === undefined) { this.cursorTimestamp = undefined; this.timeline?.set(undefined, this.timelineSource); this.hoverGraphIndex = undefined; this.scheduleInteractionDraw(); return; }
    const rect = this.canvas.getBoundingClientRect();
    // Over the lanes the cursor follows the pointer on every lane and on the graph, without the graph's value labels.
    if (this.inLanes(event)) { this.hoverGraphIndex = undefined; this.cursorTimestamp = timestamp; this.timeline?.set(timestamp, this.timelineSource); this.scheduleInteractionDraw(); return; }
    const nextGraphIndex = graphIndexAtOffset(event.clientY - rect.top, this.legendHeights, this.axisGutters, this.plotHeight); if (nextGraphIndex === undefined) { this.cursorTimestamp = undefined; this.timeline?.set(undefined, this.timelineSource); this.hoverGraphIndex = undefined; this.scheduleInteractionDraw(); return; } this.hoverGraphIndex = nextGraphIndex;
    this.cursorTimestamp = timestamp; this.timeline?.set(timestamp, this.timelineSource);
    this.scheduleInteractionDraw();
  }
  private addMarker(event: MouseEvent): void {
    if (this.suppressNextClick) { this.suppressNextClick = false; return; }
    if (this.selectedRange) { this.clearRangeSelection(); return; }
    const timestamp = this.timestampAt(event); if (timestamp === undefined || !this.shown.length) return;
    const graphIndex = this.graphIndexAt(event.clientY); if (graphIndex === undefined) return;
    this.addMarkerAt(timestamp, graphIndex);
  }
  private addMarkerAt(timestamp: number, graphIndex: number): void {
    const id = `marker-${++this.markerCounter}`;
    const signalIds = timeSeriesGraphSignalIds(timeSeriesGraphs(this.series, this.mode, this.groupLayout))[graphIndex]; if (!signalIds?.length) return;
    this.markers.set(id, { id, timestamp, signalIds });
    this.cursorTimestamp = undefined; this.updateMarkerControls(); this.draw(false);
  }
  private updateMarkerControls(): void { (this.elements.querySelector('.chart-marker-clear') as HTMLButtonElement).disabled = this.markers.size === 0; this.updateExportAction(); }
  private axisGeometry(width: number): ReturnType<typeof chartAxisGeometry> {
    return chartAxisGeometry(width, timeSeriesGroups(this.series, this.mode).length);
  }

  private measureAxisGutters(width: number, interactive: boolean): readonly number[] {
    if (!this.viewRange) return [];
    const context = document.createElement('canvas').getContext('2d')!;
    context.font = `600 11px ${css('--vscode-editor-font-family', 'monospace')}`;
    const graphs = timeSeriesGraphs(this.series, this.mode, this.groupLayout);
    const ids = timeSeriesGraphSignalIds(graphs);
    const rangeIndex = findGraphIndexBySignals(ids, this.rangeSignalIds);
    const range = this.viewRange;
    const { left, right, plotWidth } = this.axisGeometry(width);
    const x = (time: number) => left + (time - range.start) / (range.end - range.start || 1) * plotWidth;
    return graphs.map((_, index) => {
      const labels: { x: number; text: string }[] = [];
      const add = (time: number | undefined, prefix = '') => { if (time !== undefined && time >= range.start && time <= range.end) labels.push({ x: x(time), text: `${prefix}${timeLabel(time, formatSeconds)}` }); };
      for (const marker of this.markers.values()) if (findGraphIndexBySignals(ids, marker.signalIds) === index) add(this.measured.referenceTimestamp(`marker:${marker.id}`));
      if (this.selectedRange && rangeIndex === index) { add(this.selectedRange.start, t('Start ', '開始 ')); add(this.selectedRange.end, t('End ', '終了 ')); }
      add(this.timeline?.position);
      const cursor = this.cursorTimestamp;
      const matchesEdge = this.selectedRange && this.activeRangeEdge && cursor === this.selectedRange[this.activeRangeEdge] && rangeIndex === index;
      if (interactive && this.hoverGraphIndex === index && !matchesEdge) add(cursor);
      return Math.max(this.timeline?.position === undefined ? 0 : 21, timestampGutter(context, labels, left, width - right));
    });
  }

  private renderLegend(width: number): readonly number[] {
    const legend = this.elements.querySelector<HTMLElement>('.chart-legend')!;
    // The title lives in the first legend row; keep the caret where it is when the row is rebuilt during editing.
    const lead = this.legendLead as HTMLInputElement | undefined; const editing = !!lead && document.activeElement === lead; const caret = editing ? [lead!.selectionStart, lead!.selectionEnd] as const : undefined;
    legend.replaceChildren(); legend.style.width = `${width}px`; const graphs = timeSeriesGraphs(this.series, this.mode, this.groupLayout); const heights: number[] = []; let top = 0;
    for (let graphIndex = 0; graphIndex < graphs.length; graphIndex++) {
      const row = document.createElement('div'); row.className = 'chart-legend-group'; row.style.top = `${top}px`; const items = document.createElement('div'); items.className = 'chart-legend-items';
      graphs[graphIndex].forEach((group) => {
        for (const item of group.items) {
          const entry = createLegendEntry(signalLegendLabel(item.definition, this.mode, group.displayUnit), this.color(item.definition.id), (active) => this.highlightSignal(active ? item.definition.id : undefined));
          entry.className = 'chart-legend-entry'; entry.dataset.signalId = item.definition.id; emphasizeSignal(entry, item.definition.id === this.highlightedSignalId, this.color(item.definition.id)); items.appendChild(entry);
        }
      }); if (graphIndex === 0 && lead && !this.noData) items.prepend(lead); row.append(items); legend.appendChild(row); const height = Math.max(34, Math.ceil(row.scrollHeight) + 1); row.style.height = `${height}px`; heights.push(height); top += height + GRAPH_HEIGHT;
    }
    this.reportCardState(graphs.length > 0 && !!lead && !this.noData);
    if (editing && lead!.isConnected) { lead!.focus(); if (caret) lead!.setSelectionRange(caret[0], caret[1]); }
    return heights;
  }
  private highlightSignal(id: string | undefined): void {
    if (this.highlightedSignalId === id) return;
    this.highlightedSignalId = id;
    this.elements.querySelectorAll<HTMLElement>('.selector-signal,.chart-legend-entry').forEach((element) => emphasizeSignal(element, !!id && element.dataset.signalId === id, this.color(element.dataset.signalId ?? '')));
    this.scheduleInteractionDraw();
  }
  private updateStatus(): void {
    if (!this.shown.length) this.status.textContent = t('Select Signals', 'シグナルを選択');
    else if (this.seriesPending) this.status.textContent = t('Loading selected Signals…', '選択したシグナルを読み込み中…');
    else this.status.textContent = `${this.series.length} ${t('series', '系列')} · ${this.series.reduce((sum, item) => sum + item.totalSamplesInRange, 0).toLocaleString()} ${t('source samples', '元サンプル')}`;
  }
  private updateZoomControls(): void {
    const full = this.fullRange; const view = this.viewRange; const reset = this.elements.querySelector<HTMLButtonElement>('.zoom-reset')!; const out = this.elements.querySelector<HTMLButtonElement>('.zoom-out')!; const input = this.elements.querySelector<HTMLButtonElement>('.zoom-in')!; const label = this.elements.querySelector('.view-range')!;
    const zoomed = Boolean(full && view && (Math.abs(view.start - full.start) > 1e-9 || Math.abs(view.end - full.end) > 1e-9)); reset.disabled = !zoomed; out.disabled = !zoomed; input.disabled = !full || !view || (view.end - view.start) <= (full.end - full.start) * .005 + 1e-12;
    label.textContent = view ? `${timeRangeLabel(view.start, view.end, formatSeconds)} · ${formatNumber(view.end - view.start)} s` : '';
  }
  private updateExportAction(): void { this.saveImageButton.disabled = !this.series.length || !this.viewRange || this.seriesPending || this.measured.pendingMarkers(); this.saveImageButton.title = t('Save image', '画像を保存'); }
  private saveImage(): void { const image = this.renderImage(); if (image) this.post({ type: 'saveTimeSeriesImage', ...withBrandMark(image, css('--vscode-foreground', '#ddd')) }); }
  /** This graph as an export image; `heading` is the title written on it (the graph name on a combined sheet). */
  renderImage(heading = 'SigMixa · Time Series', width = 1600): SheetImage | undefined {
    if (!this.series.length || !this.viewRange || this.saveImageButton.disabled) return undefined; const graphs = timeSeriesGraphs(this.series, this.mode, this.groupLayout); const graphCount = Math.max(1, graphs.length); const canvas = document.createElement('canvas'); canvas.width = width; let context = canvas.getContext('2d'); if (!context) return undefined; const legendHeights = Array.from({ length: graphCount }, (_, index) => this.measureGraphLegendHeight(context!, graphs[index] ?? [], width)); const gutters = this.measureAxisGutters(width, false); const contentHeight = gutters.reduce((a, b) => a + b, 0) + graphCount * GRAPH_HEIGHT + legendHeights.reduce((sum, value) => sum + value, 0); const lanes = this.lanesExpanded ? lanesHeight(this.laneItems().length) : 0; const height = Math.max(width >= 1600 ? 900 : 0, 110 + contentHeight + lanes); canvas.height = height; context = canvas.getContext('2d'); if (!context) return undefined;
    context.fillStyle = css('--vscode-editor-background', '#1e1e1e'); context.fillRect(0, 0, width, height); context.fillStyle = css('--vscode-foreground', '#ddd'); context.font = '600 22px sans-serif'; context.fillText(heading, 24, 34); context.font = '12px sans-serif'; const range = timeRangeLabel(this.viewRange.start, this.viewRange.end, formatSeconds); context.fillStyle = css('--vscode-descriptionForeground', '#999'); context.fillText(range, width - context.measureText(range).width - 24, 32);
    const chartTop = 58; this.paintChart(context, width, height, chartTop, height - chartTop - contentHeight, false, legendHeights, gutters); if (lanes) this.paintLanes(context, width, chartTop + contentHeight, false);
    const vector = createSvgCanvas(width, height); const svgContext = vector.context; svgContext.fillStyle = css('--vscode-editor-background', '#1e1e1e'); svgContext.fillRect(0, 0, width, height); svgContext.fillStyle = css('--vscode-foreground', '#ddd'); svgContext.font = '600 22px sans-serif'; svgContext.fillText(heading, 24, 34); svgContext.font = '12px sans-serif'; svgContext.fillStyle = css('--vscode-descriptionForeground', '#999'); svgContext.fillText(range, width - svgContext.measureText(range).width - 24, 32); this.paintChart(svgContext, width, height, chartTop, height - chartTop - contentHeight, false, legendHeights, gutters); if (lanes) this.paintLanes(svgContext, width, chartTop + contentHeight, false);
    return { canvas, pngDataUrl: canvas.toDataURL('image/png'), svg: vector.toSvg(), width, height };
  }
  private paintGraphLegend(context: CanvasRenderingContext2D, groups: readonly TimeSeriesGroup[], width: number, top: number): void {
    context.save(); let x = 24; let y = top + 20; context.font = '12px sans-serif'; groups.forEach((group) => { for (const item of group.items) { const label = signalLegendLabel(item.definition, this.mode, group.displayUnit); const entryWidth = 26 + context.measureText(label).width; if (x + entryWidth > width - 24) { x = 24; y += 20; } context.strokeStyle = this.color(item.definition.id); context.lineWidth = 3; context.beginPath(); context.moveTo(x, y - 4); context.lineTo(x + 16, y - 4); context.stroke(); context.fillStyle = css('--vscode-foreground', '#ddd'); context.fillText(ellipsize(context, label, width - x - 28), x + 22, y); x += Math.min(entryWidth, width - x - 24) + 16; } }); context.restore();
  }
  private measureGraphLegendHeight(context: CanvasRenderingContext2D, groups: readonly TimeSeriesGroup[], width: number): number { context.save(); context.font = '12px sans-serif'; let x = 24; let rows = 1; groups.forEach((group) => { for (const item of group.items) { const label = signalLegendLabel(item.definition, this.mode, group.displayUnit); const entryWidth = 26 + context.measureText(label).width; if (x + entryWidth > width - 24) { x = 24; rows++; } x += Math.min(entryWidth, width - x - 24) + 16; } }); context.restore(); return Math.max(34, 12 + rows * 20); }
  private color(id: string): string { return this.colors.get(id) ?? SIGNAL_COLOR_PRESETS[Math.abs(hash(id)) % SIGNAL_COLOR_PRESETS.length]; }
  private snapshot(): Partial<LogViewState> { return { chartSignalGrouping: this.selector.groupingMode, chartSelectedIds: [...this.selected], chartColors: Object.fromEntries(this.colors), chartMode: this.mode, chartConnectGaps: this.connectGaps, chartAxisRange: this.axisRange, chartGroupLayout: this.groupLayout, chartPaneWidth: this.paneWidth, chartPaneCollapsed: this.paneCollapsed, chartLanesExpanded: this.lanesExpanded }; }
  private persist(): void { this.save(this.snapshot()); }
  private applyPane(): void { const toggle = this.elements.querySelector('.pane-toggle')!; const label = this.paneCollapsed ? t('Show Signal selection', 'シグナル選択を表示') : t('Hide Signal selection', 'シグナル選択を隠す'); toggle.setAttribute('aria-expanded', String(!this.paneCollapsed)); toggle.setAttribute('title', label); toggle.setAttribute('aria-label', label); const glyph = toggle.querySelector('.codicon'); if (glyph) glyph.className = `codicon codicon-${this.paneCollapsed ? 'layout-sidebar-left-off' : 'layout-sidebar-left'}`; this.pane.style.width = this.paneCollapsed ? '0' : `${this.paneWidth}px`; this.pane.style.display = this.paneCollapsed ? 'none' : 'block'; this.separator.style.display = this.paneCollapsed ? 'none' : 'block'; }
  private startPaneResize(event: MouseEvent): void { event.preventDefault(); const start = event.clientX; const initial = this.paneWidth; const move = (next: MouseEvent) => { this.paneWidth = Math.max(180, Math.min(440, initial + next.clientX - start)); this.applyPane(); }; const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); this.persist(); }; this.listenWindow('mousemove', move); this.listenWindow('mouseup', up); }
  private updateModeButtons(): void { for (const [selector, active] of [['.mode-raw', this.mode === 'raw'], ['.mode-normalized', this.mode === 'normalized']] as const) { const button = this.elements.querySelector(selector)!; button.classList.toggle('primary', active); button.setAttribute('aria-pressed', String(active)); } const normalized = this.mode === 'normalized'; this.elements.querySelector<HTMLElement>('.chart-axis-global')!.hidden = normalized;
    const raw = this.elements.querySelector<HTMLButtonElement>('.mode-raw')!;
    const requiresSplit = graphDisplayPolicy([...this.selected], this.catalogDefinitions, this.mode).requiresNormalization;
    raw.disabled = requiresSplit && !this.insertActualViews;
    raw.title = requiresSplit ? this.insertActualViews
      ? t('Split into actual-value graphs', '実値のグラフに分割')
      : t('Select at most two unit systems to use actual values.', '実値表示にするには2単位系以下にしてください。') : '';
   }
}

interface ChartGeometry { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number; readonly width: number; readonly x: (timestamp: number) => number; }
function graphIndexAtOffset(offset: number, legendHeights: readonly number[], gutters: readonly number[] = [], graphHeight = GRAPH_HEIGHT): number | undefined { if (offset < 0) return undefined; let top = 0; for (let index = 0; index < legendHeights.length; index++) { const legendBottom = top + legendHeights[index]; if (offset < legendBottom) return undefined; const graphBottom = legendBottom + graphHeight; if (offset < graphBottom) return index; if (offset < graphBottom + (gutters[index] ?? 0)) return undefined; top = graphBottom + (gutters[index] ?? 0); } return undefined; }
function groupSeriesByCompatibleUnit(series: readonly SignalSeriesDto[], emptyLabel: string): readonly TimeSeriesGroup[] {
  const groups = new Map<string, { key: string; order: number; items: SignalSeriesDto[] }>();
  for (const item of series) {
    const sourceUnit = item.definition.unit?.trim(); const conversion = resolveDisplayUnit(sourceUnit); const key = signalAxisKey(sourceUnit);
    const group = groups.get(key) ?? { key, order: conversion?.order ?? (sourceUnit ? 10_000 : 20_000), items: [] }; group.items.push(item); groups.set(key, group);
  }
  return [...groups.values()].map((group) => { const displayUnit = preferredDisplayUnit(group.items.map((item) => item.definition.unit)); return { ...group, displayUnit, label: displayUnit ?? emptyLabel }; }).sort((left, right) => left.order - right.order || left.label.localeCompare(right.label));
}
function timeSeriesGroups(series: readonly SignalSeriesDto[], mode: 'raw' | 'normalized'): readonly TimeSeriesGroup[] { return mode === 'normalized' ? series.length ? [{ key: 'normalized', label: '0–100%', items: series }] : [] : groupSeriesByCompatibleUnit(series, t('(no unit)', '(単位なし)')); }
function timeSeriesGraphs(series: readonly SignalSeriesDto[], mode: 'raw' | 'normalized', layout?: ChartGroupLayout): readonly (readonly TimeSeriesGroup[])[] { const groups = timeSeriesGroups(series, mode); return groups.length ? [arrangeSingleChartGroups(groups, layout)] : []; }
function timeSeriesGraphSignalIds(graphs: readonly (readonly TimeSeriesGroup[])[]): readonly string[][] { return graphs.map((graph) => [...new Set(graph.flatMap((group) => group.items.map((item) => item.definition.id)))]); }
function normalizeChartGroupLayout(layout: ChartGroupLayout | undefined): string[][] | undefined {
  const keys = [...new Set(layout?.flat().filter((key) => typeof key === 'string' && key) ?? [])];
  return keys.length ? [keys] : undefined;
}
function reconcileViewRange(view: { readonly start: number; readonly end: number } | undefined, full: { readonly start: number; readonly end: number } | undefined): { start: number; end: number } | undefined { if (!full || !view) return full; const fullSpan = full.end - full.start; const span = Math.min(fullSpan, Math.max(0, view.end - view.start)); if (span >= fullSpan || view.end < full.start || view.start > full.end) return full; let start = Math.max(full.start, Math.min(view.start, full.end - span)); return { start, end: start + span }; }
function seriesDisplayValue(item: SignalSeriesDto, value: number, mode: 'raw' | 'normalized', displayUnit?: string): number { return mode === 'normalized' ? normalizeValue(value, item.globalMinimum ?? value, item.globalMaximum ?? value) : convertDisplayUnit(value, item.definition.unit, displayUnit); }
function displayValueLabel(item: SignalSeriesDto, value: number, mode: 'raw' | 'normalized', displayUnit?: string): string { const unit = (mode === 'normalized' ? item.definition.unit : displayUnit)?.trim(); const actual = mode === 'normalized' ? value : convertDisplayUnit(value, item.definition.unit, displayUnit); return `${formatNumber(actual)}${unit ? ` ${unit}` : ''}`; }
function signalLegendLabel(definition: SignalDefinition, mode: 'raw' | 'normalized', displayUnit?: string): string { const sourceUnit = definition.unit?.trim(); const unit = mode === 'raw' && displayUnit && sourceUnit && displayUnit !== sourceUnit ? `${sourceUnit} → ${displayUnit}` : sourceUnit; return `${definition.name}${unit ? ` (${unit})` : ''}`; }
function ellipsize(context: CanvasRenderingContext2D, text: string, maxWidth: number): string { if (context.measureText(text).width <= maxWidth) return text; let low = 0; let high = text.length; while (low < high) { const middle = Math.ceil((low + high) / 2); if (context.measureText(`${text.slice(0, middle)}…`).width <= maxWidth) low = middle; else high = middle - 1; } return `${text.slice(0, low)}…`; }
function css(name: string, fallback: string): string { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback; }
/** Times in seconds: seven significant digits, but never rounding the whole seconds of a large (Unix) time. */
function formatSeconds(value: number): string { return Number.isFinite(value) && Math.abs(value) >= 1e5 ? Number(value.toFixed(6)).toString() : formatNumber(value); }
function formatNumber(value: number): string { if (!Number.isFinite(value)) return '—'; if (Number.isInteger(value)) return String(value); return Number(value.toPrecision(7)).toString(); }
function initialAxisRange(initial: LogViewState | undefined): ChartAxisRangeSetting {
  if (initial?.chartAxisRange) return { mode: initial.chartAxisRange.mode === 'global' ? 'global' : 'visible', includeZero: initial.chartAxisRange.includeZero === true };
  const previous = Object.values(initial?.chartAxisRanges ?? {});
  return { mode: previous.length > 0 && previous.every((setting) => setting.mode === 'global') ? 'global' : 'visible', includeZero: previous.length > 0 && previous.every((setting) => setting.includeZero === true) };
}
function fieldLabel(text: string): HTMLLabelElement { const label = document.createElement('label'); label.className = 'external-field-label'; label.textContent = text; return label; }
function hash(value: string): number { let result = 0; for (const character of value) result = ((result << 5) - result + character.charCodeAt(0)) | 0; return result; }
function nearestFromSlice(samples: readonly SignalSample[], timestamp: number): SignalSample | undefined { let best: SignalSample | undefined; let distance = Infinity; for (const sample of samples) { const next = Math.abs(sample.timestamp - timestamp); if (next < distance) { best = sample; distance = next; } } return best; }
