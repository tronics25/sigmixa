import type { FrameFilter } from '../../core/frame/frameStore';
import type { Diagnostic } from '../../core/diagnostics/diagnostic';
import type { LogViewState, RawRowDto, ToExtensionMessage, ToWebviewMessage } from '../../extension/editors/rawLogProtocol';
import { autoFitColumns, fitColumnsToView, type SizingColumn } from '../shared/columnSizing';
import { SignalTableView } from '../table/signalTableView';
import { TimeSeriesView } from '../timeseries/timeSeriesView';
import { TrajectoryView } from '../trajectory/trajectoryView';
import { TimelineController } from '../shared/timelineController';
import { computeVirtualRange } from '../shared/virtualization';
import { t } from '../shared/i18n';
import { addSelectionRange, removeSelectionIndex, selectionContains, selectionCount, type SelectionRange } from './selectionRanges';

declare function acquireVsCodeApi(): { postMessage(message: ToExtensionMessage): void; getState(): unknown; setState(value: unknown): void };

const vscode = acquireVsCodeApi();
const app = document.getElementById('app')!;
const ROW_HEIGHT = 28;
const PAGE_SIZE = 240;
type ContentMode = 'raw' | 'decoded';
function contentValue(row: RawRowDto): string {
  if (contentMode === 'raw') return row.rawContent;
  return row.decodedContent || row.rawContent;
}
function contentSizingValue(row: RawRowDto): string {
  const tagCount = contentMode === 'decoded' && row.decodedContent ? row.decodedContent.split('  ·  ').length : 0;
  return `${contentValue(row)}${'  '.repeat(tagCount)}`;
}
const columns: readonly SizingColumn<RawRowDto>[] = [
  { id: 'time', label: 'TIME(S)', minWidth: 92, maxWidth: 180, value: (row) => row.time.toFixed(6) },
  { id: 'direction', label: 'TX/RX', minWidth: 62, maxWidth: 90, value: (row) => row.direction },
  { id: 'canId', label: 'CAN ID', minWidth: 82, maxWidth: 150, value: (row) => row.canId },
  { id: 'name', label: 'NAME', minWidth: 90, maxWidth: 280, flex: 1, value: (row) => row.name },
  { id: 'channel', label: 'CH', minWidth: 48, maxWidth: 80, value: (row) => String(row.channel) },
  { id: 'dlc', label: 'DLC', minWidth: 52, maxWidth: 80, value: (row) => String(row.dlc) },
  { id: 'length', label: 'LENGTH', minWidth: 68, maxWidth: 100, value: (row) => String(row.length) },
  { id: 'content', label: 'CONTENT', minWidth: 180, maxWidth: 6000, flex: 5, value: contentSizingValue },
];

interface SavedState { readonly widths?: Record<string, number>; readonly regexEnabled?: boolean; readonly contentMode?: ContentMode; }
const saved = (vscode.getState() ?? {}) as SavedState;
const hasSavedContentMode = saved.contentMode === 'raw' || saved.contentMode === 'decoded';
let contentMode: ContentMode = saved.contentMode === 'raw' ? 'raw' : 'decoded';
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
let drawFrame: number | undefined;
let filterValid = true;
let regexEnabled = saved.regexEnabled === true;
let automaticWidthsPending = !saved.widths || !hasSavedContentMode;
let selectionRanges: SelectionRange[] = [];
let selectionAnchor: number | undefined;
let focusedIndex: number | undefined;
let sourceFrameCount = 0;
let unfilteredFrameCount: number | undefined;
let activeFilterCount = 0;
let pagePending = true;
let copyFeedbackTimer: number | undefined;
let rowDrag: { anchor: number; base: SelectionRange[]; startX: number; startY: number; clientY: number; moved: boolean; frame?: number } | undefined;
let ignoreRowClick = false;

app.innerHTML = `
<style>
  *{box-sizing:border-box} body{padding:0;margin:0;color:var(--vscode-foreground);background:var(--vscode-editor-background);font-family:var(--vscode-font-family)}
  #app{height:100vh;display:flex;flex-direction:column;min-width:0}.tabs{display:flex;gap:2px;padding:5px 8px 0;border-bottom:1px solid var(--vscode-panel-border);flex:0 0 auto}.tab{border-bottom-left-radius:0;border-bottom-right-radius:0;border-bottom-color:transparent}.tab.active{background:var(--vscode-tab-activeBackground,var(--vscode-editor-background));color:var(--vscode-tab-activeForeground,var(--vscode-foreground));border-bottom-color:var(--vscode-focusBorder)}
  .view{flex:1;min-height:0;min-width:0;display:flex;flex-direction:column}.view[hidden]{display:none}.toolbar{display:flex;gap:8px;align-items:center;padding:8px;border-bottom:1px solid var(--vscode-panel-border);flex-wrap:wrap}
  input,select,button{font:inherit;color:inherit;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,transparent);padding:5px 8px;border-radius:3px}
  button{background:var(--vscode-button-secondaryBackground);cursor:pointer}button:hover:not(:disabled){background:var(--vscode-button-secondaryHoverBackground)}button.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}button:disabled{opacity:.55;cursor:default}
  input:focus-visible,select:focus-visible,button:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:1px}.grow{flex:1;min-width:260px}.status{font-size:12px;color:var(--vscode-descriptionForeground);white-space:nowrap}.search-box{display:flex;align-items:center;min-width:260px;padding:0;border:1px solid var(--vscode-input-border,transparent);border-radius:3px;background:var(--vscode-input-background)}.search-box:focus-within{outline:1px solid var(--vscode-focusBorder);outline-offset:1px}.search-box.filtered,select.filtered,input.filtered{border-color:var(--vscode-inputOption-activeBorder,var(--vscode-focusBorder))}.search-box.invalid{border-color:var(--vscode-inputValidation-errorBorder);background:var(--vscode-inputValidation-errorBackground)}.search-box input{flex:1;min-width:0;border:0;outline:0;background:transparent}.search-box input:focus-visible{outline:0}.search-box button{align-self:stretch;min-width:30px;padding:2px 6px;border:0;border-radius:0;background:transparent;font-family:var(--vscode-editor-font-family);font-weight:600}.search-box button.active{color:var(--vscode-inputOption-activeForeground);background:var(--vscode-inputOption-activeBackground);outline:1px solid var(--vscode-inputOption-activeBorder,transparent);outline-offset:-1px}.content-mode{display:flex}.content-mode button{border-radius:0;padding:5px 7px}.content-mode button:first-child{border-radius:3px 0 0 3px}.content-mode button:last-child{border-radius:0 3px 3px 0}.content-mode button.active{color:var(--vscode-inputOption-activeForeground);background:var(--vscode-inputOption-activeBackground);border-color:var(--vscode-inputOption-activeBorder,var(--vscode-focusBorder))}.active-filters{display:flex;align-items:center;gap:6px;min-height:31px;padding:4px 8px;border-bottom:1px solid var(--vscode-panel-border);flex-wrap:wrap;font-size:12px}.active-filters[hidden]{display:none}.active-filter-label{color:var(--vscode-descriptionForeground)}.filter-chip{display:flex;align-items:center;gap:6px;max-width:300px;padding:2px 6px;border:1px solid var(--vscode-inputOption-activeBorder,var(--vscode-panel-border));border-radius:10px;background:var(--vscode-inputOption-activeBackground,var(--vscode-badge-background));color:var(--vscode-inputOption-activeForeground,var(--vscode-badge-foreground))}.filter-chip span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.filter-chip b{font-weight:400}.clear-filters{padding:2px 6px;background:transparent;border:0;color:var(--vscode-textLink-foreground)}
  .grid{position:relative;overflow:auto;flex:1;min-height:120px}.header{position:sticky;top:0;z-index:5;display:grid;background:var(--vscode-editor-background);border-bottom:1px solid var(--vscode-panel-border)}
  .head{position:relative;padding:7px 8px;font-size:11px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.resize{position:absolute;right:-3px;top:0;width:7px;height:100%;cursor:col-resize}.sticky-col{position:sticky;z-index:4;background:var(--vscode-editor-background)}.head.sticky-col{z-index:9}.sticky-edge{box-shadow:1px 0 var(--vscode-panel-border)}.row:hover .sticky-col,.row.selected .sticky-col{background:var(--vscode-editor-background)}
  .sizer{position:relative}.window{position:absolute;left:0;top:0}.row{position:relative;z-index:0;display:grid;height:${ROW_HEIGHT}px;border-bottom:1px solid color-mix(in srgb,var(--vscode-panel-border) 45%,transparent);align-items:center;cursor:default;user-select:none;-webkit-user-select:none}.grid.drag-selecting,.grid.drag-selecting .row{cursor:ns-resize}.row:hover{background:transparent}.row:not(.selected):hover::before{content:"";position:absolute;inset:0;z-index:5;pointer-events:none;background:color-mix(in srgb,var(--vscode-list-hoverBackground) 42%,transparent)}.row:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}.row.selected{background:transparent}.row.selected::after{content:"";position:absolute;inset:0;z-index:6;pointer-events:none;background:color-mix(in srgb,var(--vscode-list-activeSelectionBackground) 12%,transparent);border-left:2px solid var(--vscode-focusBorder);box-shadow:inset 0 1px color-mix(in srgb,var(--vscode-focusBorder) 38%,transparent),inset 0 -1px color-mix(in srgb,var(--vscode-focusBorder) 38%,transparent)}.selection-status{padding:2px 6px;border-radius:9px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}.raw-empty{position:sticky;left:0;display:flex;width:min(520px,100%);margin:56px auto 0;padding:18px;z-index:6;align-items:center;justify-content:center;gap:10px;color:var(--vscode-descriptionForeground);background:var(--vscode-editor-background);text-align:center}.raw-empty[hidden]{display:none}
  .cell{padding:0 8px;font-family:var(--vscode-editor-font-family);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.content-cell{padding:0}.content-line{display:block;min-width:0;padding:0 8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dir-Tx{color:var(--vscode-charts-blue)}.dir-Rx{color:var(--vscode-charts-green)}
  .tag{display:inline-block;padding:2px 6px;margin-right:5px;border-radius:9px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);font-family:var(--vscode-font-family);font-size:11px}.row-warning{box-shadow:inset 3px 0 var(--vscode-editorWarning-foreground)}
  .context-menu{position:fixed;z-index:20;padding:4px;background:var(--vscode-menu-background,var(--vscode-editor-background));border:1px solid var(--vscode-menu-border,var(--vscode-panel-border));box-shadow:0 4px 14px #0006}.context-menu button{display:block;width:100%;text-align:left;background:transparent;border:0}.context-menu button:hover{background:var(--vscode-menu-selectionBackground,var(--vscode-list-hoverBackground))}
  details{border-top:1px solid var(--vscode-panel-border);max-height:170px;overflow:auto;padding:5px 10px}summary{cursor:pointer}.diag{padding:4px 0;font-size:12px}.diag-warning{color:var(--vscode-editorWarning-foreground)}.diag-error{color:var(--vscode-editorError-foreground)}
  .signal-layout,.chart-layout{display:flex;flex:1;min-height:0;min-width:0}.signal-pane{width:250px;min-width:0;overflow:auto;border-right:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background,var(--vscode-editor-background))}.signal-main{display:flex;flex:1;min-width:0;min-height:0;flex-direction:column}.view-toolbar{display:flex;align-items:center;gap:7px;min-height:39px;padding:6px 8px;border-bottom:1px solid var(--vscode-panel-border);flex-wrap:wrap}.spacer{flex:1}.muted{color:var(--vscode-descriptionForeground);font-size:12px}
  .signal-selector{padding:8px;overflow-anchor:none}.signal-selector>input{width:100%}.selector-actions{display:flex;gap:5px;margin:7px 0}.selector-actions button{flex:1}.selector-group{margin-top:5px}.selector-group-head{display:grid;grid-template-columns:24px 20px minmax(0,1fr);align-items:center;min-height:28px;font-weight:600}.selector-group-head>span,.selector-signal>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.selector-expand{padding:1px;background:transparent;border:0}.remove-source{display:flex;width:22px;height:22px;padding:3px;align-items:center;justify-content:center;color:var(--vscode-descriptionForeground);background:transparent;border:0}.remove-source:hover{color:var(--vscode-errorForeground);background:var(--vscode-toolbar-hoverBackground)}.remove-source svg{width:16px;height:16px;fill:currentColor}.selector-signal{position:relative;display:grid;grid-template-columns:20px minmax(0,1fr) 22px 22px;align-items:center;min-height:27px;padding-left:24px;font-size:12px}.color-button{width:18px;height:18px;padding:0;border:1px solid var(--vscode-panel-border);border-radius:3px;cursor:pointer;box-shadow:inset 0 0 0 1px #0002}.color-button:hover{filter:brightness(1.12)}
  .color-popup{position:fixed;z-index:30;display:grid;grid-template-columns:repeat(4,24px);gap:5px;padding:7px;border:1px solid var(--vscode-panel-border);border-radius:5px;background:var(--vscode-editor-background);box-shadow:0 3px 12px #0006}.color-swatch{width:24px;height:24px;padding:0;border:2px solid transparent;border-radius:4px;box-shadow:inset 0 0 0 1px #0004;cursor:pointer}.color-swatch:hover{filter:brightness(1.15);border-color:var(--vscode-foreground)}.color-swatch.selected{border-color:var(--vscode-focusBorder);outline:1px solid var(--vscode-focusBorder);outline-offset:1px}
  .signal-grid{position:relative;overflow:auto;flex:1;min-height:120px}.signal-grid-header{position:sticky;top:0;z-index:7;display:grid;background:var(--vscode-editor-background);border-bottom:1px solid var(--vscode-panel-border)}.signal-head{position:relative;display:flex;flex-direction:column;justify-content:center;min-height:42px;padding:4px 8px;font-size:11px;font-weight:650;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.signal-head small{color:var(--vscode-descriptionForeground);font-weight:400}.signal-column-drag{overflow:hidden;text-overflow:ellipsis;cursor:grab}.signal-column-drag:active{cursor:grabbing}.signal-head.dragging{opacity:.55}.signal-head.drag-target{box-shadow:inset 2px 0 var(--vscode-focusBorder)}.signal-grid-sizer{position:relative}.signal-grid-window{position:absolute;left:0;top:0}.signal-grid-row{position:relative;z-index:0;display:grid;height:${ROW_HEIGHT}px;border-bottom:1px solid color-mix(in srgb,var(--vscode-panel-border) 45%,transparent);align-items:center;cursor:default;user-select:none;-webkit-user-select:none}.signal-grid.drag-selecting,.signal-grid.drag-selecting .signal-grid-row{cursor:ns-resize}.signal-grid-row:hover{background:transparent}.signal-grid-row:not(.selected):hover::before{content:"";position:absolute;inset:0;z-index:5;pointer-events:none;background:color-mix(in srgb,var(--vscode-list-hoverBackground) 42%,transparent)}.signal-grid-row.selected::after{content:"";position:absolute;inset:0;z-index:6;pointer-events:none;background:color-mix(in srgb,var(--vscode-list-activeSelectionBackground) 12%,transparent);border-left:2px solid var(--vscode-focusBorder);box-shadow:inset 0 1px color-mix(in srgb,var(--vscode-focusBorder) 38%,transparent),inset 0 -1px color-mix(in srgb,var(--vscode-focusBorder) 38%,transparent)}.signal-grid-row:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}.signal-cell{height:${ROW_HEIGHT}px;padding:6px 8px;font-family:var(--vscode-editor-font-family);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sticky-time{position:sticky;left:0;z-index:3;background:var(--vscode-editor-background);border-right:1px solid var(--vscode-panel-border)}.signal-grid-row:hover .sticky-time,.signal-grid-row.selected .sticky-time{background:var(--vscode-editor-background)}
  .chart-layout{position:relative}.chart-pane{flex:0 0 auto}.pane-separator{width:5px;cursor:col-resize;background:transparent;border-right:1px solid var(--vscode-panel-border)}.pane-separator:hover{background:var(--vscode-focusBorder)}.chart-main{overflow:hidden}.segmented{display:flex}.segmented button{border-radius:0}.chart-option{display:flex;align-items:center;gap:5px;white-space:nowrap;font-size:12px}.chart-option input{margin:0}.chart-axis-global{display:flex;align-items:center;gap:7px}.chart-axis-global[hidden]{display:none}.chart-axis-mode{display:flex;align-items:center;gap:5px;white-space:nowrap;font-size:12px}.chart-axis-mode select{padding:3px 6px}.chart-layout-editor{flex:0 0 auto;padding:8px;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background,var(--vscode-editor-background))}.chart-layout-editor[hidden]{display:none}.chart-layout-editor-head{display:flex;align-items:center;gap:8px;margin-bottom:8px}.chart-layout-cards{display:flex;align-items:stretch;gap:8px;overflow-x:auto;padding-bottom:3px}.chart-layout-card{flex:0 0 270px;padding:7px;border:1px solid var(--vscode-panel-border);border-radius:4px;background:var(--vscode-editor-background)}.chart-layout-card>strong{display:block;margin-bottom:6px}.chart-layout-slots{display:grid;grid-template-columns:1fr 1fr;gap:6px}.chart-layout-slot{position:relative;min-width:0;min-height:38px;padding:5px 5px 5px 25px;border:1px dashed var(--vscode-panel-border);border-radius:3px;transition:border-color .1s,background-color .1s}.chart-layout-slot.drop-target,.chart-layout-new.drop-target{border-color:var(--vscode-focusBorder);background:var(--vscode-list-dropBackground,var(--vscode-list-hoverBackground))}.chart-layout-axis{position:absolute;left:7px;top:11px;color:var(--vscode-descriptionForeground);font:600 10px var(--vscode-editor-font-family)}.chart-layout-chip{display:grid;grid-template-columns:14px minmax(0,1fr) auto;gap:4px;align-items:center;min-height:26px;padding:3px 5px;border-radius:3px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);cursor:grab}.chart-layout-chip:active{cursor:grabbing}.chart-layout-chip:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:2px}.chart-layout-chip.dragging{opacity:.45}.chart-layout-chip span:nth-child(2){overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.chart-layout-chip small{font-size:10px;opacity:.8}.chart-layout-handle{color:inherit}.chart-layout-empty{display:flex;min-height:26px;align-items:center;color:var(--vscode-descriptionForeground);font-size:11px}.chart-layout-new{display:flex;align-items:center;justify-content:center;flex:0 0 220px;min-height:76px;padding:8px;border:1px dashed var(--vscode-panel-border);border-radius:4px;color:var(--vscode-descriptionForeground);transition:border-color .1s,background-color .1s}.chart-legend{position:absolute;left:0;top:0;z-index:3;width:100%;pointer-events:none;font-size:12px}.chart-legend:empty{display:none}.chart-legend-group{position:absolute;left:0;width:100%;display:flex;align-items:flex-start;gap:10px;min-width:0;padding:5px 9px;background:var(--vscode-editor-background);border-bottom:1px solid color-mix(in srgb,var(--vscode-panel-border) 55%,transparent);pointer-events:auto}.chart-legend-title{flex:0 0 auto;min-width:58px;padding-top:4px;color:var(--vscode-descriptionForeground);font-weight:600}.chart-legend-items{display:flex;align-items:center;gap:8px 10px;flex:1;flex-wrap:wrap;min-width:0}.chart-legend-entry{display:flex;flex:0 0 auto;align-items:center;gap:5px;max-width:100%;white-space:nowrap}.chart-legend-entry i{width:12px;height:3px;flex:0 0 auto}.chart-legend-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.chart-axis-badge{min-width:14px;color:var(--vscode-descriptionForeground);font:600 10px var(--vscode-editor-font-family)}.chart-navigation{gap:6px}.view-range,.clip-range{white-space:nowrap}.clip-controls{display:flex;align-items:center;gap:5px;flex-wrap:wrap}.clip-controls[hidden]{display:none}.clip-edge-label{font-size:12px;color:var(--vscode-descriptionForeground)}.chart-canvas-wrap{position:relative;flex:1;min-height:300px;overflow:auto}.chart-canvas-wrap canvas{display:block}.chart-markers{position:absolute;left:0;top:0;pointer-events:none}.chart-tooltip,.chart-marker-tooltip{position:absolute;z-index:10;max-width:520px;max-height:320px;overflow:auto;padding:7px 9px;background:var(--vscode-editorHoverWidget-background,var(--vscode-editor-background));border:1px solid var(--vscode-editorHoverWidget-border,var(--vscode-panel-border));box-shadow:0 3px 10px #0006;font-size:12px}.chart-tooltip{pointer-events:none}.chart-marker-tooltip{pointer-events:auto;cursor:pointer;outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}.chart-tooltip div,.chart-marker-tooltip div{margin-top:3px;white-space:nowrap}
  .trajectory-layout{display:flex;flex:1;min-height:0}.trajectory-pane{width:250px;flex:0 0 250px;overflow:auto;padding:10px;border-right:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background,var(--vscode-editor-background))}.trajectory-pane>input,.trajectory-pane>label,.trajectory-pane>button{display:block;width:100%;margin-bottom:10px}.trajectory-pane [hidden]{display:none}.trajectory-pane label{font-size:12px}.trajectory-pane label select,.trajectory-pane label input[type=number]{display:block;width:100%;margin-top:4px}.trajectory-checks{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin:4px 0 12px}.trajectory-checks label{white-space:nowrap}.trajectory-main{display:flex;flex:1;min-width:0;min-height:0;flex-direction:column}.trajectory-camera-controls{display:flex;gap:7px}.trajectory-camera-controls[hidden]{display:none}.trajectory-canvas-wrap{position:relative;flex:1;min-height:280px;overflow:hidden}.trajectory-canvas-wrap canvas{display:block}.trajectory-canvas-wrap canvas.mode-3d{cursor:grab}.trajectory-canvas-wrap canvas.point-hover:not(.dragging){cursor:pointer}.trajectory-canvas-wrap canvas.mode-3d.dragging{cursor:grabbing}.trajectory-interaction-hint{white-space:nowrap}.trajectory-playback{display:flex;align-items:center;gap:7px;padding:7px 9px;border-top:1px solid var(--vscode-panel-border)}.trajectory-playback .play-seek{flex:1;min-width:100px}.trajectory-playback output{font-family:var(--vscode-editor-font-family);font-size:12px;text-align:center}
  .trajectory-canvas-wrap canvas.measurement-mode:not(.dragging){cursor:crosshair}.trajectory-measurement{display:flex;align-items:center;gap:9px;min-height:35px;padding:5px 9px;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-editorGroupHeader-tabsBackground,var(--vscode-editor-background));font-size:12px}.trajectory-measurement[hidden]{display:none}.trajectory-measurement-value{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--vscode-editor-font-family)}.trajectory-measurement button{flex:0 0 auto}
  .chart-source-actions{display:grid;gap:6px;padding:8px 8px 0}.chart-source-actions button{width:100%}
  .remove-source .codicon{font-size:16px}.external-import-host{padding:0 8px}.external-import-card{margin-top:6px;padding:8px;border:1px solid var(--vscode-panel-border);border-radius:4px;background:var(--vscode-sideBar-background,var(--vscode-editor-background));font-size:12px}.external-import-card>strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-bottom:7px}.external-field-label{display:block;margin:7px 0 3px;color:var(--vscode-descriptionForeground)}.external-import-card>select{width:100%}.external-columns-label{margin-top:9px}.external-column-list{max-height:170px;overflow:auto}.external-column-row{display:grid;grid-template-columns:minmax(0,1fr) 66px;gap:6px;align-items:center;padding:2px 0}.external-column-row label{display:flex;gap:5px;align-items:center;min-width:0;cursor:pointer}.external-column-row label span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.external-column-row input[type=text]{width:66px;min-width:0}.external-import-actions{display:flex;gap:6px;margin-top:8px}.external-import-actions button{flex:1}.external-import-actions button:disabled{opacity:.55;cursor:default}.external-import-note{margin:7px 0 0;line-height:1.3}
</style>
<nav class="tabs" aria-label="${t('Log views', 'ログ表示')}"><button class="tab active" data-view="raw-view">${t('Raw Log', 'RAWログ')}</button><button class="tab" data-view="table-view">${t('Table', 'テーブル')}</button><button class="tab" data-view="timeseries-view">${t('Time Series', '時系列')}</button><button class="tab" data-view="trajectory-view">${t('Trajectory', '軌跡')}</button></nav><div id="clip-scope" class="toolbar muted" hidden></div>
<section id="raw-view" class="view"><div class="toolbar">
  <div id="search-box" class="search-box grow"><input id="search" type="search" placeholder="${t('Keyword', 'キーワード')}" title="${t('Filter by Frame name, Signal, CAN ID, or data', 'フレーム名・Signal名・CAN ID・データで絞り込み')}" aria-label="${t('Filter RAW Log by Frame name, Signal, CAN ID, or data', 'フレーム名・Signal名・CAN ID・データのキーワードでRAWログを絞り込み')}"><button id="search-regex" type="button" title="${t('Use Regular Expression', '正規表現を使用')}" aria-label="${t('Use Regular Expression', '正規表現を使用')}" aria-pressed="false">.*</button></div>
  <select id="direction" aria-label="${t('Filter by direction', '送受信方向で絞り込み')}"><option value="">${t('All directions', 'すべての方向')}</option><option value="Rx">${t('Rx only', 'Rxのみ')}</option><option value="Tx">${t('Tx only', 'Txのみ')}</option></select>
  <select id="decoded" aria-label="${t('Filter by decoded result', 'デコード結果で絞り込み')}"><option value="">${t('All frames', 'すべてのフレーム')}</option><option value="true">${t('With decoded results', 'デコード結果あり')}</option><option value="false">${t('Without decoded results', 'デコード結果なし')}</option></select>
  <select id="channel" aria-label="${t('Filter by channel', 'チャンネルで絞り込み')}"><option value="">${t('All channels', 'すべてのCH')}</option></select>
  <input id="time-start" type="number" step="any" size="8" placeholder="${t('From (s)', '開始 (秒)')}" aria-label="${t('Filter start time', '開始時刻で絞り込み')}">
  <input id="time-end" type="number" step="any" size="8" placeholder="${t('To (s)', '終了 (秒)')}" aria-label="${t('Filter end time', '終了時刻で絞り込み')}">
  <div id="content-mode" class="content-mode" role="group" aria-label="${t('CONTENT display', 'CONTENT表示')}"><button type="button" data-content-mode="raw">RAW</button><button type="button" data-content-mode="decoded">Decoded</button></div>
  <button id="cancel">${t('Cancel parsing', '解析を中止')}</button>
  <span id="selection-status" class="status selection-status" hidden></span><span id="result-status" class="status"></span><span id="filter-error" class="status" style="color:var(--vscode-errorForeground)" hidden></span><span id="status" class="status">${t('Opening…', '読み込み中…')}</span>
</div>
<div id="active-filters" class="active-filters" hidden aria-live="polite"></div>
<div id="grid" class="grid" role="table" aria-rowcount="0" aria-colcount="8" aria-multiselectable="true" tabindex="0"><div id="header" class="header" role="row"></div><div id="sizer" class="sizer"><div id="window" class="window"></div></div><div id="raw-empty" class="raw-empty" hidden><span id="raw-empty-text"></span><button id="raw-empty-clear" type="button">${t('Clear filters', 'フィルターを解除')}</button></div></div>
<details id="diagnostics"><summary>${t('Diagnostics', '診断')} (0)</summary><div id="diag-list"></div></details></section>
<section id="table-view" class="view" hidden></section><section id="timeseries-view" class="view" hidden></section><section id="trajectory-view" class="view" hidden></section><div id="context-menu" class="context-menu" hidden></div>`;

const grid = document.getElementById('grid')!;
const header = document.getElementById('header')!;
const sizer = document.getElementById('sizer')!;
const windowEl = document.getElementById('window')!;
const statusEl = document.getElementById('status')!;
const resultStatusEl = document.getElementById('result-status')!;
const cancelButton = document.getElementById('cancel') as HTMLButtonElement;

function displayWidths(): Readonly<Record<string, number>> { return fitColumnsToView(columns, widths, grid.clientWidth); }
function template(): string { const visible = displayWidths(); return columns.map((column) => `${Math.round(visible[column.id])}px`).join(' '); }
function totalWidth(): number { const visible = displayWidths(); return columns.reduce((sum, column) => sum + visible[column.id], 0); }
function persist(): void { vscode.setState({ widths, regexEnabled, contentMode }); }

function applyWidths(): void {
  const value = template();
  const full = `${totalWidth()}px`;
  header.style.gridTemplateColumns = value; header.style.width = full;
  sizer.style.width = full; windowEl.style.width = full;
  windowEl.querySelectorAll<HTMLElement>('.row').forEach((row) => { row.style.gridTemplateColumns = value; });
  applyStickyOffsets();
}

function stickyOffsets(): readonly number[] { const visible = displayWidths(); const result: number[] = []; let left = 0; for (let index = 0; index < 4; index++) { result.push(left); left += visible[columns[index].id]; } return result; }
function applyStickyOffsets(): void {
  const offsets = stickyOffsets();
  header.querySelectorAll<HTMLElement>('[data-column-index]').forEach((cell) => { const index = Number(cell.dataset.columnIndex); if (index < 4) cell.style.left = `${offsets[index]}px`; });
  windowEl.querySelectorAll<HTMLElement>('[data-column-index]').forEach((cell) => { const index = Number(cell.dataset.columnIndex); if (index < 4) cell.style.left = `${offsets[index]}px`; });
}

function buildHeader(): void {
  header.replaceChildren();
  columns.forEach((column, columnIndex) => {
    const cell = document.createElement('div'); cell.className = `head${columnIndex < 4 ? ' sticky-col' : ''}${columnIndex === 3 ? ' sticky-edge' : ''}`; cell.dataset.columnIndex = String(columnIndex); cell.title = column.label; cell.textContent = column.label; cell.setAttribute('role', 'columnheader');
    const handle = document.createElement('span'); handle.className = 'resize'; handle.setAttribute('aria-hidden', 'true'); handle.title = t('Drag to resize · Double-click to fit content', 'ドラッグで幅変更・ダブルクリックで内容に合わせる');
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
  return [row.time.toFixed(6), row.direction, row.canId, row.name || '—', String(row.channel), String(row.dlc), String(row.length), contentValue(row)];
}

function appendContent(cell: HTMLElement, row: RawRowDto): void {
  cell.classList.add('content-cell'); const line = document.createElement('span'); line.className = 'content-line';
  if (contentMode === 'raw' || !row.decodedContent) line.textContent = row.rawContent;
  else for (const tag of row.decodedContent.split('  ·  ')) { const chip = document.createElement('span'); chip.className = 'tag'; chip.textContent = tag; line.appendChild(chip); }
  cell.appendChild(line);
}

function refreshSelectionStyles(): void {
  windowEl.querySelectorAll<HTMLElement>('.row[data-row-index]').forEach((element) => {
    const selected = selectionContains(selectionRanges, Number(element.dataset.rowIndex)); element.classList.toggle('selected', selected); element.setAttribute('aria-selected', String(selected));
  });
  updateSelectionStatus();
}

function updateSelectionStatus(): void {
  const status = document.getElementById('selection-status')!; const count = selectionCount(selectionRanges); status.hidden = count === 0;
  status.textContent = count ? `${count.toLocaleString()} ${t(count === 1 ? 'row selected' : 'rows selected', '行選択')}` : '';
}
function showCopyFeedback(count = selectionCount(selectionRanges)): void {
  window.clearTimeout(copyFeedbackTimer); const status = document.getElementById('selection-status')!; status.hidden = false; status.textContent = `${count.toLocaleString()} ${t(count === 1 ? 'row copied' : 'rows copied', '行コピーしました')}`; copyFeedbackTimer = window.setTimeout(() => updateSelectionStatus(), 1400);
}

function selectRow(index: number, row: RawRowDto, event: MouseEvent): void {
  if (event.shiftKey && selectionAnchor !== undefined) {
    if (!event.metaKey && !event.ctrlKey) selectionRanges = [];
    selectionRanges = addSelectionRange(selectionRanges, selectionAnchor, index);
  } else if (event.metaKey || event.ctrlKey) {
    selectionRanges = selectionContains(selectionRanges, index) ? removeSelectionIndex(selectionRanges, index) : addSelectionRange(selectionRanges, index);
    selectionAnchor = index;
  } else {
    selectionRanges = [{ start: index, end: index }]; selectionAnchor = index;
  }
  focusedIndex = index;
  refreshSelectionStyles();
}

function rowIndexAt(clientY: number): number {
  const bounds = grid.getBoundingClientRect();
  const contentY = grid.scrollTop + clientY - bounds.top - header.offsetHeight;
  return Math.max(0, Math.min(total - 1, Math.floor(contentY / ROW_HEIGHT)));
}

function updateRowDrag(): void {
  if (!rowDrag?.moved || total < 1) return;
  const index = rowIndexAt(rowDrag.clientY);
  selectionRanges = addSelectionRange(rowDrag.base, rowDrag.anchor, index);
  focusedIndex = index;
  refreshSelectionStyles();
}

function continueRowDrag(): void {
  if (!rowDrag?.moved) return;
  const bounds = grid.getBoundingClientRect();
  const top = bounds.top + header.offsetHeight;
  const overflow = rowDrag.clientY < top ? rowDrag.clientY - top : rowDrag.clientY > bounds.bottom ? rowDrag.clientY - bounds.bottom : 0;
  if (overflow) {
    grid.scrollTop += Math.sign(overflow) * Math.min(20, Math.max(4, Math.abs(overflow) * .35));
    updateRowDrag();
  }
  rowDrag.frame = requestAnimationFrame(continueRowDrag);
}

function beginRowDrag(index: number, event: MouseEvent): void {
  if (event.button !== 0) return;
  const anchor = event.shiftKey && selectionAnchor !== undefined ? selectionAnchor : index;
  const base = event.metaKey || event.ctrlKey ? [...selectionRanges] : [];
  rowDrag = { anchor, base, startX: event.clientX, startY: event.clientY, clientY: event.clientY, moved: false };
  const move = (next: MouseEvent) => {
    if (!rowDrag) return;
    rowDrag.clientY = next.clientY;
    if (!rowDrag.moved && Math.hypot(next.clientX - rowDrag.startX, next.clientY - rowDrag.startY) < 4) return;
    next.preventDefault();
    if (!rowDrag.moved) {
      rowDrag.moved = true; selectionAnchor = anchor; grid.classList.add('drag-selecting');
      rowDrag.frame = requestAnimationFrame(continueRowDrag);
    }
    updateRowDrag();
  };
  const up = () => {
    const completed = rowDrag;
    if (completed?.frame !== undefined) cancelAnimationFrame(completed.frame);
    rowDrag = undefined; grid.classList.remove('drag-selecting');
    window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up);
    if (completed?.moved) {
      ignoreRowClick = true;
      window.setTimeout(() => { ignoreRowClick = false; }, 0);
      windowEl.querySelector<HTMLElement>(`.row[data-row-index="${focusedIndex}"]`)?.focus({ preventScroll: true });
    }
  };
  window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
}

function selectedInOrder(): readonly RawRowDto[] | undefined {
  if (selectionCount(selectionRanges) > rows.size) return undefined;
  const result: RawRowDto[] = [];
  for (const range of selectionRanges) for (let index = range.start; index <= range.end; index++) { const row = rows.get(index); if (!row) return undefined; result.push(row); }
  return result;
}
function tsvCell(value: string | number): string { return String(value).replace(/[\t\r\n]+/g, ' '); }
const copyHeaders = ['TIME(S)', 'TX/RX', 'CAN ID', 'NAME', 'CH', 'DLC', 'LENGTH', 'CONTENT'] as const;
function rowValues(row: RawRowDto): readonly (string | number)[] { return [row.time.toFixed(6), row.direction, row.canId, row.name, row.channel, row.dlc, row.length, contentValue(row)]; }
function selectedRowsAsText(selected: readonly RawRowDto[], includeHeader: boolean): string {
  const lines: string[] = includeHeader ? [copyHeaders.join('\t')] : [];
  for (const row of selected) lines.push(rowValues(row).map(tsvCell).join('\t'));
  return `${lines.join('\r\n')}\r\n`;
}
function selectedRowsAsHtml(selected: readonly RawRowDto[]): string {
  const table = document.createElement('table'); const body = document.createElement('tbody'); table.appendChild(body);
  for (const row of selected) { const tr = document.createElement('tr'); for (const value of rowValues(row)) { const td = document.createElement('td'); td.textContent = String(value); tr.appendChild(td); } body.appendChild(tr); }
  return table.outerHTML;
}
function requestSelectedRows(action: 'copy' | 'open'): void { if (selectionRanges.length) vscode.postMessage({ type: 'selectedRowsRequest', action, ranges: selectionRanges, filter, contentMode }); }
function copySelectedRows(): void { if (selectionRanges.length && !document.execCommand('copy')) requestSelectedRows('copy'); }
function openSelectedRows(): void { requestSelectedRows('open'); }

function moveRowFocus(nextIndex: number, extend: boolean): void {
  if (total < 1) return; const next = Math.max(0, Math.min(total - 1, nextIndex));
  if (extend) {
    if (selectionAnchor === undefined) selectionAnchor = focusedIndex ?? next;
    selectionRanges = [{ start: Math.min(selectionAnchor, next), end: Math.max(selectionAnchor, next) }];
  } else { selectionRanges = [{ start: next, end: next }]; selectionAnchor = next; }
  focusedIndex = next; updateSelectionStatus();
  const viewportTop = grid.scrollTop; const viewportBottom = viewportTop + grid.clientHeight - header.clientHeight; const rowTop = next * ROW_HEIGHT; const rowBottom = rowTop + ROW_HEIGHT;
  if (rowTop < viewportTop) grid.scrollTop = rowTop; else if (rowBottom > viewportBottom) grid.scrollTop = rowBottom - grid.clientHeight + header.clientHeight;
  requestRange(next, next + PAGE_SIZE); scheduleDraw();
  requestAnimationFrame(() => windowEl.querySelector<HTMLElement>(`.row[data-row-index="${next}"]`)?.focus({ preventScroll: true }));
}

function draw(): void {
  grid.setAttribute('aria-rowcount', String(total)); sizer.style.height = `${total * ROW_HEIGHT}px`;
  const range = computeVirtualRange(total, grid.scrollTop, grid.clientHeight - header.clientHeight, ROW_HEIGHT);
  const gridTemplate = template(); const offsets = stickyOffsets(); windowEl.style.transform = `translateY(${range.start * ROW_HEIGHT}px)`; windowEl.replaceChildren();
  for (let index = range.start; index < range.end; index++) {
    const row = rows.get(index); const selected = selectionContains(selectionRanges, index); const rowEl = document.createElement('div'); rowEl.className = `row${selected ? ' selected' : ''}${row?.diagnostics.length ? ' row-warning' : ''}`; rowEl.style.gridTemplateColumns = gridTemplate; rowEl.setAttribute('role', 'row'); rowEl.setAttribute('aria-selected', String(selected)); rowEl.dataset.rowIndex = String(index); rowEl.tabIndex = focusedIndex === index ? 0 : -1;
    const values = row ? displayValues(row) : ['', '', t('Loading…', '読み込み中…'), '', '', '', '', ''];
    values.forEach((value, columnIndex) => {
      const cell = document.createElement('div'); cell.className = `cell${columnIndex < 4 ? ' sticky-col' : ''}${columnIndex === 3 ? ' sticky-edge' : ''}${columnIndex === 1 && row ? ` dir-${row.direction}` : ''}`; cell.dataset.columnIndex = String(columnIndex); if (columnIndex < 4) cell.style.left = `${offsets[columnIndex]}px`; cell.title = columnIndex === 3 && row?.diagnostics.length ? `${value || 'Unnamed frame'} · ${row.diagnostics.map((item) => item.message).join(' · ')}` : value; cell.setAttribute('role', 'cell');
      if (columnIndex === 7 && row) appendContent(cell, row);
      else cell.textContent = columnIndex === 3 && row?.diagnostics.length ? `⚠ ${value || '—'}` : value;
      rowEl.appendChild(cell);
    });
    if (row) {
      rowEl.addEventListener('mousedown', (event) => beginRowDrag(index, event));
      rowEl.addEventListener('click', (event) => { if (ignoreRowClick) { event.preventDefault(); return; } selectRow(index, row, event); rowEl.focus({ preventScroll: true }); });
      rowEl.addEventListener('dblclick', () => openOrRegister(row));
      rowEl.addEventListener('contextmenu', (event) => { event.preventDefault(); if (!selectionContains(selectionRanges, index)) { selectionRanges = [{ start: index, end: index }]; selectionAnchor = index; focusedIndex = index; refreshSelectionStyles(); } showContextMenu(row, event.clientX, event.clientY); });
    }
    windowEl.appendChild(rowEl);
  }
  requestRange(range.start, range.end);
}

function scheduleDraw(): void { if (drawFrame !== undefined) return; drawFrame = requestAnimationFrame(() => { drawFrame = undefined; draw(); }); }

function requestRange(start: number, end: number, force = false): void {
  if (!filterValid) return;
  const offset = Math.max(0, Math.floor(start / PAGE_SIZE) * PAGE_SIZE); const key = `${offset}:${JSON.stringify(filter)}`;
  if (!force && key === lastRequested) return;
  lastRequested = key;
  latestPageRequestId = ++requestId;
  vscode.postMessage({ type: 'pageRequest', requestId: latestPageRequestId, offset, limit: Math.max(PAGE_SIZE * 2, end - start), filter });
}

let filterTimer: number | undefined;
type ActiveFilter = { readonly label: string; readonly clearIds: readonly string[] };
function clearAllFilters(): void {
  for (const id of ['search', 'direction', 'decoded', 'channel', 'time-start', 'time-end']) (document.getElementById(id) as HTMLInputElement | HTMLSelectElement).value = '';
  updateFilter();
}
function updateResultStatus(): void {
  const source = unfilteredFrameCount ?? sourceFrameCount;
  resultStatusEl.textContent = activeFilterCount
    ? `${pagePending ? '…' : total.toLocaleString()} / ${source.toLocaleString()} ${t('frames', 'フレーム')}`
    : `${(pagePending ? source : total).toLocaleString()} ${t('frames', 'フレーム')}`;
}
function updateEmptyState(): void {
  const empty = document.getElementById('raw-empty')!; const clear = document.getElementById('raw-empty-clear') as HTMLButtonElement;
  const show = !pagePending && !parsing && filterValid && total === 0; empty.hidden = !show; if (!show) return;
  document.getElementById('raw-empty-text')!.textContent = activeFilterCount ? t('No frames match the active filters.', '有効なフィルターに一致するフレームがありません。') : t('No CAN frames were found in this file.', 'このファイルにCANフレームがありません。');
  clear.hidden = activeFilterCount === 0;
}
function renderActiveFilters(filters: readonly ActiveFilter[]): void {
  const host = document.getElementById('active-filters')!; host.replaceChildren(); host.hidden = filters.length === 0;
  activeFilterCount = filters.length; updateResultStatus(); updateEmptyState();
  if (!filters.length) return;
  const heading = document.createElement('span'); heading.className = 'active-filter-label'; heading.textContent = t('Active filters:', '有効なフィルター:'); host.appendChild(heading);
  for (const filter of filters) {
    const chip = document.createElement('button'); chip.type = 'button'; chip.className = 'filter-chip'; chip.title = `${filter.label} · ${t('Click to remove', 'クリックして解除')}`;
    const label = document.createElement('span'); label.textContent = filter.label; const close = document.createElement('b'); close.textContent = '×'; close.setAttribute('aria-hidden', 'true'); chip.append(label, close);
    chip.addEventListener('click', () => { for (const id of filter.clearIds) (document.getElementById(id) as HTMLInputElement | HTMLSelectElement).value = ''; updateFilter(); }); host.appendChild(chip);
  }
  if (filters.length > 1) {
    const clear = document.createElement('button'); clear.type = 'button'; clear.className = 'clear-filters'; clear.textContent = t('Clear all', 'すべて解除');
    clear.addEventListener('click', clearAllFilters); host.appendChild(clear);
  }
}
function updateFilter(): void {
  window.clearTimeout(filterTimer);
  filterTimer = window.setTimeout(() => {
    const searchInput = document.getElementById('search') as HTMLInputElement; const search = searchInput.value.trim();
    const direction = (document.getElementById('direction') as HTMLSelectElement).value as 'Rx' | 'Tx' | '';
    const decodedText = (document.getElementById('decoded') as HTMLSelectElement).value;
    const channelText = (document.getElementById('channel') as HTMLSelectElement).value;
    const startText = (document.getElementById('time-start') as HTMLInputElement).value;
    const endText = (document.getElementById('time-end') as HTMLInputElement).value;
    const channel = channelText ? Number(channelText) : undefined;
    const timeStart = startText ? Number(startText) : undefined;
    const timeEnd = endText ? Number(endText) : undefined;
    let invalidRegex = false; if (search && regexEnabled) try { void new RegExp(search, 'i'); } catch { invalidRegex = true; }
    const invalidRange = timeStart !== undefined && timeEnd !== undefined && timeStart > timeEnd;
    filterValid = !invalidRegex && !invalidRange; searchInput.setAttribute('aria-invalid', String(invalidRegex)); document.getElementById('search-box')!.classList.toggle('invalid', invalidRegex);
    document.getElementById('search-box')!.classList.toggle('filtered', Boolean(search));
    for (const [id, active] of [['direction', Boolean(direction)], ['decoded', Boolean(decodedText)], ['channel', Number.isFinite(channel)], ['time-start', Number.isFinite(timeStart)], ['time-end', Number.isFinite(timeEnd)]] as const) document.getElementById(id)!.classList.toggle('filtered', active);
    (document.getElementById('time-start') as HTMLInputElement).setAttribute('aria-invalid', String(invalidRange)); (document.getElementById('time-end') as HTMLInputElement).setAttribute('aria-invalid', String(invalidRange));
    const error = document.getElementById('filter-error')!; error.hidden = filterValid; error.textContent = invalidRegex ? t('Invalid Regular Expression', '正規表現が不正です') : invalidRange ? t('Start time must not exceed end time', '開始時刻は終了時刻以前にしてください') : '';
    const activeFilters: ActiveFilter[] = [];
    if (search && !invalidRegex) activeFilters.push({ label: regexEnabled ? `/${search}/` : `${t('Keyword', 'キーワード')}: ${search}`, clearIds: ['search'] });
    if (direction) activeFilters.push({ label: direction === 'Rx' ? t('Rx only', 'Rxのみ') : t('Tx only', 'Txのみ'), clearIds: ['direction'] });
    if (decodedText) activeFilters.push({ label: decodedText === 'true' ? t('With decoded results', 'デコード結果あり') : t('Without decoded results', 'デコード結果なし'), clearIds: ['decoded'] });
    if (Number.isFinite(channel)) activeFilters.push({ label: `CH ${channel}`, clearIds: ['channel'] });
    if (Number.isFinite(timeStart)) activeFilters.push({ label: `${t('From', '開始')} ${timeStart} s`, clearIds: ['time-start'] });
    if (Number.isFinite(timeEnd)) activeFilters.push({ label: `${t('To', '終了')} ${timeEnd} s`, clearIds: ['time-end'] });
    renderActiveFilters(activeFilters);
    if (!filterValid) { selectionRanges = []; selectionAnchor = undefined; focusedIndex = undefined; pagePending = false; rows.clear(); total = 0; lastRequested = ''; updateSelectionStatus(); updateResultStatus(); updateEmptyState(); draw(); return; }
    filter = {
      ...(search ? { search, searchRegex: regexEnabled, searchContent: contentMode } : {}), ...(direction ? { direction } : {}),
      ...(Number.isFinite(channel) ? { channel } : {}), ...(Number.isFinite(timeStart) ? { timeStart } : {}), ...(Number.isFinite(timeEnd) ? { timeEnd } : {}),
      ...(decodedText ? { decoded: decodedText === 'true' } : {}),
    };
    selectionRanges = []; selectionAnchor = undefined; focusedIndex = undefined; rows.clear(); total = 0; pagePending = true; lastRequested = ''; grid.scrollTop = 0; updateSelectionStatus(); updateResultStatus(); updateEmptyState(); requestRange(0, PAGE_SIZE, true); draw();
  }, 180);
}

function updateChannelOptions(channels: readonly number[]): void {
  const select = document.getElementById('channel') as HTMLSelectElement;
  const current = Array.from(select.options).slice(1).map((option) => Number(option.value));
  if (current.length === channels.length && current.every((channel, index) => channel === channels[index])) return;
  const selected = select.value;
  select.replaceChildren(new Option(t('All channels', 'すべてのCH'), ''));
  for (const channel of channels) select.add(new Option(`CH ${channel}`, String(channel)));
  if (Array.from(select.options).some((option) => option.value === selected)) select.value = selected;
}

function measure(text: string): number {
  const canvas = document.createElement('canvas'); const context = canvas.getContext('2d');
  if (!context) return text.length * 8;
  context.font = getComputedStyle(document.body).font; return context.measureText(text).width;
}

const autoFitRequests = new Map<number, { readonly target?: string }>();
function requestAutoFit(target?: string, sampleFilter: FrameFilter | null = filter): void {
  const fitRequestId = ++requestId; autoFitRequests.set(fitRequestId, { target });
  vscode.postMessage({ type: 'autoFitSampleRequest', requestId: fitRequestId, filter: sampleFilter ?? undefined });
}
function requestAutomaticWidths(frames: number): void {
  if (!automaticWidthsPending || frames < 1) return;
  automaticWidthsPending = false; requestAutoFit();
}
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

function showContextMenu(row: RawRowDto, x: number, y: number, focus = false): void {
  const menu = document.getElementById('context-menu')!; menu.replaceChildren(); menu.hidden = false; menu.style.left = `${x}px`; menu.style.top = `${y}px`;
  const addAction = (label: string, action: () => void) => { const button = document.createElement('button'); button.textContent = label; button.addEventListener('click', () => { menu.hidden = true; action(); }); menu.appendChild(button); };
  const count = selectionCount(selectionRanges);
  addAction(count === 1 ? t('Copy Row', '行をコピー') : t(`Copy ${count} Rows`, `${count}行をコピー`), copySelectedRows);
  addAction(count === 1 ? t('Open Row in Text Editor', '行をテキストエディタで開く') : t(`Open ${count} Rows in Text Editor`, `${count}行をテキストエディタで開く`), openSelectedRows);
  addAction(row.definitionId ? t('Open Frame Definition', 'フレーム定義を開く') : t('Register CAN Frame', 'CANフレームを登録'), () => openOrRegister(row));
  requestAnimationFrame(() => { const rect = menu.getBoundingClientRect(); menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - rect.width - 4))}px`; menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 4))}px`; if (focus) menu.querySelector<HTMLButtonElement>('button')?.focus(); });
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
  else { tableView?.hide(); timeSeriesView?.hide(); trajectoryView?.hide(); if (id === 'raw-view') scheduleDraw(); }
}

window.addEventListener('message', (event: MessageEvent<ToWebviewMessage>) => {
  const message = event.data;
  tableView?.handle(message); timeSeriesView?.handle(message); trajectoryView?.handle(message);
  if (message.type === 'init') { initializeSignalViews(message.viewState); updateChannelOptions(message.channels); sourceFrameCount = message.frames; parsing = message.parsing; pagePending = true; cancelButton.hidden = !parsing; const clipScope = document.getElementById('clip-scope')!; clipScope.hidden = !message.clip; if (message.clip) clipScope.textContent = `${t('Clip','クリップ')}: ${message.clip.name} · ${message.clip.startTimestamp.toFixed(6)}–${message.clip.endTimestamp.toFixed(6)} s`; statusEl.textContent = parsing ? `${message.fileName} · ${t('parsing', '解析中')}` : `${message.diagnostics.toLocaleString()} ${t('diagnostics', '件の診断')}`; updateResultStatus(); updateEmptyState(); requestRange(0, PAGE_SIZE, true); if (!message.parsing) requestAutomaticWidths(message.frames); }
  else if (message.type === 'page') {
    if (message.requestId !== latestPageRequestId) return;
    total = message.total; pagePending = false; if (!activeFilterCount) unfilteredFrameCount = message.total;
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
    updateResultStatus(); updateEmptyState();
  }
  else if (message.type === 'progress') { updateChannelOptions(message.channels); sourceFrameCount = message.frames; parsing = true; cancelButton.hidden = false; const percent = message.totalBytes ? Math.floor(message.bytesRead / message.totalBytes * 100) : 0; statusEl.textContent = `${t('Parsing', '解析中')} ${percent}%`; updateResultStatus(); updateEmptyState(); requestRange(Math.floor(grid.scrollTop / ROW_HEIGHT), Math.floor(grid.scrollTop / ROW_HEIGHT) + PAGE_SIZE, true); }
  else if (message.type === 'parseComplete') { updateChannelOptions(message.channels); sourceFrameCount = message.frames; parsing = false; pagePending = true; cancelButton.hidden = true; statusEl.textContent = `${message.cancelled ? `${t('Cancelled', '中止')} · ` : ''}${message.diagnostics.toLocaleString()} ${t('diagnostics', '件の診断')}`; updateResultStatus(); updateEmptyState(); requestRange(0, PAGE_SIZE, true); requestAutomaticWidths(message.frames); }
  else if (message.type === 'diagnostics') {
    parserDiagnosticTotal = message.total;
    latestDiagnostics.push(...message.diagnostics);
    if (latestDiagnostics.length > 200) latestDiagnostics = latestDiagnostics.slice(-200);
    showDiagnostics();
  }
  else if (message.type === 'autoFitSample') {
    const request = autoFitRequests.get(message.requestId); if (!request) return; autoFitRequests.delete(message.requestId);
    const fitted = autoFitColumns(columns, message.rows, measure);
    widths = request.target ? { ...widths, [request.target]: fitted[request.target] } : { ...widths, ...fitted };
    applyWidths(); persist();
  }
  else if (message.type === 'rowsCopied') showCopyFeedback(message.count);
  else if (message.type === 'definitionsChanged') { selectionRanges = []; selectionAnchor = undefined; focusedIndex = undefined; rows.clear(); rowDiagnostics.clear(); pagePending = true; updateSelectionStatus(); updateResultStatus(); updateEmptyState(); showDiagnostics(); lastRequested = ''; requestRange(Math.floor(grid.scrollTop / ROW_HEIGHT), Math.floor(grid.scrollTop / ROW_HEIGHT) + PAGE_SIZE, true); }
});

grid.addEventListener('scroll', scheduleDraw);
window.addEventListener('resize', () => { applyWidths(); scheduleDraw(); });
document.getElementById('search')!.addEventListener('input', updateFilter);
const regexButton = document.getElementById('search-regex')!; regexButton.classList.toggle('active', regexEnabled); regexButton.setAttribute('aria-pressed', String(regexEnabled)); regexButton.addEventListener('click', () => { regexEnabled = !regexEnabled; regexButton.classList.toggle('active', regexEnabled); regexButton.setAttribute('aria-pressed', String(regexEnabled)); persist(); updateFilter(); });
document.getElementById('direction')!.addEventListener('change', updateFilter);
document.getElementById('decoded')!.addEventListener('change', updateFilter);
document.getElementById('channel')!.addEventListener('change', updateFilter);
document.getElementById('time-start')!.addEventListener('input', updateFilter);
document.getElementById('time-end')!.addEventListener('input', updateFilter);
document.getElementById('raw-empty-clear')!.addEventListener('click', clearAllFilters);
function updateContentModeButtons(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-content-mode]').forEach((button) => { const active = button.dataset.contentMode === contentMode; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); });
  const search = document.getElementById('search') as HTMLInputElement;
  const description = contentMode === 'raw' ? t('Filter by Frame name, CAN ID, or RAW data', 'フレーム名・CAN ID・RAWデータで絞り込み') : t('Filter by Frame name, Signal, CAN ID, or displayed data', 'フレーム名・Signal名・CAN ID・表示データで絞り込み');
  search.title = description; search.setAttribute('aria-label', description);
}
document.querySelectorAll<HTMLButtonElement>('[data-content-mode]').forEach((button) => button.addEventListener('click', () => {
  const next = button.dataset.contentMode as ContentMode; if (next === contentMode) return;
  contentMode = next; updateContentModeButtons(); persist(); scheduleDraw(); requestAutoFit('content', null);
  if ((document.getElementById('search') as HTMLInputElement).value.trim()) updateFilter();
}));
cancelButton.addEventListener('click', () => { vscode.postMessage({ type: 'cancelParsing' }); cancelButton.disabled = true; statusEl.textContent = t('Cancelling…', '中止しています…'); });
document.addEventListener('click', () => { (document.getElementById('context-menu') as HTMLElement).hidden = true; });
document.addEventListener('copy', (event) => {
  const active = document.activeElement as HTMLElement | null; const editing = active?.matches('input,select,textarea,[contenteditable=true]') ?? false;
  if ((document.getElementById('raw-view') as HTMLElement).hidden || !selectionRanges.length || editing || !event.clipboardData || event.defaultPrevented) return;
  event.preventDefault(); const selected = selectedInOrder();
  if (selected) { event.clipboardData.setData('text/plain', selectedRowsAsText(selected, false)); event.clipboardData.setData('text/html', selectedRowsAsHtml(selected)); showCopyFeedback(selected.length); }
  else requestSelectedRows('copy');
});
document.addEventListener('keydown', (event) => {
  if ((document.getElementById('raw-view') as HTMLElement).hidden) return;
  const target = event.target as HTMLElement | null; const editing = target?.matches('input,select,textarea,[contenteditable=true]') ?? false;
  const menu = document.getElementById('context-menu')!;
  if (event.key === 'Escape' && !menu.hidden) { event.preventDefault(); menu.hidden = true; windowEl.querySelector<HTMLElement>(`.row[data-row-index="${focusedIndex}"]`)?.focus(); }
  else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c' && selectionRanges.length && !editing) { event.preventDefault(); copySelectedRows(); }
  else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a' && (focusedIndex !== undefined || target === grid) && !editing) { event.preventDefault(); selectionRanges = total ? [{ start: 0, end: total - 1 }] : []; selectionAnchor = 0; focusedIndex = total ? 0 : undefined; refreshSelectionStyles(); }
  else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && (focusedIndex !== undefined || target === grid) && !editing) { event.preventDefault(); const start = focusedIndex ?? (event.key === 'ArrowDown' ? -1 : total); moveRowFocus(start + (event.key === 'ArrowDown' ? 1 : -1), event.shiftKey); }
  else if (event.key === 'Enter' && focusedIndex !== undefined && !editing) { const row = rows.get(focusedIndex); if (row) { event.preventDefault(); openOrRegister(row); } }
  else if (event.shiftKey && event.key === 'F10' && focusedIndex !== undefined && !editing) { const row = rows.get(focusedIndex); const element = windowEl.querySelector<HTMLElement>(`.row[data-row-index="${focusedIndex}"]`); if (row && element) { event.preventDefault(); const rect = element.getBoundingClientRect(); showContextMenu(row, rect.left + 24, rect.top + ROW_HEIGHT, true); } }
  else if (event.key === 'Escape' && selectionRanges.length && !editing) { selectionRanges = []; selectionAnchor = undefined; refreshSelectionStyles(); }
});
document.querySelectorAll<HTMLElement>('.tab').forEach((tab) => tab.addEventListener('click', () => activateView(tab.dataset.view ?? 'raw-view')));

updateContentModeButtons(); buildHeader(); draw(); vscode.postMessage({ type: 'ready' });
