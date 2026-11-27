import type { FrameTimingRowDto, LogViewState, ToExtensionMessage, ToWebviewMessage } from '../../extension/editors/rawLogProtocol';
import { chartWheelGesture, wheelPanRange, wheelZoomFactor } from '../shared/chartWheel';
import { t } from '../shared/i18n';
import type { ViewCardState } from '../shared/iconButton';
import type { SheetImage } from '../shared/imageSheet';
import { createSvgCanvas, type ChartContext } from '../shared/svgCanvas';
import { onTimeDisplayChange, timeLabel, timeTicks } from '../shared/timeDisplay';
import { CanIdList } from './canIdList';
import { TimeRangeSelection } from './timeRangeSelection';
import type { TimelineController } from '../shared/timelineController';
import type { ViewContextAction } from '../shared/viewContextAction';
import { paintSelection, timingRowHeight, LINE_SPACING, ROW_HEIGHT, SLICE_WIDTH, TOP, css, paintFrameTiming, showTimingTip, timingGeometry, timingHeight, timingTipLines, viewShowing } from './frameTimingPaint';

interface Range { readonly start: number; readonly end: number }
interface Gap extends Range { readonly row: FrameTimingRowDto }

let instances = 0;

/**
 * Frame timing: one row per CAN ID on the time axis every graph of Visualize shares, a line per received frame. Intervals
 * much longer than the CAN ID's period are marked as gaps. Zooming, scrolling and the time under the pointer are shared
 * with the graphs through the timeline.
 */
export class FrameTimingView {
  private readonly elements: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly legend: HTMLElement;
  private readonly tip: HTMLElement;
  private readonly source = `frame-timing:${++instances}`;
  private readonly lifetime = new AbortController();
  private readonly unsubscribe: (() => void)[] = [];
  private resizeObserver?: ResizeObserver;
  private rows: readonly FrameTimingRowDto[] = [];
  private fullRange?: Range;
  /** The span the rows' times and slices were read for. */
  private dataRange?: Range;
  private pendingRange?: Range;
  private viewRange?: Range;
  private hidden: Set<string>;
  private visible = false;
  private counter = 0;
  /** The request whose answer is awaited; only one is out at a time, and `stale` asks again when it arrives. */
  private pending = 0;
  private stale = false;
  private loaded = false;
  private drawScheduled = false;
  private gapCursor = -1;
  private legendLead?: HTMLElement;
  private readonly selection: TimeRangeSelection;
  private readonly canIds: CanIdList | undefined;
  onCardState?: (state: ViewCardState) => void;

  constructor(host: HTMLElement, initial: LogViewState | undefined, private readonly post: (message: ToExtensionMessage) => void, private readonly save: (partial: Partial<LogViewState>) => void, private readonly timeline: TimelineController, private readonly optionsHost?: HTMLElement) {
    this.hidden = new Set(initial?.frameTimingHiddenKeys ?? []);
    host.innerHTML = `<div class="frame-timing"><div class="frame-timing-legend"></div><div class="frame-timing-canvas-wrap"><canvas class="frame-timing-canvas"></canvas></div></div>`;
    this.elements = host.querySelector<HTMLElement>('.frame-timing')!; this.canvas = host.querySelector('canvas')!; this.legend = host.querySelector<HTMLElement>('.frame-timing-legend')!; 
    // On the page itself: inside the card it would be cut off at the card's edge.
    this.tip = document.createElement('div'); this.tip.className = 'frame-timing-tip'; this.tip.hidden = true; document.body.appendChild(this.tip);
    const signal = this.lifetime.signal;
    this.selection = new TimeRangeSelection(this.canvas, this.timeline, this.source, (clientX, clamp) => this.timeAtX(clientX, clamp), this.post, () => this.visible, signal);
    this.canIds = optionsHost && new CanIdList(optionsHost, { chosen: (key) => !this.hidden.has(key), change: (keys, chosen) => { for (const key of keys) { if (chosen) this.hidden.delete(key); else this.hidden.add(key); } this.save({ frameTimingHiddenKeys: [...this.hidden] }); this.gapCursor = -1; this.renderLegend(); this.draw(); } });
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

  get isConfigured(): boolean { return true; }
  dispose(): void { this.hide(); this.tip.remove(); this.lifetime.abort(); this.resizeObserver?.disconnect(); for (const stop of this.unsubscribe) stop(); }
  show(): void { this.visible = true; this.request(); this.draw(); }
  hide(): void { this.visible = false; this.tip.hidden = true; }
  isPlotTarget(event: MouseEvent): boolean { return event.target === this.canvas; }
  revealOption(): void { /* The settings list every CAN ID; there is nothing to scroll to. */ }
  setLegendLead(lead: HTMLElement): void { this.legendLead = lead; this.renderLegend(); }
  contextActions(): (ViewContextAction | null)[] {
    const gaps = this.gaps();
    return [{ label: t('Go to the next gap', '次の欠落へ移動'), icon: 'debug-step-over', enabled: gaps.length > 0, run: () => this.showNextGap() }];
  }

  handle(message: ToWebviewMessage): void {
    if (this.selection.handle(message)) return;
    if (message.type === 'frameTiming') {
      if (message.requestId !== this.pending) return;
      this.pending = 0; this.loaded = true; this.rows = message.rows; this.fullRange = message.fullRange; this.dataRange = this.pendingRange ?? message.fullRange;
      this.viewRange = clampRange(this.timeline.viewRange ?? this.viewRange, this.fullRange) ?? this.fullRange;
      this.renderLegend(); this.renderOptions(); this.draw();
      if (this.stale) this.request();
    } else if (message.type === 'parseComplete' || message.type === 'analysisComplete') { if (this.visible) this.request(); }
    // Requests are forgotten when definitions change, so the answer awaited will not come.
    else if (message.type === 'definitionsChanged') { this.pending = 0; if (this.visible) this.request(); }
  }

  // ---- data ------------------------------------------------------------------------------------

  private shownRows(): readonly FrameTimingRowDto[] { return this.rows.filter((row) => !this.hidden.has(row.key)); }
  private gaps(): Gap[] { return this.shownRows().flatMap((row) => row.gaps.map((gap) => ({ ...gap, row }))).sort((left, right) => left.start - right.start); }
  private geometry(width: number): { left: number; right: number; plotWidth: number } { return timingGeometry(width); }
  private request(): void {
    if (!this.visible) return;
    if (this.pending) { this.stale = true; return; }
    this.stale = false; const { plotWidth } = this.geometry(Math.max(1, this.canvas.parentElement!.clientWidth));
    this.pending = ++this.counter; this.pendingRange = this.timeline.viewRange && { ...this.timeline.viewRange };
    this.post({ type: 'frameTimingRequest', requestId: this.pending, range: this.pendingRange, bins: Math.ceil(plotWidth / SLICE_WIDTH), maxTimes: Math.floor(plotWidth / LINE_SPACING) });
  }
  /** Shows a span at once from what is held, and asks for its own frames behind. */
  private showSpan(range: Range | undefined): void { this.viewRange = range && { ...range }; this.scheduleDraw(); this.request(); }
  private navigate(range: Range): void {
    if (!this.fullRange) return;
    this.timeline.setViewRange(range.start <= this.fullRange.start && range.end >= this.fullRange.end ? undefined : range, this.source); this.showSpan(range);
  }
  /**
   * Selects the next gap as the time range, so its span shows on every graph and can be zoomed to from there. The view
   * keeps its zoom and moves only when the gap is not in it (zooming out just enough for a gap longer than the view).
   */
  private showNextGap(): void {
    const gaps = this.gaps(); if (!gaps.length || !this.fullRange) return;
    this.gapCursor = (this.gapCursor + 1) % gaps.length; const gap = gaps[this.gapCursor];
    this.timeline.setRange({ start: gap.start, end: gap.end }, this.source);
    const view = this.viewRange ?? this.fullRange; const target = viewShowing(view, this.fullRange, gap);
    if (target) this.navigate(target);
  }

  // ---- pointer ---------------------------------------------------------------------------------

  private handleWheel(event: WheelEvent): void {
    if (!this.fullRange || !this.viewRange) return; const gesture = chartWheelGesture(event, this.canvas.clientWidth);
    if (gesture.kind === 'scroll' || !gesture.delta) return;
    const view = this.viewRange; const full = this.fullRange; const span = view.end - view.start; const fullSpan = full.end - full.start; const { left, plotWidth } = this.geometry(this.canvas.clientWidth);
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
    const time = this.timeAtX(event.clientX); this.timeline.set(time, this.source);
    const row = this.shownRows()[Math.floor((event.clientY - this.canvas.getBoundingClientRect().top - TOP) / timingRowHeight(this.shownRows()))];
    if (time === undefined || !row || !this.viewRange) { this.tip.hidden = true; this.scheduleDraw(); return; }
    const { plotWidth } = this.geometry(this.canvas.clientWidth); const perPixel = (this.viewRange.end - this.viewRange.start) / plotWidth;
    showTimingTip(this.tip, timingTipLines(row, time, perPixel, (value) => timeLabel(value)), event);
    this.scheduleDraw();
  }

  // ---- drawing ---------------------------------------------------------------------------------

  private renderLegend(): void {
    const lead = this.legendLead as HTMLInputElement | undefined; const editing = !!lead && document.activeElement === lead; const caret = editing ? [lead!.selectionStart, lead!.selectionEnd] as const : undefined;
    this.legend.replaceChildren(); if (lead) this.legend.append(lead);
    const rows = this.shownRows(); const gapCount = rows.reduce((sum, row) => sum + row.gapCount, 0);
    if (this.loaded) {
      const summary = document.createElement('span'); summary.className = 'frame-timing-summary muted'; summary.textContent = t(`${rows.length} CAN ID(s)`, `CAN ID ${rows.length}件`); this.legend.append(summary);
    }
    if (gapCount) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'frame-timing-gaps';
      button.textContent = t(`${gapCount.toLocaleString()} gap(s)`, `欠落の疑い ${gapCount.toLocaleString()}件`); button.title = t('Select the next gap as the time range', '次の欠落の範囲を選択');
      button.addEventListener('click', (event) => { event.stopPropagation(); this.showNextGap(); }); this.legend.append(button);
    }
    if (editing) { lead!.focus(); if (caret?.[0] !== null && caret?.[0] !== undefined) lead!.setSelectionRange(caret[0], caret[1]); }
    this.onCardState?.({ inlineTitle: !!lead, noData: false });
  }
  private renderOptions(): void { this.canIds?.setIds(this.rows.map((row) => ({ key: row.key, canId: row.canId, name: row.name }))); }
  private scheduleDraw(): void { if (this.drawScheduled) return; this.drawScheduled = true; requestAnimationFrame(() => { this.drawScheduled = false; if (this.visible) this.draw(); }); }
  private draw(): void {
    if (!this.visible) return; const width = Math.max(1, this.canvas.parentElement!.clientWidth); const rows = this.shownRows();
    const height = timingHeight(rows.length, timingRowHeight(rows)); const ratio = window.devicePixelRatio || 1;
    if (this.canvas.width !== Math.round(width * ratio) || this.canvas.height !== Math.round(height * ratio)) { this.canvas.width = Math.round(width * ratio); this.canvas.height = Math.round(height * ratio); this.canvas.style.width = `${width}px`; this.canvas.style.height = `${height}px`; }
    const context = this.canvas.getContext('2d'); if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, width, height);
    if (!rows.length || !this.viewRange) { context.font = '12px sans-serif'; context.fillStyle = css('--vscode-descriptionForeground', '#888'); context.textBaseline = 'middle'; context.fillText(this.loaded ? t('This log has no CAN frames.', 'このログにCANフレームはありません。') : t('Loading…', '読み込み中…'), 24, TOP + ROW_HEIGHT / 2); return; }
    this.paint(context, width, rows, true);
  }

  private paint(context: ChartContext, width: number, rows: readonly FrameTimingRowDto[], interactive: boolean): void {
    // The Trace position, then the time under the pointer of any view.
    const lines = interactive ? [...(this.timeline.positionVisible ? [{ time: this.timeline.position, color: css('--sm-trace-color', '#d18616'), alpha: 1 }] : []), { time: this.timeline.timestamp, color: css('--vscode-foreground', '#ccc'), alpha: .55 }] : [];
    paintFrameTiming(context, width, rows, this.viewRange!, this.dataRange, timeTicks, lines);
    if (interactive) paintSelection(context, width, this.viewRange!, this.timeline.range, TOP, rows.length * timingRowHeight(rows));
  }

  /** This view as an export image; `heading` is the title written on it. */
  renderImage(heading = 'SigMixa · Frame timing', width = 1600): SheetImage | undefined {
    const rows = this.shownRows(); if (!rows.length || !this.viewRange) return undefined;
    const header = 44; const height = header + timingHeight(rows.length, timingRowHeight(rows)) + 8;
    const paintAll = (context: ChartContext) => {
      context.fillStyle = css('--vscode-editor-background', '#1e1e1e'); context.fillRect(0, 0, width, height);
      context.fillStyle = css('--vscode-foreground', '#ddd'); context.font = `600 14px ${css('--vscode-font-family', 'sans-serif')}`; context.textBaseline = 'middle'; context.textAlign = 'left'; context.fillText(heading, 12, header / 2);
      context.save(); context.translate(0, header); this.paint(context, width, rows, false); context.restore();
    };
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; const context = canvas.getContext('2d'); if (!context) return undefined;
    paintAll(context); const vector = createSvgCanvas(width, height); paintAll(vector.context);
    return { canvas, pngDataUrl: canvas.toDataURL('image/png'), svg: vector.toSvg(), width, height };
  }
}

function clampRange(view: Range | undefined, full: Range | undefined): Range | undefined {
  if (!view || !full) return undefined; const span = Math.min(full.end - full.start, view.end - view.start); if (!(span > 0) || view.end < full.start || view.start > full.end) return undefined;
  const start = Math.max(full.start, Math.min(view.start, full.end - span)); return { start, end: start + span };
}

