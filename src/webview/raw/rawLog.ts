import type { FrameFilter } from '../../core/frame/frameStore';
import { parseCanId } from '../../core/frame/canId';
import type { Diagnostic } from '../../core/diagnostics/diagnostic';
import type { LogViewState, RawRowDto, ToExtensionMessage, ToWebviewMessage } from '../../extension/editors/rawLogProtocol';
import { autoFitColumns, fitColumnsToView, type SizingColumn } from '../shared/columnSizing';
import { SignalTableView } from '../table/signalTableView';
import { TimeSeriesView } from '../timeseries/timeSeriesView';
import { TrajectoryView } from '../trajectory/trajectoryView';
import { TimelineController } from '../shared/timelineController';
import { computeVirtualRange } from '../shared/virtualization';
import { t } from '../shared/i18n';

declare function acquireVsCodeApi(): { postMessage(message: ToExtensionMessage): void; getState(): unknown; setState(value: unknown): void };

const vscode = acquireVsCodeApi();
const app = document.getElementById('app')!;
const ROW_HEIGHT = 28;
const PAGE_SIZE = 240;
const columns: readonly SizingColumn<RawRowDto>[] = [
  { id: 'time', label: 'TIME(S)', minWidth: 92, maxWidth: 180, value: (row) => row.time.toFixed(6) },
  { id: 'direction', label: 'TX/RX', minWidth: 62, maxWidth: 90, value: (row) => row.direction },
  { id: 'canId', label: 'CAN ID', minWidth: 82, maxWidth: 150, value: (row) => row.canId },
  { id: 'name', label: 'NAME', minWidth: 90, maxWidth: 280, value: (row) => row.name },
  { id: 'channel', label: 'CH', minWidth: 48, maxWidth: 80, value: (row) => String(row.channel) },
  { id: 'dlc', label: 'DLC', minWidth: 52, maxWidth: 80, value: (row) => String(row.dlc) },
  { id: 'length', label: 'LENGTH', minWidth: 68, maxWidth: 100, value: (row) => String(row.length) },
  { id: 'content', label: 'CONTENT', minWidth: 180, maxWidth: 760, value: (row) => row.content },
];

interface SavedState { readonly widths?: Record<string, number>; }
const saved = (vscode.getState() ?? {}) as SavedState;
let widths: Record<string, number> = { time: 112, direction: 68, canId: 96, name: 130, channel: 52, dlc: 54, length: 74, content: 360, ...saved.widths };
let rows = new Map<number, RawRowDto>();
let total = 0;
let requestId = 0;
let latestPageRequestId = 0;
let lastRequested = '';
let parsing = true;
let filter: FrameFilter = {};
let latestDiagnostics: Diagnostic[] = [];
let parserDiagnosticTotal = 0;
const rowDiagnostics = new Map<string, Diagnostic>();
let tableView: SignalTableView | undefined;
let timeSeriesView: TimeSeriesView | undefined;
let trajectoryView: TrajectoryView | undefined;
let logViewState: LogViewState = {};
let saveTimer: number | undefined;

app.innerHTML = `
<style>
  *{box-sizing:border-box} body{padding:0;margin:0;color:var(--vscode-foreground);background:var(--vscode-editor-background);font-family:var(--vscode-font-family)}
  #app{height:100vh;display:flex;flex-direction:column;min-width:0}.tabs{display:flex;gap:2px;padding:5px 8px 0;border-bottom:1px solid var(--vscode-panel-border);flex:0 0 auto}.tab{border-bottom-left-radius:0;border-bottom-right-radius:0;border-bottom-color:transparent}.tab.active{background:var(--vscode-tab-activeBackground,var(--vscode-editor-background));color:var(--vscode-tab-activeForeground,var(--vscode-foreground));border-bottom-color:var(--vscode-focusBorder)}
  .view{flex:1;min-height:0;min-width:0;display:flex;flex-direction:column}.view[hidden]{display:none}.toolbar{display:flex;gap:8px;align-items:center;padding:8px;border-bottom:1px solid var(--vscode-panel-border);flex-wrap:wrap}
  input,select,button{font:inherit;color:inherit;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,transparent);padding:5px 8px;border-radius:3px}
  button{background:var(--vscode-button-secondaryBackground);cursor:pointer}button:hover{background:var(--vscode-button-secondaryHoverBackground)}button.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
  input:focus-visible,select:focus-visible,button:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:1px}.grow{flex:1;min-width:180px}.status{font-size:12px;color:var(--vscode-descriptionForeground);white-space:nowrap}
  .grid{position:relative;overflow:auto;flex:1;min-height:120px}.header{position:sticky;top:0;z-index:5;display:grid;background:var(--vscode-editor-background);border-bottom:1px solid var(--vscode-panel-border)}
  .head{position:relative;padding:7px 8px;font-size:11px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.resize{position:absolute;right:-3px;top:0;width:7px;height:100%;cursor:col-resize}
  .sizer{position:relative}.window{position:absolute;left:0;top:0}.row{display:grid;height:${ROW_HEIGHT}px;border-bottom:1px solid color-mix(in srgb,var(--vscode-panel-border) 45%,transparent);align-items:center}.row:hover{background:var(--vscode-list-hoverBackground)}
  .cell{padding:0 8px;font-family:var(--vscode-editor-font-family);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dir-Tx{color:var(--vscode-charts-blue)}.dir-Rx{color:var(--vscode-charts-green)}
  .tag{display:inline-block;padding:2px 6px;margin-right:5px;border-radius:9px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);font-family:var(--vscode-font-family);font-size:11px}.row-warning{box-shadow:inset 3px 0 var(--vscode-editorWarning-foreground)}
  .context-menu{position:fixed;z-index:20;padding:4px;background:var(--vscode-menu-background,var(--vscode-editor-background));border:1px solid var(--vscode-menu-border,var(--vscode-panel-border));box-shadow:0 4px 14px #0006}.context-menu button{display:block;width:100%;text-align:left;background:transparent;border:0}.context-menu button:hover{background:var(--vscode-menu-selectionBackground,var(--vscode-list-hoverBackground))}
  details{border-top:1px solid var(--vscode-panel-border);max-height:170px;overflow:auto;padding:5px 10px}summary{cursor:pointer}.diag{padding:4px 0;font-size:12px}.diag-warning{color:var(--vscode-editorWarning-foreground)}.diag-error{color:var(--vscode-editorError-foreground)}
  .signal-layout,.chart-layout{display:flex;flex:1;min-height:0;min-width:0}.signal-pane{width:250px;min-width:0;overflow:auto;border-right:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background,var(--vscode-editor-background))}.signal-main{display:flex;flex:1;min-width:0;min-height:0;flex-direction:column}.view-toolbar{display:flex;align-items:center;gap:7px;min-height:39px;padding:6px 8px;border-bottom:1px solid var(--vscode-panel-border)}.spacer{flex:1}.muted{color:var(--vscode-descriptionForeground);font-size:12px}
  .signal-selector{padding:8px;overflow-anchor:none}.signal-selector>input{width:100%}.selector-actions{display:flex;gap:5px;margin:7px 0}.selector-actions button{flex:1}.selector-group{margin-top:5px}.selector-group-head{display:grid;grid-template-columns:24px 20px minmax(0,1fr);align-items:center;min-height:28px;font-weight:600}.selector-group-head>span,.selector-signal>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.selector-expand{padding:1px;background:transparent;border:0}.remove-source{display:flex;width:22px;height:22px;padding:3px;align-items:center;justify-content:center;color:var(--vscode-descriptionForeground);background:transparent;border:0}.remove-source:hover{color:var(--vscode-errorForeground);background:var(--vscode-toolbar-hoverBackground)}.remove-source svg{width:16px;height:16px;fill:currentColor}.selector-signal{position:relative;display:grid;grid-template-columns:20px minmax(0,1fr) 22px 22px;align-items:center;min-height:27px;padding-left:24px;font-size:12px}.color-button{width:18px;height:18px;padding:0;border:1px solid var(--vscode-panel-border);border-radius:3px;cursor:pointer;box-shadow:inset 0 0 0 1px #0002}.color-button:hover{filter:brightness(1.12)}
  .color-popup{position:fixed;z-index:30;display:grid;grid-template-columns:repeat(4,24px);gap:5px;padding:7px;border:1px solid var(--vscode-panel-border);border-radius:5px;background:var(--vscode-editor-background);box-shadow:0 3px 12px #0006}.color-swatch{width:24px;height:24px;padding:0;border:2px solid transparent;border-radius:4px;box-shadow:inset 0 0 0 1px #0004;cursor:pointer}.color-swatch:hover{filter:brightness(1.15);border-color:var(--vscode-foreground)}.color-swatch.selected{border-color:var(--vscode-focusBorder);outline:1px solid var(--vscode-focusBorder);outline-offset:1px}
  .signal-grid{position:relative;overflow:auto;flex:1;min-height:120px}.signal-grid-header{position:sticky;top:0;z-index:7;display:grid;background:var(--vscode-editor-background);border-bottom:1px solid var(--vscode-panel-border)}.signal-head{position:relative;display:flex;flex-direction:column;justify-content:center;min-height:42px;padding:4px 8px;font-size:11px;font-weight:650;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.signal-head small{color:var(--vscode-descriptionForeground);font-weight:400}.signal-grid-sizer{position:relative}.signal-grid-window{position:absolute;left:0;top:0}.signal-grid-row{display:grid;height:${ROW_HEIGHT}px;border-bottom:1px solid color-mix(in srgb,var(--vscode-panel-border) 45%,transparent);align-items:center}.signal-grid-row:hover{background:var(--vscode-list-hoverBackground)}.signal-cell{height:${ROW_HEIGHT}px;padding:6px 8px;font-family:var(--vscode-editor-font-family);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sticky-time{position:sticky;left:0;z-index:3;background:var(--vscode-editor-background);border-right:1px solid var(--vscode-panel-border)}.signal-grid-row:hover .sticky-time{background:var(--vscode-list-hoverBackground)}
  .chart-layout{position:relative}.chart-pane{flex:0 0 auto}.pane-separator{width:5px;cursor:col-resize;background:transparent;border-right:1px solid var(--vscode-panel-border)}.pane-separator:hover{background:var(--vscode-focusBorder)}.chart-main{overflow:hidden}.segmented{display:flex}.segmented button{border-radius:0}.chart-legend{display:flex;gap:12px;flex-wrap:wrap;padding:5px 9px;font-size:12px}.chart-legend span{display:flex;align-items:center;gap:5px}.chart-legend i{width:12px;height:3px}.chart-canvas-wrap{position:relative;flex:1;min-height:300px;overflow:hidden}.chart-canvas-wrap canvas{display:block}.chart-tooltip{position:absolute;z-index:10;max-width:420px;padding:7px 9px;pointer-events:none;background:var(--vscode-editorHoverWidget-background,var(--vscode-editor-background));border:1px solid var(--vscode-editorHoverWidget-border,var(--vscode-panel-border));box-shadow:0 3px 10px #0006;font-size:12px}.chart-tooltip div{margin-top:3px}
  .trajectory-layout{display:flex;flex:1;min-height:0}.trajectory-pane{width:250px;flex:0 0 250px;overflow:auto;padding:10px;border-right:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background,var(--vscode-editor-background))}.trajectory-pane>input,.trajectory-pane>label,.trajectory-pane>button{display:block;width:100%;margin-bottom:10px}.trajectory-pane [hidden]{display:none}.trajectory-pane label{font-size:12px}.trajectory-pane label select,.trajectory-pane label input[type=number]{display:block;width:100%;margin-top:4px}.trajectory-checks{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin:4px 0 12px}.trajectory-checks label{white-space:nowrap}.trajectory-main{display:flex;flex:1;min-width:0;min-height:0;flex-direction:column}.trajectory-canvas-wrap{position:relative;flex:1;min-height:280px;overflow:hidden}.trajectory-canvas-wrap canvas{display:block}.trajectory-playback{display:flex;align-items:center;gap:7px;padding:7px 9px;border-top:1px solid var(--vscode-panel-border)}.trajectory-playback .play-seek{flex:1;min-width:100px}.trajectory-playback output{font-family:var(--vscode-editor-font-family);font-size:12px;text-align:center}
  .chart-source-actions{display:grid;gap:6px;padding:8px 8px 0}.chart-source-actions button{width:100%}
  .remove-source .codicon{font-size:16px}.external-import-host{padding:0 8px}.external-import-card{margin-top:6px;padding:8px;border:1px solid var(--vscode-panel-border);border-radius:4px;background:var(--vscode-sideBar-background,var(--vscode-editor-background));font-size:12px}.external-import-card>strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-bottom:7px}.external-field-label{display:block;margin:7px 0 3px;color:var(--vscode-descriptionForeground)}.external-import-card>select{width:100%}.external-columns-label{margin-top:9px}.external-column-list{max-height:170px;overflow:auto}.external-column-row{display:grid;grid-template-columns:minmax(0,1fr) 66px;gap:6px;align-items:center;padding:2px 0}.external-column-row label{display:flex;gap:5px;align-items:center;min-width:0;cursor:pointer}.external-column-row label span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.external-column-row input[type=text]{width:66px;min-width:0}.external-import-actions{display:flex;gap:6px;margin-top:8px}.external-import-actions button{flex:1}.external-import-actions button:disabled{opacity:.55;cursor:default}.external-import-note{margin:7px 0 0;line-height:1.3}
</style>
<nav class="tabs" aria-label="${t('Log views', 'ログ表示')}"><button class="tab active" data-view="raw-view">${t('Raw Log', 'RAWログ')}</button><button class="tab" data-view="table-view">${t('Table', 'テーブル')}</button><button class="tab" data-view="timeseries-view">${t('Time Series', '時系列')}</button><button class="tab" data-view="trajectory-view">${t('Trajectory', '軌跡')}</button></nav>
<section id="raw-view" class="view"><div class="toolbar">
  <input id="search" class="grow" type="search" placeholder="${t('Search CAN ID or payload bytes', 'CAN IDまたはデータを検索')}" aria-label="${t('Search raw log', 'RAWログを検索')}">
  <input id="can-id" size="10" placeholder="CAN ID" aria-label="${t('Filter by CAN ID', 'CAN IDで絞り込み')}">
  <select id="direction" aria-label="${t('Filter by direction', '送受信方向で絞り込み')}"><option value="">Rx + Tx</option><option>Rx</option><option>Tx</option></select>
  <select id="decoded" aria-label="${t('Filter by decode status', 'デコード状態で絞り込み')}"><option value="">${t('All frames', 'すべてのフレーム')}</option><option value="true">${t('Decoded', 'デコード済み')}</option><option value="false">${t('Raw only', 'RAWのみ')}</option></select>
  <input id="channel" type="number" min="0" size="4" placeholder="CH" aria-label="${t('Filter by channel', 'チャンネルで絞り込み')}">
  <input id="time-start" type="number" step="any" size="8" placeholder="${t('From (s)', '開始 (秒)')}" aria-label="${t('Filter start time', '開始時刻で絞り込み')}">
  <input id="time-end" type="number" step="any" size="8" placeholder="${t('To (s)', '終了 (秒)')}" aria-label="${t('Filter end time', '終了時刻で絞り込み')}">
  <button id="auto-fit" title="${t('Measure a bounded representative sample', '代表データから列幅を調整')}">${t('Auto Fit', '自動調整')}</button>
  <button id="fit-view">${t('Fit to View', '表示幅に合わせる')}</button>
  <button id="cancel">${t('Cancel parsing', '解析を中止')}</button>
  <span id="status" class="status">${t('Opening…', '読み込み中…')}</span>
</div>
<div id="grid" class="grid" role="table" aria-rowcount="0" aria-colcount="8"><div id="header" class="header" role="row"></div><div id="sizer" class="sizer"><div id="window" class="window"></div></div></div>
<details id="diagnostics"><summary>${t('Diagnostics', '診断')} (0)</summary><div id="diag-list"></div></details></section>
<section id="table-view" class="view" hidden></section><section id="timeseries-view" class="view" hidden></section><section id="trajectory-view" class="view" hidden></section><div id="context-menu" class="context-menu" hidden></div>`;

const grid = document.getElementById('grid')!;
const header = document.getElementById('header')!;
const sizer = document.getElementById('sizer')!;
const windowEl = document.getElementById('window')!;
const statusEl = document.getElementById('status')!;
const cancelButton = document.getElementById('cancel') as HTMLButtonElement;

function template(): string { return columns.map((column) => `${Math.round(widths[column.id])}px`).join(' '); }
function totalWidth(): number { return columns.reduce((sum, column) => sum + widths[column.id], 0); }
function persist(): void { vscode.setState({ widths }); }

function applyWidths(): void {
  const value = template();
  const full = `${totalWidth()}px`;
  header.style.gridTemplateColumns = value; header.style.width = full;
  sizer.style.width = full; windowEl.style.width = full;
  windowEl.querySelectorAll<HTMLElement>('.row').forEach((row) => { row.style.gridTemplateColumns = value; });
}

function buildHeader(): void {
  header.replaceChildren();
  columns.forEach((column) => {
    const cell = document.createElement('div'); cell.className = 'head'; cell.title = column.label; cell.textContent = column.label; cell.setAttribute('role', 'columnheader');
    const handle = document.createElement('span'); handle.className = 'resize'; handle.setAttribute('aria-hidden', 'true');
    handle.addEventListener('mousedown', (event) => {
      event.preventDefault(); const start = event.clientX; const initial = widths[column.id];
      const move = (next: MouseEvent) => { widths[column.id] = Math.max(column.minWidth, Math.min(column.maxWidth, initial + next.clientX - start)); applyWidths(); };
      const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); persist(); };
      window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    });
    handle.addEventListener('dblclick', () => requestAutoFit(column.id));
    cell.appendChild(handle); header.appendChild(cell);
  });
  applyWidths();
}

function displayValues(row: RawRowDto): readonly string[] {
  return [row.time.toFixed(6), row.direction, row.canId, row.name || '—', String(row.channel), String(row.dlc), String(row.length), row.content];
}

function draw(): void {
  grid.setAttribute('aria-rowcount', String(total)); sizer.style.height = `${total * ROW_HEIGHT}px`;
  const range = computeVirtualRange(total, grid.scrollTop, grid.clientHeight - header.clientHeight, ROW_HEIGHT);
  windowEl.style.transform = `translateY(${range.start * ROW_HEIGHT}px)`; windowEl.replaceChildren();
  for (let index = range.start; index < range.end; index++) {
    const row = rows.get(index); const rowEl = document.createElement('div'); rowEl.className = `row${row?.diagnostics.length ? ' row-warning' : ''}`; rowEl.style.gridTemplateColumns = template(); rowEl.setAttribute('role', 'row');
    const values = row ? displayValues(row) : ['', '', t('Loading…', '読み込み中…'), '', '', '', '', ''];
    values.forEach((value, columnIndex) => {
      const cell = document.createElement('div'); cell.className = `cell${columnIndex === 1 && row ? ` dir-${row.direction}` : ''}`; cell.title = columnIndex === 3 && row?.diagnostics.length ? `${value || 'Unnamed frame'} · ${row.diagnostics.map((item) => item.message).join(' · ')}` : value; cell.setAttribute('role', 'cell');
      if (columnIndex === 7 && row?.decoded) for (const tag of value.split('  ·  ')) { const chip = document.createElement('span'); chip.className = 'tag'; chip.textContent = tag; cell.appendChild(chip); }
      else cell.textContent = columnIndex === 3 && row?.diagnostics.length ? `⚠ ${value || '—'}` : value;
      rowEl.appendChild(cell);
    });
    if (row) {
      rowEl.addEventListener('dblclick', () => openOrRegister(row));
      rowEl.addEventListener('contextmenu', (event) => { event.preventDefault(); showContextMenu(row, event.clientX, event.clientY); });
    }
    windowEl.appendChild(rowEl);
  }
  requestRange(range.start, range.end);
}

function requestRange(start: number, end: number, force = false): void {
  const offset = Math.max(0, Math.floor(start / PAGE_SIZE) * PAGE_SIZE); const key = `${offset}:${JSON.stringify(filter)}`;
  if (!force && key === lastRequested && rows.has(start)) return;
  lastRequested = key;
  latestPageRequestId = ++requestId;
  vscode.postMessage({ type: 'pageRequest', requestId: latestPageRequestId, offset, limit: Math.max(PAGE_SIZE * 2, end - start), filter });
}

let filterTimer: number | undefined;
function updateFilter(): void {
  window.clearTimeout(filterTimer);
  filterTimer = window.setTimeout(() => {
    const search = (document.getElementById('search') as HTMLInputElement).value.trim();
    const idText = (document.getElementById('can-id') as HTMLInputElement).value.trim();
    const id = idText ? parseCanId(idText) : undefined;
    const direction = (document.getElementById('direction') as HTMLSelectElement).value as 'Rx' | 'Tx' | '';
    const decodedText = (document.getElementById('decoded') as HTMLSelectElement).value;
    const channelText = (document.getElementById('channel') as HTMLInputElement).value;
    const startText = (document.getElementById('time-start') as HTMLInputElement).value;
    const endText = (document.getElementById('time-end') as HTMLInputElement).value;
    const channel = channelText ? Number(channelText) : undefined;
    const timeStart = startText ? Number(startText) : undefined;
    const timeEnd = endText ? Number(endText) : undefined;
    filter = {
      ...(search ? { search } : {}), ...(id ? { canIdRefs: [id] } : {}), ...(direction ? { direction } : {}),
      ...(Number.isFinite(channel) ? { channel } : {}), ...(Number.isFinite(timeStart) ? { timeStart } : {}), ...(Number.isFinite(timeEnd) ? { timeEnd } : {}),
      ...(decodedText ? { decoded: decodedText === 'true' } : {}),
    };
    rows.clear(); total = 0; lastRequested = ''; grid.scrollTop = 0; requestRange(0, PAGE_SIZE, true); draw();
  }, 180);
}

function measure(text: string): number {
  const canvas = document.createElement('canvas'); const context = canvas.getContext('2d');
  if (!context) return text.length * 8;
  context.font = getComputedStyle(document.body).font; return context.measureText(text).width;
}

let autoFitTarget: string | undefined;
function requestAutoFit(target?: string): void { autoFitTarget = target; vscode.postMessage({ type: 'autoFitSampleRequest', requestId: ++requestId, filter }); }
function showDiagnostics(): void {
  document.querySelector('#diagnostics summary')!.textContent = `${t('Diagnostics', '診断')} (${parserDiagnosticTotal + rowDiagnostics.size})`;
  const list = document.getElementById('diag-list')!; list.replaceChildren();
  const combined = [...latestDiagnostics, ...rowDiagnostics.values()].slice(-200);
  for (const item of combined) { const line = document.createElement('div'); line.className = `diag diag-${item.severity}`; line.textContent = `${item.severity.toUpperCase()} ${item.code}${item.location?.line ? ` · line ${item.location.line}` : ''}: ${item.message}`; list.appendChild(line); }
}

function openOrRegister(row: RawRowDto): void {
  if (row.definitionId) vscode.postMessage({ type: 'openFrameDefinition', definitionId: row.definitionId });
  else vscode.postMessage({ type: 'registerFrame', canId: row.canIdValue, extended: row.extended, frameLength: row.length });
}

function showContextMenu(row: RawRowDto, x: number, y: number): void {
  const menu = document.getElementById('context-menu')!; menu.replaceChildren(); menu.hidden = false; menu.style.left = `${x}px`; menu.style.top = `${y}px`;
  const action = document.createElement('button'); action.textContent = row.definitionId ? t('Open Frame Definition', 'フレーム定義を開く') : t('Register CAN Frame', 'CANフレームを登録'); action.addEventListener('click', () => { menu.hidden = true; openOrRegister(row); }); menu.appendChild(action);
}

function saveLogViewState(partial: Partial<LogViewState>): void {
  logViewState = { ...logViewState, ...partial };
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => vscode.postMessage({ type: 'saveLogViewState', state: logViewState }), 180);
}

function initializeSignalViews(initial: LogViewState | undefined): void {
  if (tableView || timeSeriesView || trajectoryView) return;
  logViewState = initial ?? {};
  const timeline = new TimelineController();
  tableView = new SignalTableView(document.getElementById('table-view')!, logViewState, (message) => vscode.postMessage(message), saveLogViewState);
  timeSeriesView = new TimeSeriesView(document.getElementById('timeseries-view')!, logViewState, (message) => vscode.postMessage(message), saveLogViewState, timeline);
  trajectoryView = new TrajectoryView(document.getElementById('trajectory-view')!, logViewState, (message) => vscode.postMessage(message), saveLogViewState, timeline);
  activateView(document.querySelector<HTMLElement>('.tab.active')?.dataset.view ?? 'raw-view');
}

function activateView(id: string): void {
  document.querySelectorAll<HTMLElement>('.view').forEach((view) => { view.hidden = view.id !== id; });
  document.querySelectorAll<HTMLElement>('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.view === id));
  if (id === 'table-view') { timeSeriesView?.hide(); trajectoryView?.hide(); tableView?.show(); }
  else if (id === 'timeseries-view') { tableView?.hide(); trajectoryView?.hide(); timeSeriesView?.show(); }
  else if (id === 'trajectory-view') { tableView?.hide(); timeSeriesView?.hide(); trajectoryView?.show(); }
  else { tableView?.hide(); timeSeriesView?.hide(); trajectoryView?.hide(); if (id === 'raw-view') requestAnimationFrame(draw); }
}

window.addEventListener('message', (event: MessageEvent<ToWebviewMessage>) => {
  const message = event.data;
  tableView?.handle(message); timeSeriesView?.handle(message); trajectoryView?.handle(message);
  if (message.type === 'init') { initializeSignalViews(message.viewState); parsing = message.parsing; cancelButton.hidden = !parsing; statusEl.textContent = parsing ? `${message.fileName} · ${t('parsing', '解析中')} ${message.frames.toLocaleString()} ${t('frames', 'フレーム')}` : `${message.frames.toLocaleString()} ${t('frames', 'フレーム')} · ${message.diagnostics} ${t('diagnostics', '件の診断')}`; requestRange(0, PAGE_SIZE, true); }
  else if (message.type === 'page') {
    if (message.requestId !== latestPageRequestId) return;
    total = message.total;
    for (let i = 0; i < message.rows.length; i++) {
      const row = message.rows[i]; rows.set(message.offset + i, row);
      for (const item of row.diagnostics) rowDiagnostics.set(`${row.id}:${item.code}`, { id: `${row.id}:${item.code}`, source: 'definition', code: item.code, severity: 'warning', message: item.message, location: { sourceId: row.id, frameId: row.id } });
      while (rowDiagnostics.size > 2000) {
        const oldest = rowDiagnostics.keys().next().value as string | undefined;
        if (!oldest) break;
        rowDiagnostics.delete(oldest);
      }
    }
    if (rows.size > PAGE_SIZE * 6) {
      const center = Math.floor(grid.scrollTop / ROW_HEIGHT);
      for (const index of rows.keys()) if (Math.abs(index - center) > PAGE_SIZE * 3) rows.delete(index);
    }
    draw();
    showDiagnostics();
  }
  else if (message.type === 'progress') { parsing = true; cancelButton.hidden = false; const percent = message.totalBytes ? Math.floor(message.bytesRead / message.totalBytes * 100) : 0; statusEl.textContent = `${t('Parsing', '解析中')} ${percent}% · ${message.frames.toLocaleString()} ${t('frames', 'フレーム')}`; requestRange(Math.floor(grid.scrollTop / ROW_HEIGHT), Math.floor(grid.scrollTop / ROW_HEIGHT) + PAGE_SIZE, true); }
  else if (message.type === 'parseComplete') { parsing = false; cancelButton.hidden = true; statusEl.textContent = `${message.frames.toLocaleString()} ${t('frames', 'フレーム')}${message.cancelled ? ` · ${t('cancelled', '中止')}` : ''} · ${message.diagnostics} ${t('diagnostics', '件の診断')}`; requestRange(0, PAGE_SIZE, true); }
  else if (message.type === 'diagnostics') {
    parserDiagnosticTotal = message.total;
    latestDiagnostics.push(...message.diagnostics);
    if (latestDiagnostics.length > 200) latestDiagnostics = latestDiagnostics.slice(-200);
    showDiagnostics();
  }
  else if (message.type === 'autoFitSample') { const fitted = autoFitColumns(columns, message.rows, measure); widths = autoFitTarget ? { ...widths, [autoFitTarget]: fitted[autoFitTarget] } : { ...widths, ...fitted }; autoFitTarget = undefined; applyWidths(); persist(); }
  else if (message.type === 'definitionsChanged') { rows.clear(); rowDiagnostics.clear(); showDiagnostics(); lastRequested = ''; requestRange(Math.floor(grid.scrollTop / ROW_HEIGHT), Math.floor(grid.scrollTop / ROW_HEIGHT) + PAGE_SIZE, true); }
});

grid.addEventListener('scroll', () => requestAnimationFrame(draw));
window.addEventListener('resize', () => requestAnimationFrame(draw));
document.getElementById('search')!.addEventListener('input', updateFilter);
document.getElementById('can-id')!.addEventListener('input', updateFilter);
document.getElementById('direction')!.addEventListener('change', updateFilter);
document.getElementById('decoded')!.addEventListener('change', updateFilter);
document.getElementById('channel')!.addEventListener('input', updateFilter);
document.getElementById('time-start')!.addEventListener('input', updateFilter);
document.getElementById('time-end')!.addEventListener('input', updateFilter);
document.getElementById('auto-fit')!.addEventListener('click', () => requestAutoFit());
document.getElementById('fit-view')!.addEventListener('click', () => { widths = { ...widths, ...fitColumnsToView(columns, widths, grid.clientWidth) }; applyWidths(); persist(); });
cancelButton.addEventListener('click', () => { vscode.postMessage({ type: 'cancelParsing' }); cancelButton.disabled = true; statusEl.textContent = t('Cancelling…', '中止しています…'); });
document.addEventListener('click', () => { (document.getElementById('context-menu') as HTMLElement).hidden = true; });
document.querySelectorAll<HTMLElement>('.tab').forEach((tab) => tab.addEventListener('click', () => activateView(tab.dataset.view ?? 'raw-view')));

buildHeader(); draw(); vscode.postMessage({ type: 'ready' });
