import { t } from '../shared/i18n';
import { bindColumnHover, bindResizeKeyboard, widthToFit } from '../shared/tableBehavior';
import { FRAME_TABLE_LABELS, measureTableText, appendTableValue } from '../shared/dataTableStyle';
import { autoFitColumns } from '../shared/columnSizing';
import type { LastFrameDto, ToExtensionMessage, TraceColumn, TraceDisplaySettings, TraceSort } from '../../extension/editors/rawLogProtocol';
import type { ViewContextAction } from '../shared/viewContextAction';
import { traceMilliseconds } from './traceNumbers';
import { compareTraceRows, traceCanIdKey } from './traceSort';

// Trace rows cover Rx and Tx alike, so labels avoid direction-specific wording.
// Timing headings stay Japanese in the Japanese UI: the English terms are easy to confuse.
const NO_DATA = '—';
// Distinct reasons for an empty cell on a row that has been seen.
const NOT_COMPUTABLE = t('N/A', '算出不可');
const NOT_SET = t('NOT SET', '未設定');
const UNREADABLE = t('UNKNOWN', '取得不可');
const columns: readonly [TraceColumn, string][] = [['channel', 'CH'], ['direction', FRAME_TABLE_LABELS.direction], ['receivedAt', t('TIME (s)', '最終時刻 (s)')], ['age', t('AGE (ms)', '経過 (ms)')], ['count', t('COUNT', '回数')], ['interval', t('INTERVAL (ms)', '間隔 (ms)')], ['minInterval', t('MIN INTERVAL (ms)', '最小間隔 (ms)')], ['maxInterval', t('MAX INTERVAL (ms)', '最大間隔 (ms)')], ['lastChange', t('LAST CHANGE (s)', '最終変化時刻 (s)')], ['expected', t('EXPECTED (ms)', '期待周期 (ms)')], ['deviation', t('DEVIATION (ms)', '周期偏差 (ms)')]];
const defaults: readonly TraceColumn[] = ['channel', 'direction', 'receivedAt', 'age', 'count', 'interval', 'deviation'];
/** A frame is marked as stopped once it has been silent for this many expected periods. */
const STALE_PERIODS = 3;
const COPY_FEEDBACK_MS = 1400;
type ShowMenu = (actions: (ViewContextAction | null)[], label: string, x: number, y: number, returnFocus: HTMLElement) => void;


/** All IDs remain visible. Pins, columns and RAW/decoded preferences belong to the trace. */
export class TraceTableView {
  private values: readonly LastFrameDto[] = [];
  private pointerActive = false;
  private renderPending = false;
  private applyColumnWidths?: () => void;
  private header?: HTMLTableSectionElement;
  private headerKey = '';
  /** Selection follows rows by key, because the live trace re-sorts and rebuilds its rows. */
  private selectedKeys = new Set<string>();
  private anchorKey?: string;
  private dragAnchorKey?: string;
  /** Widths fitted to the content the first time a column shows data; kept until the user resizes. */
  private readonly fittedWidths = new Map<string, number>();
  /** Widths a column had to grow to because something on screen overflowed; never shrink. */
  private readonly grownWidths = new Map<string, number>();
  private readonly columnHover: { refresh(): void };
  private order: string[] = [];
  private copyFeedbackTimer?: number;
  private dragPointerY = 0;
  private dragFrame?: number;
  private shownColumns: readonly [string, string][] = [];
  settings: TraceDisplaySettings;
  constructor(private readonly host: HTMLElement, initial: TraceDisplaySettings | undefined, private readonly save: (settings: TraceDisplaySettings) => void, private readonly menu: ShowMenu, private readonly post: (message: ToExtensionMessage) => void) {
    // Discard the former ID/Signal filters: older saved settings must not hide data.
    this.settings = structuredClone({ widths: initial?.widths, pinnedIds: initial?.pinnedIds, defaultMode: initial?.defaultMode, columns: initial?.columns, sort: initial?.sort, descending: initial?.descending });
    host.tabIndex = 0;
    host.setAttribute('aria-label', t('Trace. Pin rows with the checkboxes, click a heading to sort, right-click to choose columns and the display format.', 'トレース。チェックボックスでピン留め、見出しをクリックして並び替え、右クリックで表示列と全体の表示形式を変更'));
    // Live trace updates must not replace a checkbox/header between press and release.
    host.addEventListener('pointerdown', (event) => { if ((event.target as Element).closest('input, th')) this.pointerActive = true; });
    const release = () => window.setTimeout(() => { if (this.pointerActive) { this.pointerActive = false; if (this.renderPending) this.render(); } }, 0);
    window.addEventListener('pointerup', release); window.addEventListener('pointercancel', release); window.addEventListener('blur', release);
    window.addEventListener('pagehide', () => { window.removeEventListener('pointerup', release); window.removeEventListener('pointercancel', release); window.removeEventListener('blur', release); }, { once: true });
    host.addEventListener('contextmenu', (event) => {
      event.preventDefault(); event.stopPropagation();
      const row = (event.target as Element).closest<HTMLElement>('tbody tr[data-trace-key]');
      if (row) { if (!this.selectedKeys.has(row.dataset.traceKey!)) this.select(row.dataset.traceKey!, {}); this.showRowMenu(event.clientX, event.clientY); }
      else this.showMenu(event.clientX, event.clientY);
    });
    host.addEventListener('mousedown', (event) => {
      const row = (event.target as Element).closest<HTMLElement>('tbody tr[data-trace-key]');
      if (!row || event.button !== 0 || (event.target as Element).closest('input,button')) return;
      // Rows are selected as a whole, like the RAW Log and Table; keep the browser from selecting text.
      event.preventDefault(); row.focus({ preventScroll: true });
      this.select(row.dataset.traceKey!, { toggle: event.metaKey || event.ctrlKey, extend: event.shiftKey });
      this.dragAnchorKey = event.shiftKey || event.metaKey || event.ctrlKey ? undefined : row.dataset.traceKey;
      if (this.dragAnchorKey) {
        this.host.classList.add('drag-selecting');
        const track = (next: MouseEvent) => { this.dragPointerY = next.clientY; };
        window.addEventListener('mousemove', track);
        this.dragPointerY = event.clientY; this.dragFrame = requestAnimationFrame(() => this.continueDrag());
        window.addEventListener('mouseup', () => { this.dragAnchorKey = undefined; this.host.classList.remove('drag-selecting'); window.removeEventListener('mousemove', track); if (this.dragFrame !== undefined) cancelAnimationFrame(this.dragFrame); this.dragFrame = undefined; }, { once: true });
      }
    });
    host.addEventListener('mouseover', (event) => {
      if (!this.dragAnchorKey || !(event.buttons & 1)) { this.dragAnchorKey = undefined; return; }
      const row = (event.target as Element).closest<HTMLElement>('tbody tr[data-trace-key]'); if (!row) return;
      this.anchorKey = this.dragAnchorKey; this.select(row.dataset.traceKey!, { extend: true });
    });
    host.addEventListener('copy', (event) => {
      const text = this.selectionText(); if (!text) return;
      event.preventDefault(); event.clipboardData?.setData('text/plain', text); this.showCopyFeedback(this.selectedKeys.size);
    });
    this.columnHover = bindColumnHover(host, (element) => element.closest<HTMLElement>('[data-column-id]')?.dataset.columnId, (column) => host.querySelectorAll<HTMLElement>(`thead th[data-column-id="${column}"]`));
    host.addEventListener('keydown', (event) => {
      if (this.keyDown(event)) return;
      if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
      event.preventDefault(); event.stopPropagation();
      const rect = (event.target as HTMLElement).getBoundingClientRect(); const row = (event.target as Element).closest<HTMLElement>('tbody tr[data-trace-key]');
      if (row) { if (!this.selectedKeys.has(row.dataset.traceKey!)) this.select(row.dataset.traceKey!, {}); this.showRowMenu(rect.left + 12, rect.top + 20); }
      else this.showMenu(rect.left + 12, rect.top + 20);
    });
  }
  setValues(values: readonly LastFrameDto[]): void { this.values = values; this.render(); }
  private select(key: string, mode: { toggle?: boolean; extend?: boolean }): void {
    if (mode.extend && this.anchorKey && this.order.includes(this.anchorKey)) {
      const [from, to] = [this.order.indexOf(this.anchorKey), this.order.indexOf(key)].sort((a, b) => a - b);
      this.selectedKeys = new Set(this.order.slice(from, to + 1));
    } else if (mode.toggle) {
      if (this.selectedKeys.has(key)) this.selectedKeys.delete(key); else this.selectedKeys.add(key);
      this.anchorKey = key;
    } else { this.selectedKeys = new Set([key]); this.anchorKey = key; }
    this.paintSelection();
  }
  /** Like the RAW Log and Table: dragging past the top or bottom edge scrolls and keeps extending the selection. */
  private continueDrag(): void {
    const viewport = this.host.parentElement; const anchor = this.dragAnchorKey; if (!viewport || !anchor) return;
    const bounds = viewport.getBoundingClientRect(); const top = bounds.top + (this.host.querySelector('thead')?.getBoundingClientRect().height ?? 0);
    const bottom = Math.min(bounds.bottom, window.innerHeight);
    const overflow = this.dragPointerY < top ? this.dragPointerY - top : this.dragPointerY > bottom ? this.dragPointerY - bottom : 0;
    if (overflow) {
      viewport.scrollTop += Math.sign(overflow) * Math.min(20, Math.max(4, Math.abs(overflow) * .35));
      const edgeY = overflow < 0 ? Math.max(top, 0) + 2 : Math.min(bounds.bottom, window.innerHeight) - 2; const x = bounds.left + Math.min(bounds.width - 4, 200);
      const row = document.elementFromPoint(x, edgeY)?.closest<HTMLElement>('tbody tr[data-trace-key]');
      if (row) { this.anchorKey = anchor; this.select(row.dataset.traceKey!, { extend: true }); }
    }
    this.dragFrame = requestAnimationFrame(() => this.continueDrag());
  }
  /** Same wording as the RAW Log and Table: "N rows selected", briefly "N rows copied" after a copy. */
  private statusElement(): HTMLElement | null { return this.host.closest('.last-values')?.querySelector<HTMLElement>('.trace-selection-status') ?? null; }
  private updateStatus(): void {
    if (this.copyFeedbackTimer !== undefined) return;
    const status = this.statusElement(); if (!status) return; const count = this.selectedKeys.size; status.hidden = count === 0;
    status.textContent = count ? `${count.toLocaleString()} ${t(count === 1 ? 'row selected' : 'rows selected', '行選択')}` : '';
  }
  private showCopyFeedback(count: number): void {
    const status = this.statusElement(); if (!status) return; window.clearTimeout(this.copyFeedbackTimer);
    status.hidden = false; status.textContent = `${count.toLocaleString()} ${t(count === 1 ? 'row copied' : 'rows copied', '行コピーしました')}`;
    this.copyFeedbackTimer = window.setTimeout(() => { this.copyFeedbackTimer = undefined; this.updateStatus(); }, COPY_FEEDBACK_MS);
  }
  private paintSelection(): void {
    this.host.querySelectorAll<HTMLElement>('tbody tr[data-trace-key]').forEach((row) => {
      const selected = this.selectedKeys.has(row.dataset.traceKey!); row.classList.toggle('selected', selected); row.setAttribute('aria-selected', String(selected));
    });
    this.updateStatus();
  }
  /** Row keyboard: ↑/↓ move (Shift extends), Cmd/Ctrl+A selects every row. Copy goes through the copy event. */
  private keyDown(event: KeyboardEvent): boolean {
    const row = (event.target as Element).closest?.<HTMLElement>('tbody tr[data-trace-key]');
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a' && (row || event.target === this.host)) {
      event.preventDefault(); this.selectedKeys = new Set(this.order); this.paintSelection(); return true;
    }
    if (event.key === 'Escape' && (row || event.target === this.host)) { event.preventDefault(); if (this.selectedKeys.size) { this.selectedKeys.clear(); this.paintSelection(); } (document.activeElement as HTMLElement | null)?.blur(); return true; }
    if (!row || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return false;
    const index = this.order.indexOf(row.dataset.traceKey!); const next = this.order[index + (event.key === 'ArrowDown' ? 1 : -1)];
    if (next === undefined) return true;
    event.preventDefault(); this.select(next, { extend: event.shiftKey });
    this.host.querySelector<HTMLElement>(`tbody tr[data-trace-key="${CSS.escape(next)}"]`)?.focus();
    return true;
  }
  /** Selected rows as tab-separated text, with the visible columns as a heading line. */
  private selectionText(): string {
    const rows = this.displayRows().filter((item) => this.selectedKeys.has(item.key)).sort((a, b) => this.order.indexOf(a.key) - this.order.indexOf(b.key));
    if (!rows.length) return '';
    const ids = ['canId', 'name', ...this.shownColumns.map(([id]) => id), ...(rows.some((item) => item.multiplexer) ? ['multiplexer'] : []), 'content'] as TraceSort[];
    const labels = new Map<string, string>([['canId', FRAME_TABLE_LABELS.canId], ['name', FRAME_TABLE_LABELS.name], ['multiplexer', FRAME_TABLE_LABELS.multiplexer], ['content', FRAME_TABLE_LABELS.content], ...this.shownColumns]);
    return [ids.map((id) => labels.get(id) ?? id).join('\t'), ...rows.map((item) => ids.map((id) => this.columnText(item, id)).join('\t'))].join('\n');
  }
  /** Same actions and wording as the RAW Log row menu. */
  private showRowMenu(x: number, y: number): void {
    const count = this.selectedKeys.size; const focused = this.displayRows().find((item) => item.key === this.anchorKey) ?? this.displayRows().find((item) => this.selectedKeys.has(item.key));
    const actions: ViewContextAction[] = [
      { label: count === 1 ? t('Copy Row', '行をコピー') : t(`Copy ${count} Rows`, `${count}行をコピー`), icon: 'copy', run: () => { this.host.focus(); document.execCommand('copy'); } },
      { label: count === 1 ? t('Open Row in Text Editor', '行をテキストエディタで開く') : t(`Open ${count} Rows in Text Editor`, `${count}行をテキストエディタで開く`), icon: 'go-to-file', run: () => this.post({ type: 'openText', text: this.selectionText() }) },
    ];
    if (focused) actions.push(focused.row.definitionId
      ? { label: t('Open Frame Definition', 'フレーム定義を開く'), icon: 'layers', run: () => this.post({ type: 'openFrameDefinition', definitionId: focused.row.definitionId! }) }
      : { label: t('Register CAN Frame', 'CANフレームを登録'), icon: 'add', run: () => this.post({ type: 'registerFrame', canId: focused.row.canIdValue, extended: focused.row.extended, frameLength: focused.row.length }) });
    this.menu(actions, t('Trace row actions', 'トレースの行の操作'), x, y, this.host);
  }
  private update(partial: Partial<TraceDisplaySettings>): void { this.settings = { ...this.settings, ...partial }; this.save(this.settings); this.render(); }
  private isPinned(item: LastFrameDto): boolean { return this.settings.pinnedIds?.includes(traceCanIdKey(item)) ?? false; }
  private modeFor(item: LastFrameDto): 'raw' | 'decoded' {
    const parent = item.parentKey ? this.values.find((value) => value.key === item.parentKey) ?? item : item;
    return !parent.signals.length && !parent.multiplexerRows?.length ? 'raw' : this.settings.defaultMode ?? 'decoded';
  }
  /**
   * Rows not seen before the seek time are listed only when pinned; pinned ones show "—".
   * In a Clip, a frame not yet received in the Clip is still listed while it shows values carried from before the Clip.
   */
  private displayRows(): LastFrameDto[] {
    return this.values.flatMap((item) => this.modeFor(item) === 'decoded' && item.multiplexerRows?.length ? [...item.multiplexerRows] : [item])
      .filter((item) => item.count > 0 || this.isPinned(item) || (this.modeFor(item) === 'decoded' && item.signals.some((signal) => signal.carried)));
  }
  private showMenu(x: number, y: number): void {
    const actions: (ViewContextAction | null)[] = [];
    for (const [id, label] of columns) actions.push({ label, icon: 'blank', checked: (this.settings.columns ?? defaults).includes(id), run: () => {
      const active = new Set(this.settings.columns ?? defaults); if (active.has(id)) active.delete(id); else active.add(id); this.update({ columns: columns.map(([key]) => key).filter((key) => active.has(key)) });
    } });
    actions.push(null);
    for (const [value, label, icon] of [['raw', 'RAW', 'code'], ['decoded', t('decoded', 'デコード済み'), 'symbol-numeric']] as const) actions.push({
      label: t(`Show all rows as ${label}`, `全行を${label}で表示`), icon, checked: (this.settings.defaultMode ?? 'decoded') === value,
      run: () => this.update({ defaultMode: value }),
    });
    this.menu(actions, t('Trace columns and display format', 'トレースの表示列・表示形式'), x, y, this.host);
  }
  private sortHeader(id: TraceSort, label: string, className = ''): HTMLTableCellElement {
    const cell = document.createElement('th'); cell.scope = 'col'; cell.className = className; cell.dataset.columnId = id;
    const selected = (this.settings.sort ?? 'canId') === id;
    cell.setAttribute('aria-sort', selected ? this.settings.descending ? 'descending' : 'ascending' : 'none');
    const button = document.createElement('button'); button.type = 'button'; button.className = 'trace-sort'; button.dataset.traceSort = id;

    const text = document.createElement('span'); text.textContent = label; text.dataset.fitContent = 'true';
    const indicator = document.createElement('span'); indicator.className = `trace-sort-indicator codicon codicon-chevron-${this.settings.descending ? 'down' : 'up'}`; indicator.style.visibility = selected ? 'visible' : 'hidden'; indicator.setAttribute('aria-hidden', 'true'); button.append(text, indicator); cell.appendChild(button);
    cell.onclick = () => this.update({ sort: id, descending: selected ? !this.settings.descending : false });
    const handle = document.createElement('span'); handle.className = 'resize';
    handle.dataset.traceResize = id;
    const fit = () => {
      const width = autoFitColumns([{ id, label, minWidth: this.minimumWidth(id), maxWidth: 6000, value: (row: LastFrameDto) => this.columnText(row, id) }], this.displayRows(), measureTableText, 36)[id];
      this.update({ widths: { ...this.settings.widths, [id]: width } });
    };
    bindResizeKeyboard(handle, { label, width: () => cell.getBoundingClientRect().width, setWidth: (width) => this.update({ widths: { ...this.settings.widths, [id]: Math.max(this.minimumWidth(id), Math.min(6000, width)) } }), fit });
    handle.addEventListener('mousedown', (event) => {
      event.preventDefault(); event.stopPropagation();
      const start = event.clientX; const initialWidth = cell.getBoundingClientRect().width;
      const move = (next: MouseEvent) => { this.settings = { ...this.settings, widths: { ...this.settings.widths, [id]: Math.max(this.minimumWidth(id), Math.min(6000, initialWidth + next.clientX - start)) } }; this.applyColumnWidths?.(); };
      const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); this.save(this.settings); };
      window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    });
    handle.addEventListener('dblclick', (event) => { event.preventDefault(); event.stopPropagation(); fit(); });
    cell.appendChild(handle); return cell;
  }
  private minimumWidth(id: TraceSort): number { return id === 'name' ? 90 : id === 'canId' ? 82 : id === 'content' ? 180 : 44; }
  private columnText(item: LastFrameDto, id: TraceSort): string {
    if (id === 'name') return item.row.name;
    if (id === 'canId') return item.row.canId;
    if (id === 'content') return this.contentText(item);
    return this.statCells(item)[id];
  }
  private contentText(item: LastFrameDto): string {
    return this.modeFor(item) === 'raw' ? item.count ? item.row.rawContent : NO_DATA : item.signals.map((signal) => this.signalText(signal)).join('  ');
  }
  private signalText(signal: LastFrameDto['signals'][number]): string {
    return `${signal.name}: ${signal.value === undefined ? NO_DATA : `${Number(signal.value.toPrecision(10))}${signal.unit ? ` ${signal.unit}` : ''}${signal.valueLabel ? ` (${signal.valueLabel})` : ''}`}`;
  }
  private statCells(item: LastFrameDto): Record<TraceColumn | 'multiplexer', string> {
    const cells: Record<TraceColumn | 'multiplexer', string> = { multiplexer: item.multiplexer ? item.multiplexer.value === undefined ? item.count ? UNREADABLE : NO_DATA : String(item.multiplexer.value) : '—', channel: item.row.channel < 0 ? '—' : String(item.row.channel), direction: item.row.channel < 0 ? '—' : item.row.direction, receivedAt: item.count ? item.row.time.toFixed(6) : NO_DATA, age: traceMilliseconds(item.age === undefined ? undefined : item.age * 1000), count: String(item.count), interval: item.intervalMs === undefined ? item.count ? NOT_COMPUTABLE : NO_DATA : traceMilliseconds(item.intervalMs), minInterval: item.minIntervalMs === undefined ? item.count ? NOT_COMPUTABLE : NO_DATA : traceMilliseconds(item.minIntervalMs), maxInterval: item.maxIntervalMs === undefined ? item.count ? NOT_COMPUTABLE : NO_DATA : traceMilliseconds(item.maxIntervalMs), lastChange: item.lastChangeAt === undefined ? NO_DATA : item.lastChangeAt.toFixed(6), expected: item.multiplexer ? '—' : item.expectedPeriodMs === undefined ? NOT_SET : traceMilliseconds(item.expectedPeriodMs), deviation: item.multiplexer || !item.count ? NO_DATA : item.expectedPeriodMs === undefined ? NOT_SET : item.deviationMs === undefined ? NOT_COMPUTABLE : traceMilliseconds(item.deviationMs, true) };
    return cells;
  }
  private render(): void {
    if (this.pointerActive) { this.renderPending = true; return; }
    this.renderPending = false;
    const viewport = this.host.parentElement;
    const scrollLeft = viewport?.scrollLeft ?? 0; const scrollTop = viewport?.scrollTop ?? 0;
    const focused = this.host.contains(document.activeElement) ? document.activeElement as HTMLElement : undefined;
    const focusedRow = focused?.closest<HTMLElement>('[data-trace-key]')?.dataset.traceKey;
    const focusedPin = focused instanceof HTMLInputElement; const focusedSort = focused?.dataset.traceSort; const focusedResize = focused?.dataset.traceResize;
    this.host.replaceChildren();
    const visibleRows = this.displayRows();
    const hasMultiplexer = visibleRows.some((item) => item.multiplexer);
    const shownColumns = columns.filter(([id]) => (this.settings.columns ?? defaults).includes(id)); this.shownColumns = shownColumns;
    type ColumnId = TraceSort | 'pin';
    // Trace rows identify an ID/channel/direction/MUX branch. Reception times are measurements, not identity.
    const columnOrder: readonly [ColumnId, string][] = [
      ['pin', t('Pinned', t('Pinned', 'ピン留め'))], ['canId', FRAME_TABLE_LABELS.canId], ['name', FRAME_TABLE_LABELS.name],
      ...shownColumns.filter(([id]) => id === 'channel' || id === 'direction'),
      ...(hasMultiplexer ? [['multiplexer', FRAME_TABLE_LABELS.multiplexer] as [ColumnId, string]] : []),
      ...shownColumns.filter(([id]) => id !== 'direction' && id !== 'channel'), ['content', FRAME_TABLE_LABELS.content],
    ];
    const fixedWidths: Partial<Record<ColumnId, number>> = { pin: 28, canId: 96, name: 130, channel: 48, direction: 68, multiplexer: 58 };
    const offsets = new Map<ColumnId, number>(); let left = 0;
    for (const [id] of columnOrder) { const width = fixedWidths[id]; if (width !== undefined) { offsets.set(id, left); left += width; } }
    const styleFixed = (cell: HTMLTableCellElement, id: ColumnId) => {
      const width = fixedWidths[id]; if (width === undefined) return;
      cell.classList.add('trace-fixed'); cell.style.left = `${offsets.get(id)}px`;
      cell.style.width = cell.style.minWidth = cell.style.maxWidth = `${width}px`;
      if (id === Array.from(offsets.keys()).at(-1)) cell.classList.add('trace-fixed-edge');
    };
    const table = document.createElement('table'); table.className = 'data-table'; const nextHeaderKey = JSON.stringify([columnOrder, this.settings.sort, this.settings.descending]);
    const heading = this.headerKey === nextHeaderKey && this.header ? this.header : document.createElement('thead');
    if (heading !== this.header) {
    const head = document.createElement('tr');

    const pinHead = document.createElement('th'); pinHead.scope = 'col'; pinHead.dataset.columnId = 'pin'; pinHead.className = 'trace-pin-column'; pinHead.setAttribute('aria-label', t('Pinned', 'ピン留め')); pinHead.title = t('Pinned', 'ピン留め');
    const pinIcon = document.createElement('span'); pinIcon.className = 'codicon codicon-pinned'; pinIcon.setAttribute('aria-hidden', 'true'); pinHead.appendChild(pinIcon);
    for (const [id, label] of columnOrder) {
      const cell = id === 'pin' ? pinHead : this.sortHeader(id, label, id === 'canId' ? 'trace-can-id' : id === 'name' ? 'trace-name' : id === 'multiplexer' ? 'trace-mux' : '');
      cell.classList.toggle('table-number', ['receivedAt', 'age', 'count', 'interval', 'minInterval', 'maxInterval', 'lastChange', 'expected', 'deviation'].includes(id)); styleFixed(cell, id); head.appendChild(cell);
    }
    heading.appendChild(head); this.header = heading; this.headerKey = nextHeaderKey;
    }
    const head = heading.rows[0]; table.appendChild(heading);
    const body = document.createElement('tbody'); table.appendChild(body);
    const pins = new Set(this.settings.pinnedIds ?? []);
    const sorted = visibleRows.slice().sort((a, b) => compareTraceRows(a, b, this.settings.sort ?? 'canId', this.settings.descending ?? false, pins, (item) => this.contentText(item)));
    this.order = sorted.map((item) => item.key); for (const key of [...this.selectedKeys]) if (!this.order.includes(key)) this.selectedKeys.delete(key);
    this.updateStatus();
    for (const [index, item] of sorted.entries()) {
      const row = document.createElement('tr'); row.dataset.traceKey = item.key; row.tabIndex = 0;
      const selected = this.selectedKeys.has(item.key); row.classList.toggle('selected', selected); row.setAttribute('aria-selected', String(selected));
      row.classList.toggle('trace-pinned-end', this.isPinned(item) && !this.isPinned(sorted[index + 1] ?? item));
      const stale = isStale(item); row.classList.toggle('trace-stale', stale);
      if (stale) row.title = t(`Stale (elapsed ${traceMilliseconds(item.age! * 1000)} ms / expected ${traceMilliseconds(item.expectedPeriodMs)} ms)`, `途絶（経過 ${traceMilliseconds(item.age! * 1000)} ms / 期待 ${traceMilliseconds(item.expectedPeriodMs)} ms）`);
      const pinCell = document.createElement('td'); pinCell.className = 'trace-pin-column'; pinCell.dataset.columnId = 'pin';
      const pin = document.createElement('input'); pin.type = 'checkbox'; pin.checked = this.isPinned(item); pin.setAttribute('aria-label', t(`Pin ${item.row.canId} ${item.row.name}`, `${item.row.canId} ${item.row.name}をピン留め`));
      pin.onchange = () => { const ids = new Set(this.settings.pinnedIds ?? []); if (pin.checked) ids.add(traceCanIdKey(item)); else ids.delete(traceCanIdKey(item)); this.update({ pinnedIds: [...ids] }); }; pinCell.appendChild(pin);
      const canId = document.createElement('td'); canId.className = 'trace-can-id'; canId.dataset.columnId = 'canId'; canId.textContent = item.row.canId; canId.title = item.row.extended ? t('Extended CAN ID', '拡張CAN ID') : t('Standard CAN ID', '標準CAN ID');
      const name = document.createElement('td'); name.className = 'trace-name'; name.dataset.columnId = 'name'; const label = document.createElement('div'); label.textContent = item.row.name; label.title = item.row.name; label.dataset.fitContent = 'true'; name.appendChild(label);
      const rowCells = new Map<ColumnId, HTMLTableCellElement>([['pin', pinCell], ['canId', canId], ['name', name]]);
      const content = document.createElement('td'); content.className = 'trace-values'; content.dataset.columnId = 'content';
      const raw = this.modeFor(item) === 'raw';
      if (raw) { content.textContent = item.count ? item.row.rawContent : NO_DATA; }
      else {
        const signals = document.createElement('div'); signals.className = 'trace-signals';
        for (const signal of item.signals) {
          const value = document.createElement('span'); value.className = 'trace-signal'; appendTableValue(value, signal.name, this.signalText(signal).slice(signal.name.length + 2));
          value.title = signal.timestamp === undefined ? `${signal.name}: ${NO_DATA}` : `${value.textContent}\n${t('Last update', '最終更新')} ${signal.timestamp.toFixed(6)} s${signal.carried ? `\n${t('Carried from before the Clip', 'クリップ開始前から引き継いだ値')}` : ''}`; value.classList.toggle('carried', signal.carried === true); signals.appendChild(value);
        }
        if (!item.signals.length) signals.textContent = t('No decoded values', 'デコード値なし');
        content.appendChild(signals);
      }
      const cells = this.statCells(item);
      const dataColumns: readonly (TraceColumn | 'multiplexer')[] = [...shownColumns.map(([id]) => id), ...(hasMultiplexer ? ['multiplexer' as const] : [])];
      for (const id of dataColumns) {
        const cell = document.createElement('td'); cell.textContent = cells[id]; cell.dataset.columnId = id;
        cell.className = ['channel', 'direction', 'multiplexer'].includes(id) ? 'table-center' : 'table-number';
        if (id === 'multiplexer') cell.classList.add('trace-mux');
        if (id === 'multiplexer') cell.title = item.multiplexer ? `${item.multiplexer.name}: ${cells.multiplexer}${t(' (raw value)', '（RAW値）')}` : item.multiplexerRows?.length ? t('RAW mode aggregates the whole CAN ID', 'RAW表示ではCAN ID全体を集計') : t('No multiplexer', 'Multiplexerなし');
        if (id === 'deviation') cell.title = item.multiplexer ? t('MUX rows show the interval only; they are not compared with the expected period of the whole CAN ID.', 'MUX行は間隔のみ表示します。CAN ID全体の期待周期とは比較しません。') : item.deviationMs === undefined ? cells[id] : t(`Interval − expected period\n${item.deviationMs.toPrecision(15)} ms (calculated)\nShown to 0.000001 ms at most`, `間隔 − 期待周期\n${item.deviationMs.toPrecision(15)} ms（計算値）\n表示は最大 0.000001 ms 単位`);
        rowCells.set(id, cell);
      }
      rowCells.set('content', content);
      for (const [id] of columnOrder) { const cell = rowCells.get(id)!; styleFixed(cell, id); row.appendChild(cell); }
      body.appendChild(row);
    }
    if (!sorted.length) { const row = document.createElement('tr'); const cell = document.createElement('td'); cell.colSpan = columnOrder.length; cell.textContent = t('No data', 'データなし'); row.appendChild(cell); body.appendChild(row); }
    this.host.appendChild(table);
    this.applyColumnWidths = () => {
      const sizes = new Map<ColumnId, number>(); let total = 0; let fixedLeft = 0;
      const base: Partial<Record<ColumnId, number>> = { ...fixedWidths, receivedAt: 124, age: 100, count: 92, interval: 128, minInterval: 128, maxInterval: 128, lastChange: 124, expected: 128, deviation: 128, content: 360 };
      for (const [id, label] of columnOrder) {
        const saved = id === 'pin' ? 28 : this.settings.widths?.[id];
        // Columns without a saved width fit their content. They only ever grow, so playback never makes them jump back and forth.
        if (saved === undefined && id !== 'pin' && id !== 'content' && visibleRows.some((item) => item.count > 0)) {
          this.fittedWidths.set(id, Math.max(this.fittedWidths.get(id) ?? 0, autoFitColumns([{ id, label, minWidth: this.minimumWidth(id), maxWidth: id === 'name' ? 2000 : 600, value: (row: LastFrameDto) => this.columnText(row, id as TraceSort) }], visibleRows, measureTableText, 36)[id]));
        }
        const chosen = saved !== undefined && Number.isFinite(saved) ? Math.max(id === 'pin' ? 28 : this.minimumWidth(id), Math.min(6000, saved)) : this.fittedWidths.get(id) ?? Math.max(base[id] ?? 100, measureTableText(label) + (id === 'pin' ? 0 : 36));
        // No column is cut off: it is always at least as wide as the widest header or value shown so far.
        const width = Math.max(chosen, this.grownWidths.get(id) ?? 0);
        sizes.set(id, width); total += width;
      }
      table.style.tableLayout = 'fixed'; table.style.width = `${total}px`;
      for (const [index, [id]] of columnOrder.entries()) {
        const width = sizes.get(id)!;
        for (const row of Array.from(table.rows)) {
          if (row.cells.length !== columnOrder.length) continue;
          const cell = row.cells[index]; cell.style.width = cell.style.minWidth = cell.style.maxWidth = `${width}px`;
          if (fixedWidths[id] !== undefined) cell.style.left = `${fixedLeft}px`;
        }
        if (fixedWidths[id] !== undefined) fixedLeft += width;
      }
    };
    this.applyColumnWidths();
    let grew = false;
    for (const [index, [id]] of columnOrder.entries()) {
      if (id === 'pin') continue;
      const cells = Array.from(table.rows).filter((row) => row.cells.length === columnOrder.length).map((row) => row.cells[index]);
      const width = widthToFit(cells, cells[0]?.getBoundingClientRect().width ?? 0);
      if (width !== undefined && width > (this.grownWidths.get(id) ?? 0)) { this.grownWidths.set(id, width); grew = true; }
    }
    if (grew) this.applyColumnWidths();
    this.columnHover.refresh();
    if (focusedRow) { const row = Array.from(body.rows).find((value) => value.dataset.traceKey === focusedRow); (focusedPin ? row?.querySelector('input') : row)?.focus({ preventScroll: true }); }
    if (focusedSort) Array.from(head.querySelectorAll<HTMLButtonElement>('[data-trace-sort]')).find((button) => button.dataset.traceSort === focusedSort)?.focus({ preventScroll: true });
    if (focusedResize) Array.from(head.querySelectorAll<HTMLElement>('[data-trace-resize]')).find((handle) => handle.dataset.traceResize === focusedResize)?.focus({ preventScroll: true });
    if (viewport) { viewport.scrollLeft = scrollLeft; viewport.scrollTop = scrollTop; }
  }
}

function isStale(item: LastFrameDto): boolean {
  return !!item.count && item.age !== undefined && item.expectedPeriodMs !== undefined && item.age * 1000 > item.expectedPeriodMs * STALE_PERIODS;
}
