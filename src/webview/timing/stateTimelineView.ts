import type { LogViewState, StateRowDto, ToExtensionMessage, ToWebviewMessage } from '../../extension/editors/rawLogProtocol';
import { chartWheelGesture, wheelPanRange, wheelZoomFactor } from '../shared/chartWheel';
import { t } from '../shared/i18n';
import { SignalSelector } from '../shared/signalSelector';
import type { ViewCardState } from '../shared/iconButton';
import type { SheetImage } from '../shared/imageSheet';
import { createSvgCanvas, type ChartContext } from '../shared/svgCanvas';
import { onTimeDisplayChange, timeRangeLabel, timeTicks } from '../shared/timeDisplay';
import type { TimelineController } from '../shared/timelineController';
import type { ViewContextAction } from '../shared/viewContextAction';
import { ROW_HEIGHT, TOP, css, paintSelection, showTimingTip, timingGeometry, type TimingSpan } from './frameTimingPaint';
import { TimeRangeSelection } from './timeRangeSelection';
import { RUN_SPACING, STATE_SLICE_WIDTH, paintStateTimeline, stateRowHeight, stateTimelineHeight, stateTipLines } from './stateTimelinePaint';

/** A new view starts with at most this many Signals. */
const DEFAULT_SIGNALS = 8;
let instances = 0;

/**
 * State timeline: one row per Signal on the time axis every graph of Visualize shares, a band for each stretch of time
 * the Signal keeps one value, with its state name. Made for Signals with few values: modes, flags, gears.
 */
export class StateTimelineView {
  private readonly canvas: HTMLCanvasElement;
  private readonly legend: HTMLElement;
  private readonly tip: HTMLElement;
  private readonly source = `state-timeline:${++instances}`;
  private readonly lifetime = new AbortController();
  private readonly unsubscribe: (() => void)[] = [];
  private resizeObserver?: ResizeObserver;
  private rows: readonly StateRowDto[] = [];
  /** The Signals chosen, as the settings' Signal list holds them; `ids` is undefined until a new view has been given its first ones. */
  private readonly selected = new Set<string>();
  private selector?: SignalSelector;
  private ids?: string[];
  private fullRange?: TimingSpan;
  private viewRange?: TimingSpan;
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
  private readonly selection: TimeRangeSelection;
  onCardState?: (state: ViewCardState) => void;

  constructor(host: HTMLElement, initial: LogViewState | undefined, private readonly post: (message: ToExtensionMessage) => void, private readonly save: (partial: Partial<LogViewState>) => void, private readonly timeline: TimelineController, private readonly optionsHost?: HTMLElement) {
    this.ids = initial?.stateTimelineIds ? [...initial.stateTimelineIds] : undefined; for (const id of this.ids ?? []) this.selected.add(id);
    // The Signals are chosen as in a graph's settings: the same list, search and grouping.
    if (optionsHost) { const selectorHost = document.createElement('div'); optionsHost.append(selectorHost); this.selector = new SignalSelector({ host: selectorHost, selected: this.selected, grouping: initial?.chartSignalGrouping, onGroupingChange: (grouping) => this.save({ chartSignalGrouping: grouping }), onSelectionChange: () => this.setIds([...this.selected]) }); }
    host.innerHTML = `<div class="frame-timing"><div class="frame-timing-legend"></div><div class="frame-timing-canvas-wrap"><canvas class="frame-timing-canvas"></canvas></div></div>`;
    this.canvas = host.querySelector('canvas')!; this.legend = host.querySelector<HTMLElement>('.frame-timing-legend')!;
    this.tip = document.createElement('div'); this.tip.className = 'frame-timing-tip'; this.tip.hidden = true; document.body.appendChild(this.tip);
    const signal = this.lifetime.signal;
    this.selection = new TimeRangeSelection(this.canvas, this.timeline, this.source, (clientX, clamp) => this.timeAtX(clientX, clamp), this.post, () => this.visible, signal);
    this.canvas.addEventListener('wheel', (event) => this.handleWheel(event), { passive: false, signal });
    this.canvas.addEventListener('pointermove', (event) => this.handlePointer(event), { signal });
    this.canvas.addEventListener('pointerleave', () => { this.timeline.set(undefined, this.source); this.tip.hidden = true; this.scheduleDraw(); }, { signal });
    this.unsubscribe.push(
      this.timeline.subscribeViewRange((range, source) => { if (source !== this.source) this.showSpan(range ?? this.fullRange); }),
      this.timeline.subscribeRange(() => this.scheduleDraw()),
      this.timeline.subscribe(() => this.scheduleDraw()), this.timeline.subscribePosition(() => this.scheduleDraw()), this.timeline.subscribePositionVisibility(() => this.scheduleDraw()),
      onTimeDisplayChange(() => this.scheduleDraw()));
    (this.resizeObserver = new ResizeObserver(() => { if (this.visible) { this.draw(); this.request(); } })).observe(host.querySelector('.frame-timing-canvas-wrap')!);
  }

  get isConfigured(): boolean { return this.ids === undefined || this.ids.length > 0; }
  dispose(): void { this.hide(); this.tip.remove(); this.lifetime.abort(); this.resizeObserver?.disconnect(); for (const stop of this.unsubscribe) stop(); }
  show(): void { this.visible = true; if (!this.catalogRequest) this.requestCatalog(); else this.request(); this.draw(); }
  hide(): void { this.visible = false; this.tip.hidden = true; }
  isPlotTarget(event: MouseEvent): boolean { return event.target === this.canvas; }
  revealOption(id: string): void { this.selector?.reveal(id); }
  setLegendLead(lead: HTMLElement): void { this.legendLead = lead; this.renderLegend(); }
  contextActions(): (ViewContextAction | null)[] { return []; }

  handle(message: ToWebviewMessage): void {
    if (this.selection.handle(message)) return;
    if (message.type === 'signalCatalog') {
      if (message.requestId !== this.catalogRequest) return;
      // A new view shows the Signals of this log that have state names.
      if (this.ids === undefined) { const measured = new Set(message.measuredIds ?? message.definitions.map((definition) => definition.id)); this.ids = message.definitions.filter((definition) => definition.hasValueLabels && measured.has(definition.id)).slice(0, DEFAULT_SIGNALS).map((definition) => definition.id); for (const id of this.ids) this.selected.add(id); }
      this.selector?.setCatalog(message.definitions, message.groups, { measuredIds: message.measuredIds, unmeasuredOption: message.unmeasuredOption }); this.request();
    } else if (message.type === 'stateTimeline') {
      if (message.requestId !== this.pending) return;
      this.pending = 0; this.loaded = true; this.rows = message.rows; this.fullRange = message.fullRange; this.dataRange = this.pendingRange ?? message.fullRange;
      this.viewRange = clampRange(this.timeline.viewRange ?? this.viewRange, this.fullRange) ?? this.fullRange;
      this.renderLegend(); this.draw();
      if (this.stale) this.request();
    } else if (message.type === 'parseComplete' || message.type === 'analysisComplete') { if (this.visible) this.requestCatalog(); }
    // Requests are forgotten when definitions change, so the answers awaited will not come.
    else if (message.type === 'definitionsChanged') { this.pending = 0; if (this.visible) this.requestCatalog(); else this.catalogRequest = 0; }
  }

  // ---- data ------------------------------------------------------------------------------------

  private requestCatalog(): void { this.catalogRequest = ++this.counter; this.post({ type: 'signalCatalogRequest', requestId: this.catalogRequest, view: 'timeSeries' }); }
  private request(): void {
    if (!this.visible || this.ids === undefined) return;
    if (this.pending) { this.stale = true; return; }
    this.stale = false; const { plotWidth } = timingGeometry(Math.max(1, this.canvas.parentElement!.clientWidth));
    this.pending = ++this.counter; this.pendingRange = this.timeline.viewRange && { ...this.timeline.viewRange };
    this.post({ type: 'stateTimelineRequest', requestId: this.pending, selectedIds: this.ids, range: this.pendingRange, bins: Math.ceil(plotWidth / STATE_SLICE_WIDTH), maxRuns: Math.floor(plotWidth / RUN_SPACING) });
  }
  private showSpan(range: TimingSpan | undefined): void { this.viewRange = range && { ...range }; this.scheduleDraw(); this.request(); }
  private navigate(range: TimingSpan): void {
    if (!this.fullRange) return;
    this.timeline.setViewRange(range.start <= this.fullRange.start && range.end >= this.fullRange.end ? undefined : range, this.source); this.showSpan(range);
  }
  private setIds(ids: string[]): void { this.ids = ids; this.save({ stateTimelineIds: ids }); this.request(); this.renderLegend(); }

  // ---- pointer ---------------------------------------------------------------------------------

  private handleWheel(event: WheelEvent): void {
    if (!this.fullRange || !this.viewRange) return; const gesture = chartWheelGesture(event, this.canvas.clientWidth);
    if (gesture.kind === 'scroll' || !gesture.delta) return;
    const view = this.viewRange; const full = this.fullRange; const span = view.end - view.start; const fullSpan = full.end - full.start; const { left, plotWidth } = timingGeometry(this.canvas.clientWidth);
    if (gesture.kind === 'zoom') {
      event.preventDefault(); const next = Math.max(fullSpan * 0.0005, Math.min(fullSpan, span * wheelZoomFactor(gesture.delta)));
      const ratio = Math.max(0, Math.min(1, (event.clientX - this.canvas.getBoundingClientRect().left - left) / plotWidth)); const pivot = view.start + span * ratio;
      const start = Math.max(full.start, Math.min(pivot - next * ratio, full.end - next)); this.navigate({ start, end: start + next }); return;
    }
    if (span >= fullSpan - 1e-12) return;
    event.preventDefault(); this.navigate(wheelPanRange(view, full, gesture.delta, plotWidth));
  }
  /** The time at a pointer position: undefined outside the plot, or, with `clamp`, the nearest time of the plot. */
  private timeAtX(clientX: number, clamp = false): number | undefined {
    const view = this.viewRange; if (!view) return undefined; const { left, plotWidth } = timingGeometry(this.canvas.clientWidth); const offset = clientX - this.canvas.getBoundingClientRect().left;
    if (!clamp && (offset < left || offset > left + plotWidth)) return undefined;
    return view.start + Math.max(0, Math.min(1, (offset - left) / plotWidth)) * (view.end - view.start);
  }
  private handlePointer(event: PointerEvent): void {
    const view = this.viewRange; const bounds = this.canvas.getBoundingClientRect(); const { left, plotWidth } = timingGeometry(this.canvas.clientWidth); const offset = event.clientX - bounds.left;
    const time = view && offset >= left && offset <= left + plotWidth ? view.start + (offset - left) / plotWidth * (view.end - view.start) : undefined;
    this.timeline.set(time, this.source); const row = this.rows[Math.floor((event.clientY - bounds.top - TOP) / stateRowHeight(undefined, this.rows, this.canvas.clientWidth))];
    if (!row) { this.tip.hidden = true; this.scheduleDraw(); return; }
    const lines = stateTipLines(row, time, this.dataRange, timeRangeLabel);
    if (lines.length === 1 && time !== undefined) { this.tip.hidden = true; this.scheduleDraw(); return; }
    showTimingTip(this.tip, lines, event); this.scheduleDraw();
  }

  // ---- drawing ---------------------------------------------------------------------------------

  private renderLegend(): void {
    const lead = this.legendLead as HTMLInputElement | undefined; const editing = !!lead && document.activeElement === lead; const caret = editing ? [lead!.selectionStart, lead!.selectionEnd] as const : undefined;
    this.legend.replaceChildren(); if (lead) this.legend.append(lead);
    if (this.ids !== undefined) { const summary = document.createElement('span'); summary.className = 'frame-timing-summary muted'; summary.textContent = t(`${this.ids.length} Signal(s)`, `シグナル ${this.ids.length}件`); this.legend.append(summary); }
    if (editing) { lead!.focus(); if (caret?.[0] !== null && caret?.[0] !== undefined) lead!.setSelectionRange(caret[0], caret[1]); }
    // Signals are chosen but the log has none of them: the card shrinks to one line, as a graph does.
    const noData = this.loaded && !!this.ids?.length && !this.rows.length; this.onCardState?.({ inlineTitle: !!lead && !noData, noData });
  }
  private scheduleDraw(): void { if (this.drawScheduled) return; this.drawScheduled = true; requestAnimationFrame(() => { this.drawScheduled = false; if (this.visible) this.draw(); }); }
  private draw(): void {
    if (!this.visible) return; const width = Math.max(1, this.canvas.parentElement!.clientWidth); const height = stateTimelineHeight(this.rows, width); const ratio = window.devicePixelRatio || 1;
    if (this.canvas.width !== Math.round(width * ratio) || this.canvas.height !== Math.round(height * ratio)) { this.canvas.width = Math.round(width * ratio); this.canvas.height = Math.round(height * ratio); this.canvas.style.width = `${width}px`; this.canvas.style.height = `${height}px`; }
    const context = this.canvas.getContext('2d'); if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, width, height);
    if (!this.rows.length || !this.viewRange) { context.font = '12px sans-serif'; context.fillStyle = css('--vscode-descriptionForeground', '#888'); context.textBaseline = 'middle'; context.fillText(!this.loaded ? t('Loading…', '読み込み中…') : this.ids?.length ? t('None of its Signals are in this log.', '該当するシグナルはありません。') : t('Select Signals in Graph settings.', 'グラフ設定でシグナルを選択してください。'), 24, TOP + ROW_HEIGHT / 2); return; }
    this.paint(context, width, true);
  }

  private paint(context: ChartContext, width: number, interactive: boolean): void {
    const cursor = interactive ? this.timeline.timestamp ?? (this.timeline.positionVisible ? this.timeline.position : undefined) : undefined;
    paintStateTimeline(context, width, this.rows, this.viewRange!, this.dataRange, timeTicks, cursor, interactive ? [{ time: this.timeline.positionVisible ? this.timeline.position : undefined, color: css('--sm-trace-color', '#d18616'), alpha: 1 }, { time: this.timeline.timestamp, color: css('--vscode-foreground', '#ccc'), alpha: .55 }] : []);
    if (interactive) paintSelection(context, width, this.viewRange!, this.timeline.range, TOP, this.rows.length * stateRowHeight(undefined, this.rows, width));
  }

  /** This view as an export image; `heading` is the title written on it. */
  renderImage(heading = 'SigMixa · State timeline', width = 1600): SheetImage | undefined {
    if (!this.rows.length || !this.viewRange) return undefined;
    const header = 44; const height = header + stateTimelineHeight(this.rows, width) + 8;
    const paintAll = (context: ChartContext) => {
      context.fillStyle = css('--vscode-editor-background', '#1e1e1e'); context.fillRect(0, 0, width, height);
      context.fillStyle = css('--vscode-foreground', '#ddd'); context.font = `600 14px ${css('--vscode-font-family', 'sans-serif')}`; context.textBaseline = 'middle'; context.textAlign = 'left'; context.fillText(heading, 12, header / 2);
      context.save(); context.translate(0, header); this.paint(context, width, false); context.restore();
    };
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; const context = canvas.getContext('2d'); if (!context) return undefined;
    paintAll(context); const vector = createSvgCanvas(width, height); paintAll(vector.context);
    return { canvas, pngDataUrl: canvas.toDataURL('image/png'), svg: vector.toSvg(), width, height };
  }
}

function clampRange(view: TimingSpan | undefined, full: TimingSpan | undefined): TimingSpan | undefined {
  if (!view || !full) return undefined; const span = Math.min(full.end - full.start, view.end - view.start); if (!(span > 0) || view.end < full.start || view.start > full.end) return undefined;
  const start = Math.max(full.start, Math.min(view.start, full.end - span)); return { start, end: start + span };
}
