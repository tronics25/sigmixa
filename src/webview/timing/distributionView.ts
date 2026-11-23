import type { DistributionRowDto, LogViewState, ToExtensionMessage, ToWebviewMessage } from '../../extension/editors/rawLogProtocol';
import { t } from '../shared/i18n';
import { SignalSelector } from '../shared/signalSelector';
import { MeasuredSamples } from '../shared/measuredSamples';
import type { ViewCardState } from '../shared/iconButton';
import type { SheetImage } from '../shared/imageSheet';
import { createSvgCanvas, type ChartContext } from '../shared/svgCanvas';
import { onTimeDisplayChange, timeRangeLabel } from '../shared/timeDisplay';
import type { TimelineController } from '../shared/timelineController';
import type { ViewContextAction } from '../shared/viewContextAction';
import { DISTRIBUTION_BINS, distributionHeight, distributionTipLines, paintDistribution } from './distributionPaint';
import { css, showTimingTip, type TimingSpan } from './frameTimingPaint';

/** A new view starts with at most this many Signals. */
const DEFAULT_SIGNALS = 4;

/**
 * Distribution and statistics: one row per Signal with how its values are spread and their count, least, greatest, mean
 * and standard deviation, over the time span the graphs of Visualize show. Zooming a graph narrows what is counted.
 */
export class DistributionView {
  private readonly canvas: HTMLCanvasElement;
  private readonly legend: HTMLElement;
  private readonly tip: HTMLElement;
  private readonly lifetime = new AbortController();
  private readonly unsubscribe: (() => void)[] = [];
  private resizeObserver?: ResizeObserver;
  private rows: readonly DistributionRowDto[] = [];
  /** The Signals chosen, as the settings' Signal list holds them; `ids` is undefined until a new view has been given its first ones. */
  private readonly selected = new Set<string>();
  private selector?: SignalSelector;
  private ids?: string[];
  private fullRange?: TimingSpan;
  /** The span the rows were counted over. */
  private dataRange?: TimingSpan;
  private pendingRange?: TimingSpan;
  private visible = false;
  private counter = 0;
  private catalogRequest = 0;
  private pending = 0;
  private stale = false;
  private loaded = false;
  private drawScheduled = false;
  private legendLead?: HTMLElement;
  /** True when the rows were counted over the selected time range, not the span shown. */
  private dataSelected = false;
  private pendingSelected = false;
  /** The values at the time under the pointer, else at the Trace position: marked on the bars. */
  private readonly cursorValues: MeasuredSamples;
  private marks = new Map<string, number>();
  private markHover = false;
  onCardState?: (state: ViewCardState) => void;

  constructor(host: HTMLElement, initial: LogViewState | undefined, private readonly post: (message: ToExtensionMessage) => void, private readonly save: (partial: Partial<LogViewState>) => void, private readonly timeline: TimelineController, private readonly optionsHost?: HTMLElement) {
    this.ids = initial?.distributionIds ? [...initial.distributionIds] : undefined; for (const id of this.ids ?? []) this.selected.add(id);
    // The Signals are chosen as in a graph's settings: the same list, search and grouping.
    if (optionsHost) { const selectorHost = document.createElement('div'); optionsHost.append(selectorHost); this.selector = new SignalSelector({ host: selectorHost, selected: this.selected, grouping: initial?.chartSignalGrouping, onGroupingChange: (grouping) => this.save({ chartSignalGrouping: grouping }), onSelectionChange: () => this.setIds([...this.selected]) }); }
    host.innerHTML = `<div class="frame-timing"><div class="frame-timing-legend"></div><div class="frame-timing-canvas-wrap"><canvas class="frame-timing-canvas distribution-canvas"></canvas></div></div>`;
    this.canvas = host.querySelector('canvas')!; this.legend = host.querySelector<HTMLElement>('.frame-timing-legend')!;
    this.tip = document.createElement('div'); this.tip.className = 'frame-timing-tip'; this.tip.hidden = true; document.body.appendChild(this.tip);
    const signal = this.lifetime.signal;
    this.canvas.addEventListener('pointermove', (event) => { const bounds = this.canvas.getBoundingClientRect(); const lines = distributionTipLines(this.rows, this.canvas.clientWidth, event.clientX - bounds.left, event.clientY - bounds.top); if (lines) showTimingTip(this.tip, lines, event); else this.tip.hidden = true; }, { signal });
    this.canvas.addEventListener('pointerleave', () => { this.tip.hidden = true; }, { signal });
    this.cursorValues = new MeasuredSamples((requestId, query) => this.post({ type: 'measuredSignalsRequest', requestId, selectedIds: query.signalIds, timestamp: query.timestamp }), () => this.takeMarks());
    this.unsubscribe.push(this.timeline.subscribeViewRange(() => this.request()), this.timeline.subscribeRange(() => this.request()), onTimeDisplayChange(() => this.renderLegend()),
      this.timeline.subscribe(() => this.followCursor()), this.timeline.subscribePosition(() => this.followCursor()), this.timeline.subscribePositionVisibility(() => this.followCursor()));
    (this.resizeObserver = new ResizeObserver(() => { if (this.visible) this.draw(); })).observe(host.querySelector('.frame-timing-canvas-wrap')!);
  }

  get isConfigured(): boolean { return this.ids === undefined || this.ids.length > 0; }
  dispose(): void { this.hide(); this.tip.remove(); this.lifetime.abort(); this.resizeObserver?.disconnect(); for (const stop of this.unsubscribe) stop(); }
  show(): void { this.visible = true; if (!this.catalogRequest) this.requestCatalog(); else this.request(); this.followCursor(); this.draw(); }
  hide(): void { this.visible = false; this.tip.hidden = true; this.cursorValues.update([]); }
  isPlotTarget(event: MouseEvent): boolean { return event.target === this.canvas; }
  revealOption(id: string): void { this.selector?.reveal(id); }
  setLegendLead(lead: HTMLElement): void { this.legendLead = lead; this.renderLegend(); }
  contextActions(): (ViewContextAction | null)[] { return []; }

  handle(message: ToWebviewMessage): void {
    if (message.type === 'signalCatalog') {
      if (message.requestId !== this.catalogRequest) return;
      // A new view shows the first Signals of this log that are measured values, not states.
      if (this.ids === undefined) { const measured = new Set(message.measuredIds ?? message.definitions.map((definition) => definition.id)); this.ids = message.definitions.filter((definition) => !definition.hasValueLabels && measured.has(definition.id)).slice(0, DEFAULT_SIGNALS).map((definition) => definition.id); for (const id of this.ids) this.selected.add(id); }
      this.selector?.setCatalog(message.definitions, message.groups, { measuredIds: message.measuredIds, unmeasuredOption: message.unmeasuredOption }); this.request();
    } else if (message.type === 'distribution') {
      if (message.requestId !== this.pending) return;
      this.pending = 0; this.loaded = true; this.rows = message.rows; this.fullRange = message.fullRange; this.dataRange = this.pendingRange ?? message.fullRange; this.dataSelected = this.pendingSelected;
      this.renderLegend(); this.draw();
      if (this.stale) this.request();
    } else if (message.type === 'measuredSignals') this.cursorValues.receive(message.requestId, message.samples);
    else if (message.type === 'parseComplete' || message.type === 'analysisComplete') { this.cursorValues.invalidate(); if (this.visible) { this.requestCatalog(); this.followCursor(); } }
    // Requests are forgotten when definitions change, so the answers awaited will not come.
    else if (message.type === 'definitionsChanged') { this.pending = 0; this.cursorValues.invalidate(); if (this.visible) { this.requestCatalog(); this.followCursor(); } else this.catalogRequest = 0; }
  }

  private requestCatalog(): void { this.catalogRequest = ++this.counter; this.post({ type: 'signalCatalogRequest', requestId: this.catalogRequest, view: 'timeSeries' }); }
  /** Counts again over the selected time range, else the span shown: one request at a time, and once more when the span moved on meanwhile. */
  private request(): void {
    if (!this.visible || this.ids === undefined) return;
    if (this.pending) { this.stale = true; return; }
    const selected = this.timeline.range; const span = selected ? { start: Math.min(selected.start, selected.end), end: Math.max(selected.start, selected.end) } : this.timeline.viewRange;
    this.stale = false; this.pending = ++this.counter; this.pendingRange = span && { ...span }; this.pendingSelected = !!selected;
    this.post({ type: 'distributionRequest', requestId: this.pending, selectedIds: this.ids, range: this.pendingRange, bins: DISTRIBUTION_BINS });
  }
  private setIds(ids: string[]): void { this.ids = ids; this.save({ distributionIds: ids }); this.request(); this.followCursor(); this.renderLegend(); }
  /** Asks for the values at the time under the pointer, else at the Trace position; the marks drawn stay until those arrive. */
  private followCursor(): void {
    const hover = this.timeline.timestamp; const time = hover ?? (this.timeline.positionVisible ? this.timeline.position : undefined);
    if (!this.visible || time === undefined || !this.ids?.length) { this.cursorValues.update([]); if (this.marks.size) { this.marks = new Map(); this.scheduleDraw(); } return; }
    this.markHover = hover !== undefined; this.cursorValues.update([{ slot: 'cursor', timestamp: time, signalIds: this.ids }]); this.takeMarks();
  }
  private takeMarks(): void {
    if (!this.cursorValues.ready('cursor')) return;
    this.marks = new Map((this.ids ?? []).flatMap((id) => { const sample = this.cursorValues.sample('cursor', id); return sample ? [[id, sample.value] as const] : []; })); this.scheduleDraw();
  }
  private get markStyle(): { values: ReadonlyMap<string, number>; color: string } { return { values: this.marks, color: this.markHover ? css('--vscode-foreground', '#ccc') : css('--sm-trace-color', '#d18616') }; }

  private renderLegend(): void {
    const lead = this.legendLead as HTMLInputElement | undefined; const editing = !!lead && document.activeElement === lead; const caret = editing ? [lead!.selectionStart, lead!.selectionEnd] as const : undefined;
    this.legend.replaceChildren(); if (lead) this.legend.append(lead);
    if (this.ids !== undefined) { const summary = document.createElement('span'); summary.className = 'frame-timing-summary muted'; summary.textContent = t(`${this.ids.length} Signal(s)`, `シグナル ${this.ids.length}件`); this.legend.append(summary); }
    // The statistics are of the time span shown.
    const span = this.dataRange ?? this.fullRange; if (span && this.rows.length) { const range = document.createElement('span'); range.className = 'frame-timing-summary muted'; range.textContent = `${this.dataSelected ? `${t('Selected range', '選択範囲')} ` : ''}${timeRangeLabel(span.start, span.end)}`; this.legend.append(range); }
    if (editing) { lead!.focus(); if (caret?.[0] !== null && caret?.[0] !== undefined) lead!.setSelectionRange(caret[0], caret[1]); }
    // Signals are chosen but the log has none of them: the card shrinks to one line, as a graph does.
    const noData = this.loaded && !!this.ids?.length && !this.rows.length; this.onCardState?.({ inlineTitle: !!lead && !noData, noData });
  }
  private scheduleDraw(): void { if (this.drawScheduled) return; this.drawScheduled = true; requestAnimationFrame(() => { this.drawScheduled = false; if (this.visible) this.draw(); }); }
  private draw(): void {
    if (!this.visible) return; const width = Math.max(1, this.canvas.parentElement!.clientWidth); const height = distributionHeight(this.rows.length); const ratio = window.devicePixelRatio || 1;
    if (this.canvas.width !== Math.round(width * ratio) || this.canvas.height !== Math.round(height * ratio)) { this.canvas.width = Math.round(width * ratio); this.canvas.height = Math.round(height * ratio); this.canvas.style.width = `${width}px`; this.canvas.style.height = `${height}px`; }
    const context = this.canvas.getContext('2d'); if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, width, height);
    if (!this.rows.length) { context.font = '12px sans-serif'; context.fillStyle = css('--vscode-descriptionForeground', '#888'); context.textBaseline = 'middle'; context.fillText(!this.loaded ? t('Loading…', '読み込み中…') : this.ids?.length ? t('None of its Signals are in this log.', '該当するシグナルはありません。') : t('Select Signals in Graph settings.', 'グラフ設定でシグナルを選択してください。'), 24, 40); return; }
    paintDistribution(context, width, this.rows, this.markStyle);
  }

  /** This view as an export image; `heading` is the title written on it. */
  renderImage(heading = 'SigMixa · Distribution', width = 1600): SheetImage | undefined {
    if (!this.rows.length) return undefined;
    const header = 44; const height = header + distributionHeight(this.rows.length) + 8; const span = this.dataRange ?? this.fullRange; const title = span ? `${heading} · ${timeRangeLabel(span.start, span.end)}` : heading;
    const paintAll = (context: ChartContext) => {
      context.fillStyle = css('--vscode-editor-background', '#1e1e1e'); context.fillRect(0, 0, width, height);
      context.fillStyle = css('--vscode-foreground', '#ddd'); context.font = `600 14px ${css('--vscode-font-family', 'sans-serif')}`; context.textBaseline = 'middle'; context.textAlign = 'left'; context.fillText(title, 12, header / 2);
      context.save(); context.translate(0, header); paintDistribution(context, width, this.rows); context.restore();
    };
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; const context = canvas.getContext('2d'); if (!context) return undefined;
    paintAll(context); const vector = createSvgCanvas(width, height); paintAll(vector.context);
    return { canvas, pngDataUrl: canvas.toDataURL('image/png'), svg: vector.toSvg(), width, height };
  }
}
