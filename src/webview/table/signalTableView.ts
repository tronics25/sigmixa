import type { SignalDefinition } from '../../core/signal/signal';
import type { LogViewState, SignalTableRowDto, ToExtensionMessage, ToWebviewMessage } from '../../extension/editors/rawLogProtocol';
import { autoFitColumns, fitColumnsToView, type SizingColumn } from '../shared/columnSizing';
import { SignalSelector } from '../shared/signalSelector';
import { computeVirtualRange } from '../shared/virtualization';

const ROW_HEIGHT = 28;
const PAGE_SIZE = 240;

export class SignalTableView {
  private readonly selected: Set<string>;
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

  constructor(
    private readonly host: HTMLElement,
    initial: LogViewState | undefined,
    private readonly post: (message: ToExtensionMessage) => void,
    private readonly save: (partial: Partial<LogViewState>) => void
  ) {
    this.selected = new Set(initial?.tableSelectedIds ?? []);
    this.widths = { time: 118, ...(initial?.tableWidths ?? {}) };
    this.fittedWidths = new Set(Object.keys(initial?.tableWidths ?? {}));
    host.innerHTML = `<div class="signal-layout"><aside class="signal-pane"><div class="table-selector"></div></aside><section class="signal-main"><div class="view-toolbar"><button class="table-auto-fit">Auto Fit</button><button class="table-fit-view">Fit to View</button><button class="table-export">Export CSV</button><span class="spacer"></span><span class="table-status muted">Select Signals</span></div><div class="signal-grid" role="table"><div class="signal-grid-header" role="row"></div><div class="signal-grid-sizer"><div class="signal-grid-window"></div></div></div></section></div>`;
    this.grid = host.querySelector('.signal-grid')!; this.header = host.querySelector('.signal-grid-header')!; this.sizer = host.querySelector('.signal-grid-sizer')!; this.rowWindow = host.querySelector('.signal-grid-window')!;
    this.selector = new SignalSelector({ host: host.querySelector('.table-selector')!, selected: this.selected, onSelectionChange: () => this.selectionChanged() });
    this.grid.addEventListener('scroll', () => requestAnimationFrame(() => this.draw()));
    host.querySelector('.table-auto-fit')!.addEventListener('click', () => this.requestSample());
    host.querySelector('.table-fit-view')!.addEventListener('click', () => this.fitView());
    host.querySelector('.table-export')!.addEventListener('click', () => this.post({ type: 'exportSignalCsv', selectedIds: [...this.selected] }));
  }

  show(): void { this.visible = true; if (!this.catalogRequested) { this.catalogRequested = true; this.latestCatalogRequest = ++this.counter; this.post({ type: 'signalCatalogRequest', requestId: this.latestCatalogRequest, view: 'table' }); } this.draw(); }
  hide(): void { this.visible = false; }

  handle(message: ToWebviewMessage): void {
    if (message.type === 'signalCatalog' && message.requestId === this.latestCatalogRequest) {
      this.definitions.clear(); for (const definition of message.definitions) this.definitions.set(definition.id, definition);
      for (const id of [...this.selected]) if (!this.definitions.has(id)) this.selected.delete(id);
      this.selector.setCatalog(message.definitions, message.groups); this.buildHeader(); this.requestPage(true); this.requestMissingWidths();
    } else if (message.type === 'signalTablePage' && message.requestId === this.latestPageRequest) {
      this.total = message.total; for (let index = 0; index < message.rows.length; index++) this.rows.set(message.offset + index, message.rows[index]);
      this.pruneRows(); this.draw();
    } else if (message.type === 'signalTableSample' && message.requestId === this.latestSampleRequest) {
      const columns = this.sizingColumns(); const fitted = autoFitColumns(columns, message.rows, measureText);
      if (this.autoFitTargets) for (const id of this.autoFitTargets) { if (fitted[id] !== undefined) { this.widths[id] = fitted[id]; this.fittedWidths.add(id); } }
      else { Object.assign(this.widths, fitted); for (const id of Object.keys(fitted)) this.fittedWidths.add(id); }
      this.autoFitTargets = undefined; this.persistWidths(); this.applyWidths();
    } else if (message.type === 'analysisComplete' || message.type === 'definitionsChanged') {
      this.catalogRequested = false; this.rows.clear(); this.total = 0; if (this.visible) this.show();
    } else if ((message.type === 'progress' || message.type === 'parseComplete') && this.visible && this.selected.size) {
      this.requestPage(true, Math.floor(this.grid.scrollTop / ROW_HEIGHT));
    }
  }

  private selectionChanged(): void {
    this.rows.clear(); this.total = 0; this.buildHeader(); this.requestPage(true); this.requestMissingWidths();
    this.save({ tableSelectedIds: [...this.selected], tableWidths: this.widths });
  }

  private columns(): readonly { id: string; definition?: SignalDefinition }[] {
    return [{ id: 'time' }, ...[...this.selected].map((id) => ({ id, definition: this.definitions.get(id) })).filter((item): item is { id: string; definition: SignalDefinition } => Boolean(item.definition))];
  }

  private sizingColumns(): readonly SizingColumn<SignalTableRowDto>[] {
    return this.columns().map((column) => column.id === 'time'
      ? { id: 'time', label: 'TIME(S)', minWidth: 96, maxWidth: 180, value: (row) => formatNumber(row.timestamp, 6) }
      : { id: column.id, label: `${column.definition!.name}${column.definition!.unit ? ` (${column.definition!.unit})` : ''}`, minWidth: 90, maxWidth: 320, value: (row) => row.values[column.id] === undefined ? '' : formatNumber(row.values[column.id]) });
  }

  private buildHeader(): void {
    this.header.replaceChildren(); this.header.style.gridTemplateColumns = this.template(); this.header.style.width = `${this.totalWidth()}px`;
    for (const column of this.columns()) {
      const cell = document.createElement('div'); cell.className = `signal-head${column.id === 'time' ? ' sticky-time' : ''}`;
      if (column.id === 'time') cell.textContent = 'TIME(S)';
      else { const name = document.createElement('span'); name.textContent = column.definition!.name; const unit = document.createElement('small'); unit.textContent = column.definition!.unit ?? ''; cell.append(name, unit); }
      const handle = document.createElement('span'); handle.className = 'resize'; handle.addEventListener('mousedown', (event) => this.startResize(event, column.id)); handle.addEventListener('dblclick', () => this.requestSample(new Set([column.id]))); cell.appendChild(handle); this.header.appendChild(cell);
    }
    this.applyWidths();
  }

  private draw(): void {
    if (!this.visible) return;
    const status = this.host.querySelector('.table-status')!; status.textContent = this.selected.size ? `${this.total.toLocaleString()} event rows` : 'Select Signals';
    this.sizer.style.height = `${this.total * ROW_HEIGHT}px`; this.sizer.style.width = `${this.totalWidth()}px`;
    const range = computeVirtualRange(this.total, this.grid.scrollTop, this.grid.clientHeight - this.header.clientHeight, ROW_HEIGHT);
    this.rowWindow.style.transform = `translateY(${range.start * ROW_HEIGHT}px)`; this.rowWindow.style.width = `${this.totalWidth()}px`; this.rowWindow.replaceChildren();
    const columns = this.columns();
    for (let index = range.start; index < range.end; index++) {
      const data = this.rows.get(index); const row = document.createElement('div'); row.className = 'signal-grid-row'; row.style.gridTemplateColumns = this.template();
      columns.forEach((column) => { const cell = document.createElement('div'); cell.className = `signal-cell${column.id === 'time' ? ' sticky-time' : ''}`; const value = !data ? 'Loading…' : column.id === 'time' ? formatNumber(data.timestamp, 6) : data.values[column.id] === undefined ? '—' : formatNumber(data.values[column.id]); cell.textContent = value; cell.title = value; row.appendChild(cell); });
      this.rowWindow.appendChild(row);
    }
    this.requestPage(false, range.start, range.end);
  }

  private requestPage(force = false, start = 0, end = PAGE_SIZE): void {
    if (!this.selected.size) { this.rows.clear(); this.total = 0; return; }
    const offset = Math.max(0, Math.floor(start / PAGE_SIZE) * PAGE_SIZE);
    if (!force && this.rows.has(start) && this.rows.has(Math.min(Math.max(0, end - 1), this.total - 1))) return;
    this.latestPageRequest = ++this.counter; this.post({ type: 'signalTablePageRequest', requestId: this.latestPageRequest, selectedIds: [...this.selected], offset, limit: PAGE_SIZE * 2 });
  }

  private requestSample(targets?: ReadonlySet<string>): void { if (!this.selected.size) return; this.autoFitTargets = targets; this.latestSampleRequest = ++this.counter; this.post({ type: 'signalTableSampleRequest', requestId: this.latestSampleRequest, selectedIds: [...this.selected] }); }
  private requestMissingWidths(): void { const missing = new Set(this.columns().map((column) => column.id).filter((id) => !this.fittedWidths.has(id))); if (missing.size) this.requestSample(missing); }
  private template(): string { return this.columns().map((column) => `${Math.round(this.widths[column.id] ?? (column.id === 'time' ? 118 : 140))}px`).join(' '); }
  private totalWidth(): number { return this.columns().reduce((sum, column) => sum + (this.widths[column.id] ?? (column.id === 'time' ? 118 : 140)), 0); }
  private applyWidths(): void { const value = this.template(); const width = `${this.totalWidth()}px`; this.header.style.gridTemplateColumns = value; this.header.style.width = width; this.sizer.style.width = width; this.rowWindow.style.width = width; this.rowWindow.querySelectorAll<HTMLElement>('.signal-grid-row').forEach((row) => row.style.gridTemplateColumns = value); }
  private startResize(event: MouseEvent, id: string): void { event.preventDefault(); const start = event.clientX; const initial = this.widths[id] ?? (id === 'time' ? 118 : 140); const column = this.sizingColumns().find((item) => item.id === id)!; const move = (next: MouseEvent) => { this.widths[id] = Math.max(column.minWidth, Math.min(column.maxWidth, initial + next.clientX - start)); this.applyWidths(); }; const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); this.fittedWidths.add(id); this.persistWidths(); }; window.addEventListener('mousemove', move); window.addEventListener('mouseup', up); }
  private fitView(): void { Object.assign(this.widths, fitColumnsToView(this.sizingColumns(), this.widths, this.grid.clientWidth)); for (const column of this.columns()) this.fittedWidths.add(column.id); this.persistWidths(); this.applyWidths(); }
  private persistWidths(): void { this.save({ tableSelectedIds: [...this.selected], tableWidths: { ...this.widths } }); }
  private pruneRows(): void { if (this.rows.size <= PAGE_SIZE * 6) return; const center = Math.floor(this.grid.scrollTop / ROW_HEIGHT); for (const index of this.rows.keys()) if (Math.abs(index - center) > PAGE_SIZE * 3) this.rows.delete(index); }
}

function formatNumber(value: number, digits = 9): string { if (!Number.isFinite(value)) return '—'; if (Number.isInteger(value)) return String(value); return Number(value.toPrecision(digits)).toString(); }
function measureText(text: string): number { const canvas = document.createElement('canvas'); const context = canvas.getContext('2d'); if (!context) return text.length * 8; context.font = getComputedStyle(document.body).font; return context.measureText(text).width; }
