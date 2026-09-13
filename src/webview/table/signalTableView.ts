import type { SignalDefinition } from '../../core/signal/signal';
import type { LogViewState, SignalTableRowDto, ToExtensionMessage, ToWebviewMessage } from '../../extension/editors/rawLogProtocol';
import { autoFitColumns, fitColumnsToView, type SizingColumn } from '../shared/columnSizing';
import { SignalSelector } from '../shared/signalSelector';
import { computeVirtualRange } from '../shared/virtualization';
import { t } from '../shared/i18n';
import { addSelectionRange, removeSelectionIndex, selectionContains, selectionCount, type SelectionRange } from '../raw/selectionRanges';

const ROW_HEIGHT = 28;
const PAGE_SIZE = 240;

export class SignalTableView {
  private readonly selected: Set<string>;
  private readonly columnOrder: string[];
  private readonly widths: Record<string, number>;
  private readonly definitions = new Map<string, SignalDefinition>();
  private readonly selector: SignalSelector;
  private readonly rows = new Map<number, SignalTableRowDto>();
  private total = 0;
  private counter = 100_000;
  private latestPageRequest = 0;
  private latestSampleRequest = 0;
  private autoFitTargets: ReadonlySet<string> | undefined;
  private readonly fittedWidths: Set<string>;
  private catalogRequested = false;
  private latestCatalogRequest = 0;
  private visible = false;
  private readonly grid: HTMLElement;
  private readonly header: HTMLElement;
  private readonly sizer: HTMLElement;
  private readonly rowWindow: HTMLElement;
  private readonly exportButton: HTMLButtonElement;
  private readonly status: HTMLElement;
  private readonly selectionStatus: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly pane: HTMLElement;
  private readonly separator: HTMLElement;
  private readonly contextMenu: HTMLElement;
  private readonly analysisCancel: HTMLButtonElement;
  private paneWidth: number;
  private paneCollapsed: boolean;
  private pagePending = false;
  private parsing = false;
  private analysisProgress: { processed: number; total: number } | undefined;
  private selectionRanges: SelectionRange[] = [];
  private selectionAnchor: number | undefined;
  private focusedIndex: number | undefined;
  private copyFeedbackTimer: number | undefined;
  private rowDrag: { anchor: number; base: SelectionRange[]; startX: number; startY: number; clientY: number; moved: boolean; frame?: number } | undefined;
  private ignoreRowClick = false;

  constructor(
    private readonly host: HTMLElement,
    initial: LogViewState | undefined,
    private readonly post: (message: ToExtensionMessage) => void,
    private readonly save: (partial: Partial<LogViewState>) => void
  ) {
    this.selected = new Set(initial?.tableSelectedIds ?? []);
    this.columnOrder = [...(initial?.tableColumnOrder ?? initial?.tableSelectedIds ?? [])];
    this.widths = { time: 118, ...(initial?.tableWidths ?? {}) };
    this.fittedWidths = new Set(Object.keys(initial?.tableWidths ?? {}));
    this.paneWidth = Math.max(180, Math.min(440, initial?.tablePaneWidth ?? 250)); this.paneCollapsed = initial?.tablePaneCollapsed ?? false;
    host.innerHTML = `<div class="signal-layout"><aside class="signal-pane table-pane"><div class="table-selector"></div></aside><div class="pane-separator table-pane-separator"></div><section class="signal-main"><div class="view-toolbar"><button class="table-pane-toggle">${t('Signals', 'Signal')}</button><button class="table-export">${t('Export CSV…', 'CSVへ出力…')}</button><span class="spacer"></span><span class="table-selection-status status selection-status" hidden></span><span class="table-status muted">${t('Select Signals', 'Signalを選択')}</span><button class="table-analysis-cancel" hidden>${t('Cancel analysis', '解析を中止')}</button></div><div class="signal-grid" role="table" aria-multiselectable="true" tabindex="0"><div class="signal-grid-header" role="row"></div><div class="signal-grid-sizer"><div class="signal-grid-window"></div></div><div class="table-empty raw-empty" hidden><span></span></div></div></section></div><div class="context-menu table-context-menu" hidden></div>`;
    this.grid = host.querySelector('.signal-grid')!; this.header = host.querySelector('.signal-grid-header')!; this.sizer = host.querySelector('.signal-grid-sizer')!; this.rowWindow = host.querySelector('.signal-grid-window')!;
    this.exportButton = host.querySelector('.table-export')!; this.status = host.querySelector('.table-status')!; this.selectionStatus = host.querySelector('.table-selection-status')!; this.empty = host.querySelector('.table-empty')!; this.pane = host.querySelector('.table-pane')!; this.separator = host.querySelector('.table-pane-separator')!; this.contextMenu = host.querySelector('.table-context-menu')!; this.analysisCancel = host.querySelector('.table-analysis-cancel')!;
    this.selector = new SignalSelector({ host: host.querySelector('.table-selector')!, selected: this.selected, onSelectionChange: () => this.selectionChanged() });
    this.grid.addEventListener('scroll', () => requestAnimationFrame(() => this.draw()));
    window.addEventListener('resize', () => { if (this.visible) { this.applyWidths(); this.draw(); } });
    this.exportButton.addEventListener('click', () => this.post({ type: 'exportSignalCsv', selectedIds: this.columnOrder.filter((id) => this.selected.has(id)) }));
    host.querySelector('.table-pane-toggle')!.addEventListener('click', () => { this.paneCollapsed = !this.paneCollapsed; this.applyPane(); this.persist(); });
    this.analysisCancel.addEventListener('click', () => this.post({ type: 'cancelAnalysis' }));
    this.separator.addEventListener('mousedown', (event) => this.startPaneResize(event));
    document.addEventListener('click', () => { this.contextMenu.hidden = true; });
    document.addEventListener('copy', (event) => this.copyEvent(event));
    document.addEventListener('keydown', (event) => this.keyDown(event));
    this.applyPane(); this.syncColumnOrder(); this.updatePresentation();
    this.updateActions();
  }

  show(): void { this.visible = true; if (!this.catalogRequested) { this.catalogRequested = true; this.latestCatalogRequest = ++this.counter; this.post({ type: 'signalCatalogRequest', requestId: this.latestCatalogRequest, view: 'table' }); } this.applyPane(); this.draw(); }
  hide(): void { this.visible = false; this.contextMenu.hidden = true; }

  handle(message: ToWebviewMessage): void {
    if (message.type === 'signalCatalog' && message.requestId === this.latestCatalogRequest) {
      this.definitions.clear(); for (const definition of message.definitions) this.definitions.set(definition.id, definition);
      let selectionChanged = false; for (const id of [...this.selected]) if (!this.definitions.has(id)) { this.selected.delete(id); selectionChanged = true; }
      this.syncColumnOrder(); this.selector.setCatalog(message.definitions, message.groups); this.buildHeader(); this.updateActions(); this.pagePending = this.selected.size > 0; this.requestPage(true); this.requestMissingWidths(); this.updatePresentation();
      if (selectionChanged) this.persist();
    } else if (message.type === 'signalTablePage' && message.requestId === this.latestPageRequest) {
      this.pagePending = false; this.total = message.total; for (let index = 0; index < message.rows.length; index++) this.rows.set(message.offset + index, message.rows[index]);
      this.pruneRows(); this.draw();
    } else if (message.type === 'signalTableSample' && message.requestId === this.latestSampleRequest) {
      const columns = this.sizingColumns(); const fitted = autoFitColumns(columns, message.rows, measureText);
      if (this.autoFitTargets) for (const id of this.autoFitTargets) { if (fitted[id] !== undefined) { this.widths[id] = fitted[id]; this.fittedWidths.add(id); } }
      else { Object.assign(this.widths, fitted); for (const id of Object.keys(fitted)) this.fittedWidths.add(id); }
      this.autoFitTargets = undefined; this.persistWidths(); this.applyWidths();
    } else if (message.type === 'definitionsChanged') {
      this.catalogRequested = false; this.rows.clear(); this.rowWindow.replaceChildren(); this.total = 0; this.pagePending = this.selected.size > 0; this.clearSelection(); if (this.visible) this.show();
    } else if (message.type === 'progress') {
      this.parsing = true; if (this.visible && this.selected.size) this.requestPage(true, Math.floor(this.grid.scrollTop / ROW_HEIGHT)); this.updatePresentation();
    } else if (message.type === 'parseComplete') {
      this.parsing = false; if (this.visible && this.selected.size) this.requestPage(true, Math.floor(this.grid.scrollTop / ROW_HEIGHT)); this.updatePresentation();
    } else if (message.type === 'analysisProgress') {
      this.analysisProgress = { processed: message.processed, total: message.total }; this.analysisCancel.hidden = false; this.updatePresentation();
    } else if (message.type === 'analysisComplete') {
      this.analysisProgress = undefined; this.analysisCancel.hidden = true; if (this.visible && this.selected.size) this.requestPage(true, Math.floor(this.grid.scrollTop / ROW_HEIGHT)); else this.updatePresentation();
    } else if (message.type === 'signalTableRowsCopied') {
      this.showCopyFeedback(message.count);
    }
  }

  private selectionChanged(): void {
    this.syncColumnOrder(); this.rows.clear(); this.rowWindow.replaceChildren(); this.total = 0; this.pagePending = this.selected.size > 0; this.grid.scrollTop = 0; this.clearSelection(); this.buildHeader(); this.draw(); this.requestPage(true); this.requestMissingWidths();
    this.updateActions(); this.persist();
  }

  private updateActions(): void { this.exportButton.disabled = this.selected.size === 0; }

  private columns(): readonly { id: string; definition?: SignalDefinition }[] {
    return [{ id: 'time' }, ...this.columnOrder.map((id) => ({ id, definition: this.definitions.get(id) })).filter((item): item is { id: string; definition: SignalDefinition } => this.selected.has(item.id) && Boolean(item.definition))];
  }

  private syncColumnOrder(): void { const seen = new Set<string>(); const next: string[] = []; for (const id of [...this.columnOrder, ...this.selected]) if (this.selected.has(id) && !seen.has(id)) { seen.add(id); next.push(id); } this.columnOrder.splice(0, this.columnOrder.length, ...next); }

  private sizingColumns(): readonly SizingColumn<SignalTableRowDto>[] {
    return this.columns().map((column) => column.id === 'time'
      ? { id: 'time', label: 'TIME(S)', minWidth: 96, maxWidth: 180, value: (row) => formatNumber(row.timestamp, 6) }
      : { id: column.id, label: `${column.definition!.name}${column.definition!.unit ? ` (${column.definition!.unit})` : ''}`, minWidth: 90, maxWidth: 320, flex: 1, value: (row) => row.values[column.id] === undefined ? '' : formatNumber(row.values[column.id]) });
  }

  private buildHeader(): void {
    this.header.replaceChildren(); this.header.style.gridTemplateColumns = this.template(); this.header.style.width = `${this.totalWidth()}px`;
    for (const column of this.columns()) {
      const cell = document.createElement('div'); cell.className = `signal-head${column.id === 'time' ? ' sticky-time' : ''}`; cell.setAttribute('role', 'columnheader');
      if (column.id === 'time') cell.textContent = 'TIME(S)';
      else {
        const name = document.createElement('span'); name.textContent = column.definition!.name; name.className = 'signal-column-drag'; name.draggable = true; name.title = t('Drag to reorder this column', 'ドラッグして列を並べ替え');
        name.addEventListener('dragstart', (event) => { event.dataTransfer?.setData('text/plain', column.id); if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'; cell.classList.add('dragging'); });
        name.addEventListener('dragend', () => { this.header.querySelectorAll('.dragging,.drag-target').forEach((item) => item.classList.remove('dragging', 'drag-target')); });
        const unit = document.createElement('small'); unit.textContent = column.definition!.unit ?? ''; cell.append(name, unit);
        cell.addEventListener('dragover', (event) => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'; cell.classList.add('drag-target'); });
        cell.addEventListener('dragleave', () => cell.classList.remove('drag-target'));
        cell.addEventListener('drop', (event) => { event.preventDefault(); cell.classList.remove('drag-target'); const source = event.dataTransfer?.getData('text/plain'); if (source) this.moveColumn(source, column.id, event.clientX > cell.getBoundingClientRect().left + cell.clientWidth / 2); });
      }
      const handle = document.createElement('span'); handle.className = 'resize'; handle.title = t('Drag to resize · Double-click to fit content', 'ドラッグで幅変更・ダブルクリックで内容に合わせる'); handle.addEventListener('mousedown', (event) => this.startResize(event, column.id)); handle.addEventListener('dblclick', () => this.requestSample(new Set([column.id]))); cell.appendChild(handle); this.header.appendChild(cell);
    }
    this.applyWidths();
  }

  private draw(): void {
    if (!this.visible) return;
    this.grid.setAttribute('aria-rowcount', String(this.total)); this.grid.setAttribute('aria-colcount', String(this.columns().length)); this.updatePresentation();
    this.sizer.style.height = `${this.total * ROW_HEIGHT}px`; this.sizer.style.width = `${this.totalWidth()}px`;
    const range = computeVirtualRange(this.total, this.grid.scrollTop, this.grid.clientHeight - this.header.clientHeight, ROW_HEIGHT);
    this.rowWindow.style.transform = `translateY(${range.start * ROW_HEIGHT}px)`; this.rowWindow.style.width = `${this.totalWidth()}px`; this.rowWindow.replaceChildren();
    const columns = this.columns();
    for (let index = range.start; index < range.end; index++) {
      const data = this.rows.get(index); const selected = selectionContains(this.selectionRanges, index); const row = document.createElement('div'); row.className = `signal-grid-row${selected ? ' selected' : ''}`; row.style.gridTemplateColumns = this.template(); row.dataset.rowIndex = String(index); row.setAttribute('role', 'row'); row.setAttribute('aria-selected', String(selected)); row.tabIndex = this.focusedIndex === index ? 0 : -1;
      columns.forEach((column) => { const cell = document.createElement('div'); cell.className = `signal-cell${column.id === 'time' ? ' sticky-time' : ''}`; const value = !data ? t('Loading…', '読み込み中…') : column.id === 'time' ? formatNumber(data.timestamp, 6) : data.values[column.id] === undefined ? '—' : formatNumber(data.values[column.id]); cell.textContent = value; cell.title = value; cell.setAttribute('role', 'cell'); row.appendChild(cell); });
      if (data) {
        row.addEventListener('mousedown', (event) => this.beginRowDrag(index, event));
        row.addEventListener('click', (event) => { if (this.ignoreRowClick) { event.preventDefault(); return; } this.selectRow(index, event); row.focus({ preventScroll: true }); });
        row.addEventListener('contextmenu', (event) => { event.preventDefault(); if (!selectionContains(this.selectionRanges, index)) { this.selectionRanges = [{ start: index, end: index }]; this.selectionAnchor = index; this.focusedIndex = index; this.refreshSelectionStyles(); } this.showContextMenu(event.clientX, event.clientY); });
      }
      this.rowWindow.appendChild(row);
    }
    this.requestPage(false, range.start, range.end);
  }

  private requestPage(force = false, start = 0, end = PAGE_SIZE): void {
    if (!this.selected.size) { this.rows.clear(); this.total = 0; this.pagePending = false; this.updatePresentation(); return; }
    const offset = Math.max(0, Math.floor(start / PAGE_SIZE) * PAGE_SIZE);
    if (!force && this.rows.has(start) && this.rows.has(Math.min(Math.max(0, end - 1), this.total - 1))) return;
    if (force && this.total === 0) { this.pagePending = true; this.updatePresentation(); }
    this.latestPageRequest = ++this.counter; this.post({ type: 'signalTablePageRequest', requestId: this.latestPageRequest, selectedIds: this.columnOrder.filter((id) => this.selected.has(id)), offset, limit: PAGE_SIZE * 2 });
  }

  private updatePresentation(): void {
    const count = selectionCount(this.selectionRanges); this.selectionStatus.hidden = count === 0;
    if (count) this.selectionStatus.textContent = `${count.toLocaleString()} ${t(count === 1 ? 'row selected' : 'rows selected', '行選択')}`;
    if (!this.selected.size) this.status.textContent = t('Select Signals', 'Signalを選択');
    else if (this.analysisProgress) { const percent = this.analysisProgress.total ? Math.floor(this.analysisProgress.processed / this.analysisProgress.total * 100) : 100; this.status.textContent = `${t('Analyzing', '解析中')} ${percent}%`; }
    else if (this.parsing) this.status.textContent = `${this.total.toLocaleString()} ${t('event rows', 'イベント行')} · ${t('importing', '読込中')}`;
    else if (this.pagePending && this.total === 0) this.status.textContent = t('Loading events…', 'イベントを読み込み中…');
    else this.status.textContent = `${this.total.toLocaleString()} ${t('event rows', 'イベント行')}`;
    const text = this.empty.querySelector('span')!;
    if (!this.selected.size) text.textContent = t('Select one or more Signals to build the event table.', 'Signalを選択するとイベントテーブルを表示します。');
    else if (this.analysisProgress) text.textContent = t('Analyzing Signal events…', 'Signalイベントを解析しています…');
    else if (this.parsing || (this.pagePending && this.total === 0)) text.textContent = t('Loading Signal events…', 'Signalイベントを読み込んでいます…');
    else text.textContent = t('No events were found for the selected Signals.', '選択したSignalのイベントはありません。');
    this.empty.hidden = this.total > 0;
  }

  private clearSelection(): void { this.selectionRanges = []; this.selectionAnchor = undefined; this.focusedIndex = undefined; this.updatePresentation(); }

  private refreshSelectionStyles(): void {
    this.rowWindow.querySelectorAll<HTMLElement>('.signal-grid-row[data-row-index]').forEach((row) => { const selected = selectionContains(this.selectionRanges, Number(row.dataset.rowIndex)); row.classList.toggle('selected', selected); row.setAttribute('aria-selected', String(selected)); });
    this.updatePresentation();
  }

  private selectRow(index: number, event: MouseEvent): void {
    if (event.shiftKey && this.selectionAnchor !== undefined) {
      if (!event.metaKey && !event.ctrlKey) this.selectionRanges = [];
      this.selectionRanges = addSelectionRange(this.selectionRanges, this.selectionAnchor, index);
    } else if (event.metaKey || event.ctrlKey) {
      this.selectionRanges = selectionContains(this.selectionRanges, index) ? removeSelectionIndex(this.selectionRanges, index) : addSelectionRange(this.selectionRanges, index); this.selectionAnchor = index;
    } else { this.selectionRanges = [{ start: index, end: index }]; this.selectionAnchor = index; }
    this.focusedIndex = index; this.refreshSelectionStyles();
  }

  private rowIndexAt(clientY: number): number { const bounds = this.grid.getBoundingClientRect(); return Math.max(0, Math.min(this.total - 1, Math.floor((this.grid.scrollTop + clientY - bounds.top - this.header.offsetHeight) / ROW_HEIGHT))); }

  private updateRowDrag(): void {
    if (!this.rowDrag?.moved || this.total < 1) return; const index = this.rowIndexAt(this.rowDrag.clientY);
    this.selectionRanges = addSelectionRange(this.rowDrag.base, this.rowDrag.anchor, index); this.focusedIndex = index; this.refreshSelectionStyles();
  }

  private continueRowDrag(): void {
    if (!this.rowDrag?.moved) return; const bounds = this.grid.getBoundingClientRect(); const top = bounds.top + this.header.offsetHeight;
    const overflow = this.rowDrag.clientY < top ? this.rowDrag.clientY - top : this.rowDrag.clientY > bounds.bottom ? this.rowDrag.clientY - bounds.bottom : 0;
    if (overflow) { this.grid.scrollTop += Math.sign(overflow) * Math.min(20, Math.max(4, Math.abs(overflow) * .35)); this.updateRowDrag(); }
    this.rowDrag.frame = requestAnimationFrame(() => this.continueRowDrag());
  }

  private beginRowDrag(index: number, event: MouseEvent): void {
    if (event.button !== 0) return; const anchor = event.shiftKey && this.selectionAnchor !== undefined ? this.selectionAnchor : index; const base = event.metaKey || event.ctrlKey ? [...this.selectionRanges] : [];
    this.rowDrag = { anchor, base, startX: event.clientX, startY: event.clientY, clientY: event.clientY, moved: false };
    const move = (next: MouseEvent) => {
      if (!this.rowDrag) return; this.rowDrag.clientY = next.clientY;
      if (!this.rowDrag.moved && Math.hypot(next.clientX - this.rowDrag.startX, next.clientY - this.rowDrag.startY) < 4) return;
      next.preventDefault(); if (!this.rowDrag.moved) { this.rowDrag.moved = true; this.selectionAnchor = anchor; this.grid.classList.add('drag-selecting'); this.rowDrag.frame = requestAnimationFrame(() => this.continueRowDrag()); } this.updateRowDrag();
    };
    const up = () => {
      const completed = this.rowDrag; if (completed?.frame !== undefined) cancelAnimationFrame(completed.frame); this.rowDrag = undefined; this.grid.classList.remove('drag-selecting'); window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up);
      if (completed?.moved) { this.ignoreRowClick = true; window.setTimeout(() => { this.ignoreRowClick = false; }, 0); this.rowWindow.querySelector<HTMLElement>(`.signal-grid-row[data-row-index="${this.focusedIndex}"]`)?.focus({ preventScroll: true }); }
    };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  }

  private selectedInOrder(): readonly SignalTableRowDto[] | undefined {
    if (selectionCount(this.selectionRanges) > this.rows.size) return undefined; const result: SignalTableRowDto[] = [];
    for (const range of this.selectionRanges) for (let index = range.start; index <= range.end; index++) { const row = this.rows.get(index); if (!row) return undefined; result.push(row); } return result;
  }

  private rowValues(row: SignalTableRowDto): readonly string[] { return [formatNumber(row.timestamp, 6), ...this.columnOrder.filter((id) => this.selected.has(id)).map((id) => row.values[id] === undefined ? '' : formatNumber(row.values[id]))]; }
  private selectedRowsAsText(rows: readonly SignalTableRowDto[]): string { return `${rows.map((row) => this.rowValues(row).map(cleanCell).join('\t')).join('\r\n')}\r\n`; }
  private selectedRowsAsHtml(rows: readonly SignalTableRowDto[]): string { const table = document.createElement('table'); const body = document.createElement('tbody'); table.appendChild(body); for (const row of rows) { const tr = document.createElement('tr'); for (const value of this.rowValues(row)) { const td = document.createElement('td'); td.textContent = value; tr.appendChild(td); } body.appendChild(tr); } return table.outerHTML; }
  private requestSelectedRows(action: 'copy' | 'open'): void { if (this.selectionRanges.length) this.post({ type: 'signalTableRowsRequest', action, ranges: this.selectionRanges, selectedIds: this.columnOrder.filter((id) => this.selected.has(id)) }); }
  private copySelectedRows(): void { if (this.selectionRanges.length && !document.execCommand('copy')) this.requestSelectedRows('copy'); }

  private copyEvent(event: ClipboardEvent): void {
    const active = document.activeElement as HTMLElement | null; const editing = active?.matches('input,select,textarea,[contenteditable=true]') ?? false;
    if (!this.visible || !this.selectionRanges.length || editing || !event.clipboardData || event.defaultPrevented) return; event.preventDefault(); const selected = this.selectedInOrder();
    if (selected) { event.clipboardData.setData('text/plain', this.selectedRowsAsText(selected)); event.clipboardData.setData('text/html', this.selectedRowsAsHtml(selected)); this.showCopyFeedback(selected.length); } else this.requestSelectedRows('copy');
  }

  private showCopyFeedback(count: number): void { window.clearTimeout(this.copyFeedbackTimer); this.selectionStatus.hidden = false; this.selectionStatus.textContent = `${count.toLocaleString()} ${t(count === 1 ? 'row copied' : 'rows copied', '行コピーしました')}`; this.copyFeedbackTimer = window.setTimeout(() => this.updatePresentation(), 1400); }

  private showContextMenu(x: number, y: number, focus = false): void {
    this.contextMenu.replaceChildren(); this.contextMenu.hidden = false; this.contextMenu.style.left = `${x}px`; this.contextMenu.style.top = `${y}px`; const count = selectionCount(this.selectionRanges);
    const action = (label: string, run: () => void) => { const button = document.createElement('button'); button.textContent = label; button.addEventListener('click', () => { this.contextMenu.hidden = true; run(); }); this.contextMenu.appendChild(button); };
    action(count === 1 ? t('Copy Row', '行をコピー') : t(`Copy ${count} Rows`, `${count}行をコピー`), () => this.copySelectedRows());
    action(count === 1 ? t('Open Row in Text Editor', '行をテキストエディタで開く') : t(`Open ${count} Rows in Text Editor`, `${count}行をテキストエディタで開く`), () => this.requestSelectedRows('open'));
    requestAnimationFrame(() => { const bounds = this.contextMenu.getBoundingClientRect(); this.contextMenu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - bounds.width - 4))}px`; this.contextMenu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - bounds.height - 4))}px`; if (focus) this.contextMenu.querySelector<HTMLButtonElement>('button')?.focus(); });
  }

  private keyDown(event: KeyboardEvent): void {
    if (!this.visible) return; const target = event.target as HTMLElement | null; const editing = target?.matches('input,select,textarea,[contenteditable=true]') ?? false;
    if (event.key === 'Escape' && !this.contextMenu.hidden) { event.preventDefault(); this.contextMenu.hidden = true; this.rowWindow.querySelector<HTMLElement>(`.signal-grid-row[data-row-index="${this.focusedIndex}"]`)?.focus(); }
    else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c' && this.selectionRanges.length && !editing) { event.preventDefault(); this.copySelectedRows(); }
    else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a' && (this.focusedIndex !== undefined || target === this.grid) && !editing) { event.preventDefault(); this.selectionRanges = this.total ? [{ start: 0, end: this.total - 1 }] : []; this.selectionAnchor = 0; this.focusedIndex = this.total ? 0 : undefined; this.refreshSelectionStyles(); }
    else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && (this.focusedIndex !== undefined || target === this.grid) && !editing) { event.preventDefault(); const start = this.focusedIndex ?? (event.key === 'ArrowDown' ? -1 : this.total); this.moveRowFocus(start + (event.key === 'ArrowDown' ? 1 : -1), event.shiftKey); }
    else if (event.shiftKey && event.key === 'F10' && this.focusedIndex !== undefined && !editing) { const row = this.rowWindow.querySelector<HTMLElement>(`.signal-grid-row[data-row-index="${this.focusedIndex}"]`); if (row) { event.preventDefault(); const bounds = row.getBoundingClientRect(); this.showContextMenu(bounds.left + 24, bounds.top + ROW_HEIGHT, true); } }
    else if (event.key === 'Escape' && this.selectionRanges.length && !editing) { event.preventDefault(); this.clearSelection(); this.refreshSelectionStyles(); }
  }

  private moveRowFocus(nextIndex: number, extend: boolean): void {
    if (this.total < 1) return; const next = Math.max(0, Math.min(this.total - 1, nextIndex));
    if (extend) { if (this.selectionAnchor === undefined) this.selectionAnchor = this.focusedIndex ?? next; this.selectionRanges = [{ start: Math.min(this.selectionAnchor, next), end: Math.max(this.selectionAnchor, next) }]; }
    else { this.selectionRanges = [{ start: next, end: next }]; this.selectionAnchor = next; }
    this.focusedIndex = next; const top = this.grid.scrollTop; const bottom = top + this.grid.clientHeight - this.header.clientHeight; const rowTop = next * ROW_HEIGHT; const rowBottom = rowTop + ROW_HEIGHT;
    if (rowTop < top) this.grid.scrollTop = rowTop; else if (rowBottom > bottom) this.grid.scrollTop = rowBottom - this.grid.clientHeight + this.header.clientHeight;
    this.requestPage(false, next, next + PAGE_SIZE); this.draw(); requestAnimationFrame(() => this.rowWindow.querySelector<HTMLElement>(`.signal-grid-row[data-row-index="${next}"]`)?.focus({ preventScroll: true }));
  }

  private moveColumn(source: string, target: string, after: boolean): void {
    if (source === target || !this.selected.has(source) || !this.selected.has(target)) return; const next = this.columnOrder.filter((id) => id !== source); const targetIndex = next.indexOf(target); next.splice(targetIndex + (after ? 1 : 0), 0, source); this.columnOrder.splice(0, this.columnOrder.length, ...next); this.buildHeader(); this.draw(); this.persist();
  }

  private applyPane(): void { const toggle = this.host.querySelector('.table-pane-toggle')!; toggle.setAttribute('aria-expanded', String(!this.paneCollapsed)); toggle.setAttribute('title', this.paneCollapsed ? t('Show Signal selection', 'Signal選択を表示') : t('Hide Signal selection', 'Signal選択を隠す')); this.pane.hidden = this.paneCollapsed; this.separator.hidden = this.paneCollapsed; this.pane.style.width = `${this.paneWidth}px`; this.pane.style.flex = `0 0 ${this.paneWidth}px`; requestAnimationFrame(() => { if (this.visible) { this.applyWidths(); this.draw(); } }); }
  private startPaneResize(event: MouseEvent): void { event.preventDefault(); const start = event.clientX; const initial = this.paneWidth; const move = (next: MouseEvent) => { this.paneWidth = Math.max(180, Math.min(440, initial + next.clientX - start)); this.applyPane(); }; const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); this.persist(); }; window.addEventListener('mousemove', move); window.addEventListener('mouseup', up); }

  private requestSample(targets?: ReadonlySet<string>): void { if (!this.selected.size) return; this.autoFitTargets = targets; this.latestSampleRequest = ++this.counter; this.post({ type: 'signalTableSampleRequest', requestId: this.latestSampleRequest, selectedIds: this.columnOrder.filter((id) => this.selected.has(id)) }); }
  private requestMissingWidths(): void { const missing = new Set(this.columns().map((column) => column.id).filter((id) => !this.fittedWidths.has(id))); if (missing.size) this.requestSample(missing); }
  private displayWidths(): Readonly<Record<string, number>> { return fitColumnsToView(this.sizingColumns(), this.widths, this.grid.clientWidth); }
  private template(): string { const visible = this.displayWidths(); return this.columns().map((column) => `${Math.round(visible[column.id])}px`).join(' '); }
  private totalWidth(): number { const visible = this.displayWidths(); return this.columns().reduce((sum, column) => sum + visible[column.id], 0); }
  private applyWidths(): void { const value = this.template(); const width = `${this.totalWidth()}px`; this.header.style.gridTemplateColumns = value; this.header.style.width = width; this.sizer.style.width = width; this.rowWindow.style.width = width; this.rowWindow.querySelectorAll<HTMLElement>('.signal-grid-row').forEach((row) => row.style.gridTemplateColumns = value); }
  private startResize(event: MouseEvent, id: string): void { event.preventDefault(); const start = event.clientX; const displayed = this.displayWidths(); Object.assign(this.widths, displayed); const initial = displayed[id]; const column = this.sizingColumns().find((item) => item.id === id)!; const move = (next: MouseEvent) => { this.widths[id] = Math.max(column.minWidth, Math.min(column.maxWidth, initial + next.clientX - start)); this.applyWidths(); }; const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); for (const visible of this.columns()) this.fittedWidths.add(visible.id); this.persistWidths(); }; window.addEventListener('mousemove', move); window.addEventListener('mouseup', up); }
  private persist(): void { this.save({ tableSelectedIds: [...this.selected], tableColumnOrder: [...this.columnOrder], tableWidths: { ...this.widths }, tablePaneWidth: this.paneWidth, tablePaneCollapsed: this.paneCollapsed }); }
  private persistWidths(): void { this.persist(); }
  private pruneRows(): void { if (this.rows.size <= PAGE_SIZE * 6) return; const center = Math.floor(this.grid.scrollTop / ROW_HEIGHT); for (const index of this.rows.keys()) if (Math.abs(index - center) > PAGE_SIZE * 3) this.rows.delete(index); }
}

function formatNumber(value: number, digits = 9): string { if (!Number.isFinite(value)) return '—'; if (Number.isInteger(value)) return String(value); return Number(value.toPrecision(digits)).toString(); }
function cleanCell(value: string): string { return value.replace(/[\t\r\n]+/g, ' '); }
function measureText(text: string): number { const canvas = document.createElement('canvas'); const context = canvas.getContext('2d'); if (!context) return text.length * 8; context.font = getComputedStyle(document.body).font; return context.measureText(text).width; }
