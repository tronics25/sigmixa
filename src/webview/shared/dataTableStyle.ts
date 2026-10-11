/** Shared density and labels for RAW, decoded Signal tables, and Trace. */
export const DATA_TABLE_ROW_HEIGHT = 28;
export const FRAME_TABLE_LABELS = { canId: 'CAN ID', name: 'NAME', channel: 'CH', direction: 'TX/RX', content: 'CONTENT', multiplexer: 'MUX' } as const;
/** Visual rules shared by read-only grids and editable definition/plugin tables. */
export const TABLE_BASE_STYLES = `
:root{--table-active-wash:color-mix(in srgb,var(--vscode-list-activeSelectionBackground) 12%,transparent);--table-active-edge:color-mix(in srgb,var(--vscode-focusBorder) 38%,transparent);--table-surface:var(--vscode-editor-background);--table-heading:color-mix(in srgb,var(--vscode-foreground) 5%,var(--table-surface));--table-rule:color-mix(in srgb,var(--vscode-panel-border) 45%,transparent);--table-hover:color-mix(in srgb,var(--vscode-list-hoverBackground,var(--vscode-foreground)) 35%,var(--table-surface));--table-selected:color-mix(in srgb,var(--vscode-list-activeSelectionBackground,var(--vscode-focusBorder)) 22%,var(--table-surface));--table-fixed-shadow:1px 0 var(--vscode-panel-border),5px 0 6px -5px var(--vscode-widget-shadow,#0006)}
.header,.signal-grid-header,.signal-header,.derived-header,.data-table thead{font-family:var(--vscode-font-family);background:var(--table-heading);border-bottom:1px solid var(--vscode-panel-border)}
.head,.signal-head,.data-table th{font-family:var(--vscode-font-family);font-size:var(--sm-font-caption);font-weight:var(--sm-weight-semibold);line-height:16px;padding:var(--sm-space-sm) var(--sm-space-md);letter-spacing:.025em;color:var(--vscode-foreground)}
.head,.signal-head{z-index:0}
.cell,.signal-cell,.data-table td{font-family:var(--vscode-editor-font-family);font-size:var(--sm-font-small);line-height:18px;font-variant-numeric:tabular-nums}
.data-table{border-collapse:separate;border-spacing:0;background:var(--table-surface)}
.table-scroll{overflow:auto;border:1px solid var(--vscode-panel-border);border-radius:var(--sm-radius-md)}
.data-table th,.data-table td{box-sizing:border-box;text-align:left;white-space:nowrap;border-right:0;border-bottom:1px solid var(--table-rule)}
.data-table th{background:var(--table-heading);border-bottom-color:var(--vscode-panel-border)}
.data-table td{height:${DATA_TABLE_ROW_HEIGHT}px;padding:var(--sm-space-xs) var(--sm-space-md)}
.data-table td.table-name{font-family:var(--vscode-font-family);font-weight:var(--sm-weight-medium)}
.data-table td.table-number{text-align:right}
.data-table .table-select{width:32px;text-align:center}
.data-table tbody>tr:hover{background:var(--table-hover)}
.data-table tbody>tr[aria-selected=true]{background:var(--table-selected)}
.data-table input[type=checkbox]{width:13px;height:13px;margin:0;vertical-align:middle;accent-color:var(--vscode-focusBorder)}
.resize{right:0;width:7px;z-index:10;touch-action:none;user-select:none}
.resize::after{content:"";position:absolute;right:0;top:4px;bottom:4px;width:1px;background:var(--vscode-panel-border);opacity:0}
.head:hover>.resize::after,.signal-head:hover>.resize::after,.data-table th:hover>.resize::after{opacity:1}
.resize:hover::after,.resize:active::after{width:2px;background:var(--vscode-focusBorder);opacity:1}
`;
/** Editors share the same typography; controls need a 26px hit area plus cell padding. */
export const EDITABLE_TABLE_STYLES = `${TABLE_BASE_STYLES}
.signal-row,.derived-row{border-bottom:1px solid var(--table-rule)}
.signal-row:hover,.derived-row:hover,.signal-row.is-hovered,.derived-row.is-hovered{background:var(--table-hover)}
.signal-row.is-selected,.derived-row.is-selected{background:var(--table-selected)}
/* The row being edited is marked exactly like a selected RAW log row: the same wash and the same soft top/bottom edges, drawn above the cells. */
.signal-row.is-editing::after,.derived-row.is-editing::after{content:"";position:absolute;inset:0;z-index:1;pointer-events:none;background:var(--table-active-wash);box-shadow:inset 0 1px var(--table-active-edge),inset 0 -1px var(--table-active-edge)}
.table-wrap .cell,.data-table td{padding:var(--sm-space-xs) var(--sm-space-md)}
.table-wrap .cell input,.table-wrap .cell select,.data-table td input:not([type=checkbox]),.data-table td select{height:26px;padding:var(--sm-space-xs) var(--sm-space-xs);font-size:var(--sm-font-small);line-height:18px;font-family:var(--vscode-editor-font-family)}
.table-wrap .cell input,.table-wrap .cell select,.data-table td input:not([type=checkbox]),.data-table td select{background:transparent;border-color:transparent}
.table-wrap .cell input:hover,.table-wrap .cell select:hover,.data-table td input:not([type=checkbox]):hover,.data-table td select:hover{background:var(--vscode-input-background);border-color:var(--vscode-panel-border)}
.table-wrap .cell input:focus,.table-wrap .cell select:focus,.data-table td input:focus,.data-table td select:focus{background:var(--vscode-input-background);border-color:var(--vscode-focusBorder);outline:0}
.table-wrap .lookup-table input.is-point-active{border-color:var(--vscode-focusBorder)}
.table-wrap .definition-summary{min-height:26px;line-height:26px;font-size:var(--sm-font-small)}
.signal-row>.cell:first-child input,.derived-row>.cell:first-child input{font-family:var(--vscode-font-family);font-weight:var(--sm-weight-medium)}
.data-table td.actions{padding:0 var(--sm-space-xs)}
.definition-subtable.data-table{display:table;table-layout:fixed;width:100%;max-width:none;border:1px solid var(--vscode-panel-border);border-radius:var(--sm-radius-md);overflow:hidden}
.definition-subtable .actions{width:32px;text-align:center}
.definition-subtable td input{width:100%;min-width:0}
.data-table td.table-number input,.table-wrap .cell input[type=number],.table-wrap .resolution input{text-align:right}
.definition-subtable td.table-name input{font-family:var(--vscode-font-family)}
/* Column titles are left-aligned in every table; only the cell values keep their own alignment. */
.data-table th,.head,.signal-head{text-align:left}
`;
export const DATA_TABLE_STYLES = `${TABLE_BASE_STYLES}
.last-value-table{background:var(--vscode-editor-background)}
.header,.signal-grid-header,.last-values thead{font-family:var(--vscode-font-family);background:var(--table-heading)}
.head,.signal-head,.last-values th{font-size:var(--sm-font-caption);font-weight:var(--sm-weight-semibold);line-height:16px;padding:var(--sm-space-sm) var(--sm-space-md);letter-spacing:.025em;color:var(--vscode-foreground)}
.cell,.signal-cell,.last-values td{font-family:var(--vscode-editor-font-family);font-size:var(--sm-font-small);line-height:18px;font-variant-numeric:tabular-nums}
.row,.signal-grid-row{align-items:stretch;--table-row-surface:var(--table-surface);background:var(--table-row-surface)}
.row:hover,.signal-grid-row:hover{--table-row-surface:var(--table-hover);background:var(--table-row-surface)}
.row.selected,.signal-grid-row.selected{--table-row-surface:var(--table-selected);background:var(--table-row-surface)}
.row:not(.selected):hover::before,.signal-grid-row:not(.selected):hover::before{content:none}
.row.selected::after,.signal-grid-row.selected::after{background:transparent}
.cell,.signal-cell{height:100%;min-width:0;padding:var(--sm-space-xs) var(--sm-space-md)}
.content-line{padding:0}
.row .sticky-col,.row:hover .sticky-col,.row.selected .sticky-col,.signal-grid-row .sticky-time,.signal-grid-row:hover .sticky-time,.signal-grid-row.selected .sticky-time{background:var(--table-row-surface)}
.head.sticky-col,.last-values th,.last-values th.trace-fixed{background:var(--table-heading)}
.sticky-edge,.sticky-time,.last-values .trace-fixed-edge{box-shadow:var(--table-fixed-shadow)}
.sticky-time{border-right:0}
.last-values tbody>tr{--table-row-surface:var(--table-surface)}
.last-values tbody>tr:hover{--table-row-surface:var(--table-hover)}
.last-values td,.last-values td.trace-fixed{background:var(--table-row-surface)}.last-values tbody tr.selected{--table-row-surface:var(--table-selected)}.drag-selecting .last-values tbody tr[data-trace-key],.last-values.drag-selecting tbody tr[data-trace-key]{cursor:ns-resize}
.last-values tbody tr[data-trace-key]{user-select:none;-webkit-user-select:none}
.last-values tbody tr[data-trace-key]:not(.selected):hover>td{background-image:linear-gradient(color-mix(in srgb,var(--vscode-list-hoverBackground) 42%,transparent),color-mix(in srgb,var(--vscode-list-hoverBackground) 42%,transparent))}
/* Table rows cannot carry positioned pseudo-elements (they become extra cells), so the RAW Log selection frame is drawn on the cells. */
.last-values tbody tr[data-trace-key].selected>td{background-image:linear-gradient(color-mix(in srgb,var(--vscode-list-activeSelectionBackground) 12%,transparent),color-mix(in srgb,var(--vscode-list-activeSelectionBackground) 12%,transparent));box-shadow:inset 0 1px color-mix(in srgb,var(--vscode-focusBorder) 38%,transparent),inset 0 -1px color-mix(in srgb,var(--vscode-focusBorder) 38%,transparent)}
.last-values tbody tr[data-trace-key].selected>td.trace-fixed-edge{box-shadow:var(--table-fixed-shadow),inset 0 1px color-mix(in srgb,var(--vscode-focusBorder) 38%,transparent),inset 0 -1px color-mix(in srgb,var(--vscode-focusBorder) 38%,transparent)}
.last-values tbody tr[data-trace-key].selected>td:first-child{box-shadow:inset 2px 0 var(--vscode-focusBorder),inset 0 1px color-mix(in srgb,var(--vscode-focusBorder) 38%,transparent),inset 0 -1px color-mix(in srgb,var(--vscode-focusBorder) 38%,transparent)}
.last-values td{height:${DATA_TABLE_ROW_HEIGHT}px;padding:var(--sm-space-xs) var(--sm-space-md);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row,.signal-grid-row,.last-values td{border-bottom:1px solid color-mix(in srgb,var(--vscode-panel-border) 45%,transparent)}
.header,.signal-grid-header,.last-values th{border-bottom:1px solid var(--vscode-panel-border)}
.last-values th{position:sticky;overflow:visible}.last-values .trace-sort{overflow:hidden}.trace-sort>span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.last-values td.trace-name>div{width:auto;overflow:hidden;text-overflow:ellipsis}.last-values td.trace-values{min-width:0}.trace-signals{width:max-content}
.last-values .trace-sort-indicator{width:12px;min-width:12px;flex-basis:12px;font-size:var(--sm-font-small)}
.last-values tr.trace-pinned-end>td{border-bottom:2px solid var(--vscode-focusBorder)}.last-values tr.trace-stale>td.trace-can-id,.last-values tr.trace-stale>td[data-column-id="receivedAt"],.last-values tr.trace-stale>td[data-column-id="age"]{color:var(--vscode-editorWarning-foreground)}.last-values tr.trace-stale>td.trace-can-id::before{content:'⚠ '}
.tag,.trace-signal{display:inline-block;padding:0;margin:0;border-radius:0;background:transparent;color:inherit;font:inherit;vertical-align:top}
.tag+.tag,.trace-signal+.trace-signal{margin-left:var(--sm-space-md);padding-left:var(--sm-space-md);border-left:1px solid var(--vscode-panel-border)}
.trace-signals{gap:0}
.table-value-label{color:var(--vscode-descriptionForeground)}
.table-value-data{font-weight:var(--sm-weight-medium)}
.tag:hover .table-value-label{text-decoration:underline;text-underline-offset:3px}
.cell.table-name,.last-values td.trace-name{font-family:var(--vscode-font-family);font-weight:var(--sm-weight-medium)}
.cell.table-number,.signal-cell,.last-values td.table-number{text-align:right}
.cell.table-center,.last-values td.table-center{text-align:center}
.last-values th.table-number .trace-sort{justify-content:flex-start}
`;
let context: CanvasRenderingContext2D | null | undefined;
export function measureTableText(text: string): number {
  context ??= document.createElement('canvas').getContext('2d');
  if (!context) return text.length * 7;
  const style = getComputedStyle(document.body);
  context.font = `12px ${style.getPropertyValue('--vscode-editor-font-family') || 'monospace'}`;
  const body = context.measureText(text).width;
  context.font = `600 12px ${style.fontFamily}`;
  return Math.max(body, context.measureText(text).width);
}

/** Keep signal labels quiet and measurements prominent without badge backgrounds. */
export function appendTableValue(host: HTMLElement, name: string, value: string, separator = ': '): void {
  const label = document.createElement('span'); label.className = 'table-value-label'; label.textContent = name + separator;
  const data = document.createElement('span'); data.className = 'table-value-data'; data.textContent = value;
  host.append(label, data);
}
