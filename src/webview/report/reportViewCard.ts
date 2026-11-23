import { intervalSeries, timingSlice, type TimeList } from '../../core/frame/frameTiming';
import type { ComparisonGraphDefinition, ReportViewKind } from '../../core/project/comparison';
import { mergeDistribution, slicesIn } from '../../core/signal/distribution';
import { sliceStateRuns } from '../../core/signal/stateRuns';
import type { DistributionRowDto, FrameTimingRowDto, StateRowDto } from '../../extension/editors/rawLogProtocol';
import type { ReportAnalysis, ReportFrameIntervals } from '../../extension/report/reportData';
import { clearLegend, placeCardTitle } from '../comparison/cardTitle';
import type { ComparisonCard, GraphHost } from '../comparison/graphCard';
import { withBrandMark } from '../shared/brandMark';
import { chartTicks } from '../shared/chartAxes';
import { chartWheelGesture, wheelZoomFactor } from '../shared/chartWheel';
import { t } from '../shared/i18n';
import { iconButton, viewActionGroup } from '../shared/iconButton';
import type { SheetImage } from '../shared/imageSheet';
import { createSvgCanvas, type ChartContext } from '../shared/svgCanvas';
import { distributionHeight, distributionTipLines, paintDistribution } from '../timing/distributionPaint';
import { CanIdList } from '../timing/canIdList';
import { SignalSelector } from '../shared/signalSelector';
import { INTERVAL_SLICE_WIDTH, intervalHeading, intervalLaneAt, intervalLanes, intervalLegendItems, intervalTipLines, paintFrameIntervals, type IntervalData } from '../timing/frameIntervalPaint';
import { AXIS_HEIGHT, LINE_SPACING, ROW_HEIGHT, SLICE_WIDTH, TOP, css, paintFrameTiming, paintSelection, showTimingTip, timingGeometry, timingHeight, timingRowHeight, timingTipLines, viewShowing } from '../timing/frameTimingPaint';
import { RUN_SPACING, STATE_SLICE_WIDTH, paintStateTimeline, stateRowHeight, stateTimelineHeight, stateTipLines } from '../timing/stateTimelinePaint';

interface Span { readonly start: number; readonly end: number }
/** The gutters of the report's graphs (a graph with an axis on each side), so the time axes line up. */
const GUTTERS = { left: 72, right: 72 };

/** The kinds of view a log report has besides graphs and trajectories, as **Add view** lists them. */
export const REPORT_VIEW_KINDS: Record<ReportViewKind, { readonly icon: string; label(): string }> = {
  frameTiming: { icon: 'pulse', label: () => t('Frame timing', 'フレームタイミング') },
  frameInterval: { icon: 'graph-scatter', label: () => t('Receive interval', '受信間隔') },
  stateTimeline: { icon: 'layers', label: () => t('State timeline', '状態タイムライン') },
  distribution: { icon: 'graph', label: () => t('Distribution and statistics', '分布と統計') },
};
export function isReportViewKind(kind: string | undefined): kind is ReportViewKind { return !!kind && kind in REPORT_VIEW_KINDS; }

/** What a new view of a kind shows, as in Visualize; undefined when the report has nothing to draw it from. */
export function newReportView(kind: ReportViewKind, analysis: ReportAnalysis): Pick<ComparisonGraphDefinition, 'signalIds' | 'canKeys' | 'hiddenCanKeys'> | undefined {
  if (kind === 'frameTiming') return analysis.frames.length ? { signalIds: [] } : undefined;
  if (kind === 'frameInterval') { const rows = intervalChoices(analysis); const row = rows.find((item) => item.gapCount > 0) ?? rows.find((item) => item.periodMs !== undefined) ?? rows[0]; return row && { signalIds: [], canKeys: [row.key] }; }
  if (kind === 'stateTimeline') { const rows = analysis.states.filter((row) => row.states.some((state) => state.label !== undefined)); return analysis.states.length ? { signalIds: (rows.length ? rows : analysis.states).slice(0, 8).map((row) => row.signalId) } : undefined; }
  return analysis.distributions.length ? { signalIds: analysis.distributions.slice(0, 8).map((row) => row.signalId) } : undefined;
}
/** The CAN IDs a receive interval view can show: those whose receive times, or intervals per slice, the report embeds. */
function intervalChoices(analysis: ReportAnalysis): FrameTimingRowDto[] { return analysis.frames.filter((row) => row.times || analysis.intervals.some((item) => item.key === row.key)); }

/** What a card draws: `shown` is the span in the log's own time, `pointer` the time under the pointer on any view. */
interface Content {
  readonly height: number;
  /** Texts after the card's name. */
  legend(): { text: string; muted: boolean }[];
  /** A button after those texts. */
  readonly action?: HTMLElement;
  paint(context: ChartContext, width: number, shown: Span, pointer: number | undefined): void;
  /** The lines of the hover box at a time and a place in the canvas; none hides it. */
  tip(time: number | undefined, x: number, y: number, perPixel: number, width: number): readonly string[] | undefined;
  /** True for a view that is not on the time axis: the wheel scrolls the page. */
  readonly plain?: boolean;
  /** Where the selected time range is drawn, when not over everything between the usual top and the time axis. */
  readonly bands?: readonly { readonly top: number; readonly height: number }[];
}

/**
 * A frame timing, receive interval, state timeline or distribution view of a log report: a card among the report's
 * graphs, on their time axis, with the same actions and its settings in the graph settings. Everything is drawn from what
 * the report embeds, so zooming in shows single frames and state changes without the log.
 */
export class ReportViewCard implements ComparisonCard {
  readonly element = document.createElement('section');
  readonly options = document.createElement('section');
  private readonly header = document.createElement('header');
  private readonly title = document.createElement('input');
  private readonly legend = document.createElement('div');
  private readonly canvas = document.createElement('canvas');
  private readonly tip = document.createElement('div');
  private readonly up: HTMLButtonElement;
  private readonly kind: ReportViewKind;
  private readonly stopAxis: () => void;
  private readonly resize: ResizeObserver;
  private readonly lifetime = new AbortController();
  private content: Content;
  private written = '';
  private drawScheduled = false;
  private readonly selected = new Set<string>();
  private selector?: SignalSelector;
  private canIds?: CanIdList;
  private press?: { x: number; time: number };
  private suppressClick = false;

  constructor(private definitionValue: ComparisonGraphDefinition, private readonly host: GraphHost, list: HTMLElement, optionsHost: HTMLElement, private readonly analysis: ReportAnalysis) {
    this.kind = definitionValue.kind as ReportViewKind;
    this.element.className = 'visualize-card'; this.element.dataset.kind = this.kind;
    this.header.className = 'visualize-card-header'; this.header.tabIndex = 0;
    this.title.className = 'visualize-card-title'; this.title.value = definitionValue.name; this.title.setAttribute('aria-label', t('Graph name', 'グラフ名'));
    const actions = document.createElement('div'); actions.className = 'visualize-card-actions';
    const make = (icon: string, label: string, run: () => void) => { const button = iconButton(document.createElement('button'), icon, label); button.type = 'button'; button.addEventListener('click', (event) => { event.stopPropagation(); run(); }); return button; };
    this.up = make('arrow-up', t('Move graph up', 'グラフを上へ移動'), () => this.host.move(this, -1));
    actions.append(
      viewActionGroup(t('Export', 'エクスポート'), make('export', t('Save image', '画像を保存'), () => this.saveImage())),
      viewActionGroup(t('Graph actions', 'グラフ操作'), make('settings-gear', t('Show graph settings', 'グラフ設定を表示'), () => this.host.select(this, true)), this.up, make('copy', t('Duplicate graph', 'グラフを複製'), () => this.host.duplicate(this)), make('trash', t('Delete graph', 'グラフを削除'), () => this.host.remove(this))),
    );
    this.header.append(actions);
    const body = document.createElement('div'); body.className = 'visualize-card-body'; const frame = document.createElement('div'); frame.className = 'frame-timing';
    this.legend.className = 'frame-timing-legend'; const wrap = document.createElement('div'); wrap.className = 'frame-timing-canvas-wrap'; this.canvas.className = 'frame-timing-canvas'; wrap.append(this.canvas);
    frame.append(this.legend, wrap); body.append(frame); this.element.append(this.header, body); list.appendChild(this.element);
    placeCardTitle(this.element, this.header, this.legend, this.title, true);
    this.tip.className = 'frame-timing-tip'; this.tip.hidden = true; document.body.appendChild(this.tip);
    this.options.className = 'view-specific-options'; this.options.hidden = true; optionsHost.appendChild(this.options);
    this.content = this.build(); this.renderOptions();

    this.title.addEventListener('change', () => { const name = this.title.value.trim() || this.definitionValue.name; this.title.value = name; this.update({ name }); });
    this.title.addEventListener('keydown', (event) => { if (event.isComposing) return; if (event.key === 'Enter') { event.preventDefault(); this.title.blur(); } if (event.key === 'Escape') { event.preventDefault(); this.title.value = this.definitionValue.name; this.title.blur(); } });
    this.title.addEventListener('input', () => placeCardTitle(this.element, this.header, this.legend, this.title, true));
    // A click on the card, away from its controls and its plot, opens its settings, as on a graph.
    this.element.addEventListener('click', (event) => { const target = event.target as Element; if (target === this.canvas || target.closest('button, select, input, textarea, label, a') || window.getSelection()?.toString()) return; this.host.select(this, true); });
    this.element.addEventListener('contextmenu', (event) => {
      event.preventDefault(); event.stopPropagation(); const rect = this.header.getBoundingClientRect();
      this.host.showMenu([
        { label: t('Show graph settings', 'グラフ設定を表示'), icon: 'settings-gear', run: () => this.host.select(this, true) }, null,
        { label: t('Save image', '画像を保存'), icon: 'export', run: () => this.saveImage() }, null,
        { label: t('Rename graph', 'グラフ名を変更'), icon: 'edit', run: () => { this.title.focus(); this.title.select(); } },
        { label: t('Duplicate graph', 'グラフを複製'), icon: 'copy', run: () => this.host.duplicate(this) },
        { label: t('Move graph up', 'グラフを上へ移動'), icon: 'arrow-up', enabled: !this.host.isFirst(this), run: () => this.host.move(this, -1) },
        { label: t('Move graph down', 'グラフを下へ移動'), icon: 'arrow-down', enabled: !this.host.isLast(this), run: () => this.host.move(this, 1) },
        null, { label: t('Delete graph', 'グラフを削除'), icon: 'trash', run: () => this.host.remove(this) },
      ], this.definitionValue.name, event.clientX || rect.left + 12, event.clientY || rect.bottom, this.header);
    });
    this.bindCanvas();
    this.syncSpan();
    this.stopAxis = this.host.time.subscribe(() => this.scheduleDraw()); (this.resize = new ResizeObserver(() => this.scheduleDraw())).observe(wrap);
  }

  get id(): string { return this.definitionValue.id; }
  get definition(): ComparisonGraphDefinition { return this.definitionValue; }
  get name(): string { return this.definitionValue.name; }
  setDefinition(definition: ComparisonGraphDefinition): void { this.definitionValue = definition; this.title.value = definition.name; this.selected.clear(); for (const id of definition.signalIds) this.selected.add(id); this.rebuild(); this.selector?.render(); this.canIds?.render(); }
  setCatalog(): void { /* Drawn from what the report embeds. */ }
  request(): void { this.scheduleDraw(); }
  receive(): void { /* No samples are asked for. */ }
  highlight(): void { /* No Signal lines to emphasize. */ }
  markerQueries(): { slot: string; sourceId: string; timestamp: number; signalIds: string[] }[] { return []; }
  revealSignal(signalId: string): void { this.selector?.reveal(signalId); }
  setEditing(editing: boolean): void { this.element.classList.toggle('options-editing', editing); this.options.hidden = !(this.host.selectedGraph() === this); }
  focusHeader(): void { this.header.focus({ preventScroll: true }); }
  dispose(): void { this.lifetime.abort(); this.stopAxis(); this.resize.disconnect(); this.host.time.report(this.id, undefined); this.tip.remove(); this.element.remove(); this.options.remove(); }
  scheduleDraw(): void { if (this.drawScheduled) return; this.drawScheduled = true; requestAnimationFrame(() => { this.drawScheduled = false; this.draw(); }); }

  // ---- time ------------------------------------------------------------------------------------

  /** The log's (or Clip's) own time where the report's axis starts, and its span. */
  private get anchor(): number { return this.host.targets()[0]?.start ?? 0; }
  private get whole(): Span | undefined { const target = this.host.targets()[0]; return target?.start !== undefined && target.end !== undefined ? { start: target.start, end: target.end } : undefined; }
  private get shown(): Span | undefined { const whole = this.whole; if (!whole) return undefined; const view = this.host.time.view; return view ? { start: view.start + this.anchor, end: view.end + this.anchor } : whole; }
  private get pointer(): number | undefined { const time = this.host.hoverTime(); return time === undefined ? undefined : time + this.anchor; }
  /** Times are labelled as on the graphs: seconds from the start of the log or Clip. */
  private ticks = (start: number, end: number, intervals: number) => chartTicks(start - this.anchor, end - this.anchor, intervals).map((value) => ({ timestamp: value + this.anchor, label: `${value} s` }));
  private seconds = (time: number) => `${(time - this.anchor).toFixed(6)} s`;

  // ---- drawing ---------------------------------------------------------------------------------

  private update(partial: Partial<ComparisonGraphDefinition>): void { this.definitionValue = { ...this.definitionValue, ...partial }; this.host.changed(this); this.rebuild(); }
  /** The log's span the content was built for; the report's targets can arrive after the card is made. */
  private spanKey: string | undefined;
  /** Gives the time axis the log's span and builds the content for it, once the span is known or when it changes. */
  private syncSpan(): void {
    const whole = this.whole; const key = whole && `${whole.start}:${whole.end}`; if (key === this.spanKey) return; this.spanKey = key;
    this.host.time.report(this.id, whole && { start: whole.start - this.anchor, end: whole.end - this.anchor });
    this.content = this.build(); this.written = '\u0000';
  }
  private rebuild(): void { this.content = this.build(); this.written = '\u0000'; this.renderOptions(); this.draw(); }
  private renderLegend(): void {
    const items = this.content.legend(); const text = items.map((item) => item.text).join('\n'); if (text === this.written) return; this.written = text;
    clearLegend(this.legend, this.title);
    for (const item of items) { const element = document.createElement('span'); element.className = item.muted ? 'frame-timing-summary muted' : 'frame-timing-summary'; element.textContent = item.text; this.legend.append(element); }
    if (this.content.action) this.legend.append(this.content.action);
  }
  draw(): void {
    this.syncSpan(); this.up.disabled = this.host.isFirst(this); const shown = this.shown; const wrap = this.canvas.parentElement!; const width = Math.max(1, wrap.clientWidth); if (!shown || !this.element.isConnected || width < 2) return;
    const height = this.content.height; const ratio = window.devicePixelRatio || 1;
    if (this.canvas.width !== Math.round(width * ratio) || this.canvas.height !== Math.round(height * ratio)) { this.canvas.width = Math.round(width * ratio); this.canvas.height = Math.round(height * ratio); this.canvas.style.width = `${width}px`; this.canvas.style.height = `${height}px`; }
    const context = this.canvas.getContext('2d'); if (!context) return; context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, width, height);
    this.content.paint(context, width, shown, this.pointer); this.renderLegend();
    // The time range selected on any graph or view of the report.
    const selection = this.host.selection(); if (selection && !this.content.plain) for (const band of this.content.bands ?? [{ top: TOP, height: this.content.height - TOP - AXIS_HEIGHT }]) paintSelection(context, width, shown, { start: selection.start + this.anchor, end: selection.end + this.anchor }, band.top, band.height, GUTTERS);
  }
  private bindCanvas(): void {
    const canvas = this.canvas; const axis = this.host.time;
    canvas.addEventListener('wheel', (event) => {
      if (this.content.plain) return; const gesture = chartWheelGesture(event, canvas.clientWidth); if (gesture.kind === 'scroll' || !gesture.delta) return;
      const shown = axis.view; if (!shown) return; event.preventDefault(); const { left, plotWidth } = timingGeometry(canvas.clientWidth, GUTTERS);
      if (gesture.kind === 'zoom') { const ratio = Math.max(0, Math.min(1, (event.clientX - canvas.getBoundingClientRect().left - left) / plotWidth)); axis.zoom(wheelZoomFactor(gesture.delta), shown.start + (shown.end - shown.start) * ratio); }
      else axis.panBy(gesture.delta / plotWidth * (shown.end - shown.start));
    }, { passive: false });
    canvas.addEventListener('pointermove', (event) => {
      const bounds = canvas.getBoundingClientRect(); const { left, plotWidth } = timingGeometry(canvas.clientWidth, GUTTERS); const x = event.clientX - bounds.left; const y = event.clientY - bounds.top; const shown = this.shown;
      const onAxis = !this.content.plain && !!shown && x >= left && x <= left + plotWidth; const perPixel = shown ? (shown.end - shown.start) / plotWidth : 0; const time = onAxis ? shown!.start + (x - left) * perPixel : undefined;
      // The time under the pointer is marked on every view of the report.
      if (!this.content.plain) this.host.setHoverTime(time === undefined ? undefined : time - this.anchor);
      const lines = this.content.plain || time !== undefined ? this.content.tip(time, x, y, perPixel, canvas.clientWidth) : undefined; if (lines) showTimingTip(this.tip, lines, event); else this.tip.hidden = true;
    });
    canvas.addEventListener('pointerleave', () => { this.tip.hidden = true; if (!this.content.plain) this.host.setHoverTime(undefined); });
    // Drag to select a time range, click to clear it, as on a graph.
    const timeAt = (clientX: number, clamp: boolean): number | undefined => {
      const shown = this.shown; if (!shown || this.content.plain) return undefined; const { left, plotWidth } = timingGeometry(canvas.clientWidth, GUTTERS); const offset = clientX - canvas.getBoundingClientRect().left;
      if (!clamp && (offset < left || offset > left + plotWidth)) return undefined; return shown.start + Math.max(0, Math.min(1, (offset - left) / plotWidth)) * (shown.end - shown.start) - this.anchor;
    };
    canvas.addEventListener('mousedown', (event) => { const time = event.button === 0 ? timeAt(event.clientX, false) : undefined; this.press = time === undefined ? undefined : { x: event.clientX, time }; });
    window.addEventListener('mousemove', (event) => { if (!this.press || Math.abs(event.clientX - this.press.x) <= 6) return; const time = timeAt(event.clientX, true); if (time === undefined) return; this.host.setSelection({ start: Math.min(this.press.time, time), end: Math.max(this.press.time, time) }); this.suppressClick = true; }, { signal: this.lifetime.signal });
    window.addEventListener('mouseup', () => { this.press = undefined; }, { signal: this.lifetime.signal });
    canvas.addEventListener('click', (event) => { if (this.suppressClick) { this.suppressClick = false; return; } if (this.host.selection() && timeAt(event.clientX, false) !== undefined) this.host.setSelection(undefined); });
  }
  private saveImage(): void { const image = this.renderImage(); if (!image) return; const marked = withBrandMark(image, css('--vscode-foreground', '#ddd')); this.host.saveImage(marked.pngDataUrl, marked.svg); }
  /** This view as an export image (also used for the combined sheet). */
  renderImage(heading = `SigMixa · ${this.definitionValue.name}`, width = 1600): SheetImage | undefined {
    const shown = this.shown; if (!shown) return undefined; const header = 44; const height = header + this.content.height + 8;
    const title = [heading, ...this.content.legend().map((item) => item.text)].join(' · ');
    const paintAll = (context: ChartContext) => {
      context.fillStyle = css('--vscode-editor-background', '#1e1e1e'); context.fillRect(0, 0, width, height);
      context.fillStyle = css('--vscode-foreground', '#ddd'); context.font = `600 14px ${css('--vscode-font-family', 'sans-serif')}`; context.textBaseline = 'middle'; context.textAlign = 'left'; context.fillText(title, 12, header / 2);
      context.save(); context.translate(0, header); this.content.paint(context, width, shown, undefined); context.restore();
    };
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; const context = canvas.getContext('2d'); if (!context) return undefined;
    paintAll(context); const vector = createSvgCanvas(width, height); paintAll(vector.context);
    return { canvas, pngDataUrl: canvas.toDataURL('image/png'), svg: vector.toSvg(), width, height };
  }

  // ---- what each kind shows --------------------------------------------------------------------

  private build(): Content { return this.kind === 'frameTiming' ? this.timing() : this.kind === 'frameInterval' ? this.interval() : this.kind === 'stateTimeline' ? this.states() : this.distribution(); }

  private timing(): Content {
    const span = this.whole ?? { start: 0, end: 1 }; const hiddenKeys = new Set(this.definitionValue.hiddenCanKeys ?? []); const rows = this.analysis.frames.filter((row) => !hiddenKeys.has(row.key));
    const lists = new Map(rows.map((row) => [row.key, row.times && list(row.times)]));
    /** The rows as they are drawn in a span: every time while they can be told apart, else frames per slice of the span. */
    const slicesFor = (shown: Span, plotWidth: number): FrameTimingRowDto[] => rows.map((row) => {
      const slices = Math.ceil(plotWidth / SLICE_WIDTH); const times = lists.get(row.key);
      // The frames sent on events are marked only where single frames are drawn, and only those in the span shown.
      if (times) { const slice = timingSlice(times, shown, slices, Math.floor(plotWidth / LINE_SPACING)); const events = slice.times && row.eventTimes?.filter((time) => time >= shown.start && time <= shown.end); return { ...row, count: slice.count, times: slice.times, bins: slice.bins, eventTimes: events?.length ? events : undefined }; }
      // Only counts per slice of the whole span were embedded: each drawn slice takes its share of the one it lies in.
      const coarse = row.bins ?? []; const coarseWidth = (span.end - span.start) / Math.max(1, coarse.length); const width = (shown.end - shown.start) / slices; const bins: number[] = [];
      for (let at = 0; at < slices; at++) { const middle = shown.start + width * (at + .5); const from = Math.floor((middle - span.start) / coarseWidth); bins.push((coarse[from] ?? 0) * Math.min(1, width / coarseWidth)); }
      return { ...row, count: Math.round(bins.reduce((sum, value) => sum + value, 0)), times: undefined, bins, eventTimes: undefined };
    });
    const gaps = rows.flatMap((row) => row.gaps.map((gap) => ({ ...gap, row }))).sort((left, right) => left.start - right.start); const gapCount = rows.reduce((sum, row) => sum + row.gapCount, 0);
    let action: HTMLButtonElement | undefined;
    if (gapCount && gaps.length) {
      let cursor = -1; action = document.createElement('button'); action.type = 'button'; action.className = 'frame-timing-gaps';
      action.textContent = t(`${gapCount.toLocaleString()} gap(s)`, `欠落の疑い ${gapCount.toLocaleString()}件`); action.title = t('Select the next gap as the time range', '次の欠落の範囲を選択');
      // As in Visualize: the gap becomes the selected time range; the view moves only when the gap is not in it.
      action.addEventListener('click', () => {
        cursor = (cursor + 1) % gaps.length; const gap = gaps[cursor]; const axis = this.host.time; const selected = { start: gap.start - this.anchor, end: gap.end - this.anchor };
        this.host.setSelection(selected);
        const full = axis.full ?? { start: span.start - this.anchor, end: span.end - this.anchor }; const target = viewShowing(axis.view ?? full, full, selected);
        if (target) axis.setView(target);
      });
    }
    let drawn: FrameTimingRowDto[] = [];
    return {
      height: timingHeight(rows.length, timingRowHeight(rows)), action, legend: () => [{ text: t(`${rows.length} CAN ID(s)`, `CAN ID ${rows.length}件`), muted: true }],
      paint: (context, width, shown, pointer) => { drawn = slicesFor(shown, timingGeometry(width, GUTTERS).plotWidth); paintFrameTiming(context, width, drawn, shown, shown, this.ticks, pointerLine(pointer), GUTTERS); },
      tip: (time, _x, y, perPixel) => { const row = drawn[Math.floor((y - TOP) / timingRowHeight(rows))]; return row && time !== undefined ? timingTipLines(row, time, perPixel, this.seconds) : undefined; },
    };
  }

  private interval(): Content {
    const span = this.whole ?? { start: 0, end: 1 };
    // One per CAN ID chosen: its receive times, or, for one with too many frames to embed them, its intervals per slice.
    const sources = (this.definitionValue.canKeys ?? []).flatMap((key): ReportFrameIntervals[] => {
      const row = this.analysis.frames.find((item) => item.key === key); if (row?.times) return [{ key: row.key, canId: row.canId, name: row.name, periodMs: row.periodMs, estimated: row.estimated, times: row.times }];
      const coarse = this.analysis.intervals.find((item) => item.key === key); return coarse ? [coarse] : [];
    });
    const times = sources.map((data) => data.times && list(data.times)); let drawn: IntervalData[] = sources; let read: Span[] = sources.map(() => span);
    const layout = () => intervalLanes(sources.length, drawn.map(intervalHeading)); const lanes = layout().lanes;
    return {
      height: layout().height, bands: lanes.map((lane) => ({ top: lane.top, height: lane.height })),
      // One CAN ID: its summary is the legend. Several: each has its own line above its plot.
      legend: () => drawn.length === 1 ? intervalLegendItems(drawn[0]) : [{ text: t(`${drawn.length} CAN ID(s)`, `CAN ID ${drawn.length}件`), muted: true }],
      paint: (context, width, shown, pointer) => {
        // Every interval while they can be told apart, else their range per slice; the summaries are of the span shown.
        const { plotWidth } = timingGeometry(width, GUTTERS);
        drawn = sources.map((data, index) => { const own = times[index]; return own ? { ...data, ...intervalSeries(own, shown, Math.ceil(plotWidth / INTERVAL_SLICE_WIDTH), Math.floor(plotWidth * 1.5)) } : data; }); read = sources.map((_, index) => times[index] ? shown : span);
        const now = layout().lanes; drawn.forEach((data, index) => paintFrameIntervals(context, width, data, shown, read[index], this.ticks, pointerLine(pointer), GUTTERS, now[index]));
      },
      tip: (time, _x, y, perPixel) => { const at = intervalLaneAt(lanes, y); const data = drawn[at]; if (time === undefined || !data) return undefined; const lines = intervalTipLines(data, time, perPixel, read[at], this.seconds); return lines.length > 1 ? lines : undefined; },
    };
  }

  private states(): Content {
    const span = this.whole ?? { start: 0, end: 1 }; const rows = this.definitionValue.signalIds.flatMap((id) => this.analysis.states.filter((row) => row.signalId === id));
    /** The rows as they are drawn in a span: single runs while they can be told apart, else the longest-lasting state per slice. */
    const rowsFor = (shown: Span, plotWidth: number): StateRowDto[] => rows.map((row) => {
      const head = { signalId: row.signalId, name: row.name, unit: row.unit, states: row.states, tooMany: row.tooMany }; const slices = Math.ceil(plotWidth / STATE_SLICE_WIDTH);
      if (row.starts && row.stateOf) return { ...head, ...sliceStateRuns({ starts: row.starts, stateOf: row.stateOf, states: row.states, end: row.end ?? span.end, tooMany: false }, shown, Math.floor(plotWidth / RUN_SPACING), slices) };
      if (!row.bins?.length) return head;
      // Only the state per slice of the whole span was embedded: each drawn slice shows the one it lies in.
      const coarseWidth = (span.end - span.start) / row.bins.length; const width = (shown.end - shown.start) / slices;
      return { ...head, bins: Array.from({ length: slices }, (_, at) => row.bins![Math.floor((shown.start + width * (at + .5) - span.start) / coarseWidth)] ?? null) };
    });
    let drawn: StateRowDto[] = []; let read: Span = span;
    return {
      height: stateTimelineHeight(rows, 0, GUTTERS), legend: () => [{ text: t(`${rows.length} Signal(s)`, `シグナル ${rows.length}件`), muted: true }],
      paint: (context, width, shown, pointer) => { drawn = rowsFor(shown, timingGeometry(width, GUTTERS).plotWidth); read = shown; paintStateTimeline(context, width, drawn, shown, shown, this.ticks, pointer, pointerLine(pointer), GUTTERS); },
      tip: (time, _x, y) => { const row = drawn[Math.floor((y - TOP) / stateRowHeight(GUTTERS))]; return row && stateTipLines(row, time, read, (start, end) => `${(start - this.anchor).toFixed(6)}–${(end - this.anchor).toFixed(6)} s`); },
    };
  }

  private distribution(): Content {
    const rows = this.definitionValue.signalIds.flatMap((id) => this.analysis.distributions.filter((row) => row.signalId === id)); let drawn: DistributionRowDto[] = []; let covered = '';
    return {
      height: distributionHeight(rows.length), plain: true,
      legend: () => [{ text: t(`${rows.length} Signal(s)`, `シグナル ${rows.length}件`), muted: true }, ...(covered ? [{ text: covered, muted: true }] : [])],
      paint: (context, width, shown) => {
        // The statistics are of the embedded slices of time in the selected time range, else in the span shown; the legend says which span that is.
        const selection = this.host.selection(); const counted = selection ? { start: Math.min(selection.start, selection.end) + this.anchor, end: Math.max(selection.start, selection.end) + this.anchor } : shown; let span = counted;
        drawn = rows.map((row) => { const { from, to } = slicesIn(row.grid, counted); const slice = (row.grid.end - row.grid.start) / row.grid.slices; span = { start: row.grid.start + from * slice, end: row.grid.start + to * slice }; return { signalId: row.signalId, name: row.name, unit: row.unit, lo: row.grid.lo, hi: row.grid.hi, ...mergeDistribution(row.grid, from, to) }; });
        covered = rows.length ? `${selection ? `${t('Selected range', '選択範囲')} ` : ''}${Number((span.start - this.anchor).toFixed(3))}–${Number((span.end - this.anchor).toFixed(3))} s` : '';
        paintDistribution(context, width, drawn);
      },
      tip: (_time, x, y, _perPixel, width) => distributionTipLines(drawn, width, x, y),
    };
  }

  // ---- settings --------------------------------------------------------------------------------

  /**
   * The view's settings, in the graph settings, as its counterpart in Visualize has them: the Signal list of a graph for
   * Signals, the same kind of list for CAN IDs. They choose from what the report embeds.
   */
  private renderOptions(): void {
    if (this.selector || this.canIds) return;
    const settings = document.createElement('div'); settings.className = 'view-settings'; const host = document.createElement('div'); settings.append(host); this.options.replaceChildren(settings);
    if (this.kind === 'frameTiming') {
      this.canIds = new CanIdList(host, { chosen: (key) => !(this.definitionValue.hiddenCanKeys ?? []).includes(key), change: (keys, chosen) => { const hidden = new Set(this.definitionValue.hiddenCanKeys ?? []); for (const key of keys) { if (chosen) hidden.delete(key); else hidden.add(key); } this.update({ hiddenCanKeys: [...hidden] }); } });
      this.canIds.setIds(this.analysis.frames.map((row) => ({ key: row.key, canId: row.canId, name: row.name })));
    } else if (this.kind === 'frameInterval') {
      this.canIds = new CanIdList(host, { chosen: (key) => (this.definitionValue.canKeys ?? []).includes(key), change: (keys, chosen) => { const next = (this.definitionValue.canKeys ?? []).filter((key) => !keys.includes(key)); if (chosen) next.push(...keys); this.update({ canKeys: next }); } });
      this.canIds.setIds(intervalChoices(this.analysis).map((row) => ({ key: row.key, canId: row.canId, name: row.name })));
    } else {
      const pool = new Set((this.kind === 'stateTimeline' ? this.analysis.states : this.analysis.distributions).map((row) => row.signalId)); for (const id of this.definitionValue.signalIds) this.selected.add(id);
      this.selector = new SignalSelector({ host, selected: this.selected, onSelectionChange: () => this.update({ signalIds: [...this.selected] }) });
      this.selector.setCatalog((this.analysis.definitions ?? []).filter((definition) => pool.has(definition.id)), (this.analysis.groups ?? []).map((group) => ({ ...group, signalIds: group.signalIds.filter((id) => pool.has(id)) })).filter((group) => group.signalIds.length));
    }
  }
}

const pointerLine = (pointer: number | undefined) => [{ time: pointer, color: css('--vscode-foreground', '#ccc'), alpha: .55 }];
function list(values: readonly number[]): TimeList { return { length: values.length, at: (index) => values[index] }; }
