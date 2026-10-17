import type { SignalDefinition } from '../../core/signal/signal';
import type { ReportTable } from '../../extension/report/reportData';
import { reportCellLabel } from '../../extension/report/reportTableCells';
import { t } from '../shared/i18n';

const ROW = 28;
const format = (value: number) => Number(value.toPrecision(10)).toString();

export const REPORT_TABLE_STYLES = `
.report-table{display:flex;flex-direction:column;flex:1;min-height:0}
.report-table .view-toolbar{flex:0 0 auto}
.report-table input[type=search]{flex:0 1 280px;min-width:140px}
.report-table-scroll{flex:1;min-height:0;overflow:auto;position:relative}
.report-table table{border-collapse:separate;border-spacing:0;font-size:var(--sm-font-small);font-variant-numeric:tabular-nums}
.report-table th,.report-table td{height:${ROW}px;padding:0 var(--sm-space-md);white-space:nowrap;border-bottom:1px solid color-mix(in srgb,var(--vscode-panel-border) 70%,transparent);text-align:right}
.report-table th{position:sticky;top:0;z-index:2;background:var(--vscode-editorGroupHeader-tabsBackground);font-weight:var(--sm-weight-semibold);cursor:pointer;user-select:none}
.report-table th small{display:block;font-weight:var(--sm-weight-regular);color:var(--vscode-descriptionForeground);font-size:var(--sm-font-caption);line-height:1}
.report-table th:first-child,.report-table td:first-child{position:sticky;left:0;z-index:1;background:var(--vscode-editor-background);text-align:right}.report-table th:first-child{text-align:left}
.report-table th:first-child{z-index:3;background:var(--vscode-editorGroupHeader-tabsBackground)}
.report-table th:hover{color:var(--vscode-textLink-foreground)}
.report-table tr:hover td{background:var(--vscode-list-hoverBackground)}
.report-table td.empty{color:var(--vscode-descriptionForeground)}
.report-table th.no-data{color:var(--vscode-descriptionForeground);font-weight:var(--sm-weight-regular);font-style:italic}
.report-table .spacer-row td{height:auto;padding:0;border:0}
`;

/** Read-only Signal table: search by Signal name, sort by any column, virtual scrolling for large exports. */
export function renderReportTable(host: HTMLElement, table: ReportTable, definitions: readonly SignalDefinition[]): void {
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  const empty = new Set(table.emptySignalIds ?? []);
  let query = ''; let sortColumn = -1; let descending = false; let order: number[] = table.timestamps.map((_, index) => index);
  host.classList.add('report-table');
  host.innerHTML = `<div class="view-toolbar"><input type="search" placeholder="${t('Search Signals…', 'シグナルを検索…')}" aria-label="${t('Search Signals', 'シグナルを検索')}"><span class="muted"></span><span class="spacer"></span><span class="muted">${t('Click a heading to sort', '見出しをクリックで並べ替え')}</span></div><div class="report-table-scroll"><table><thead></thead><tbody></tbody></table></div>`;
  const scroll = host.querySelector<HTMLElement>('.report-table-scroll')!; const head = host.querySelector('thead')!; const body = host.querySelector('tbody')!; const status = host.querySelector('.view-toolbar .muted')!;
  const columns = () => table.signalIds.map((id, index) => ({ id, index })).filter(({ id }) => { const definition = byId.get(id); return !query || `${definition?.name ?? id} ${definition?.unit ?? ''}`.toLowerCase().includes(query); });
  const cell = (column: number, row: number): string => {
    const value = table.values[column]?.[row]; if (value === null || value === undefined) return '—';
    const label = reportCellLabel(table, column, row); return label ? `${format(value)} (${label})` : format(value);
  };
  const sort = () => {
    order = table.timestamps.map((_, index) => index);
    if (sortColumn >= 0) { const values = table.values[sortColumn]; order.sort((a, b) => { const x = values[a]; const y = values[b]; if (x === null) return y === null ? a - b : 1; if (y === null) return -1; return (descending ? y - x : x - y) || a - b; }); }
    else if (descending) order.reverse();
  };
  const renderHead = () => {
    const row = document.createElement('tr');
    const time = document.createElement('th'); time.textContent = 'TIME'; time.appendChild(Object.assign(document.createElement('small'), { textContent: 's' }));
    time.setAttribute('aria-sort', sortColumn === -1 ? (descending ? 'descending' : 'ascending') : 'none'); time.addEventListener('click', () => { descending = sortColumn === -1 ? !descending : false; sortColumn = -1; sort(); renderHead(); renderBody(); });
    row.appendChild(time);
    for (const { id, index } of columns()) {
      const definition = byId.get(id); const th = document.createElement('th'); th.textContent = definition?.name ?? id;
      // Selected or drawn, but without data in this log: the column stays, marked, so that missing data is seen as missing.
      if (empty.has(id)) { th.classList.add('no-data'); th.title = t('Not in this log', 'このログにはありません'); }
      th.appendChild(Object.assign(document.createElement('small'), { textContent: definition?.unit || ' ' }));
      th.setAttribute('aria-sort', sortColumn === index ? (descending ? 'descending' : 'ascending') : 'none');
      th.addEventListener('click', () => { descending = sortColumn === index ? !descending : false; sortColumn = index; sort(); renderHead(); renderBody(); });
      row.appendChild(th);
    }
    head.replaceChildren(row);
  };
  const renderBody = () => {
    const visible = columns(); const first = Math.max(0, Math.floor(scroll.scrollTop / ROW) - 10); const count = Math.ceil(scroll.clientHeight / ROW) + 20; const last = Math.min(order.length, first + count);
    const spacer = (height: number) => { const row = document.createElement('tr'); row.className = 'spacer-row'; const td = document.createElement('td'); td.colSpan = visible.length + 1; td.style.height = `${height}px`; row.appendChild(td); return row; };
    const rows: HTMLElement[] = [spacer(first * ROW)];
    for (let position = first; position < last; position++) {
      const index = order[position]; const row = document.createElement('tr');
      const time = document.createElement('td'); time.textContent = table.timestamps[index].toFixed(6); row.appendChild(time);
      for (const column of visible) { const td = document.createElement('td'); const text = cell(column.index, index); td.textContent = text; if (text === '—') td.className = 'empty'; row.appendChild(td); }
      rows.push(row);
    }
    rows.push(spacer((order.length - last) * ROW)); body.replaceChildren(...rows);
    status.textContent = table.totalRows > table.timestamps.length ? t(`${table.timestamps.length.toLocaleString()} of ${table.totalRows.toLocaleString()} rows (thinned)`, `${table.totalRows.toLocaleString()} 行中 ${table.timestamps.length.toLocaleString()} 行（間引き）`) : t(`${table.timestamps.length.toLocaleString()} rows`, `${table.timestamps.length.toLocaleString()} 行`);
  };
  host.querySelector<HTMLInputElement>('input[type=search]')!.addEventListener('input', (event) => { query = (event.target as HTMLInputElement).value.trim().toLowerCase(); renderHead(); renderBody(); });
  let frame = 0; scroll.addEventListener('scroll', () => { if (frame) return; frame = requestAnimationFrame(() => { frame = 0; renderBody(); }); });
  new ResizeObserver(() => renderBody()).observe(scroll);
  renderHead(); renderBody();
}
