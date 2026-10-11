import { TraceTableView } from './traceTable';
import type { ViewContextAction } from '../shared/viewContextAction';
import { iconButton, labeledIconButton, type ViewCardState } from '../shared/iconButton';
import { bindPressRepeat } from '../shared/pressRepeat';
import type { LogViewState, ToExtensionMessage, ToWebviewMessage, VisualizeViewDefinition } from '../../extension/editors/rawLogProtocol';
import { TimeSeriesView } from '../timeseries/timeSeriesView';
import { TrajectoryView } from '../trajectory/trajectoryView';
import { advancePlayback } from '../../core/trajectory/trajectory';
import { SEEK_STEPS, seekTimestamp, TimelineController } from '../shared/timelineController';
import { t } from '../shared/i18n';
import { closeActionMenu, showActionMenu } from '../shared/contextMenu';
import { composeImageSheet } from '../shared/imageSheet';

interface Entry { definition: VisualizeViewDefinition; view: TimeSeriesView | TrajectoryView; element: HTMLElement; options: HTMLElement; title: HTMLInputElement; }

/** Owns each view's settings and routes responses using unique request IDs. */
export class VisualizeView {
  private readonly timeline = new TimelineController();
  private readonly entries: Entry[] = [];
  private updateTimeControls: () => void = () => undefined;
  private readonly requests = new Map<number, { id: string; requestId: number }>();
  private nextRequest = 1_000_000;
  private lastRequest = 0;
  private lastRequestTimer?: number;
  private traceTable!: TraceTableView;
  private lastValues: Extract<ToWebviewMessage, {type: 'lastFrames'}>['values'] = [];
  private visible = false;
  private boundsRequest = 0;
  private playing = false;
  private playbackFrame?: number;
  private lastTick?: number;
  private playbackSpeed = 1;
  private seeking = false;
  private finishSeek?: () => void;
  private readonly list: HTMLElement;
  private readonly options: HTMLElement;
  private selectedId?: string;
  private optionsCollapsed = false;
  private traceHeight: number;
  private readonly trace: HTMLElement;
  private traceCollapsed = false;
  private readonly traceSplitter: HTMLElement;
  private readonly content: HTMLElement;
  constructor(private readonly host: HTMLElement, initial: LogViewState, private readonly post: (message: ToExtensionMessage) => void, private readonly save: (partial: Partial<LogViewState>) => void) {
    this.traceHeight = typeof initial.visualizeTraceHeight === 'number' && Number.isFinite(initial.visualizeTraceHeight) ? Math.max(0, initial.visualizeTraceHeight) : 220;
    this.selectedId = initial.visualizeSelectedViewId;
    this.optionsCollapsed = initial.visualizeOptionsCollapsed ?? initial.visualizeOptionsPinned !== true;
    host.innerHTML = `<div class="view-toolbar"><button class="add-view" type="button" aria-haspopup="menu" aria-expanded="false"><span class="codicon codicon-add" aria-hidden="true"></span> ${t('Add graph', 'グラフを追加')}</button><span class="spacer"></span><span class="reference-time muted"></span><div class="range-controls visualize-range" role="group" aria-label="${t('Selected range', '選択範囲')}" hidden><span class="clip-range muted"></span><span class="range-edge"><span class="clip-edge-label">${t('Start', '開始')}</span><span class="segmented"><button class="vr-start-prev" type="button"></button><button class="vr-start-next" type="button"></button></span></span><span class="range-edge"><span class="clip-edge-label">${t('End', '終了')}</span><span class="segmented"><button class="vr-end-prev" type="button"></button><button class="vr-end-next" type="button"></button></span></span><span class="range-actions segmented"><button class="vr-zoom" type="button"></button><button class="vr-clip" type="button"></button></span><button class="vr-clear" type="button"></button></div><div class="view-action-group visualize-zoom-all" role="group" aria-label="${t('Zoom', 'ズーム')}" hidden><span class="segmented"><button class="zoom-all-in" type="button"></button><button class="zoom-all-out" type="button"></button><button class="zoom-all-reset" type="button"></button></span></div><button class="save-sheet" type="button"></button></div><div class="visualize-workspace"><div class="visualize-content"><div class="visualize-list"></div><div class="trace-splitter" role="separator" tabindex="0" aria-orientation="horizontal" aria-controls="visualize-trace" aria-label="${t('Trace height', 'トレースの高さ')}"></div><section id="visualize-trace" class="last-values"><button class="trace-toggle" type="button" aria-controls="visualize-trace-data"><span class="codicon codicon-chevron-down" aria-hidden="true"></span>${t('Trace', 'トレース')}</button><div class="trace-playback"><div class="trace-playback-actions"><button class="trace-marker-toggle" type="button"></button><button class="trace-start"></button><button class="trace-play"></button><button class="trace-end"></button></div><output class="trace-time" aria-live="off">—</output><input class="trace-seek" type="range" min="0" max="1000000" step="1" value="0" aria-label="${t('Trace position', 'トレース位置')}"><span class="trace-range-end" aria-label="${t('End time', '終端時刻')}"></span><select class="trace-speed" aria-label="${t('Playback speed', '再生速度')}"><option value="0.25">0.25×</option><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option><option value="5">5×</option></select><span class="trace-selection-status status selection-status" hidden></span></div><div id="visualize-trace-data" class="trace-data"><div class="last-value-table"></div></div></section></div><aside id="visualize-options" class="visualize-options" aria-label="${t('Graph settings', 'グラフ設定')}"><header><strong>${t('Graph settings', 'グラフ設定')}</strong><button class="close-view-options" type="button"></button></header><div class="options-view-name"></div><p class="options-empty muted">${t('Add a graph to configure it.', 'グラフを追加すると設定できます。')}</p><div class="view-options-panels"></div></aside></div>`;
    this.list = host.querySelector('.visualize-list')!;
    this.content = host.querySelector('.visualize-content')!;
    this.trace = host.querySelector('.last-values')!;
    this.traceSplitter = host.querySelector('.trace-splitter')!;
    this.traceCollapsed = initial.visualizeTraceCollapsed === true;
    this.timeline.setPositionVisible(initial.visualizeTraceMarkerVisible !== false);
    this.bindTraceResize();
    this.options = host.querySelector('.view-options-panels')!;
    this.traceTable = new TraceTableView(host.querySelector('.last-value-table')!, initial.traceSettings, (settings) => this.save({ traceSettings: settings }),
      (actions, label, x, y, returnFocus) => this.showActionMenu(actions, label, x, y, returnFocus), (message) => this.post(message));
    const closeOptions = iconButton(host.querySelector<HTMLButtonElement>('.close-view-options')!, 'close', t('Close graph settings', 'グラフ設定を閉じる'));
    closeOptions.addEventListener('click', () => { this.optionsCollapsed = true; this.updateOptionsVisibility(); this.persist(); this.entries.find((entry) => entry.definition.id === this.selectedId)?.element.querySelector<HTMLElement>('.visualize-card-header')?.focus({ preventScroll: true }); });
    this.updateOptionsVisibility();
    this.timeline.subscribe((timestamp) => { host.querySelector('.reference-time')!.textContent = timestamp === undefined ? '' : `${timestamp.toFixed(6)} s`; });
    this.timeline.subscribePosition((timestamp) => {
      this.updateTracePlayback();
      if (timestamp === undefined) { window.clearTimeout(this.lastRequestTimer); this.lastRequestTimer = undefined; this.lastRequest = ++this.nextRequest; this.lastValues = []; this.renderLastValues(); return; }
      if (this.lastRequestTimer === undefined) this.lastRequestTimer = window.setTimeout(() => {
        this.lastRequestTimer = undefined; const position = this.timeline.position; if (position === undefined) return;
        this.lastRequest = ++this.nextRequest; this.post({ type: 'lastFramesRequest', requestId: this.lastRequest, timestamp: position });
      }, 40);
    });
    host.querySelector('.trace-marker-toggle')!.addEventListener('click', () => {
      this.timeline.setPositionVisible(!this.timeline.positionVisible); this.updateTracePlayback(); this.persist();
    });
    const traceSeek = host.querySelector<HTMLInputElement>('.trace-seek')!;
    traceSeek.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || traceSeek.disabled) return;
      this.finishSeek?.(); this.seeking = true; this.pausePlayback();
      const lifetime = new AbortController();
      const finish = () => { lifetime.abort(); this.finishSeek = undefined; this.seeking = false; this.updateTracePlayback(); };
      this.finishSeek = finish;
      const release = (next: PointerEvent) => { if (next.pointerId === event.pointerId) finish(); };
      window.addEventListener('pointerup', release, { signal: lifetime.signal });
      window.addEventListener('pointercancel', release, { signal: lifetime.signal });
      window.addEventListener('blur', finish, { signal: lifetime.signal });
    });
    traceSeek.addEventListener('input', (event) => {
      const value = Number((event.target as HTMLInputElement).value);
      this.pausePlayback(); const range = this.timeline.bounds;
      if (range) this.timeline.setPosition(seekTimestamp(value, range), 'trace');
    });
    host.querySelector('.trace-start')!.addEventListener('click', () => { this.pausePlayback(); this.timeline.setPosition(this.timeline.bounds?.start, 'trace'); });
    host.querySelector('.trace-end')!.addEventListener('click', () => { this.pausePlayback(); this.timeline.setPosition(this.timeline.bounds?.end, 'trace'); });
    host.querySelector('.trace-play')!.addEventListener('click', () => {
      if (this.playing) { this.pausePlayback(); return; }
      const range = this.timeline.bounds; if (!range || range.start === range.end) return;
      if (this.timeline.position === range.end) this.timeline.setPosition(range.start, 'trace');
      this.playing = true; this.lastTick = undefined; this.updateTracePlayback(); this.playbackFrame = requestAnimationFrame((time) => this.tickPlayback(time));
    });
    host.querySelector('.trace-speed')!.addEventListener('change', (event) => { this.playbackSpeed = Number((event.target as HTMLSelectElement).value); });
    this.updateTracePlayback();
    window.addEventListener('pagehide', () => this.pausePlayback(), { once: true });
    labeledIconButton(host.querySelector<HTMLButtonElement>('.save-sheet')!, 'export', t('Export', 'エクスポート')).addEventListener('click', () => this.saveSheet());
    // Time belongs to the whole log: every graph shows the same span. Zooming and everything done with the selected range
    // is up here; a zoom is given to one graph, which shares it with the others through the timeline.
    const graphs = () => this.entries.flatMap((entry) => entry.view instanceof TimeSeriesView ? [entry.view] : []);
    for (const [selector, icon, text, label, factor] of [['.zoom-all-in', 'zoom-in', t('Zoom in', '拡大'), t('Zoom in; hold to repeat', '拡大・長押しで連続'), 1 / 1.5], ['.zoom-all-out', 'zoom-out', t('Zoom out', '縮小'), t('Zoom out; hold to repeat', '縮小・長押しで連続'), 1.5]] as const)
      bindPressRepeat(labeledIconButton(host.querySelector<HTMLButtonElement>(selector)!, icon, text, label), () => graphs().find((graph) => graph.canZoom)?.zoomBy(factor), { intervalMs: 180 });
    labeledIconButton(host.querySelector<HTMLButtonElement>('.zoom-all-reset')!, 'discard', t('Reset', 'リセット'), t('Reset zoom', 'ズームをリセット')).addEventListener('click', () => graphs().find((graph) => graph.canZoom)?.resetZoom());
    for (const [selector, edge, direction, label] of [['.vr-start-prev', 'start', -1, t('Move start to previous CAN Timestamp', '開始を前のCANタイムスタンプへ移動')], ['.vr-start-next', 'start', 1, t('Move start to next CAN Timestamp', '開始を次のCANタイムスタンプへ移動')], ['.vr-end-prev', 'end', -1, t('Move end to previous CAN Timestamp', '終了を前のCANタイムスタンプへ移動')], ['.vr-end-next', 'end', 1, t('Move end to next CAN Timestamp', '終了を次のCANタイムスタンプへ移動')]] as const)
      bindPressRepeat(iconButton(host.querySelector<HTMLButtonElement>(selector)!, direction < 0 ? 'chevron-left' : 'chevron-right', label), () => graphs()[0]?.adjustSelectedRange(edge, direction));
    labeledIconButton(host.querySelector<HTMLButtonElement>('.vr-zoom')!, 'zoom-in', t('Zoom to range', '選択範囲を拡大'), t('Zoom to selected range', '選択範囲を拡大')).addEventListener('click', () => {
      const range = this.timeline.range; if (!range) return; const all = graphs(); all.find((graph) => graph.canZoom)?.zoomToRange(range); all[0]?.clearSelectedRange();
    });
    labeledIconButton(host.querySelector<HTMLButtonElement>('.vr-clip')!, 'new-file', t('Create Clip', 'クリップ作成')).addEventListener('click', () => graphs()[0]?.createClipFromSelectedRange());
    labeledIconButton(host.querySelector<HTMLButtonElement>('.vr-clear')!, 'close', t('Clear', '解除'), t('Clear selected range', '選択範囲を解除')).addEventListener('click', () => graphs()[0]?.clearSelectedRange());
    this.updateTimeControls = () => {
      const range = this.timeline.range; const any = graphs().length > 0;
      host.querySelector<HTMLElement>('.visualize-zoom-all')!.hidden = !any;
      host.querySelector<HTMLElement>('.visualize-range')!.hidden = !range || !any;
      // With a range selected, the only zoom offered is zooming to it, so there is one zoom button, not two kinds.
      for (const selector of ['.zoom-all-in', '.zoom-all-out']) host.querySelector<HTMLElement>(selector)!.hidden = !!range;
      if (range) host.querySelector('.visualize-range .clip-range')!.textContent = `${range.start.toFixed(6).replace(/\.?0+$/, '')}–${range.end.toFixed(6).replace(/\.?0+$/, '')} s · ${(range.end - range.start).toFixed(6).replace(/\.?0+$/, '')} s`;
    };
    this.timeline.subscribeRange(() => this.updateTimeControls());
    const addView = host.querySelector<HTMLButtonElement>('.add-view')!;
    addView.addEventListener('click', () => {
      if (addView.getAttribute('aria-expanded') === 'true') { closeActionMenu(); return; }
      this.showAddViewMenu(addView);
    });
    addView.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') { event.preventDefault(); this.showAddViewMenu(addView); }
    });
    const { visualizeViews, ...legacy } = initial;
    const defaults: VisualizeViewDefinition[] = [
      { id: crypto.randomUUID(), kind: 'graph', name: t('Graph', 'グラフ'), settings: legacy },
      { id: crypto.randomUUID(), kind: 'trajectory', name: t('Trajectory', '軌跡'), settings: legacy },
    ];
    for (const definition of visualizeViews ?? defaults) this.add(definition);
    this.select(this.entries.find((entry) => entry.definition.id === this.selectedId)?.definition.id ?? this.entries[0]?.definition.id, false, false);
  }
  show(): void { this.visible = true; this.requestBounds(); this.applyTraceHeight(); for (const entry of this.entries) entry.view.show(); }
  hide(): void { this.finishSeek?.(); this.pausePlayback(); closeActionMenu(); this.visible = false; for (const entry of this.entries) entry.view.hide(); }
  handle(message: ToWebviewMessage): void {
    if (message.type === 'clipRanges') { this.timeline.setClipRanges(message.clips); return; }
    if (message.type === 'timelineRange') { if (message.requestId === this.boundsRequest) this.timeline.setBounds(message.range); return; }
    if (this.visible && (message.type === 'progress' || message.type === 'parseComplete' || message.type === 'analysisComplete')) this.requestBounds();
    if (message.type === 'definitionsChanged') { this.requestBounds(); this.requests.clear(); this.lastRequest = 0; this.lastValues = []; this.renderLastValues(); }
    if (message.type === 'lastFrames') { if (message.requestId === this.lastRequest) { this.lastValues = message.values; this.renderLastValues(); } return; }
    if ('requestId' in message) {
      const route = this.requests.get(message.requestId); if (!route) return;
      this.requests.delete(message.requestId);
      this.entries.find((entry) => entry.definition.id === route.id)?.view.handle({ ...message, requestId: route.requestId });
    } else for (const entry of this.entries) entry.view.handle(message);
  }
  private requestBounds(): void { this.boundsRequest = ++this.nextRequest; this.post({ type: 'timelineRangeRequest', requestId: this.boundsRequest }); }
  private pausePlayback(): void { this.playing = false; if (this.playbackFrame !== undefined) cancelAnimationFrame(this.playbackFrame); this.playbackFrame = undefined; this.lastTick = undefined; this.updateTracePlayback(); }
  private tickPlayback(time: number): void {
    const range = this.timeline.bounds; if (!this.playing || !range) { this.pausePlayback(); return; }
    const elapsed = this.lastTick === undefined ? 0 : (time - this.lastTick) / 1000; this.lastTick = time;
    const next = advancePlayback(this.timeline.position ?? range.start, elapsed, this.playbackSpeed, range);
    this.timeline.setPosition(next.timestamp, 'trace');
    if (next.ended) this.pausePlayback(); else this.playbackFrame = requestAnimationFrame((nextTime) => this.tickPlayback(nextTime));
  }
  private updateTracePlayback(): void {
    const range = this.timeline.bounds; const timestamp = this.timeline.position;
    const markerVisible = this.timeline.positionVisible;
    const markerToggle = iconButton(this.host.querySelector<HTMLButtonElement>('.trace-marker-toggle')!, markerVisible ? 'eye' : 'eye-closed', t('Show trace markers', 'トレースマーカーを表示'));
    markerToggle.setAttribute('aria-pressed', String(markerVisible));
    markerToggle.title = markerVisible ? t('Hide trace markers', 'トレースマーカーを非表示') : t('Show trace markers', 'トレースマーカーを表示');
    const seek = this.host.querySelector<HTMLInputElement>('.trace-seek')!;
    seek.disabled = !range || range.start === range.end;
    if (!this.seeking) seek.value = String(!range || timestamp === undefined || range.start === range.end ? 0 : timestamp === range.end ? SEEK_STEPS : (timestamp - range.start) / (range.end - range.start) * SEEK_STEPS);
    // The painted track spans the thumb center's travel, with no text-input padding.
    seek.style.setProperty('--trace-progress', `${seek.valueAsNumber / SEEK_STEPS * 100}%`);
    seek.setAttribute('aria-valuetext', timestamp === undefined ? '—' : `${timestamp.toFixed(6)} s`);
    this.host.querySelector('.trace-time')!.textContent = timestamp === undefined ? '—' : `${timestamp.toFixed(6)} s`;
    seek.title = range ? `${t('Time range', '時刻範囲')}: ${range.start.toFixed(6)} – ${range.end.toFixed(6)} s` : '';
    this.host.querySelector<HTMLOutputElement>('.trace-time')!.title = timestamp === undefined ? '' : `${timestamp.toFixed(6)} s`;
    this.host.querySelector('.trace-range-end')!.textContent = range ? `${range.end.toFixed(6)} s` : '—';
    for (const [selector, icon, label] of [['.trace-start', 'debug-step-back', t('Go to start', '始点へ移動')], ['.trace-play', this.playing ? 'debug-pause' : 'play', this.playing ? t('Pause', '一時停止') : t('Play', '再生')], ['.trace-end', 'debug-step-over', t('Go to end', '終点へ移動')]] as const) {
      const button = iconButton(this.host.querySelector<HTMLButtonElement>(selector)!, icon, label); button.disabled = !range || (selector === '.trace-play' && range.start === range.end);
    }
  }
  private renderLastValues(): void { this.traceTable.setValues(this.lastValues); }
  private persist(): void { this.save({ traceSettings: this.traceTable.settings, visualizeViews: this.entries.map((entry) => entry.definition), visualizeSelectedViewId: this.selectedId, visualizeOptionsCollapsed: this.optionsCollapsed, visualizeOptionsPinned: undefined, visualizeTraceHeight: this.traceHeight, visualizeTraceCollapsed: this.traceCollapsed, visualizeTraceMarkerVisible: this.timeline.positionVisible }); }
  private traceHeightLimits(): { min: number; max: number } {
    const max = Math.max(0, this.content.clientHeight - this.traceSplitter.getBoundingClientRect().height);
    return { min: 0, max };
  }
  private applyTraceHeight(): void {
    const { min, max } = this.traceHeightLimits();
    const height = Math.max(min, Math.min(max, this.traceHeight));
    this.trace.style.height = !this.traceCollapsed ? `${height}px` : '';
    this.trace.querySelector<HTMLElement>('.trace-data')!.hidden = this.traceCollapsed;
    const toggle = this.trace.querySelector<HTMLButtonElement>('.trace-toggle')!;
    toggle.setAttribute('aria-expanded', String(!this.traceCollapsed));
    toggle.querySelector('.codicon')!.className = `codicon codicon-chevron-${this.traceCollapsed ? 'right' : 'down'}`;
    this.traceSplitter.hidden = this.traceCollapsed;
    this.traceSplitter.setAttribute('aria-valuemin', String(min));
    this.traceSplitter.setAttribute('aria-valuemax', String(max));
    this.traceSplitter.setAttribute('aria-valuenow', String(Math.round(height)));
  }
  private bindTraceResize(): void {
    let drag: { pointerId: number; y: number; height: number } | undefined;
    const resize = (height: number) => {
      const { min, max } = this.traceHeightLimits();
      this.traceHeight = Math.max(min, Math.min(max, height));
      this.applyTraceHeight();
    };
    this.traceSplitter.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || this.traceCollapsed) return;
      event.preventDefault(); this.traceSplitter.focus();
      drag = { pointerId: event.pointerId, y: event.clientY, height: this.trace.getBoundingClientRect().height };
      this.traceSplitter.setPointerCapture(event.pointerId);
      this.content.classList.add('resizing-trace');
    });
    this.traceSplitter.addEventListener('pointermove', (event) => {
      if (drag?.pointerId === event.pointerId) resize(drag.height + drag.y - event.clientY);
    });
    const finish = (event: PointerEvent) => {
      if (drag?.pointerId !== event.pointerId) return;
      drag = undefined; this.content.classList.remove('resizing-trace');
      if (this.traceSplitter.hasPointerCapture(event.pointerId)) this.traceSplitter.releasePointerCapture(event.pointerId);
      this.persist();
    };
    this.traceSplitter.addEventListener('pointerup', finish);
    this.traceSplitter.addEventListener('pointercancel', finish);
    this.traceSplitter.addEventListener('lostpointercapture', finish);
    this.traceSplitter.addEventListener('keydown', (event) => {
      if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); const { min, max } = this.traceHeightLimits();
      const height = this.trace.getBoundingClientRect().height;
      resize(event.key === 'Home' ? min : event.key === 'End' ? max : height + (event.key === 'ArrowUp' ? 20 : -20));
      this.persist();
    });
    this.trace.querySelector('.trace-toggle')!.addEventListener('click', () => { this.traceCollapsed = !this.traceCollapsed; this.applyTraceHeight(); this.persist(); });
    const observer = new ResizeObserver(() => this.applyTraceHeight()); observer.observe(this.content);
    window.addEventListener('pagehide', () => observer.disconnect(), { once: true });
    this.applyTraceHeight();
  }
  private updateOptionsVisibility(): void {
    this.host.querySelector<HTMLElement>('.visualize-options')!.hidden = this.optionsCollapsed;
    for (const entry of this.entries) {
      entry.element.classList.toggle('options-editing', !this.optionsCollapsed && entry.definition.id === this.selectedId);
      entry.element.classList.toggle('view-selected', entry.definition.id === this.selectedId);
      const header = entry.element.querySelector<HTMLElement>('.visualize-card-header')!;
      entry.element.classList.toggle('view-unconfigured', !entry.view.isConfigured);
      header.removeAttribute('title');
    }
  }
  private updateOptionsHeading(): void {
    const selected = this.entries.find((entry) => entry.definition.id === this.selectedId); const heading = this.host.querySelector<HTMLElement>('.options-view-name')!; heading.replaceChildren();
    if (selected) {
      const icon = document.createElement('span'); icon.className = `codicon codicon-${selected.definition.kind === 'graph' ? 'graph-line' : 'compass'}`; icon.setAttribute('aria-hidden', 'true');
      // The graph's name can be changed here as well as on the graph itself.
      const name = document.createElement('input'); name.className = 'options-view-title'; name.value = selected.definition.name;
      name.setAttribute('aria-label', t('Graph name', 'グラフ名'));
      name.addEventListener('change', () => {
        selected.definition = { ...selected.definition, name: name.value.trim() || selected.definition.name };
        name.value = selected.definition.name; selected.title.value = selected.definition.name; this.fitTitle(selected.title); this.persist();
      });
      name.addEventListener('keydown', (event) => {
        if (event.isComposing) return;
        if (event.key === 'Enter') { event.preventDefault(); name.blur(); }
        if (event.key === 'Escape') { event.preventDefault(); name.value = selected.definition.name; name.blur(); }
      });
      heading.append(icon, name);
    }
    this.host.querySelector<HTMLElement>('.options-empty')!.hidden = !!this.entries.length;
  }
  private select(id?: string, reveal = false, persist = true): void {
    const changed = this.selectedId !== id;
    this.selectedId = id;
    for (const entry of this.entries) {
      const selected = entry.definition.id === id;
      entry.options.hidden = !selected;
    }
    this.updateOptionsHeading();
    if (reveal) this.optionsCollapsed = false;
    this.updateOptionsVisibility();
    if (persist && (changed || reveal)) this.persist();
  }
  private opensOptions(entry: Entry, event: MouseEvent): boolean {
    const target = event.target as Element;
    // The title sits in the legend row: clicking it selects the graph like a legend entry does (and still edits the name).
    if (target.closest('.chart-legend-entry, .trajectory-legend-entry, .visualize-card-title')) return true;
    if (target.closest('button, select, input, textarea, label, a, [role="separator"], .view-resizer, .chart-markers>*')) return false;
    return !entry.view.isPlotTarget(event);
  }
  /** Export: every graph and trajectory on one PNG/SVG sheet (named after the log or Clip), or the HTML report. */
  private saveSheet(): void {
    const images = this.entries.flatMap((entry) => { const image = entry.view.renderImage(entry.definition.name, 800); return image ? [image] : []; });
    if (!images.length) { this.post({ type: 'exportVisualize', trajectoryCurrentTime: this.timeline.position }); return; }
    const heading = document.getElementById('source-breadcrumb')?.textContent?.trim() || 'SigMixa';
    const style = getComputedStyle(document.documentElement); const color = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
    const sheet = composeImageSheet(heading, new Date().toLocaleString(), images, { background: color('--vscode-editor-background', '#1e1e1e'), foreground: color('--vscode-foreground', '#ddd'), muted: color('--vscode-descriptionForeground', '#999') });
    this.post({ type: 'exportVisualize', trajectoryCurrentTime: this.timeline.position, ...sheet });
  }
  private duplicate(entry: Entry): void {
    const added = this.add({ ...structuredClone(entry.definition), id: crypto.randomUUID(), name: `${entry.definition.name} (${t('copy', 'コピー')})` });
    this.select(added.definition.id);
  }
  private insertActualViews(source: Entry, settings: Partial<LogViewState>[]): void {
    let position = this.entries.indexOf(source) + 1;
    let suffix = 2;
    for (const group of settings) {
      let name: string;
      do { name = `${source.definition.name} (${suffix++})`; } while (this.entries.some((entry) => entry.definition.name === name));
      const added = this.add({ id: crypto.randomUUID(), kind: 'graph', name, settings: { ...structuredClone(source.definition.settings), ...group } });
      this.entries.pop();
      this.entries.splice(position++, 0, added);
      this.list.insertBefore(added.element, this.entries[position]?.element ?? null);
    }
    this.persist();
  }
  private move(entry: Entry, direction: -1 | 1): void {
    const index = this.entries.indexOf(entry); const target = index + direction;
    if (index < 0 || target < 0 || target >= this.entries.length) return;
    this.entries.splice(index, 1); this.entries.splice(target, 0, entry);
    this.list.insertBefore(entry.element, this.entries[target + 1]?.element ?? null);
    this.persist();
  }
  private remove(entry: Entry): void {
    entry.view.dispose(); this.entries.splice(this.entries.indexOf(entry), 1); this.updateTimeControls();
    for (const [id, route] of this.requests) if (route.id === entry.definition.id) this.requests.delete(id);
    entry.element.remove(); entry.options.remove();
    this.select(this.selectedId === entry.definition.id ? this.entries[0]?.definition.id : this.selectedId, false, false); this.persist();
  }
  private showAddViewMenu(trigger: HTMLButtonElement): void {
    const actions: ViewContextAction[] = (['graph', 'trajectory'] as const).map((kind) => ({
      label: kind === 'graph' ? t('Time series', '時系列') : t('Trajectory', '軌跡'),
      icon: kind === 'graph' ? 'graph-line' : 'compass',
      run: () => {
        const added = this.add({ id: crypto.randomUUID(), kind, name: kind === 'graph' ? t('Time series', '時系列') : t('Trajectory', '軌跡'), settings: {} });
        this.select(added.definition.id);
        added.element.scrollIntoView({ block: 'nearest' });
        added.element.querySelector<HTMLElement>('.visualize-card-header')!.focus({ preventScroll: true });
      },
    }));
    const rect = trigger.getBoundingClientRect();
    this.showActionMenu(actions, t('Add graph', 'グラフを追加'), rect.left, rect.bottom + 4, trigger, trigger);
  }
  private showViewMenu(entry: Entry, x: number, y: number, pointer?: { clientX: number; clientY: number }): void {
    const index = this.entries.indexOf(entry);
    const actions: (ViewContextAction | null)[] = [
      { label: t('Show graph settings', 'グラフ設定を表示'), icon: 'settings-gear', run: () => { this.select(entry.definition.id, true); this.host.querySelector<HTMLButtonElement>('.close-view-options')!.focus({ preventScroll: true }); } },
      null, ...(entry.view instanceof TimeSeriesView ? entry.view.contextActions(pointer) : entry.view.contextActions()), null,
      { label: t('Rename graph', 'グラフ名を変更'), icon: 'edit', run: () => { entry.title.focus(); entry.title.select(); } },
      { label: t('Duplicate graph', 'グラフを複製'), icon: 'copy', run: () => this.duplicate(entry) },
      { label: t('Move graph up', 'グラフを上へ移動'), icon: 'arrow-up', enabled: index > 0, run: () => this.move(entry, -1) },
      { label: t('Move graph down', 'グラフを下へ移動'), icon: 'arrow-down', enabled: index < this.entries.length - 1, run: () => this.move(entry, 1) },
      null, { label: t('Delete graph', 'グラフを削除'), icon: 'trash', run: () => this.remove(entry) },
    ];
    this.showActionMenu(actions, entry.definition.name, x, y, entry.element.querySelector<HTMLElement>('.visualize-card-header')!);
  }
  private showActionMenu(actions: (ViewContextAction | null)[], label: string, x: number, y: number, returnFocus: HTMLElement, trigger?: HTMLButtonElement): void {
    showActionMenu(actions, label, x, y, returnFocus, { trigger, scroller: this.list });
  }
  private bindViewResize(entry: Entry): void {
    const handle = document.createElement('div'); handle.className = 'view-resizer'; handle.tabIndex = 0;
    handle.setAttribute('role', 'separator'); handle.setAttribute('aria-orientation', 'horizontal'); handle.setAttribute('aria-label', t('Graph height', 'グラフの高さ'));
 entry.element.appendChild(handle);
    const defaultHeight = entry.definition.kind === 'graph' ? 320 : 470;
    let height = typeof entry.definition.height === 'number' && Number.isFinite(entry.definition.height) ? entry.definition.height : defaultHeight;
    const apply = (value: number) => {
      height = Math.max(entry.definition.kind === 'graph' ? 120 : 220, value);
      if (entry.view instanceof TimeSeriesView) entry.view.setPlotHeight(height); else entry.element.style.height = `${height}px`;
      entry.definition = { ...entry.definition, height }; handle.setAttribute('aria-valuenow', String(Math.round(height))); handle.setAttribute('aria-valuetext', `${Math.round(height)} px`);
    };
    apply(height);
    let drag: { y: number; height: number; id: number } | undefined;
    handle.addEventListener('pointerdown', (event) => { if (event.button !== 0) return; event.preventDefault(); event.stopPropagation(); drag = { y: event.clientY, height, id: event.pointerId }; handle.setPointerCapture(event.pointerId); });
    handle.addEventListener('pointermove', (event) => { if (drag && event.pointerId === drag.id) apply(drag.height + event.clientY - drag.y); });
    const finish = () => { if (drag) { drag = undefined; this.persist(); } };
    handle.addEventListener('pointerup', finish); handle.addEventListener('pointercancel', finish); handle.addEventListener('lostpointercapture', finish);
    handle.addEventListener('click', (event) => event.stopPropagation());
    handle.addEventListener('dblclick', () => { apply(defaultHeight); this.persist(); });
    handle.addEventListener('keydown', (event) => { if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return; event.preventDefault(); apply(height + (event.key === 'ArrowUp' ? -20 : 20)); this.persist(); });
  }
  private titleMeasure?: CanvasRenderingContext2D;
  /** Sizes the title to its text, so the legend follows it directly. */
  private fitTitle(title: HTMLInputElement): void {
    const context = this.titleMeasure ??= document.createElement('canvas').getContext('2d')!; const style = getComputedStyle(title);
    context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    title.style.setProperty('--title-width', `${Math.ceil(context.measureText(title.value || ' ').width) + 16}px`);
  }
  private applyCardState(entry: Entry, header: HTMLElement, state: ViewCardState): void {
    entry.element.classList.toggle('title-inline', state.inlineTitle); entry.element.classList.toggle('view-no-data', state.noData);
    if (!state.inlineTitle && entry.title.parentElement !== header) header.prepend(entry.title);
    this.fitTitle(entry.title);
  }
  private add(definition: VisualizeViewDefinition): Entry {
    const element = document.createElement('section'); element.className = 'visualize-card'; element.dataset.kind = definition.kind;
    const header = document.createElement('header'); header.className = 'visualize-card-header'; header.tabIndex = 0;
    const title = document.createElement('input'); title.className = 'visualize-card-title'; title.value = definition.name;
    title.setAttribute('aria-label', t('Graph name', 'グラフ名')); header.appendChild(title);
    const noData = document.createElement('span'); noData.className = 'visualize-card-nodata'; noData.textContent = t('None of its Signals are in this log.', '該当するシグナルはありません。'); header.appendChild(noData);
    const headerActions = document.createElement('div'); headerActions.className = 'visualize-card-actions'; header.appendChild(headerActions);
    const body = document.createElement('div'); body.className = 'visualize-card-body';
    element.append(header, body); this.list.appendChild(element);
    const options = document.createElement('section'); options.className = 'view-specific-options'; options.hidden = true; this.options.appendChild(options);
    const controls = document.createElement('div'); controls.className = 'view-settings'; options.appendChild(controls);
    const send = (message: ToExtensionMessage) => {
      if ('requestId' in message) {
        const requestId = ++this.nextRequest;
        this.requests.set(requestId, { id: definition.id, requestId: message.requestId });
        this.post({ ...message, requestId });
      } else this.post(message);
    };
    const save = (partial: Partial<LogViewState>) => { entry.definition = { ...entry.definition, settings: { ...entry.definition.settings, ...partial } }; this.updateOptionsVisibility(); this.persist(); };
    const view = definition.kind === 'graph' ? new TimeSeriesView(body, definition.settings, send, save, this.timeline, controls, headerActions, (settings) => this.insertActualViews(entry, settings)) : new TrajectoryView(body, definition.settings, send, save, this.timeline, controls, headerActions);
    const entry: Entry = { definition, view, element, options, title }; this.entries.push(entry); this.updateTimeControls();
    // The title sits at the start of the view's legend row, so title and legend share one flow; the header then holds only
    // the actions, shown while the card is hovered, selected or focused. Without a legend the title stays in the header.
    view.onCardState = (state) => this.applyCardState(entry, header, state);
    view.setLegendLead(title); this.fitTitle(title);
    title.addEventListener('input', () => this.fitTitle(title));
    this.bindViewResize(entry);
    element.addEventListener('click', (event) => {
      // Empty views offer a direct setup path. Toolbar actions keep their own behavior.
      if (entry.view.isConfigured || (event.target as Element).closest('button, select, input[type="checkbox"], .view-resizer')) return;
      this.select(entry.definition.id, true);
      event.stopPropagation();
    }, { capture: true });
    // Pressing anywhere on the card selects the graph: title, legend, plotting area and action icons alike. Markers, range
    // selection, rotation and the icons' own actions work as before. This alone does not open the settings panel; an open
    // panel switches to this graph.
    element.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      // A name still being edited in another graph is finished, so only this graph shows its actions.
      const active = document.activeElement; if (active instanceof HTMLElement && active.classList.contains('visualize-card-title') && !element.contains(active)) active.blur();
      if (this.selectedId !== entry.definition.id) this.select(entry.definition.id);
    }, { capture: true });
    // Outside the plotting area a click opens this graph's settings; a legend entry also jumps to its option.
    let pressOpensOptions = false;
    element.addEventListener('pointerdown', (event) => { pressOpensOptions = event.button === 0 && this.opensOptions(entry, event); });
    element.addEventListener('click', (event) => {
      const opens = pressOpensOptions && this.opensOptions(entry, event); pressOpensOptions = false;
      if (!opens || window.getSelection()?.toString()) return;
      this.select(entry.definition.id, true);
      const legend = (event.target as Element).closest<HTMLElement>('.chart-legend-entry, .trajectory-legend-entry');
      const optionId = legend?.dataset.signalId ?? legend?.dataset.trackId;
      if (optionId) entry.view.revealOption(optionId);
    });
    const actions = document.createElement('div'); actions.className = 'view-header-actions view-action-group'; actions.setAttribute('role', 'group'); actions.setAttribute('aria-label', t('Graph actions', 'グラフ操作')); headerActions.appendChild(actions);
    title.addEventListener('change', () => { entry.definition = { ...entry.definition, name: title.value.trim() || entry.definition.name }; title.value = entry.definition.name; this.updateOptionsHeading(); this.persist(); });
    title.addEventListener('keydown', (event) => {
      if (event.isComposing) return;
      if (event.key === 'Enter') { event.preventDefault(); title.blur(); }
      if (event.key === 'Escape') { event.preventDefault(); title.value = entry.definition.name; title.blur(); }
    });
    const button = (icon: string, label: string, action: () => void) => { const control = iconButton(document.createElement('button'), icon, label); control.type = 'button'; control.addEventListener('click', (event) => { event.stopPropagation(); action(); }); actions.appendChild(control); };
    button('settings-gear', t('Show graph settings', 'グラフ設定を表示'), () => this.select(entry.definition.id, true));
    button('arrow-up', t('Move graph up', 'グラフを上へ移動'), () => this.move(entry, -1));
    button('copy', t('Duplicate graph', 'グラフを複製'), () => this.duplicate(entry));
    button('trash', t('Delete graph', 'グラフを削除'), () => this.remove(entry));
    element.addEventListener('contextmenu', (event) => {
      event.preventDefault(); event.stopPropagation();
      const rect = header.getBoundingClientRect();
      this.showViewMenu(entry, event.clientX || rect.left + 12, event.clientY || rect.bottom, event.clientX || event.clientY ? { clientX: event.clientX, clientY: event.clientY } : undefined);
    });
    header.addEventListener('keydown', (event) => {
      if (event.target === header && (!entry.view.isConfigured || !this.optionsCollapsed) && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault(); this.select(entry.definition.id, !entry.view.isConfigured);
      }
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
        event.preventDefault(); const rect = header.getBoundingClientRect(); this.showViewMenu(entry, rect.left + 12, rect.bottom);
      }
    });
    this.updateOptionsHeading();
    if (this.visible) view.show();
    return entry;
  }
}
