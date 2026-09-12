import { normalizeValue } from '../../core/timeline/timeline';
import type { SignalDefinition, SignalSample } from '../../core/signal/signal';
import type { ExternalCsvPreviewDto, LogViewState, SignalSeriesDto, ToExtensionMessage, ToWebviewMessage } from '../../extension/editors/rawLogProtocol';
import { SIGNAL_COLOR_PRESETS, SignalSelector } from '../shared/signalSelector';
import type { TimelineController } from '../shared/timelineController';
import { t } from '../shared/i18n';

export class TimeSeriesView {
  private readonly selected: Set<string>;
  private readonly colors: Map<string, string>;
  private mode: 'raw' | 'normalized';
  private paneWidth: number;
  private paneCollapsed: boolean;
  private readonly selector: SignalSelector;
  private readonly canvas: HTMLCanvasElement;
  private readonly tooltip: HTMLElement;
  private readonly pane: HTMLElement;
  private readonly separator: HTMLElement;
  private series: readonly SignalSeriesDto[] = [];
  private fullRange: { start: number; end: number } | undefined;
  private viewRange: { start: number; end: number } | undefined;
  private counter = 200_000;
  private latestSeriesRequest = 0;
  private latestNearestRequest = 0;
  private refreshTimer: number | undefined;
  private catalogRequested = false;
  private latestCatalogRequest = 0;
  private visible = false;
  private cursorTimestamp: number | undefined;
  private hoverRequestScheduled = false;
  private nearestValues: readonly { definition: SignalDefinition; sample: SignalSample }[] = [];
  private pendingImport: (ExternalCsvPreviewDto & { timestampColumn: string; timestampUnit: 'seconds' | 'milliseconds' | 'microseconds'; selectedColumns: Set<string>; units: Map<string, string> }) | undefined;

  constructor(
    private readonly host: HTMLElement,
    initial: LogViewState | undefined,
    private readonly post: (message: ToExtensionMessage) => void,
    private readonly save: (partial: Partial<LogViewState>) => void,
    private readonly timeline?: TimelineController
  ) {
    this.selected = new Set(initial?.chartSelectedIds ?? []);
    this.colors = new Map(Object.entries(initial?.chartColors ?? {}));
    this.mode = initial?.chartMode ?? 'raw'; this.paneWidth = initial?.chartPaneWidth ?? 250; this.paneCollapsed = initial?.chartPaneCollapsed ?? false;
    host.innerHTML = `<div class="chart-layout"><aside class="signal-pane chart-pane"><div class="chart-source-actions"><button class="import-external-csv">+ ${t('External CSV…', '外部CSV…')}</button></div><div class="external-import-host"></div><div class="chart-selector"></div></aside><div class="pane-separator"></div><section class="signal-main chart-main"><div class="view-toolbar"><button class="pane-toggle">${t('Signals', 'Signal')}</button><span>${t('Display:', '表示:')}</span><button class="mode-raw">${t('Actual', '実値')}</button><button class="mode-normalized">${t('Normalized 0–100%', '正規化 0–100%')}</button><span class="spacer"></span><span class="chart-status muted">${t('Select Signals', 'Signalを選択')}</span><button class="analysis-cancel" hidden>${t('Cancel analysis', '解析を中止')}</button></div><div class="view-toolbar"><div class="segmented"><button class="zoom-out">−</button><button class="zoom-in">+</button></div><button class="zoom-reset">${t('Reset Zoom', 'ズームをリセット')}</button><span class="muted">${t('Wheel / trackpad: pan', 'ホイール／トラックパッド: 移動')}</span></div><div class="chart-legend"></div><div class="chart-canvas-wrap"><canvas></canvas><div class="chart-tooltip" hidden></div></div></section></div>`;
    this.canvas = host.querySelector('canvas')!; this.tooltip = host.querySelector('.chart-tooltip')!; this.pane = host.querySelector('.chart-pane')!; this.separator = host.querySelector('.pane-separator')!;
    this.selector = new SignalSelector({
      host: host.querySelector('.chart-selector')!, selected: this.selected, colors: this.colors,
      onSelectionChange: () => this.selectionChanged(), onColorChange: () => { this.persist(); this.draw(); },
      onRemoveSignal: (definition, group) => this.removeExternalSignal(definition, group),
    });
    host.querySelector('.pane-toggle')!.addEventListener('click', () => { this.paneCollapsed = !this.paneCollapsed; this.applyPane(); this.persist(); });
    host.querySelector('.mode-raw')!.addEventListener('click', () => { this.mode = 'raw'; this.persist(); this.updateModeButtons(); this.draw(); });
    host.querySelector('.mode-normalized')!.addEventListener('click', () => { this.mode = 'normalized'; this.persist(); this.updateModeButtons(); this.draw(); });
    host.querySelector('.zoom-in')!.addEventListener('click', () => this.zoom(1 / 1.5)); host.querySelector('.zoom-out')!.addEventListener('click', () => this.zoom(1.5)); host.querySelector('.zoom-reset')!.addEventListener('click', () => { this.viewRange = this.fullRange; this.requestSeries(); });
    host.querySelector('.analysis-cancel')!.addEventListener('click', () => this.post({ type: 'cancelAnalysis' }));
    host.querySelector('.import-external-csv')!.addEventListener('click', () => this.beginExternalImport());
    this.separator.addEventListener('mousedown', (event) => this.startPaneResize(event));
    this.canvas.addEventListener('wheel', (event) => this.pan(event), { passive: false }); this.canvas.addEventListener('mousemove', (event) => this.hover(event)); this.canvas.addEventListener('mouseleave', () => { this.tooltip.hidden = true; this.cursorTimestamp = undefined; this.nearestValues = []; this.draw(); });
    new ResizeObserver(() => this.draw()).observe(host.querySelector('.chart-canvas-wrap')!);
    this.applyPane(); this.updateModeButtons();
    this.timeline?.subscribe((timestamp, source) => { if (source === 'timeSeries') return; this.cursorTimestamp = timestamp; if (this.visible && this.selected.size) { this.latestNearestRequest = ++this.counter; this.post({ type: 'nearestSignalsRequest', requestId: this.latestNearestRequest, selectedIds: [...this.selected], timestamp }); this.draw(); } });
  }

  show(): void { this.visible = true; if (!this.catalogRequested) { this.catalogRequested = true; this.latestCatalogRequest = ++this.counter; this.post({ type: 'signalCatalogRequest', requestId: this.latestCatalogRequest, view: 'timeSeries' }); } this.draw(); }
  hide(): void { this.visible = false; }

  handle(message: ToWebviewMessage): void {
    if (message.type === 'externalCsvPreview') {
      this.pendingImport = { ...message, timestampColumn: message.suggestedTimestampColumn ?? message.headers[0] ?? '', timestampUnit: message.suggestedTimestampUnit, selectedColumns: new Set(), units: new Map() };
      this.renderImportWizard();
    } else if (message.type === 'signalCatalog' && message.requestId === this.latestCatalogRequest) {
      const valid = new Set(message.definitions.map((item) => item.id)); let selectionChanged = false;
      for (const id of [...this.selected]) if (!valid.has(id)) { this.selected.delete(id); selectionChanged = true; }
      message.definitions.forEach((definition, index) => { if (!this.colors.has(definition.id)) this.colors.set(definition.id, SIGNAL_COLOR_PRESETS[index % SIGNAL_COLOR_PRESETS.length]); });
      this.selector.setCatalog(message.definitions, message.groups); if (selectionChanged) this.persist(); if (this.selected.size) this.requestSeries();
    } else if (message.type === 'signalSeries' && message.requestId === this.latestSeriesRequest) {
      this.series = message.series; this.fullRange = message.fullRange;
      if (!this.viewRange || !this.fullRange || this.viewRange.end < this.fullRange.start || this.viewRange.start > this.fullRange.end) this.viewRange = this.fullRange;
      this.host.querySelector('.chart-status')!.textContent = `${this.series.length} ${t('series', '系列')} · ${this.series.reduce((sum, item) => sum + item.totalSamplesInRange, 0).toLocaleString()} ${t('source samples', '元サンプル')}`;
      this.draw();
    } else if (message.type === 'nearestSignals' && message.requestId === this.latestNearestRequest) {
      this.nearestValues = message.values; this.showTooltip(); this.draw();
    } else if (message.type === 'analysisProgress') {
      const percent = message.total ? Math.floor(message.processed / message.total * 100) : 100; this.host.querySelector('.chart-status')!.textContent = `${t('Analyzing', '解析中')} ${percent}% · ${message.processed.toLocaleString()} ${t('frames', 'フレーム')}`; (this.host.querySelector('.analysis-cancel') as HTMLButtonElement).hidden = false;
    } else if (message.type === 'analysisComplete') {
      (this.host.querySelector('.analysis-cancel') as HTMLButtonElement).hidden = true; if (!message.cancelled && this.visible && this.selected.size) this.requestSeries();
    } else if (message.type === 'definitionsChanged') {
      this.catalogRequested = false; this.series = []; this.fullRange = undefined; this.viewRange = undefined; if (this.visible) this.show();
    } else if (message.type === 'progress' && this.visible && this.selected.size) this.scheduleSeriesRefresh();
    else if (message.type === 'parseComplete' && this.visible && this.selected.size) this.requestSeries();
  }

  private selectionChanged(): void { this.viewRange = undefined; this.series = []; this.persist(); this.requestSeries(); }
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
    for (const header of pending.headers) { const option = document.createElement('option'); option.value = header; option.textContent = header || '(unnamed column)'; option.selected = header === pending.timestampColumn; timestamp.appendChild(option); }
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
      const name = document.createElement('span'); name.textContent = header || '(unnamed column)'; name.title = name.textContent; label.append(checkbox, name);
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
    this.series = this.series.filter((item) => item.definition.id !== definition.id); this.viewRange = undefined;
    this.persist(); this.draw(); this.post({ type: 'removeExternalCsvSignal', sourceId: group.remove.sourceId, column: definition.source.column });
  }
  private requestSeries(): void { if (!this.selected.size) { this.series = []; this.fullRange = undefined; this.draw(); return; } this.latestSeriesRequest = ++this.counter; this.post({ type: 'signalSeriesRequest', requestId: this.latestSeriesRequest, selectedIds: [...this.selected], range: this.viewRange, maxPoints: 4000 }); }
  private scheduleSeriesRefresh(): void { if (this.refreshTimer !== undefined) return; this.refreshTimer = window.setTimeout(() => { this.refreshTimer = undefined; if (this.visible) this.requestSeries(); }, 250); }

  private zoom(factor: number): void {
    if (!this.fullRange) return; const current = this.viewRange ?? this.fullRange; const fullSpan = this.fullRange.end - this.fullRange.start || 1; const center = (current.start + current.end) / 2; const span = Math.max(fullSpan * 0.005, Math.min(fullSpan, (current.end - current.start || fullSpan) * factor));
    let start = center - span / 2; let end = center + span / 2; if (start < this.fullRange.start) { start = this.fullRange.start; end = start + span; } if (end > this.fullRange.end) { end = this.fullRange.end; start = end - span; }
    this.viewRange = { start, end }; this.requestSeries();
  }

  private pan(event: WheelEvent): void {
    if (!this.fullRange || !this.viewRange) return; const fullSpan = this.fullRange.end - this.fullRange.start; const span = this.viewRange.end - this.viewRange.start; if (span >= fullSpan - 1e-12) return; event.preventDefault(); const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY; const shift = Math.sign(delta) * span * 0.18; let start = this.viewRange.start + shift; let end = this.viewRange.end + shift; if (start < this.fullRange.start) { start = this.fullRange.start; end = start + span; } if (end > this.fullRange.end) { end = this.fullRange.end; start = end - span; } this.viewRange = { start, end }; this.requestSeries();
  }

  private draw(): void {
    if (!this.visible) return; const wrapper = this.canvas.parentElement!; const width = Math.max(320, wrapper.clientWidth); const height = Math.max(300, wrapper.clientHeight || 420); const ratio = window.devicePixelRatio || 1; this.canvas.width = width * ratio; this.canvas.height = height * ratio; this.canvas.style.width = `${width}px`; this.canvas.style.height = `${height}px`; const context = this.canvas.getContext('2d')!; context.scale(ratio, ratio); context.clearRect(0, 0, width, height);
    const margin = { left: 58, right: 18, top: 16, bottom: 34 }; const plotW = width - margin.left - margin.right; const plotH = height - margin.top - margin.bottom; context.strokeStyle = css('--vscode-panel-border', '#777'); context.strokeRect(margin.left, margin.top, plotW, plotH);
    if (!this.series.length || !this.viewRange) { context.fillStyle = css('--vscode-descriptionForeground', '#888'); context.fillText(this.selected.size ? 'No samples in this range.' : 'Select Signals from the left pane.', margin.left + 12, margin.top + 24); this.renderLegend(); return; }
    const allValues = this.series.flatMap((item) => item.samples.map((sample) => this.mode === 'normalized' ? normalizeValue(sample.value, item.globalMinimum ?? sample.value, item.globalMaximum ?? sample.value) : sample.value)).filter(Number.isFinite);
    let yMin = this.mode === 'normalized' ? 0 : Math.min(...allValues); let yMax = this.mode === 'normalized' ? 100 : Math.max(...allValues); if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) { yMin = 0; yMax = 1; } if (yMin === yMax) { const pad = Math.abs(yMin) * 0.05 || 1; yMin -= pad; yMax += pad; }
    const x = (timestamp: number) => margin.left + (timestamp - this.viewRange!.start) / (this.viewRange!.end - this.viewRange!.start || 1) * plotW; const y = (value: number) => margin.top + (1 - (value - yMin) / (yMax - yMin)) * plotH;
    context.font = '11px sans-serif'; context.fillStyle = css('--vscode-descriptionForeground', '#888'); context.fillText(formatNumber(yMax), 4, margin.top + 4); context.fillText(formatNumber(yMin), 4, margin.top + plotH); context.fillText(`${formatNumber(this.viewRange.start)}s`, margin.left, height - 10); context.fillText(`${formatNumber(this.viewRange.end)}s`, width - margin.right - 70, height - 10);
    for (const item of this.series) {
      const color = this.color(item.definition.id); context.strokeStyle = color; context.lineWidth = 1.5; context.beginPath(); let started = false;
      for (const sample of item.samples) { const value = this.mode === 'normalized' ? normalizeValue(sample.value, item.globalMinimum ?? sample.value, item.globalMaximum ?? sample.value) : sample.value; if (!Number.isFinite(value)) continue; const px = x(sample.timestamp); const py = y(value); started ? context.lineTo(px, py) : context.moveTo(px, py); started = true; }
      context.stroke(); this.drawEvents(context, item, x, y);
    }
    if (this.cursorTimestamp !== undefined) { context.strokeStyle = css('--vscode-editorCursor-foreground', '#fff'); context.beginPath(); const px = x(this.cursorTimestamp); context.moveTo(px, margin.top); context.lineTo(px, margin.top + plotH); context.stroke(); }
    this.renderLegend();
  }

  private drawEvents(context: CanvasRenderingContext2D, item: SignalSeriesDto, x: (t: number) => number, y: (v: number) => number): void {
    context.fillStyle = this.color(item.definition.id);
    for (const event of item.events) {
      const points = event.endTimestamp === undefined || event.endTimestamp === event.timestamp ? [event.timestamp] : [event.timestamp, event.endTimestamp];
      points.forEach((timestamp, index) => { const sample = nearestFromSlice(item.samples, timestamp); if (!sample) return; const value = this.mode === 'normalized' ? normalizeValue(sample.value, item.globalMinimum ?? sample.value, item.globalMaximum ?? sample.value) : sample.value; const px = x(timestamp); const py = y(value); context.beginPath(); if (points.length === 1) { context.moveTo(px, py - 5); context.lineTo(px + 5, py); context.lineTo(px, py + 5); context.lineTo(px - 5, py); } else { const direction = index === 0 ? 1 : -1; context.moveTo(px, py); context.lineTo(px - 5, py + 7 * direction); context.lineTo(px + 5, py + 7 * direction); } context.closePath(); context.fill(); });
    }
  }

  private hover(event: MouseEvent): void {
    if (!this.viewRange || !this.selected.size) return;
    const rect = this.canvas.getBoundingClientRect(); const marginLeft = 58; const plotWidth = rect.width - marginLeft - 18; const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left - marginLeft) / plotWidth));
    this.cursorTimestamp = this.viewRange.start + fraction * (this.viewRange.end - this.viewRange.start); this.timeline?.set(this.cursorTimestamp, 'timeSeries'); this.tooltip.style.left = `${event.clientX - rect.left + 12}px`; this.tooltip.style.top = `${event.clientY - rect.top + 12}px`;
    if (this.hoverRequestScheduled) return;
    this.hoverRequestScheduled = true;
    requestAnimationFrame(() => {
      this.hoverRequestScheduled = false;
      if (this.cursorTimestamp === undefined) return;
      this.latestNearestRequest = ++this.counter; this.post({ type: 'nearestSignalsRequest', requestId: this.latestNearestRequest, selectedIds: [...this.selected], timestamp: this.cursorTimestamp });
    });
  }
  private showTooltip(): void { if (this.cursorTimestamp === undefined) return; this.tooltip.replaceChildren(); const time = document.createElement('strong'); time.textContent = `${formatNumber(this.cursorTimestamp)}s`; this.tooltip.appendChild(time); for (const item of this.nearestValues) { const row = document.createElement('div'); row.textContent = `${item.definition.name}: ${formatNumber(item.sample.value)}${item.definition.unit ? ` ${item.definition.unit}` : ''} @ ${formatNumber(item.sample.timestamp)}s`; row.style.color = this.color(item.definition.id); this.tooltip.appendChild(row); } this.tooltip.hidden = false; }
  private renderLegend(): void { const legend = this.host.querySelector('.chart-legend')!; legend.replaceChildren(); for (const item of this.series) { const entry = document.createElement('span'); const color = document.createElement('i'); color.style.background = this.color(item.definition.id); entry.append(color, `${item.definition.name}${item.definition.unit ? ` (${item.definition.unit})` : ''}`); legend.appendChild(entry); } }
  private color(id: string): string { return this.colors.get(id) ?? SIGNAL_COLOR_PRESETS[Math.abs(hash(id)) % SIGNAL_COLOR_PRESETS.length]; }
  private persist(): void { this.save({ chartSelectedIds: [...this.selected], chartColors: Object.fromEntries(this.colors), chartMode: this.mode, chartPaneWidth: this.paneWidth, chartPaneCollapsed: this.paneCollapsed }); }
  private applyPane(): void { this.pane.style.width = this.paneCollapsed ? '0' : `${this.paneWidth}px`; this.pane.style.display = this.paneCollapsed ? 'none' : 'block'; this.separator.style.display = this.paneCollapsed ? 'none' : 'block'; }
  private startPaneResize(event: MouseEvent): void { event.preventDefault(); const start = event.clientX; const initial = this.paneWidth; const move = (next: MouseEvent) => { this.paneWidth = Math.max(180, Math.min(440, initial + next.clientX - start)); this.applyPane(); }; const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); this.persist(); }; window.addEventListener('mousemove', move); window.addEventListener('mouseup', up); }
  private updateModeButtons(): void { this.host.querySelector('.mode-raw')!.classList.toggle('primary', this.mode === 'raw'); this.host.querySelector('.mode-normalized')!.classList.toggle('primary', this.mode === 'normalized'); }
}

function css(name: string, fallback: string): string { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback; }
function formatNumber(value: number): string { if (!Number.isFinite(value)) return '—'; if (Number.isInteger(value)) return String(value); return Number(value.toPrecision(7)).toString(); }
function fieldLabel(text: string): HTMLLabelElement { const label = document.createElement('label'); label.className = 'external-field-label'; label.textContent = text; return label; }
function hash(value: string): number { let result = 0; for (const character of value) result = ((result << 5) - result + character.charCodeAt(0)) | 0; return result; }
function nearestFromSlice(samples: readonly SignalSample[], timestamp: number): SignalSample | undefined { let best: SignalSample | undefined; let distance = Infinity; for (const sample of samples) { const next = Math.abs(sample.timestamp - timestamp); if (next < distance) { best = sample; distance = next; } } return best; }
