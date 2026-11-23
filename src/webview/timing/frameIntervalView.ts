import type { FrameIntervalsDto, LogViewState, ToExtensionMessage, ToWebviewMessage } from '../../extension/editors/rawLogProtocol';
import { chartWheelGesture, wheelPanRange, wheelZoomFactor } from '../shared/chartWheel';
import { t } from '../shared/i18n';
import type { ViewCardState } from '../shared/iconButton';
import type { SheetImage } from '../shared/imageSheet';
import { createSvgCanvas, type ChartContext } from '../shared/svgCanvas';
import { onTimeDisplayChange, timeLabel, timeTicks } from '../shared/timeDisplay';
import type { TimelineController } from '../shared/timelineController';
import type { ViewContextAction } from '../shared/viewContextAction';
import { CanIdList } from './canIdList';
import { TimeRangeSelection } from './timeRangeSelection';
import { INTERVAL_SLICE_WIDTH, INTERVAL_TOP, intervalHeading, intervalLaneAt, intervalLanes, intervalLegendItems, intervalTipLines, paintFrameIntervals } from './frameIntervalPaint';
import { css, paintSelection, showTimingTip, timingGeometry, type TimingSpan } from './frameTimingPaint';

let instances = 0;

/**
 * Receive interval: the time between the frames of one CAN ID, as a point per frame on the time axis every graph of
 * Visualize shares. The period is a dashed line with a ±10 % band, so jitter and late frames show at a glance; intervals
 * beyond the plot are marked at its top with their value.
 */
export class FrameIntervalView {
  private readonly canvas: HTMLCanvasElement;
  private readonly legend: HTMLElement;
  private readonly tip: HTMLElement;
  private readonly source = `frame-interval:${++instances}`;
  private readonly lifetime = new AbortController();
  private readonly unsubscribe: (() => void)[] = [];
  private resizeObserver?: ResizeObserver;
  /** One per CAN ID shown, in the order they were chosen. */
  private items: readonly FrameIntervalsDto[] = [];
  private ids: FrameIntervalsDto['ids'] = [];
  private fullRange?: TimingSpan;
  private viewRange?: TimingSpan;
  /** The span the points or slices were read for. */
  private dataRange?: TimingSpan;
  private pendingRange?: TimingSpan;
  /** The CAN IDs chosen; undefined in a new view, which shows the one the log suggests. */
  private keys?: string[];
  private visible = false;
  private counter = 0;
  private pending = 0;
  private stale = false;
  private loaded = false;
  private drawScheduled = false;
  private legendLead?: HTMLElement;
  private readonly selection: TimeRangeSelection;
  private readonly canIds: CanIdList | undefined;
  onCardState?: (state: ViewCardState) => void;

  constructor(host: HTMLElement, initial: LogViewState | undefined, private readonly post: (message: ToExtensionMessage) => void, private readonly save: (partial: Partial<LogViewState>) => void, private readonly timeline: TimelineController, private readonly optionsHost?: HTMLElement) {
    this.keys = initial?.frameIntervalKeys ? [...initial.frameIntervalKeys] : initial?.frameIntervalKey ? [initial.frameIntervalKey] : undefined;
    host.innerHTML = `<div class="frame-timing"><div class="frame-timing-legend"></div><div class="frame-timing-canvas-wrap"><canvas class="frame-timing-canvas"></canvas></div></div>`;
    this.canvas = host.querySelector('canvas')!; this.legend = host.querySelector<HTMLElement>('.frame-timing-legend')!;
    this.tip = document.createElement('div'); this.tip.className = 'frame-timing-tip'; this.tip.hidden = true; document.body.appendChild(this.tip);
    const signal = this.lifetime.signal;
    this.selection = new TimeRangeSelection(this.canvas, this.timeline, this.source, (clientX, clamp) => this.timeAtX(clientX, clamp), this.post, () => this.visible, signal);
    this.canIds = optionsHost && new CanIdList(optionsHost, { chosen: (key) => (this.keys ?? this.items.map((item) => item.key)).includes(key), change: (keys, chosen) => { const next = (this.keys ?? []).filter((key) => !keys.includes(key)); if (chosen) next.push(...keys); this.keys = next; this.save({ frameIntervalKeys: next, frameIntervalKey: undefined }); this.request(); } });
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

  get isConfigured(): boolean { return this.keys === undefined || this.keys.length > 0; }
  dispose(): void { this.hide(); this.tip.remove(); this.lifetime.abort(); this.resizeObserver?.disconnect(); for (const stop of this.unsubscribe) stop(); }
  show(): void { this.visible = true; this.request(); this.draw(); }
  hide(): void { this.visible = false; this.tip.hidden = true; }
  isPlotTarget(event: MouseEvent): boolean { return event.target === this.canvas; }
  revealOption(): void { /* One setting: the CAN ID. */ }
  setLegendLead(lead: HTMLElement): void { this.legendLead = lead; this.renderLegend(); }
  contextActions(): (ViewContextAction | null)[] { return []; }

  handle(message: ToWebviewMessage): void {
    if (this.selection.handle(message)) return;
    if (message.type === 'frameIntervals') {
      if (message.requestId !== this.pending) return;
      this.pending = 0; this.loaded = true; this.items = message.items; this.ids = message.data.ids; this.fullRange = message.fullRange;
      // A new view keeps the CAN ID it was given.
      if (this.keys === undefined && message.items.length) this.keys = message.items.flatMap((item) => item.key ? [item.key] : []); this.dataRange = this.pendingRange ?? message.fullRange;
      this.viewRange = clampRange(this.timeline.viewRange ?? this.viewRange, this.fullRange) ?? this.fullRange;
      this.renderLegend(); this.renderOptions(); this.draw();
      if (this.stale) this.request();
    } else if (message.type === 'parseComplete' || message.type === 'analysisComplete') { if (this.visible) this.request(); }
    // Requests are forgotten when definitions change, so the answer awaited will not come.
    else if (message.type === 'definitionsChanged') { this.pending = 0; if (this.visible) this.request(); }
  }

  // ---- data ------------------------------------------------------------------------------------

  private request(): void {
    if (!this.visible) return;
    if (this.pending) { this.stale = true; return; }
    this.stale = false; const { plotWidth } = timingGeometry(Math.max(1, this.canvas.parentElement!.clientWidth));
    this.pending = ++this.counter; this.pendingRange = this.timeline.viewRange && { ...this.timeline.viewRange };
    this.post({ type: 'frameIntervalRequest', requestId: this.pending, keys: this.keys, range: this.pendingRange, buckets: Math.ceil(plotWidth / INTERVAL_SLICE_WIDTH), maxPoints: Math.floor(plotWidth * 1.5) });
  }
  /** Shows a span at once from what is held, and asks for its own intervals behind. */
  private showSpan(range: TimingSpan | undefined): void { this.viewRange = range && { ...range }; this.scheduleDraw(); this.request(); }
  private navigate(range: TimingSpan): void {
    if (!this.fullRange) return;
    this.timeline.setViewRange(range.start <= this.fullRange.start && range.end >= this.fullRange.end ? undefined : range, this.source); this.showSpan(range);
  }

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
    const view = this.viewRange; const bounds = this.canvas.getBoundingClientRect(); const lanes = this.lanes.lanes; const data = this.items[intervalLaneAt(lanes, event.clientY - bounds.top)]; const { left, plotWidth } = timingGeometry(this.canvas.clientWidth); const offset = event.clientX - bounds.left;
    if (!view || !data || offset < left || offset > left + plotWidth) { this.timeline.set(undefined, this.source); this.tip.hidden = true; this.scheduleDraw(); return; }
    const perPixel = (view.end - view.start) / plotWidth; const time = view.start + (offset - left) * perPixel; this.timeline.set(time, this.source);
    const lines = intervalTipLines(data, time, perPixel, this.dataRange, timeLabel);
    if (lines.length === 1) { this.tip.hidden = true; this.scheduleDraw(); return; }
    showTimingTip(this.tip, lines, event); this.scheduleDraw();
  }

  // ---- drawing ---------------------------------------------------------------------------------

  private renderLegend(): void {
    const lead = this.legendLead as HTMLInputElement | undefined; const editing = !!lead && document.activeElement === lead; const caret = editing ? [lead!.selectionStart, lead!.selectionEnd] as const : undefined;
    this.legend.replaceChildren(); if (lead) this.legend.append(lead);
    // One CAN ID: its summary is the legend. Several: each has its own line above its plot.
    for (const item of this.items.length === 1 ? intervalLegendItems(this.items[0]) : this.items.length ? [{ text: t(`${this.items.length} CAN ID(s)`, `CAN ID ${this.items.length}件`), muted: true }] : []) { const element = document.createElement('span'); element.className = item.muted ? 'frame-timing-summary muted' : 'frame-timing-summary'; element.textContent = item.text; this.legend.append(element); }
    if (editing) { lead!.focus(); if (caret?.[0] !== null && caret?.[0] !== undefined) lead!.setSelectionRange(caret[0], caret[1]); }
    this.onCardState?.({ inlineTitle: !!lead, noData: false });
  }
  private renderOptions(): void { this.canIds?.setIds(this.ids); }
  private get lanes() { return intervalLanes(this.items.length, this.items.map(intervalHeading)); }
  private scheduleDraw(): void { if (this.drawScheduled) return; this.drawScheduled = true; requestAnimationFrame(() => { this.drawScheduled = false; if (this.visible) this.draw(); }); }
  private draw(): void {
    if (!this.visible) return; const width = Math.max(1, this.canvas.parentElement!.clientWidth); const height = this.lanes.height; const ratio = window.devicePixelRatio || 1;
    if (this.canvas.width !== Math.round(width * ratio) || this.canvas.height !== Math.round(height * ratio)) { this.canvas.width = Math.round(width * ratio); this.canvas.height = Math.round(height * ratio); this.canvas.style.width = `${width}px`; this.canvas.style.height = `${height}px`; }
    const context = this.canvas.getContext('2d'); if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, width, height);
    if (!this.items.length || !this.viewRange) { context.font = '12px sans-serif'; context.fillStyle = css('--vscode-descriptionForeground', '#888'); context.textBaseline = 'middle'; context.fillText(!this.loaded ? t('Loading…', '読み込み中…') : this.keys?.length === 0 ? t('Select CAN IDs in Graph settings.', 'グラフ設定でCAN IDを選択してください。') : t('This log has no CAN frames.', 'このログにCANフレームはありません。'), 24, INTERVAL_TOP + 20); return; }
    this.paint(context, width, true);
  }

  private paint(context: ChartContext, width: number, interactive: boolean): void {
    const { lanes } = this.lanes; const view = this.viewRange!;
    const marks = interactive ? [{ time: this.timeline.positionVisible ? this.timeline.position : undefined, color: css('--sm-trace-color', '#d18616'), alpha: 1 }, { time: this.timeline.timestamp, color: css('--vscode-foreground', '#ccc'), alpha: .55 }] : [];
    this.items.forEach((item, index) => {
      paintFrameIntervals(context, width, item, view, this.dataRange, timeTicks, marks, undefined, lanes[index]);
      if (interactive) paintSelection(context, width, view, this.timeline.range, lanes[index].top, lanes[index].height);
    });
  }

  /** This view as an export image; `heading` is the title written on it. */
  renderImage(heading = 'SigMixa · Receive interval', width = 1600): SheetImage | undefined {
    if (!this.items.length || !this.viewRange) return undefined;
    const header = 44; const height = header + this.lanes.height + 8; const only = this.items.length === 1 ? this.items[0] : undefined; const title = only ? `${heading} · ${only.canId ?? ''}${only.name ? ` ${only.name}` : ''}` : heading;
    const paintAll = (context: ChartContext) => {
      context.fillStyle = css('--vscode-editor-background', '#1e1e1e'); context.fillRect(0, 0, width, height);
      context.fillStyle = css('--vscode-foreground', '#ddd'); context.font = `600 14px ${css('--vscode-font-family', 'sans-serif')}`; context.textBaseline = 'middle'; context.textAlign = 'left'; context.fillText(title, 12, header / 2);
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
