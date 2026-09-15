import { normalizeValue } from '../../core/timeline/timeline';
import type { SignalDefinition, SignalSample } from '../../core/signal/signal';
import type { ChartAxisRangeSetting, ExternalCsvPreviewDto, LogViewState, SignalSeriesDto, ToExtensionMessage, ToWebviewMessage } from '../../extension/editors/rawLogProtocol';
import { SIGNAL_COLOR_PRESETS, SignalSelector } from '../shared/signalSelector';
import { bindPressRepeat } from '../shared/pressRepeat';
import type { TimelineController } from '../shared/timelineController';
import { t } from '../shared/i18n';
import { convertDisplayUnit, preferredDisplayUnit, resolveDisplayUnit } from '../../core/units/displayUnit';
import { crossesSeriesGap, displaySeriesRange, interpolatedSeriesSample } from '../shared/chartSeries';
import { MeasuredSamples, measuredValueLabel, type MeasuredSampleQuery } from '../shared/measuredSamples';
import { chartWheelGesture } from '../shared/chartWheel';
import { emphasizeSignal } from '../shared/signalEmphasis';
import { arrangeChartGroups, findGraphIndexBySignals, moveChartGroup, moveChartGroupToNewGraph, type ChartGroupLayout } from '../shared/chartLayout';
import { layoutHoverLabelBoxes, layoutTimestampMarker, timestampGutter, paintTimestampConnector, type HoverLabelRect } from '../shared/chartHoverLabels';
import { createSvgCanvas } from '../shared/svgCanvas';
import { iconButton, secondaryToolbar } from '../shared/iconButton';

interface ChartMarker { readonly id: string; readonly timestamp: number; readonly signalIds: readonly string[]; }
interface TimeSeriesGroup { readonly key: string; readonly label: string; readonly displayUnit?: string; readonly items: readonly SignalSeriesDto[]; }
interface CanvasHoverValue { readonly y: number; readonly sampleX: number; readonly sampleY: number; readonly text: string; readonly color: string; readonly lineDash?: number[]; }
interface CanvasTimestampMarker { readonly cursorX: number; readonly bottom: number; readonly text: string; readonly rect: HoverLabelRect; readonly emphasized?: boolean; }

const CHART_LEFT = 92;
const CHART_RIGHT = 92;
const GRAPH_HEIGHT = 320;

export class TimeSeriesView {
  private readonly selected: Set<string>;
  private readonly colors: Map<string, string>;
  private mode: 'raw' | 'normalized';
  private connectGaps: boolean;
  private axisRange: ChartAxisRangeSetting;
  private groupLayout: string[][] | undefined;
  private layoutEditorOpen = false;
  private draggedGroupKey: string | undefined;
  private highlightedSignalId: string | undefined;
  private paneWidth: number;
  private paneCollapsed: boolean;
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
  private readonly status: HTMLElement;
  private readonly saveImageButton: HTMLButtonElement;
  private pendingImport: (ExternalCsvPreviewDto & { timestampColumn: string; timestampUnit: 'seconds' | 'milliseconds' | 'microseconds'; selectedColumns: Set<string>; units: Map<string, string> }) | undefined;

  constructor(
    private readonly host: HTMLElement,
    initial: LogViewState | undefined,
    private readonly post: (message: ToExtensionMessage) => void,
    private readonly save: (partial: Partial<LogViewState>) => void,
    private readonly timeline?: TimelineController
  ) {
    this.measured = new MeasuredSamples((requestId, query) => this.post({ type: 'measuredSignalsRequest', requestId, selectedIds: query.signalIds, timestamp: query.timestamp }), () => this.scheduleInteractionDraw());
    this.selected = new Set(initial?.chartSelectedIds ?? []);
    this.colors = new Map(Object.entries(initial?.chartColors ?? {}));
    this.mode = initial?.chartMode ?? 'raw'; this.connectGaps = initial?.chartConnectGaps !== false; this.axisRange = initialAxisRange(initial); this.groupLayout = normalizeChartGroupLayout(initial?.chartGroupLayout); this.paneWidth = initial?.chartPaneWidth ?? 250; this.paneCollapsed = initial?.chartPaneCollapsed ?? false;
    host.innerHTML = `<div class="chart-layout"><aside class="signal-pane chart-pane"><div class="chart-source-actions"><button class="import-external-csv">+ ${t('External CSV…', '外部CSV…')}</button></div><div class="external-import-host"></div><div class="chart-selector"></div></aside><div class="pane-separator"></div><section class="signal-main chart-main"><div class="view-toolbar"><button class="pane-toggle">${t('Signals', 'Signal')}</button><div class="segmented"><button class="mode-raw">${t('Actual (converted units)', '実値（単位換算）')}</button><button class="mode-normalized">${t('Normalized 0–100%', '正規化 0–100%')}</button></div><label class="chart-option"><input class="connect-gaps" type="checkbox">${t('Connect gaps', '欠損を補完')}</label><span class="chart-axis-global"><label class="chart-axis-mode">${t('Y axis', 'Y軸')}<select class="axis-range-mode" aria-label="${t('Y-axis range for all graphs', '全グラフのY軸範囲')}"><option value="visible">${t('Visible interval', '表示区間')}</option><option value="global">${t('All data', '全データ')}</option></select></label><label class="chart-option"><input class="axis-include-zero" type="checkbox">${t('Include 0', '0を含める')}</label></span><button class="save-chart-image">${t('Save Image…', '画像を保存…')}</button><span class="spacer"></span><span class="chart-status muted">${t('Select Signals', 'Signalを選択')}</span><button class="analysis-cancel" hidden>${t('Cancel analysis', '解析を中止')}</button></div><div class="view-toolbar chart-navigation"><div class="segmented"><button class="zoom-out">−</button><button class="zoom-in">＋</button></div><button class="zoom-reset" disabled>${t('Reset Zoom', 'ズームをリセット')}</button><span class="view-range muted"></span><span class="spacer"></span><button class="chart-marker-clear" disabled>${t('Clear Markers', 'マーカーを全解除')}</button></div><div class="view-toolbar range-controls" hidden><strong>${t('Selected range', '選択範囲')}</strong><span class="clip-range muted"></span><span class="spacer"></span><span class="clip-edge-label">${t('Start', '開始')}</span><div class="segmented"><button class="clip-start-prev" title="${t('Previous CAN Timestamp', '前のCANタイムスタンプ')}">◀</button><button class="clip-start-next" title="${t('Next CAN Timestamp', '次のCANタイムスタンプ')}">▶</button></div><span class="clip-edge-label">${t('End', '終了')}</span><div class="segmented"><button class="clip-end-prev" title="${t('Previous CAN Timestamp', '前のCANタイムスタンプ')}">◀</button><button class="clip-end-next" title="${t('Next CAN Timestamp', '次のCANタイムスタンプ')}">▶</button></div><div class="range-actions segmented"><button class="range-zoom primary">${t('Zoom to Range', '選択範囲を拡大')}</button><button class="clip-create">${t('Create Clip', 'クリップ作成')}</button></div><button class="clip-clear" title="${t('Clear selected range', '選択範囲を解除')}" aria-label="${t('Clear selected range', '選択範囲を解除')}">×</button></div><div class="chart-canvas-wrap"><canvas aria-label="${t('Time-series graph. Click to add a marker; drag to select a range.', '時系列グラフ。クリックでマーカー追加、ドラッグで範囲選択。')}"></canvas><div class="chart-legend"></div><div class="chart-markers"></div></div></section></div>`;
    host.querySelector('.save-chart-image')!.insertAdjacentHTML('beforebegin', `<button class="chart-layout-toggle" aria-expanded="false">${t('Graph Layout…', 'グラフ構成…')}</button>`);
    host.querySelector('.chart-canvas-wrap')!.insertAdjacentHTML('beforebegin', `<section class="chart-layout-editor" hidden><div class="chart-layout-editor-head"><strong>${t('Graph Layout', 'グラフ構成')}</strong><span class="muted">${t('Drag each unit system to a left or right axis.', '各単位系統を左右の軸へドラッグ')}</span><span class="spacer"></span><button class="chart-layout-auto">${t('Automatic Layout', '自動配置')}</button></div><div class="chart-layout-cards"></div></section>`);
    this.canvas = host.querySelector('canvas')!; this.pane = host.querySelector('.chart-pane')!; this.separator = host.querySelector('.pane-separator')!; this.status = host.querySelector('.chart-status')!; this.saveImageButton = host.querySelector('.save-chart-image')!;
    const mainToolbar = host.querySelector<HTMLElement>('.chart-main>.view-toolbar')!; const paneToggle = iconButton(host.querySelector<HTMLButtonElement>('.pane-toggle')!, 'layout-sidebar-left', t('Toggle Signal selection', 'Signal選択を表示／非表示')); const layoutToggle = iconButton(host.querySelector<HTMLButtonElement>('.chart-layout-toggle')!, 'layout', t('Graph layout', 'グラフ構成')); iconButton(this.saveImageButton, 'export', t('Save image', '画像を保存')); const secondary = secondaryToolbar(paneToggle, layoutToggle, this.saveImageButton); secondary.setAttribute('aria-label', t('Secondary actions', '補助操作')); mainToolbar.appendChild(secondary);
    this.selector = new SignalSelector({
      host: host.querySelector('.chart-selector')!, selected: this.selected, colors: this.colors,
      grouping: initial?.chartSignalGrouping, onGroupingChange: () => this.persist(),
      onSelectionChange: () => this.selectionChanged(), onColorChange: () => { this.persist(); this.draw(); },
      onRemoveSignal: (definition, group) => this.removeExternalSignal(definition, group),
      onHighlightChange: (id) => this.highlightSignal(id),
    });
    host.querySelector('.pane-toggle')!.addEventListener('click', () => { this.paneCollapsed = !this.paneCollapsed; this.applyPane(); this.persist(); });
    host.querySelector('.mode-raw')!.addEventListener('click', () => { this.mode = 'raw'; this.persist(); this.updateModeButtons(); this.draw(); });
    host.querySelector('.mode-normalized')!.addEventListener('click', () => { this.mode = 'normalized'; this.persist(); this.updateModeButtons(); this.draw(); });
    const connectGaps = host.querySelector<HTMLInputElement>('.connect-gaps')!; connectGaps.checked = this.connectGaps; connectGaps.addEventListener('change', () => { this.connectGaps = connectGaps.checked; this.persist(); this.draw(); });
    const axisMode = host.querySelector<HTMLSelectElement>('.axis-range-mode')!; axisMode.value = this.axisRange.mode === 'global' ? 'global' : 'visible'; axisMode.addEventListener('change', () => { this.axisRange = { ...this.axisRange, mode: axisMode.value as 'visible' | 'global' }; this.persist(); this.draw(); });
    const includeZero = host.querySelector<HTMLInputElement>('.axis-include-zero')!; includeZero.checked = this.axisRange.includeZero === true; includeZero.addEventListener('change', () => { this.axisRange = { ...this.axisRange, includeZero: includeZero.checked }; this.persist(); this.draw(); });
    host.querySelector('.chart-layout-toggle')!.addEventListener('click', () => { this.layoutEditorOpen = !this.layoutEditorOpen; this.updateModeButtons(); this.renderLayoutEditor(); });
    host.querySelector('.chart-layout-auto')!.addEventListener('click', () => { this.groupLayout = undefined; this.persist(); this.draw(); });
    this.saveImageButton.addEventListener('click', () => this.saveImage());
    for (const [selector, label, action] of [['.zoom-in', t('Zoom in; hold to repeat', '拡大・長押しで連続'), () => this.zoom(1 / 1.5)], ['.zoom-out', t('Zoom out; hold to repeat', '縮小・長押しで連続'), () => this.zoom(1.5)]] as const) { const button = host.querySelector<HTMLButtonElement>(selector)!; button.setAttribute('title', label); button.setAttribute('aria-label', label); bindPressRepeat(button, action, { intervalMs: 180 }); }
    const zoomReset = host.querySelector<HTMLButtonElement>('.zoom-reset')!; zoomReset.textContent = '↺'; zoomReset.title = t('Reset zoom', 'ズームをリセット'); zoomReset.setAttribute('aria-label', zoomReset.title); host.querySelector('.chart-navigation .segmented')!.appendChild(zoomReset); zoomReset.addEventListener('click', () => this.requestSeries(this.fullRange));
    iconButton(host.querySelector<HTMLButtonElement>('.chart-marker-clear')!, 'clear-all', t('Clear markers', 'マーカーを全解除'));
    host.querySelector('.analysis-cancel')!.addEventListener('click', () => this.post({ type: 'cancelAnalysis' }));
    host.querySelector('.import-external-csv')!.addEventListener('click', () => this.beginExternalImport());
    host.querySelector('.clip-clear')!.addEventListener('click', () => this.clearRangeSelection());
    const rangeZoom = host.querySelector<HTMLButtonElement>('.range-zoom')!; rangeZoom.textContent = t('Zoom', '拡大'); rangeZoom.addEventListener('click', () => this.zoomToSelectedRange());
    host.querySelector('.chart-marker-clear')!.addEventListener('click', () => { this.markers.clear(); this.updateMarkerControls(); this.draw(false); });
    const clipCreate = host.querySelector<HTMLButtonElement>('.clip-create')!; clipCreate.textContent = t('Create Clip', 'クリップ作成'); clipCreate.addEventListener('click', () => { if (this.selectedRange) this.post({ type: 'createClip', startTimestamp: this.selectedRange.start, endTimestamp: this.selectedRange.end, signalIds: [...this.selected] }); });
    for (const [selector, label] of [['.clip-start-prev', t('Move start to previous CAN Timestamp', '開始を前のCANタイムスタンプへ移動')], ['.clip-start-next', t('Move start to next CAN Timestamp', '開始を次のCANタイムスタンプへ移動')], ['.clip-end-prev', t('Move end to previous CAN Timestamp', '終了を前のCANタイムスタンプへ移動')], ['.clip-end-next', t('Move end to next CAN Timestamp', '終了を次のCANタイムスタンプへ移動')]] as const) host.querySelector(selector)!.setAttribute('aria-label', label);
    for (const [selector, edge, direction] of [['.clip-start-prev', 'start', -1], ['.clip-start-next', 'start', 1], ['.clip-end-prev', 'end', -1], ['.clip-end-next', 'end', 1]] as const) bindPressRepeat(host.querySelector<HTMLButtonElement>(selector)!, () => this.adjustRange(edge, direction));
    this.separator.addEventListener('mousedown', (event) => this.startPaneResize(event));
    this.canvas.addEventListener('wheel', (event) => this.handleWheel(event), { passive: false });
    this.canvas.addEventListener('mousedown', (event) => this.beginRangeSelection(event));
    this.canvas.addEventListener('mousemove', (event) => { if (this.selectionAnchor !== undefined) this.updateRangeSelection(event); else this.hover(event); });
    this.canvas.addEventListener('mouseup', (event) => this.endRangeSelection(event));
    this.canvas.addEventListener('click', (event) => this.addMarker(event));
    this.canvas.addEventListener('mouseleave', () => { if (this.selectionAnchor !== undefined) return; this.cursorTimestamp = undefined; this.hoverGraphIndex = undefined; this.draw(false); });
    window.addEventListener('mouseup', (event) => { if (this.selectionAnchor !== undefined && event.target !== this.canvas) this.endRangeSelection(event); });
    new ResizeObserver(() => this.draw()).observe(host.querySelector('.chart-canvas-wrap')!);
    this.applyPane(); this.updateModeButtons(); this.updateRangeControls(); this.updateMarkerControls(); this.updateStatus();
    this.timeline?.subscribe((timestamp, source) => { if (source === 'timeSeries') return; this.cursorTimestamp = timestamp; if (this.visible && this.selected.size) this.scheduleInteractionDraw(); });
  }

  show(): void {
    const wasVisible = this.visible; this.visible = true;
    if (!this.catalogRequested) { this.catalogRequested = true; this.latestCatalogRequest = ++this.counter; this.post({ type: 'signalCatalogRequest', requestId: this.latestCatalogRequest, view: 'timeSeries' }); }
    else if (!wasVisible && this.selected.size) this.requestSeries();
    this.draw();
  }
  hide(): void { this.visible = false; this.cursorTimestamp = undefined; this.hoverGraphIndex = undefined; this.measured.update([]); }

  handle(message: ToWebviewMessage): void {
    if (message.type === 'measuredSignals') {
      this.measured.receive(message.requestId, message.samples);
    } else if (message.type === 'externalCsvPreview') {
      this.pendingImport = { ...message, timestampColumn: message.suggestedTimestampColumn ?? message.headers[0] ?? '', timestampUnit: message.suggestedTimestampUnit, selectedColumns: new Set(), units: new Map() };
      this.renderImportWizard();
    } else if (message.type === 'signalCatalog' && message.requestId === this.latestCatalogRequest) {
      const valid = new Set(message.definitions.map((item) => item.id)); let selectionChanged = false;
      for (const id of [...this.selected]) if (!valid.has(id)) { this.selected.delete(id); selectionChanged = true; }
      message.definitions.forEach((definition, index) => { if (!this.colors.has(definition.id)) this.colors.set(definition.id, SIGNAL_COLOR_PRESETS[index % SIGNAL_COLOR_PRESETS.length]); });
      this.selector.setCatalog(message.definitions, message.groups); if (selectionChanged) this.persist(); if (this.selected.size) this.requestSeries(); else { this.updateStatus(); this.updateZoomControls(); this.draw(); }
    } else if (message.type === 'signalSeries' && message.requestId === this.latestSeriesRequest) {
      this.measured.invalidate();
      this.seriesPending = false; this.series = message.series; this.fullRange = message.fullRange;
      this.viewRange = reconcileViewRange(this.requestedViewRange ?? this.viewRange, this.fullRange); this.requestedViewRange = undefined;
      this.updateStatus(); this.updateZoomControls();
      this.draw();
    } else if (message.type === 'analysisProgress') {
      const percent = message.total ? Math.floor(message.processed / message.total * 100) : 100; this.status.textContent = `${t('Analyzing', '解析中')} ${percent}% · ${message.processed.toLocaleString()} ${t('frames', 'フレーム')}`; (this.host.querySelector('.analysis-cancel') as HTMLButtonElement).hidden = false;
    } else if (message.type === 'analysisComplete') {
      (this.host.querySelector('.analysis-cancel') as HTMLButtonElement).hidden = true; if (this.visible && this.selected.size) this.requestSeries(); else this.updateStatus();
    } else if (message.type === 'definitionsChanged') {
      this.measured.invalidate();
      this.catalogRequested = false; this.seriesPending = this.selected.size > 0; this.series = []; this.fullRange = undefined; this.viewRange = undefined; this.requestedViewRange = undefined; this.updateStatus(); this.updateZoomControls(); if (this.visible) this.show();
    } else if (message.type === 'clipCreated') {
      this.clearRangeSelection();
    } else if (message.type === 'timeRangeAdjusted' && message.requestId === this.latestRangeRequest) {
      this.rangePending = false; this.selectedRange = { start: message.startTimestamp, end: message.endTimestamp }; const edge = this.activeRangeEdge; if (edge) this.cursorTimestamp = this.selectedRange[edge]; this.hoverGraphIndex = findGraphIndexBySignals(timeSeriesGraphSignalIds(timeSeriesGraphs(this.series, this.mode, this.groupLayout)), this.rangeSignalIds); this.updateRangeControls(); this.draw(false);
    } else if (message.type === 'progress' && this.visible && this.selected.size) this.scheduleSeriesRefresh();
    else if (message.type === 'parseComplete' && this.visible && this.selected.size) this.requestSeries();
  }

  private selectionChanged(): void { this.series = []; this.persist(); this.updateRangeControls(); this.requestSeries(); }
  private beginExternalImport(): void {
    if (this.pendingImport) this.post({ type: 'cancelExternalCsvImport', importId: this.pendingImport.importId });
    this.pendingImport = undefined; this.renderImportWizard(); this.post({ type: 'importExternalCsv' });
  }
  private renderImportWizard(): void {
    const host = this.host.querySelector('.external-import-host')!; host.replaceChildren(); const pending = this.pendingImport;
    if (!pending) return;
    const box = document.createElement('section'); box.className = 'external-import-card';
    const title = document.createElement('strong'); title.textContent = pending.fileName; title.title = pending.fileName; box.appendChild(title);
    box.appendChild(fieldLabel(t('Timestamp column', '時刻列')));
    const timestamp = document.createElement('select'); timestamp.setAttribute('aria-label', t('CSV Timestamp column', 'CSVの時刻列'));
    for (const header of pending.headers) { const option = document.createElement('option'); option.value = header; option.textContent = header || t('(unnamed column)', '(名前なしの列)'); option.selected = header === pending.timestampColumn; timestamp.appendChild(option); }
    timestamp.addEventListener('change', () => { pending.timestampColumn = timestamp.value; pending.selectedColumns.delete(timestamp.value); this.renderImportWizard(); }); box.appendChild(timestamp);
    box.appendChild(fieldLabel(t('Timestamp unit', '時刻単位')));
    const timestampUnit = document.createElement('select'); timestampUnit.setAttribute('aria-label', t('CSV Timestamp unit', 'CSVの時刻単位'));
    for (const [value, label] of [['seconds', 'seconds (s)'], ['milliseconds', 'milliseconds (ms)'], ['microseconds', 'microseconds (µs)']] as const) { const option = document.createElement('option'); option.value = value; option.textContent = label; option.selected = value === pending.timestampUnit; timestampUnit.appendChild(option); }
    timestampUnit.addEventListener('change', () => { pending.timestampUnit = timestampUnit.value as typeof pending.timestampUnit; }); box.appendChild(timestampUnit);
    const columnsLabel = fieldLabel(t('Value columns and units', '値の列と単位')); columnsLabel.classList.add('external-columns-label'); box.appendChild(columnsLabel);
    const columns = document.createElement('div'); columns.className = 'external-column-list'; box.appendChild(columns);
    const actions = document.createElement('div'); actions.className = 'external-import-actions';
    const add = document.createElement('button'); add.type = 'button'; add.className = 'primary'; add.textContent = t('Add to graph', 'グラフへ追加');
    const updateAdd = () => { add.disabled = pending.selectedColumns.size === 0 || !pending.timestampColumn; }; updateAdd();
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
      this.post({ type: 'commitExternalCsv', importId: pending.importId, timestampColumn: pending.timestampColumn, timestampUnit: pending.timestampUnit, valueColumns: [...pending.selectedColumns].map((column) => ({ column, name: column, unit: pending.units.get(column)?.trim() || undefined })) });
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
  private requestSeries(range = this.viewRange): void { if (!this.selected.size) { this.seriesPending = false; this.series = []; this.fullRange = undefined; this.viewRange = undefined; this.requestedViewRange = undefined; this.updateStatus(); this.updateZoomControls(); this.draw(); return; } this.seriesPending = true; this.requestedViewRange = range ? { ...range } : undefined; this.updateStatus(); this.updateExportAction(); this.latestSeriesRequest = ++this.counter; this.post({ type: 'signalSeriesRequest', requestId: this.latestSeriesRequest, selectedIds: [...this.selected], range: this.requestedViewRange, maxPoints: 4000 }); if (!this.series.length) this.draw(); }
  private scheduleSeriesRefresh(): void { if (this.refreshTimer !== undefined) return; this.refreshTimer = window.setTimeout(() => { this.refreshTimer = undefined; if (this.visible) this.requestSeries(); }, 250); }

  private zoom(factor: number, centerTimestamp?: number): void {
    if (!this.fullRange) return; const current = this.requestedViewRange ?? this.viewRange ?? this.fullRange; const fullSpan = this.fullRange.end - this.fullRange.start || 1; const center = (current.start + current.end) / 2; const span = Math.max(fullSpan * 0.005, Math.min(fullSpan, (current.end - current.start || fullSpan) * factor));
    const pivot = centerTimestamp ?? center; const ratio = (pivot - current.start) / (current.end - current.start || 1); let start = pivot - span * ratio; let end = start + span; if (start < this.fullRange.start) { start = this.fullRange.start; end = start + span; } if (end > this.fullRange.end) { end = this.fullRange.end; start = end - span; }
    this.requestSeries({ start, end });
  }

  private handleWheel(event: WheelEvent): void {
    if (!this.fullRange || !this.viewRange) return; const gesture = chartWheelGesture(event, this.canvas.clientWidth);
    if (gesture.kind === 'scroll') return;
    if (!gesture.delta) return;
    if (gesture.kind === 'zoom') { event.preventDefault(); const timestamp = this.timestampAt(event as unknown as MouseEvent); const factor = gesture.delta < 0 ? 1 / 1.5 : 1.5; this.scheduleViewportNavigation(() => this.zoom(factor, timestamp)); return; }
    const fullSpan = this.fullRange.end - this.fullRange.start; const span = this.viewRange.end - this.viewRange.start; if (span >= fullSpan - 1e-12) return; event.preventDefault(); const direction = Math.sign(gesture.delta); this.scheduleViewportNavigation(() => this.panStep(direction));
  }

  private panStep(direction: number): void {
    if (!this.fullRange || !this.viewRange || !direction) return; const span = this.viewRange.end - this.viewRange.start; const shift = Math.sign(direction) * span * .18; let start = this.viewRange.start + shift; let end = this.viewRange.end + shift; if (start < this.fullRange.start) { start = this.fullRange.start; end = start + span; } if (end > this.fullRange.end) { end = this.fullRange.end; start = end - span; } this.requestSeries({ start, end });
  }

  private scheduleViewportNavigation(action: () => void): void { window.clearTimeout(this.viewportRequestTimer); this.viewportRequestTimer = window.setTimeout(() => { this.viewportRequestTimer = undefined; if (this.visible) action(); }, 100); }

  private timestampAt(event: MouseEvent): number | undefined {
    if (!this.viewRange) return undefined; const rect = this.canvas.getBoundingClientRect(); const left = CHART_LEFT; const width = rect.width - left - CHART_RIGHT;
    if (event.clientX < rect.left + left || event.clientX > rect.left + left + width) return undefined;
    const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left - left) / width));
    return this.viewRange.start + fraction * (this.viewRange.end - this.viewRange.start);
  }
  private beginRangeSelection(event: MouseEvent): void {
    if (event.button !== 0) return; const timestamp = this.timestampAt(event); if (timestamp === undefined) return;
    const rect = this.canvas.getBoundingClientRect(); const graphIndex = graphIndexAtOffset(event.clientY - rect.top - 16, this.legendHeights, this.axisGutters); if (graphIndex === undefined) return;
    const signalIds = timeSeriesGraphSignalIds(timeSeriesGraphs(this.series, this.mode, this.groupLayout))[graphIndex]; if (!signalIds?.length) return;
    this.selectionAnchor = timestamp; this.selectionAnchorClientX = event.clientX; this.selectionGraphIndex = graphIndex; this.rangeSignalIds = signalIds; this.activeRangeEdge = 'end'; this.rangeDragged = false; this.rangePending = false; this.selectedRange = { start: timestamp, end: timestamp }; this.cursorTimestamp = timestamp; this.hoverGraphIndex = graphIndex; this.timeline?.set(timestamp, 'timeSeries'); event.preventDefault(); this.updateRangeControls(); this.draw(false);
  }
  private updateRangeSelection(event: MouseEvent): void {
    const timestamp = this.timestampAt(event); if (timestamp === undefined || this.selectionAnchor === undefined) return;
    if (this.selectionAnchorClientX !== undefined && Math.abs(event.clientX - this.selectionAnchorClientX) > 6) this.rangeDragged = true;
    this.selectedRange = { start: Math.min(this.selectionAnchor, timestamp), end: Math.max(this.selectionAnchor, timestamp) }; this.activeRangeEdge = timestamp < this.selectionAnchor ? 'start' : 'end'; this.cursorTimestamp = timestamp; this.hoverGraphIndex = this.selectionGraphIndex; this.timeline?.set(timestamp, 'timeSeries'); this.scheduleInteractionDraw();
  }
  private endRangeSelection(event: MouseEvent): void {
    if (this.selectionAnchor === undefined) return; this.updateRangeSelection(event); this.suppressNextClick = this.rangeDragged; this.selectionAnchor = undefined; this.selectionAnchorClientX = undefined;
    if (!this.rangeDragged) this.selectedRange = undefined;
    else if (this.selectedRange) { this.rangePending = true; this.latestRangeRequest = ++this.counter; this.post({ type: 'snapTimeRangeRequest', requestId: this.latestRangeRequest, startTimestamp: this.selectedRange.start, endTimestamp: this.selectedRange.end }); }
    this.selectionGraphIndex = undefined;
    this.updateRangeControls(); this.draw();
  }
  private updateRangeControls(): void {
    const range = this.selectedRange; const valid = Boolean(range && range.end > range.start && this.selected.size && !this.rangePending);
    const controls = this.host.querySelector<HTMLElement>('.range-controls')!; const visible = Boolean(range && this.selectionAnchor === undefined); controls.hidden = !visible;
    this.host.querySelector<HTMLElement>('.chart-navigation')!.hidden = visible;
    (this.host.querySelector('.range-zoom') as HTMLButtonElement).disabled = !valid;
    (this.host.querySelector('.clip-create') as HTMLButtonElement).disabled = !valid;
    this.host.querySelectorAll<HTMLButtonElement>('.clip-start-prev,.clip-start-next,.clip-end-prev,.clip-end-next').forEach((button) => { button.disabled = !range || this.rangePending; });
    if (range) this.host.querySelector('.clip-range')!.textContent = `${formatNumber(range.start)}–${formatNumber(range.end)} s · ${formatNumber(range.end - range.start)} s`;
  }

  private zoomToSelectedRange(): void {
    const range = this.selectedRange; if (!range || !(range.end > range.start)) return;
    const target = { ...range }; this.clearRangeSelection(false); this.draw(false); this.requestSeries(target);
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
    if (!this.visible) return; const wrapper = this.canvas.parentElement!; const width = Math.max(320, wrapper.clientWidth); const graphCount = Math.max(1, timeSeriesGraphs(this.series, this.mode, this.groupLayout).length); if (renderControls || this.legendHeights.length !== graphCount) this.legendHeights = this.renderLegend(width); if (renderControls) this.renderLayoutEditor(); this.axisGutters = this.measureAxisGutters(width, true); let legendTop = 16; this.host.querySelectorAll<HTMLElement>('.chart-legend-group').forEach((row, index) => { row.style.top = `${legendTop}px`; legendTop += (this.legendHeights[index] ?? 0) + GRAPH_HEIGHT + (this.axisGutters[index] ?? 0); }); const contentHeight = this.axisGutters.reduce((a, b) => a + b, 0) + graphCount * GRAPH_HEIGHT + this.legendHeights.reduce((sum, value) => sum + value, 0); const height = 16 + contentHeight + 34; const ratio = window.devicePixelRatio || 1; this.canvas.width = width * ratio; this.canvas.height = height * ratio; this.canvas.style.width = `${width}px`; this.canvas.style.height = `${height}px`; const context = this.canvas.getContext('2d')!; context.scale(ratio, ratio); context.clearRect(0, 0, width, height); context.fillStyle = css('--vscode-editor-background', '#1e1e1e'); context.fillRect(0, 0, width, height); if (renderControls) this.updateZoomControls();
    if (!this.series.length || !this.viewRange) { context.font = '12px sans-serif'; context.fillStyle = css('--vscode-descriptionForeground', '#888'); context.fillText(this.seriesPending ? t('Loading selected Signals…', '選択したSignalを読み込んでいます…') : this.selected.size ? t('No samples in this range.', 'この範囲にサンプルがありません。') : t('Select Signals from the left pane.', '左側からSignalを選択してください。'), 24, 34); this.updateExportAction(); return; }
    this.paintChart(context, width, height, 16, 34, true, this.legendHeights); this.updateExportAction();
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
    if (!this.series.length || !this.viewRange) return undefined; const left = CHART_LEFT; const right = CHART_RIGHT; const plotW = Math.max(1, width - left - right); const plotH = Math.max(1, height - top - bottom); const x = (timestamp: number) => left + (timestamp - this.viewRange!.start) / (this.viewRange!.end - this.viewRange!.start || 1) * plotW;
    const graphs = timeSeriesGraphs(this.series, this.mode, this.groupLayout); const graphSignalIds = timeSeriesGraphSignalIds(graphs); const rangeGraphIndex = findGraphIndexBySignals(graphSignalIds, this.rangeSignalIds); const graphCount = Math.max(1, graphs.length); let precedingHeight = 0; context.font = '11px sans-serif'; context.lineWidth = 1;
    const cursorTimestamp = this.cursorTimestamp;
    const markers = [...this.markers.values()].flatMap((marker) => { const timestamp = this.measured.referenceTimestamp(`marker:${marker.id}`); return timestamp === undefined ? [] : [{ ...marker, timestamp }]; });
    for (let graphIndex = 0; graphIndex < graphCount; graphIndex++) {
      const legendHeight = legendHeights[graphIndex] ?? 0; const blockTop = top + precedingHeight; const graphTop = blockTop + legendHeight; const laneTop = graphTop + 30; const laneHeight = GRAPH_HEIGHT - 58; const pair = graphs[graphIndex] ?? []; const hoverValues: CanvasHoverValue[] = []; const markerValues = new Map<string, CanvasHoverValue[]>(); if (!interactions) this.paintGraphLegend(context, pair, graphIndex, width, blockTop); precedingHeight += legendHeight + GRAPH_HEIGHT + (gutters[graphIndex] ?? 0);
      context.strokeStyle = css('--vscode-panel-border', '#777'); context.strokeRect(left, laneTop, plotW, laneHeight);
      for (let tick = 0; tick <= 5; tick++) { const px = left + plotW * tick / 5; context.globalAlpha = .48; context.beginPath(); context.moveTo(px, laneTop); context.lineTo(px, laneTop + laneHeight); context.stroke(); context.globalAlpha = 1; const timestamp = this.viewRange.start + (this.viewRange.end - this.viewRange.start) * tick / 5; const label = `${formatNumber(timestamp)}s`; const labelWidth = context.measureText(label).width; context.fillStyle = css('--vscode-descriptionForeground', '#888'); context.fillText(label, Math.max(left, Math.min(left + plotW - labelWidth, px - labelWidth / 2)), laneTop + laneHeight + 20); }
      pair.forEach((group, axisIndex) => {
        const range = this.mode === 'normalized' ? { minimum: 0, maximum: 100 } : displaySeriesRange(group.items, this.axisRange, this.viewRange, group.displayUnit); let { minimum, maximum } = range; if (minimum === maximum) { const pad = Math.abs(minimum) * .05 || 1; minimum -= pad; maximum += pad; }
        const y = (value: number) => laneTop + (1 - (value - minimum) / (maximum - minimum)) * laneHeight; const rightAxis = axisIndex === 1;
        context.save(); context.font = '600 11px sans-serif'; context.textAlign = rightAxis ? 'right' : 'left'; context.fillStyle = css('--vscode-foreground', '#ddd'); context.fillText(ellipsize(context, group.label, Math.max(24, plotW / 2 - 12)), rightAxis ? left + plotW : left, graphTop + 16); context.restore();
        for (let tick = 0; tick <= 4; tick++) { const py = laneTop + laneHeight * tick / 4; const value = maximum - (maximum - minimum) * tick / 4; if (axisIndex === 0) { context.strokeStyle = css('--vscode-panel-border', '#777'); context.globalAlpha = .58; context.beginPath(); context.moveTo(left, py); context.lineTo(left + plotW, py); context.stroke(); context.globalAlpha = 1; } const label = formatNumber(value); context.fillStyle = css('--vscode-descriptionForeground', '#888'); context.fillText(label, rightAxis ? left + plotW + 7 : Math.max(4, left - context.measureText(label).width - 7), Math.min(laneTop + laneHeight - 2, py + 4)); }
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
          if (Number.isFinite(py)) hoverValues.push({ y: Math.max(laneTop, Math.min(laneTop + laneHeight, py)), sampleY: py, sampleX: x(cursorTimestamp), text: `${displayValueLabel(value, this.mode, group.displayUnit)}${sample.valueLabel ? ` (${sample.valueLabel})` : ''}`, color: this.color(item.definition.id) });
        }
        for (const marker of markers) {
          if (findGraphIndexBySignals(graphSignalIds, marker.signalIds) !== graphIndex) continue;
          for (const item of group.items) {
          const sample = this.measured.sample(`marker:${marker.id}`, item.definition.id); if (!sample) continue;
          const value = seriesDisplayValue(item, sample.value, this.mode, group.displayUnit); const py = y(value); if (!Number.isFinite(py)) continue;
          const values = markerValues.get(marker.id) ?? []; values.push({ y: Math.max(laneTop, Math.min(laneTop + laneHeight, py)), sampleY: py, sampleX: x(sample.timestamp), text: measuredValueLabel(`${displayValueLabel(value, this.mode, group.displayUnit)}${sample.valueLabel ? ` (${sample.valueLabel})` : ''}`, sample.timestamp, marker.timestamp), color: this.color(item.definition.id) }); markerValues.set(marker.id, values);
          }
        }
      });
      if (this.selectedRange) { const rangeStart = Math.max(this.viewRange.start, this.selectedRange.start); const rangeEnd = Math.min(this.viewRange.end, this.selectedRange.end); if (rangeEnd >= rangeStart) { const start = x(rangeStart); const end = x(rangeEnd); context.fillStyle = css('--vscode-editor-selectionBackground', '#264f78aa'); context.fillRect(start, laneTop, end - start, laneHeight); context.strokeStyle = css('--vscode-focusBorder', '#007acc'); context.strokeRect(start, laneTop, end - start, laneHeight); } }
      const visibleMarkers = markers.filter((marker) => findGraphIndexBySignals(graphSignalIds, marker.signalIds) === graphIndex && marker.timestamp >= this.viewRange!.start && marker.timestamp <= this.viewRange!.end);
      for (const marker of visibleMarkers) { context.strokeStyle = css('--vscode-focusBorder', '#007acc'); context.beginPath(); const px = x(marker.timestamp); context.moveTo(px, laneTop); context.lineTo(px, laneTop + laneHeight); context.stroke(); }
      if (interactions && cursorTimestamp !== undefined && cursorTimestamp >= this.viewRange.start && cursorTimestamp <= this.viewRange.end && (this.hoverGraphIndex === undefined || this.hoverGraphIndex === graphIndex)) { context.strokeStyle = css('--vscode-editorCursor-foreground', '#fff'); context.beginPath(); const px = x(cursorTimestamp); context.moveTo(px, laneTop); context.lineTo(px, laneTop + laneHeight); context.stroke(); }
      const occupiedLabels: HoverLabelRect[] = [];
      const fixedTimestampMarkers = visibleMarkers.map((marker) => {
        const timestampMarker = this.createTimestampMarker(context, x(marker.timestamp), `${formatNumber(marker.timestamp)} s`, left, left + plotW, laneTop + laneHeight, occupiedLabels, laneTop);
        occupiedLabels.push(timestampMarker.rect); return timestampMarker;
      });
      const rangeTimestampMarkers: CanvasTimestampMarker[] = [];
      if (this.selectedRange && rangeGraphIndex === graphIndex) {
        for (const edge of ['start', 'end'] as const) {
          const timestamp = this.selectedRange[edge]; if (timestamp < this.viewRange.start || timestamp > this.viewRange.end) continue;
          const marker = this.createTimestampMarker(context, x(timestamp), `${edge === 'start' ? t('Start', '開始') : t('End', '終了')} ${formatNumber(timestamp)} s`, left, left + plotW, laneTop + laneHeight, occupiedLabels, laneTop, this.activeRangeEdge === edge);
          occupiedLabels.push(marker.rect); rangeTimestampMarkers.push(marker);
        }
      }
      const cursorMatchesRangeEdge = this.selectedRange && this.activeRangeEdge && cursorTimestamp === this.selectedRange[this.activeRangeEdge] && rangeGraphIndex === graphIndex;
      const timestampMarker = interactions && cursorTimestamp !== undefined && this.hoverGraphIndex === graphIndex && !cursorMatchesRangeEdge
        ? this.createTimestampMarker(context, x(cursorTimestamp), `${formatNumber(cursorTimestamp)} s`, left, left + plotW, laneTop + laneHeight, occupiedLabels, laneTop)
        : undefined;
      if (timestampMarker) occupiedLabels.push(timestampMarker.rect);
      for (const marker of visibleMarkers) this.paintHoverValues(context, x(marker.timestamp), markerValues.get(marker.id) ?? [], left, left + plotW, laneTop, laneTop + laneHeight, occupiedLabels);
      if (interactions && cursorTimestamp !== undefined && this.hoverGraphIndex === graphIndex) this.paintHoverValues(context, x(cursorTimestamp), hoverValues, left, left + plotW, laneTop, laneTop + laneHeight, occupiedLabels);
      context.save(); context.strokeStyle = css('--vscode-descriptionForeground', '#888'); for (const marker of [...fixedTimestampMarkers, ...rangeTimestampMarkers, ...(timestampMarker ? [timestampMarker] : [])]) paintTimestampConnector(context, marker.cursorX, marker.bottom, marker.rect); context.restore();
      for (const fixedTimestampMarker of fixedTimestampMarkers) this.paintTimestampMarker(context, fixedTimestampMarker);
      for (const rangeTimestampMarker of rangeTimestampMarkers) this.paintTimestampMarker(context, rangeTimestampMarker);
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
    context.save(); context.font = `600 11px ${css('--vscode-editor-font-family', 'monospace')}`; context.textBaseline = 'middle';
    const positioned = layoutHoverLabelBoxes(values.map((value) => ({ ...value, cursorX, width: context.measureText(value.text).width + 10, height: 16 })), { left, right, top, bottom }, occupied);
    for (const value of positioned) {
      context.setLineDash(value.lineDash ?? []); context.strokeStyle = value.color; context.globalAlpha = .7; context.beginPath(); if (value.sampleX >= left && value.sampleX <= right && value.sampleY >= top && value.sampleY <= bottom) { context.arc(value.sampleX, value.sampleY, 3, 0, Math.PI * 2); context.fillStyle = value.color; context.fill(); context.moveTo(value.sampleX, value.sampleY); context.lineTo(value.placeLeft ? value.boxX + value.width : value.boxX, value.labelY); context.stroke(); }
      context.globalAlpha = .92; context.fillStyle = css('--vscode-editorHoverWidget-background', '#252526'); context.fillRect(value.boxX, value.boxY, value.width, value.height); context.globalAlpha = 1; context.strokeStyle = value.color; context.strokeRect(value.boxX, value.boxY, value.width, value.height); context.fillStyle = value.color; context.fillText(value.text, value.boxX + 5, value.labelY);
    }
    context.setLineDash([]);
    occupied.push(...positioned.map((value) => value.rect));
    context.restore();
  }

  private createTimestampMarker(context: CanvasRenderingContext2D, cursorX: number, text: string, left: number, right: number, bottom: number, occupied: readonly HoverLabelRect[] = [], top = 0, emphasized = false): CanvasTimestampMarker {
    context.save(); context.font = `600 11px ${css('--vscode-editor-font-family', 'monospace')}`; const width = context.measureText(text).width + 12; context.restore();
    return { text, cursorX, bottom, rect: layoutTimestampMarker(cursorX, width, 18, left, right, bottom, occupied, top), emphasized };
  }

  private paintTimestampMarker(context: CanvasRenderingContext2D, marker: CanvasTimestampMarker): void {
    context.save(); context.font = `600 11px ${css('--vscode-editor-font-family', 'monospace')}`; context.textAlign = 'center'; context.textBaseline = 'middle'; context.fillStyle = css('--vscode-editorHoverWidget-background', '#252526'); context.fillRect(marker.rect.x, marker.rect.y, marker.rect.width, marker.rect.height); context.strokeStyle = marker.emphasized ? css('--vscode-focusBorder', '#007acc') : css('--vscode-editorCursor-foreground', '#fff'); context.lineWidth = marker.emphasized ? 2 : 1; context.strokeRect(marker.rect.x, marker.rect.y, marker.rect.width, marker.rect.height); context.fillStyle = css('--vscode-editor-foreground', '#ddd'); context.fillText(marker.text, marker.rect.x + marker.rect.width / 2, marker.rect.y + marker.rect.height / 2); context.restore();
  }

  private hover(event: MouseEvent): void {
    if (!this.viewRange || !this.selected.size) return;
    const rect = this.canvas.getBoundingClientRect(); const marginLeft = CHART_LEFT; const plotWidth = rect.width - marginLeft - CHART_RIGHT; const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left - marginLeft) / plotWidth));
    const nextGraphIndex = graphIndexAtOffset(event.clientY - rect.top - 16, this.legendHeights, this.axisGutters); if (nextGraphIndex === undefined) { this.cursorTimestamp = undefined; this.hoverGraphIndex = undefined; this.scheduleInteractionDraw(); return; } this.hoverGraphIndex = nextGraphIndex;
    this.cursorTimestamp = this.viewRange.start + fraction * (this.viewRange.end - this.viewRange.start); this.timeline?.set(this.cursorTimestamp, 'timeSeries');
    this.scheduleInteractionDraw();
  }
  private addMarker(event: MouseEvent): void {
    if (this.suppressNextClick) { this.suppressNextClick = false; return; }
    const timestamp = this.timestampAt(event); if (timestamp === undefined || !this.selected.size) return;
    const rect = this.canvas.getBoundingClientRect(); const graphIndex = graphIndexAtOffset(event.clientY - rect.top - 16, this.legendHeights, this.axisGutters); if (graphIndex === undefined) return;
    const id = `marker-${++this.markerCounter}`;
    const signalIds = timeSeriesGraphSignalIds(timeSeriesGraphs(this.series, this.mode, this.groupLayout))[graphIndex]; if (!signalIds?.length) return;
    this.markers.set(id, { id, timestamp, signalIds });
    this.cursorTimestamp = undefined; this.updateMarkerControls(); this.draw(false);
  }
  private updateMarkerControls(): void { (this.host.querySelector('.chart-marker-clear') as HTMLButtonElement).disabled = this.markers.size === 0; this.updateExportAction(); }
  private renderLayoutEditor(): void {
    const editor = this.host.querySelector<HTMLElement>('.chart-layout-editor')!; const cards = this.host.querySelector<HTMLElement>('.chart-layout-cards')!; const hidden = !this.layoutEditorOpen || this.mode === 'normalized'; editor.hidden = hidden; cards.replaceChildren(); if (hidden) return;
    const groups = timeSeriesGroups(this.series, 'raw'); const graphs = arrangeChartGroups(groups, this.groupLayout); const automatic = this.host.querySelector<HTMLButtonElement>('.chart-layout-auto')!; automatic.disabled = !this.groupLayout;
    if (!groups.length) { const empty = document.createElement('span'); empty.className = 'muted'; empty.textContent = t('Select Signals to arrange their unit systems.', 'Signalを選択すると単位系統を配置できます。'); cards.appendChild(empty); return; }
    graphs.forEach((graph, graphIndex) => {
      const card = document.createElement('section'); card.className = 'chart-layout-card'; const title = document.createElement('strong'); title.textContent = `${t('Graph', 'グラフ')} ${graphIndex + 1}`; card.appendChild(title);
      const slots = document.createElement('div'); slots.className = 'chart-layout-slots';
      ([0, 1] as const).forEach((axisIndex) => { const group = graph[axisIndex]; const slot = document.createElement('div'); slot.className = 'chart-layout-slot'; slot.dataset.graphIndex = String(graphIndex); slot.dataset.axisIndex = String(axisIndex); const axis = document.createElement('span'); axis.className = 'chart-layout-axis'; axis.textContent = axisIndex === 0 ? 'L' : 'R'; slot.appendChild(axis); this.enableLayoutDrop(slot, graphIndex, axisIndex);
        if (group) { const chip = document.createElement('div'); chip.className = 'chart-layout-chip'; chip.draggable = true; chip.tabIndex = 0; chip.setAttribute('aria-label', t(`${group.label} unit system, ${group.items.length} Signals`, `${group.label}系統、${group.items.length} Signal`)); const handle = document.createElement('span'); handle.className = 'chart-layout-handle'; handle.textContent = '⠿'; handle.setAttribute('aria-hidden', 'true'); const label = document.createElement('span'); label.textContent = group.label; const count = document.createElement('small'); count.textContent = `${group.items.length}`; chip.append(handle, label, count); chip.addEventListener('dragstart', (event) => { this.draggedGroupKey = group.key; event.dataTransfer?.setData('text/plain', group.key); if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'; chip.classList.add('dragging'); }); chip.addEventListener('dragend', () => this.finishLayoutDrag()); slot.appendChild(chip); }
        else { const empty = document.createElement('span'); empty.className = 'chart-layout-empty'; empty.textContent = t('Drop here', 'ここへドロップ'); slot.appendChild(empty); }
        slots.appendChild(slot); }); card.appendChild(slots); cards.appendChild(card);
    });
    const separate = document.createElement('div'); separate.className = 'chart-layout-new'; separate.textContent = `＋ ${t('Drop here for a new graph', 'ここへドロップして新しいグラフ')}`; separate.addEventListener('dragover', (event) => { if (!this.draggedGroupKey) return; event.preventDefault(); separate.classList.add('drop-target'); if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'; }); separate.addEventListener('dragleave', () => separate.classList.remove('drop-target')); separate.addEventListener('drop', (event) => { event.preventDefault(); const key = this.layoutDragKey(event); if (!key) return; this.groupLayout = moveChartGroupToNewGraph(graphs.map((graph) => graph.map((group) => group.key)), key); this.finishLayoutDrag(); this.persist(); this.draw(); }); cards.appendChild(separate);
  }
  private enableLayoutDrop(slot: HTMLElement, graphIndex: number, axisIndex: 0 | 1): void {
    slot.addEventListener('dragover', (event) => { if (!this.draggedGroupKey) return; event.preventDefault(); slot.classList.add('drop-target'); if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'; }); slot.addEventListener('dragleave', () => slot.classList.remove('drop-target')); slot.addEventListener('drop', (event) => { event.preventDefault(); const key = this.layoutDragKey(event); if (!key) return; const layout = timeSeriesGraphs(this.series, 'raw', this.groupLayout).map((graph) => graph.map((group) => group.key)); this.groupLayout = moveChartGroup(layout, key, graphIndex, axisIndex); this.finishLayoutDrag(); this.persist(); this.draw(); });
  }
  private layoutDragKey(event: DragEvent): string | undefined { return this.draggedGroupKey ?? (event.dataTransfer?.getData('text/plain') || undefined); }
  private finishLayoutDrag(): void { this.draggedGroupKey = undefined; this.host.querySelectorAll('.dragging,.drop-target').forEach((element) => element.classList.remove('dragging', 'drop-target')); }

  private measureAxisGutters(width: number, interactive: boolean): readonly number[] {
    if (!this.viewRange) return [];
    const context = document.createElement('canvas').getContext('2d')!;
    context.font = `600 11px ${css('--vscode-editor-font-family', 'monospace')}`;
    const graphs = timeSeriesGraphs(this.series, this.mode, this.groupLayout);
    const ids = timeSeriesGraphSignalIds(graphs);
    const rangeIndex = findGraphIndexBySignals(ids, this.rangeSignalIds);
    const range = this.viewRange;
    const x = (time: number) => CHART_LEFT + (time - range.start) / (range.end - range.start || 1) * Math.max(1, width - CHART_LEFT - CHART_RIGHT);
    return graphs.map((_, index) => {
      const labels: { x: number; text: string }[] = [];
      const add = (time: number | undefined, prefix = '') => { if (time !== undefined && time >= range.start && time <= range.end) labels.push({ x: x(time), text: `${prefix}${formatNumber(time)} s` }); };
      for (const marker of this.markers.values()) if (findGraphIndexBySignals(ids, marker.signalIds) === index) add(this.measured.referenceTimestamp(`marker:${marker.id}`));
      if (this.selectedRange && rangeIndex === index) { add(this.selectedRange.start, t('Start ', '開始 ')); add(this.selectedRange.end, t('End ', '終了 ')); }
      const cursor = this.cursorTimestamp;
      const matchesEdge = this.selectedRange && this.activeRangeEdge && cursor === this.selectedRange[this.activeRangeEdge] && rangeIndex === index;
      if (interactive && this.hoverGraphIndex === index && !matchesEdge) add(cursor);
      return timestampGutter(context, labels, CHART_LEFT, width - CHART_RIGHT);
    });
  }

  private renderLegend(width: number): readonly number[] {
    const legend = this.host.querySelector<HTMLElement>('.chart-legend')!; legend.replaceChildren(); legend.style.width = `${width}px`; const graphs = timeSeriesGraphs(this.series, this.mode, this.groupLayout); const heights: number[] = []; let top = 16;
    for (let graphIndex = 0; graphIndex < graphs.length; graphIndex++) {
      const row = document.createElement('div'); row.className = 'chart-legend-group'; row.style.top = `${top}px`; const title = document.createElement('span'); title.className = 'chart-legend-title'; title.textContent = `${t('Graph', 'グラフ')} ${graphIndex + 1}`; const items = document.createElement('div'); items.className = 'chart-legend-items';
      graphs[graphIndex].forEach((group) => {
        for (const item of group.items) {
          const entry = document.createElement('button'); entry.type = 'button'; entry.className = 'chart-legend-entry'; entry.dataset.signalId = item.definition.id;
          entry.style.cssText = 'background:transparent;border:0;padding:2px 0;color:inherit;font:inherit;text-align:left';
          entry.addEventListener('mouseenter', () => this.highlightSignal(item.definition.id)); entry.addEventListener('mouseleave', () => this.highlightSignal(entry.matches(':focus-visible') ? item.definition.id : undefined));
          entry.addEventListener('focus', () => { if (entry.matches(':focus-visible')) this.highlightSignal(item.definition.id); }); entry.addEventListener('blur', () => { if (!entry.matches(':hover')) this.highlightSignal(undefined); });
          const color = document.createElement('i'); color.style.background = this.color(item.definition.id); const label = document.createElement('span'); label.className = 'chart-legend-label'; label.textContent = signalLegendLabel(item.definition, this.mode, group.displayUnit); entry.append(color, label); items.appendChild(entry);
        }
      }); row.append(title, items); legend.appendChild(row); const height = Math.max(34, Math.ceil(row.scrollHeight) + 1); row.style.height = `${height}px`; heights.push(height); top += height + GRAPH_HEIGHT;
    } return heights;
  }
  private highlightSignal(id: string | undefined): void {
    if (this.highlightedSignalId === id) return;
    this.highlightedSignalId = id;
    this.host.querySelectorAll<HTMLElement>('.selector-signal,.chart-legend-entry').forEach((element) => emphasizeSignal(element, !!id && element.dataset.signalId === id, this.color(element.dataset.signalId ?? '')));
    this.scheduleInteractionDraw();
  }
  private updateStatus(): void {
    if (!this.selected.size) this.status.textContent = t('Select Signals', 'Signalを選択');
    else if (this.seriesPending) this.status.textContent = t('Loading selected Signals…', '選択したSignalを読み込み中…');
    else this.status.textContent = `${this.series.length} ${t('series', '系列')} · ${this.series.reduce((sum, item) => sum + item.totalSamplesInRange, 0).toLocaleString()} ${t('source samples', '元サンプル')}`;
  }
  private updateZoomControls(): void {
    const full = this.fullRange; const view = this.viewRange; const reset = this.host.querySelector<HTMLButtonElement>('.zoom-reset')!; const out = this.host.querySelector<HTMLButtonElement>('.zoom-out')!; const input = this.host.querySelector<HTMLButtonElement>('.zoom-in')!; const label = this.host.querySelector('.view-range')!;
    const zoomed = Boolean(full && view && (Math.abs(view.start - full.start) > 1e-9 || Math.abs(view.end - full.end) > 1e-9)); reset.disabled = !zoomed; out.disabled = !zoomed; input.disabled = !full || !view || (view.end - view.start) <= (full.end - full.start) * .005 + 1e-12;
    label.textContent = view ? `${formatNumber(view.start)}–${formatNumber(view.end)} s · ${formatNumber(view.end - view.start)} s` : '';
  }
  private updateExportAction(): void { this.saveImageButton.disabled = !this.series.length || !this.viewRange || this.seriesPending || this.measured.pendingMarkers(); this.saveImageButton.title = t('Save every graph, legend, range and marker as SVG or PNG', '全グラフ・凡例・選択範囲・マーカーをSVGまたはPNGで保存'); }
  private saveImage(): void {
    if (!this.series.length || !this.viewRange || this.saveImageButton.disabled) return; const width = 1600; const graphs = timeSeriesGraphs(this.series, this.mode, this.groupLayout); const graphCount = Math.max(1, graphs.length); const canvas = document.createElement('canvas'); canvas.width = width; let context = canvas.getContext('2d'); if (!context) return; const legendHeights = Array.from({ length: graphCount }, (_, index) => this.measureGraphLegendHeight(context!, graphs[index] ?? [], width)); const gutters = this.measureAxisGutters(width, false); const contentHeight = gutters.reduce((a, b) => a + b, 0) + graphCount * GRAPH_HEIGHT + legendHeights.reduce((sum, value) => sum + value, 0); const height = Math.max(900, 110 + contentHeight); canvas.height = height; context = canvas.getContext('2d'); if (!context) return;
    context.fillStyle = css('--vscode-editor-background', '#1e1e1e'); context.fillRect(0, 0, width, height); context.fillStyle = css('--vscode-foreground', '#ddd'); context.font = '600 22px sans-serif'; context.fillText('SigMixa · Time Series', 24, 34); context.font = '12px sans-serif'; const range = `${formatNumber(this.viewRange.start)}–${formatNumber(this.viewRange.end)} s`; context.fillStyle = css('--vscode-descriptionForeground', '#999'); context.fillText(range, width - context.measureText(range).width - 24, 32);
    const chartTop = 58; this.paintChart(context, width, height, chartTop, height - chartTop - contentHeight, false, legendHeights, gutters);
    const vector = createSvgCanvas(width, height); const svgContext = vector.context; svgContext.fillStyle = css('--vscode-editor-background', '#1e1e1e'); svgContext.fillRect(0, 0, width, height); svgContext.fillStyle = css('--vscode-foreground', '#ddd'); svgContext.font = '600 22px sans-serif'; svgContext.fillText('SigMixa · Time Series', 24, 34); svgContext.font = '12px sans-serif'; svgContext.fillStyle = css('--vscode-descriptionForeground', '#999'); svgContext.fillText(range, width - svgContext.measureText(range).width - 24, 32); this.paintChart(svgContext, width, height, chartTop, height - chartTop - contentHeight, false, legendHeights, gutters);
    this.post({ type: 'saveTimeSeriesImage', pngDataUrl: canvas.toDataURL('image/png'), svg: vector.toSvg() });
  }
  private paintGraphLegend(context: CanvasRenderingContext2D, groups: readonly TimeSeriesGroup[], graphIndex: number, width: number, top: number): void {
    context.save(); context.font = '600 12px sans-serif'; context.fillStyle = css('--vscode-descriptionForeground', '#999'); context.fillText(`${t('Graph', 'グラフ')} ${graphIndex + 1}`, 24, top + 20); let x = 94; let y = top + 20; context.font = '12px sans-serif'; groups.forEach((group) => { for (const item of group.items) { const label = signalLegendLabel(item.definition, this.mode, group.displayUnit); const entryWidth = 26 + context.measureText(label).width; if (x + entryWidth > width - 24) { x = 94; y += 20; } context.strokeStyle = this.color(item.definition.id); context.lineWidth = 3; context.beginPath(); context.moveTo(x, y - 4); context.lineTo(x + 16, y - 4); context.stroke(); context.fillStyle = css('--vscode-foreground', '#ddd'); context.fillText(ellipsize(context, label, width - x - 28), x + 22, y); x += Math.min(entryWidth, width - x - 24) + 16; } }); context.restore();
  }
  private measureGraphLegendHeight(context: CanvasRenderingContext2D, groups: readonly TimeSeriesGroup[], width: number): number { context.save(); context.font = '12px sans-serif'; let x = 94; let rows = 1; groups.forEach((group) => { for (const item of group.items) { const label = signalLegendLabel(item.definition, this.mode, group.displayUnit); const entryWidth = 26 + context.measureText(label).width; if (x + entryWidth > width - 24) { x = 94; rows++; } x += Math.min(entryWidth, width - x - 24) + 16; } }); context.restore(); return Math.max(34, 12 + rows * 20); }
  private color(id: string): string { return this.colors.get(id) ?? SIGNAL_COLOR_PRESETS[Math.abs(hash(id)) % SIGNAL_COLOR_PRESETS.length]; }
  private persist(): void { this.save({ chartSignalGrouping: this.selector.groupingMode, chartSelectedIds: [...this.selected], chartColors: Object.fromEntries(this.colors), chartMode: this.mode, chartConnectGaps: this.connectGaps, chartAxisRange: this.axisRange, chartGroupLayout: this.groupLayout, chartPaneWidth: this.paneWidth, chartPaneCollapsed: this.paneCollapsed }); }
  private applyPane(): void { const toggle = this.host.querySelector('.pane-toggle')!; const label = this.paneCollapsed ? t('Show Signal selection', 'Signal選択を表示') : t('Hide Signal selection', 'Signal選択を隠す'); toggle.setAttribute('aria-expanded', String(!this.paneCollapsed)); toggle.setAttribute('title', label); toggle.setAttribute('aria-label', label); const glyph = toggle.querySelector('.codicon'); if (glyph) glyph.className = `codicon codicon-${this.paneCollapsed ? 'layout-sidebar-left-off' : 'layout-sidebar-left'}`; this.pane.style.width = this.paneCollapsed ? '0' : `${this.paneWidth}px`; this.pane.style.display = this.paneCollapsed ? 'none' : 'block'; this.separator.style.display = this.paneCollapsed ? 'none' : 'block'; }
  private startPaneResize(event: MouseEvent): void { event.preventDefault(); const start = event.clientX; const initial = this.paneWidth; const move = (next: MouseEvent) => { this.paneWidth = Math.max(180, Math.min(440, initial + next.clientX - start)); this.applyPane(); }; const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); this.persist(); }; window.addEventListener('mousemove', move); window.addEventListener('mouseup', up); }
  private updateModeButtons(): void { for (const [selector, active] of [['.mode-raw', this.mode === 'raw'], ['.mode-normalized', this.mode === 'normalized']] as const) { const button = this.host.querySelector(selector)!; button.classList.toggle('primary', active); button.setAttribute('aria-pressed', String(active)); } const normalized = this.mode === 'normalized'; this.host.querySelector<HTMLElement>('.chart-axis-global')!.hidden = normalized; const layoutToggle = this.host.querySelector<HTMLButtonElement>('.chart-layout-toggle')!; layoutToggle.disabled = normalized; layoutToggle.classList.toggle('primary', this.layoutEditorOpen && !normalized); layoutToggle.setAttribute('aria-expanded', String(this.layoutEditorOpen && !normalized)); this.host.querySelector<HTMLElement>('.chart-layout-editor')!.hidden = normalized || !this.layoutEditorOpen; }
}

interface ChartGeometry { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number; readonly width: number; readonly x: (timestamp: number) => number; }
function graphIndexAtOffset(offset: number, legendHeights: readonly number[], gutters: readonly number[] = []): number | undefined { if (offset < 0) return undefined; let top = 0; for (let index = 0; index < legendHeights.length; index++) { const legendBottom = top + legendHeights[index]; if (offset < legendBottom) return undefined; const graphBottom = legendBottom + GRAPH_HEIGHT; if (offset < graphBottom) return index; if (offset < graphBottom + (gutters[index] ?? 0)) return undefined; top = graphBottom + (gutters[index] ?? 0); } return undefined; }
function groupSeriesByCompatibleUnit(series: readonly SignalSeriesDto[], emptyLabel: string): readonly TimeSeriesGroup[] {
  const groups = new Map<string, { key: string; order: number; items: SignalSeriesDto[] }>();
  for (const item of series) {
    const sourceUnit = item.definition.unit?.trim(); const conversion = resolveDisplayUnit(sourceUnit); const key = conversion ? `family:${conversion.family}` : sourceUnit ? `unit:${sourceUnit.toLowerCase()}` : 'empty';
    const group = groups.get(key) ?? { key, order: conversion?.order ?? (sourceUnit ? 10_000 : 20_000), items: [] }; group.items.push(item); groups.set(key, group);
  }
  return [...groups.values()].map((group) => { const displayUnit = preferredDisplayUnit(group.items.map((item) => item.definition.unit)); return { ...group, displayUnit, label: displayUnit ?? emptyLabel }; }).sort((left, right) => left.order - right.order || left.label.localeCompare(right.label));
}
function timeSeriesGroups(series: readonly SignalSeriesDto[], mode: 'raw' | 'normalized'): readonly TimeSeriesGroup[] { return mode === 'normalized' ? series.length ? [{ key: 'normalized', label: '0–100%', items: series }] : [] : groupSeriesByCompatibleUnit(series, t('(no unit)', '(単位なし)')); }
function timeSeriesGraphs(series: readonly SignalSeriesDto[], mode: 'raw' | 'normalized', layout?: ChartGroupLayout): readonly (readonly TimeSeriesGroup[])[] { const groups = timeSeriesGroups(series, mode); return mode === 'normalized' ? groups.length ? [groups] : [] : arrangeChartGroups(groups, layout); }
function timeSeriesGraphSignalIds(graphs: readonly (readonly TimeSeriesGroup[])[]): readonly string[][] { return graphs.map((graph) => [...new Set(graph.flatMap((group) => group.items.map((item) => item.definition.id)))]); }
function normalizeChartGroupLayout(layout: ChartGroupLayout | undefined): string[][] | undefined {
  if (!layout?.length) return undefined;
  const used = new Set<string>();
  const result: string[][] = [];
  for (const graph of layout) {
    const normalized: string[] = [];
    for (const key of graph) {
      if (typeof key !== 'string' || !key || used.has(key)) continue;
      normalized.push(key); used.add(key);
      if (normalized.length === 2) break;
    }
    if (normalized.length) result.push(normalized);
  }
  return result.length ? result : undefined;
}
function reconcileViewRange(view: { readonly start: number; readonly end: number } | undefined, full: { readonly start: number; readonly end: number } | undefined): { start: number; end: number } | undefined { if (!full || !view) return full; const fullSpan = full.end - full.start; const span = Math.min(fullSpan, Math.max(0, view.end - view.start)); if (span >= fullSpan || view.end < full.start || view.start > full.end) return full; let start = Math.max(full.start, Math.min(view.start, full.end - span)); return { start, end: start + span }; }
function seriesDisplayValue(item: SignalSeriesDto, value: number, mode: 'raw' | 'normalized', displayUnit?: string): number { return mode === 'normalized' ? normalizeValue(value, item.globalMinimum ?? value, item.globalMaximum ?? value) : convertDisplayUnit(value, item.definition.unit, displayUnit); }
function displayValueLabel(value: number, mode: 'raw' | 'normalized', displayUnit?: string): string { const unit = mode === 'normalized' ? '%' : displayUnit?.trim(); return `${formatNumber(value)}${unit ? ` ${unit}` : ''}`; }
function signalLegendLabel(definition: SignalDefinition, mode: 'raw' | 'normalized', displayUnit?: string): string { const sourceUnit = definition.unit?.trim(); const unit = mode === 'raw' && displayUnit && sourceUnit && displayUnit !== sourceUnit ? `${sourceUnit} → ${displayUnit}` : sourceUnit; return `${definition.name}${unit ? ` (${unit})` : ''}`; }
function ellipsize(context: CanvasRenderingContext2D, text: string, maxWidth: number): string { if (context.measureText(text).width <= maxWidth) return text; let low = 0; let high = text.length; while (low < high) { const middle = Math.ceil((low + high) / 2); if (context.measureText(`${text.slice(0, middle)}…`).width <= maxWidth) low = middle; else high = middle - 1; } return `${text.slice(0, low)}…`; }
function css(name: string, fallback: string): string { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback; }
function formatNumber(value: number): string { if (!Number.isFinite(value)) return '—'; if (Number.isInteger(value)) return String(value); return Number(value.toPrecision(7)).toString(); }
function initialAxisRange(initial: LogViewState | undefined): ChartAxisRangeSetting {
  if (initial?.chartAxisRange) return { mode: initial.chartAxisRange.mode === 'global' ? 'global' : 'visible', includeZero: initial.chartAxisRange.includeZero === true };
  const previous = Object.values(initial?.chartAxisRanges ?? {});
  return { mode: previous.length > 0 && previous.every((setting) => setting.mode === 'global') ? 'global' : 'visible', includeZero: previous.length > 0 && previous.every((setting) => setting.includeZero === true) };
}
function fieldLabel(text: string): HTMLLabelElement { const label = document.createElement('label'); label.className = 'external-field-label'; label.textContent = text; return label; }
function hash(value: string): number { let result = 0; for (const character of value) result = ((result << 5) - result + character.charCodeAt(0)) | 0; return result; }
function nearestFromSlice(samples: readonly SignalSample[], timestamp: number): SignalSample | undefined { let best: SignalSample | undefined; let distance = Infinity; for (const sample of samples) { const next = Math.abs(sample.timestamp - timestamp); if (next < distance) { best = sample; distance = next; } } return best; }
