import { SIGNAL_LEGEND_STYLES } from '../shared/signalLegend';
import { COMPONENT_STYLES, DESIGN_TOKENS } from '../shared/designTokens';
import { attachNumberStepper } from '../shared/numberStepper';
import { CHOICE_GROUP_STYLES, enhanceChoiceSelect, syncChoiceSelect } from '../shared/choiceGroup';
import { DATA_TABLE_ROW_HEIGHT, DATA_TABLE_STYLES, FRAME_TABLE_LABELS, measureTableText, appendTableValue } from '../shared/dataTableStyle';
import { ICON_BUTTON_STYLES, iconButton as styleIconButton } from '../shared/iconButton';
import type { FrameFilter } from '../../core/frame/frameStore';
import type { DiagnosticGroup } from '../../core/diagnostics/diagnosticTally';
import type { LogViewState, RawRowDto, ToExtensionMessage, ToWebviewMessage } from '../../extension/editors/rawLogProtocol';
import { autoFitColumns, fitColumnsToView, type SizingColumn } from '../shared/columnSizing';
import { SignalTableView } from '../table/signalTableView';
import { VisualizeView } from './visualizeView';
import { computeVirtualRange } from '../shared/virtualization';
import { t } from '../shared/i18n';
import { showActionMenu } from '../shared/contextMenu';
import { bindColumnHover, bindResizeKeyboard, blurTableFocus, widthToFit } from '../shared/tableBehavior';
import { bindDecodedInspection, hideDecodedInspection } from './decodedInspection';
import { addSelectionRange, removeSelectionIndex, selectionContains, selectionCount, type SelectionRange } from './selectionRanges';

declare function acquireVsCodeApi(): { postMessage(message: ToExtensionMessage): void; getState(): unknown; setState(value: unknown): void };

const vscode = acquireVsCodeApi();
const app = document.getElementById('app')!;
const ROW_HEIGHT = DATA_TABLE_ROW_HEIGHT;
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
  { id: 'direction', label: FRAME_TABLE_LABELS.direction, minWidth: 62, maxWidth: 90, value: (row) => row.direction },
  { id: 'canId', label: FRAME_TABLE_LABELS.canId, minWidth: 82, maxWidth: 150, value: (row) => row.canId },
  { id: 'name', label: FRAME_TABLE_LABELS.name, minWidth: 90, maxWidth: 2000, flex: 1, value: (row) => row.name },
  { id: 'channel', label: FRAME_TABLE_LABELS.channel, minWidth: 48, maxWidth: 80, value: (row) => String(row.channel) },
  { id: 'dlc', label: 'DLC', minWidth: 52, maxWidth: 80, value: (row) => String(row.dlc) },
  { id: 'length', label: 'LENGTH', minWidth: 68, maxWidth: 100, value: (row) => String(row.length) },
  { id: 'content', label: FRAME_TABLE_LABELS.content, minWidth: 180, maxWidth: 6000, flex: 5, value: contentSizingValue },
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
let sourceDiagnosticGroups: readonly DiagnosticGroup[] = [];
/** Decode findings for the whole log, collected by the extension in the background. */
let analysisDiagnosticGroups: readonly DiagnosticGroup[] = [];
let parseCancelled = false;
let tableView: SignalTableView | undefined;
let visualizeView: VisualizeView | undefined;
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
<style>${DESIGN_TOKENS}
  *{box-sizing:border-box} body{padding:0;margin:0;color:var(--vscode-foreground);background:var(--vscode-editor-background);font-family:var(--vscode-font-family)}
  #app{height:100vh;display:flex;flex-direction:column;min-width:0}.tabs{display:flex;gap:var(--sm-space-2xs);padding:var(--sm-space-xs) var(--sm-space-md) 0;border-bottom:1px solid var(--vscode-panel-border);flex:0 0 auto}.tab{border-bottom-left-radius:0;border-bottom-right-radius:0;border-bottom-color:transparent}.tab.active{background:var(--vscode-tab-activeBackground,var(--vscode-editor-background));color:var(--vscode-tab-activeForeground,var(--vscode-foreground));border-bottom-color:var(--vscode-focusBorder)}
  .view{flex:1;min-height:0;min-width:0;display:flex;flex-direction:column}.view[hidden]{display:none}.toolbar{display:flex;gap:var(--sm-space-md);align-items:center;padding:var(--sm-toolbar-padding);border-bottom:1px solid var(--vscode-panel-border);flex-wrap:wrap}

  button:hover:not(:disabled){background:var(--vscode-button-secondaryHoverBackground)}
  .grow{flex:1;min-width:260px}.status{font-size:var(--sm-font-small);color:var(--vscode-descriptionForeground);white-space:nowrap}.search-box{display:flex;align-items:center;min-width:260px;padding:0;border:1px solid var(--vscode-input-border,transparent);border-radius:var(--sm-radius-legacy-3);background:var(--vscode-input-background)}.search-box:focus-within{outline:1px solid var(--vscode-focusBorder);outline-offset:1px}.search-box.filtered,select.filtered,input.filtered{border-color:var(--vscode-inputOption-activeBorder,var(--vscode-focusBorder))}.search-box.invalid{border-color:var(--vscode-inputValidation-errorBorder);background:var(--vscode-inputValidation-errorBackground)}.search-box input{flex:1;min-width:0;border:0;outline:0;background:transparent}.search-box input:focus-visible{outline:0}.search-box button{align-self:stretch;min-width:30px;padding:var(--sm-space-2xs) var(--sm-space-sm);border:0;border-radius:0;background:transparent;font-family:var(--vscode-editor-font-family);font-weight:var(--sm-weight-semibold)}.search-box button.active{color:var(--vscode-inputOption-activeForeground);background:var(--vscode-inputOption-activeBackground);outline:1px solid var(--vscode-inputOption-activeBorder,transparent);outline-offset:-1px}.content-mode{display:flex}.content-mode button{border-radius:0;padding:var(--sm-space-xs) var(--sm-space-md)}.content-mode button:first-child{border-radius:var(--sm-radius-legacy-3) 0 0 var(--sm-radius-legacy-3)}.content-mode button:last-child{border-radius:0 var(--sm-radius-legacy-3) var(--sm-radius-legacy-3) 0}.content-mode button.active{color:var(--vscode-inputOption-activeForeground);background:var(--vscode-inputOption-activeBackground);border-color:var(--vscode-inputOption-activeBorder,var(--vscode-focusBorder))}.active-filters{display:flex;align-items:center;gap:var(--sm-space-sm);min-height:31px;padding:var(--sm-space-xs) var(--sm-space-md);border-bottom:1px solid var(--vscode-panel-border);flex-wrap:wrap;font-size:var(--sm-font-small)}.active-filters[hidden]{display:none}.active-filter-label{color:var(--vscode-descriptionForeground)}.filter-chip{display:flex;align-items:center;gap:var(--sm-space-sm);max-width:300px;padding:var(--sm-space-2xs) var(--sm-space-sm);border:1px solid var(--vscode-inputOption-activeBorder,var(--vscode-panel-border));border-radius:var(--sm-radius-legacy-10);background:var(--vscode-inputOption-activeBackground,var(--vscode-badge-background));color:var(--vscode-inputOption-activeForeground,var(--vscode-badge-foreground))}.filter-chip span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.filter-chip b{font-weight:var(--sm-weight-regular)}.clear-filters{padding:var(--sm-space-2xs) var(--sm-space-sm);background:transparent;border:0;color:var(--vscode-textLink-foreground)}
  .grid{position:relative;overflow:auto;flex:1;min-height:120px}.header{position:sticky;top:0;z-index:5;display:grid;background:var(--vscode-editor-background);border-bottom:1px solid var(--vscode-panel-border)}
  .head{position:relative;padding:var(--sm-space-md) var(--sm-space-md);font-size:var(--sm-font-caption);font-weight:var(--sm-weight-legacy-650);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.resize{position:absolute;right:-3px;top:0;width:7px;height:100%;cursor:col-resize}.sticky-col{position:sticky;z-index:4;background:var(--vscode-editor-background)}.head.sticky-col{z-index:9}.sticky-edge{box-shadow:1px 0 var(--vscode-panel-border)}.row:hover .sticky-col,.row.selected .sticky-col{background:var(--vscode-editor-background)}
  .sizer{position:relative}.window{position:absolute;left:0;top:0}.row{position:relative;z-index:0;display:grid;height:${ROW_HEIGHT}px;border-bottom:1px solid color-mix(in srgb,var(--vscode-panel-border) 45%,transparent);align-items:center;cursor:default;user-select:none;-webkit-user-select:none}.grid.drag-selecting,.grid.drag-selecting .row{cursor:ns-resize}.row:hover{background:transparent}.row:not(.selected):hover::before{content:"";position:absolute;inset:0;z-index:5;pointer-events:none;background:color-mix(in srgb,var(--vscode-list-hoverBackground) 42%,transparent)}.row:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}.row.selected{background:transparent}.row.selected::after{content:"";position:absolute;inset:0;z-index:6;pointer-events:none;background:var(--table-active-wash);border-left:2px solid var(--vscode-focusBorder);box-shadow:inset 0 1px var(--table-active-edge),inset 0 -1px var(--table-active-edge)}.selection-status{padding:var(--sm-space-2xs) var(--sm-space-sm);border-radius:var(--sm-radius-legacy-9);background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}.raw-empty{position:sticky;left:0;display:flex;width:min(520px,100%);margin:var(--sm-space-4xl) auto 0;padding:var(--sm-space-xl);z-index:6;align-items:center;justify-content:center;gap:var(--sm-space-md);color:var(--vscode-descriptionForeground);background:var(--vscode-editor-background);text-align:center}.raw-empty[hidden]{display:none}
  .cell{padding:0 var(--sm-space-md);font-family:var(--vscode-editor-font-family);font-size:var(--sm-font-small);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.content-cell{padding:0}.content-line{display:block;min-width:0;padding:0 var(--sm-space-md);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dir-Tx{color:var(--vscode-charts-blue)}.dir-Rx{color:var(--vscode-charts-green)}
  .tag{display:inline-block;padding:var(--sm-space-2xs) var(--sm-space-sm);margin-right:var(--sm-space-xs);border-radius:var(--sm-radius-legacy-9);background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);font-family:var(--vscode-font-family);font-size:var(--sm-font-caption)}.row-warning{box-shadow:inset 3px 0 var(--vscode-editorWarning-foreground)}
  .context-menu{position:fixed;z-index:20;padding:var(--sm-space-xs);background:var(--vscode-menu-background,var(--vscode-editor-background));border:1px solid var(--vscode-menu-border,var(--vscode-panel-border));box-shadow:0 4px 14px #0006}.context-menu button{display:block;width:100%;text-align:left;background:transparent;border:0}.context-menu button:hover{background:var(--vscode-menu-selectionBackground,var(--vscode-list-hoverBackground))}
  details{border-top:1px solid var(--vscode-panel-border);max-height:170px;overflow:auto;padding:var(--sm-space-xs) var(--sm-space-md)}summary{cursor:pointer}.diag{padding:var(--sm-space-xs) 0;font-size:var(--sm-font-small)}.diag-warning{color:var(--vscode-editorWarning-foreground)}.diag-error{color:var(--vscode-editorError-foreground)}
  .signal-layout,.chart-layout{display:flex;flex:1;min-height:0;min-width:0}.signal-pane{width:250px;min-width:0;overflow:auto;border-right:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background,var(--vscode-editor-background))}.signal-main{display:flex;flex:1;min-width:0;min-height:0;flex-direction:column}.view-toolbar{display:flex;align-items:center;gap:var(--sm-toolbar-gap);min-height:38px;padding:var(--sm-toolbar-padding);border-bottom:1px solid var(--vscode-panel-border);flex-wrap:wrap}.spacer{flex:1}.muted{color:var(--vscode-descriptionForeground);font-size:var(--sm-font-small)}
  .toolbar-secondary{display:flex;align-items:center;gap:var(--sm-space-2xs);padding-left:var(--sm-space-sm);border-left:1px solid var(--vscode-panel-border)}.chart-navigation button.icon-button{margin-left:auto}.trajectory-camera-controls.segmented{gap:0}.trajectory-camera-controls.segmented button{border-radius:0}.trajectory-camera-controls.segmented button:first-child{border-radius:var(--sm-radius-legacy-3) 0 0 var(--sm-radius-legacy-3)}.trajectory-camera-controls.segmented button:last-child{border-radius:0 var(--sm-radius-legacy-3) var(--sm-radius-legacy-3) 0}
  .signal-selector{padding:var(--sm-space-md);overflow-anchor:none}.signal-selector>input{width:100%}.selector-group{margin-top:var(--sm-space-xs)}.selector-group-head{display:grid;grid-template-columns:24px 20px minmax(0,1fr);align-items:center;min-height:28px;font-weight:var(--sm-weight-semibold)}.selector-group-head>span,.selector-signal>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.selector-expand{padding:1px;background:transparent;border:0}.remove-source{display:flex;width:22px;height:22px;padding:var(--sm-space-xs);align-items:center;justify-content:center;color:var(--vscode-descriptionForeground);background:transparent;border:0}.remove-source:hover{color:var(--vscode-errorForeground);background:var(--vscode-toolbar-hoverBackground)}.remove-source svg{width:16px;height:16px;fill:currentColor}.selector-signal{position:relative;display:grid;grid-template-columns:20px minmax(0,1fr) 22px 22px;align-items:center;min-height:27px;padding-left:var(--sm-space-2xl);font-size:var(--sm-font-small)}.color-button{width:18px;height:18px;padding:0;border:1px solid var(--vscode-panel-border);border-radius:var(--sm-radius-legacy-3);cursor:pointer;box-shadow:inset 0 0 0 1px #0002}.color-button:hover{filter:brightness(1.12)}
  .color-popup{position:fixed;z-index:30;display:grid;grid-template-columns:repeat(4,24px);gap:var(--sm-space-xs);padding:var(--sm-space-md);border:1px solid var(--vscode-panel-border);border-radius:var(--sm-radius-menu);background:var(--vscode-editor-background);box-shadow:0 3px 12px #0006}.color-swatch{width:24px;height:24px;padding:0;border:2px solid transparent;border-radius:var(--sm-radius-md);box-shadow:inset 0 0 0 1px #0004;cursor:pointer}.color-swatch:hover{filter:brightness(1.15);border-color:var(--vscode-foreground)}.color-swatch.selected{border-color:var(--vscode-focusBorder);outline:1px solid var(--vscode-focusBorder);outline-offset:1px}
  .signal-grid{position:relative;overflow:auto;flex:1;min-height:120px}.signal-grid-header{position:sticky;top:0;z-index:7;display:grid;background:var(--vscode-editor-background);border-bottom:1px solid var(--vscode-panel-border)}.signal-head{position:relative;display:flex;flex-direction:column;justify-content:center;min-height:42px;padding:var(--sm-space-xs) var(--sm-space-md);font-size:var(--sm-font-caption);font-weight:var(--sm-weight-legacy-650);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.signal-head small{color:var(--vscode-descriptionForeground);font-weight:var(--sm-weight-regular)}.signal-column-drag{overflow:hidden;text-overflow:ellipsis;cursor:grab}.signal-column-drag:active{cursor:grabbing}.signal-head.dragging{opacity:.55}.signal-head.drag-target{box-shadow:inset 2px 0 var(--vscode-focusBorder)}.signal-grid-sizer{position:relative}.signal-grid-window{position:absolute;left:0;top:0}.signal-grid-row{position:relative;z-index:0;display:grid;height:${ROW_HEIGHT}px;border-bottom:1px solid color-mix(in srgb,var(--vscode-panel-border) 45%,transparent);align-items:center;cursor:default;user-select:none;-webkit-user-select:none}.signal-grid.drag-selecting,.signal-grid.drag-selecting .signal-grid-row{cursor:ns-resize}.signal-grid-row:hover{background:transparent}.signal-grid-row:not(.selected):hover::before{content:"";position:absolute;inset:0;z-index:5;pointer-events:none;background:color-mix(in srgb,var(--vscode-list-hoverBackground) 42%,transparent)}.signal-grid-row.selected::after{content:"";position:absolute;inset:0;z-index:6;pointer-events:none;background:var(--table-active-wash);border-left:2px solid var(--vscode-focusBorder);box-shadow:inset 0 1px var(--table-active-edge),inset 0 -1px var(--table-active-edge)}.signal-grid-row:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}.signal-cell{height:${ROW_HEIGHT}px;padding:var(--sm-space-sm) var(--sm-space-md);font-family:var(--vscode-editor-font-family);font-size:var(--sm-font-small);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sticky-time{position:sticky;left:0;z-index:3;background:var(--vscode-editor-background);border-right:1px solid var(--vscode-panel-border)}.signal-grid-row:hover .sticky-time,.signal-grid-row.selected .sticky-time{background:var(--vscode-editor-background)}
  .chart-layout{position:relative}.chart-pane{flex:0 0 auto}.pane-separator{width:5px;cursor:col-resize;background:transparent;border-right:1px solid var(--vscode-panel-border)}.pane-separator:hover{background:var(--vscode-focusBorder)}.chart-main{overflow:hidden}.segmented{display:flex}.segmented button{border-radius:0}.chart-option{display:flex;align-items:center;gap:var(--sm-space-xs);white-space:nowrap;font-size:var(--sm-font-small)}.chart-option input{margin:0}.chart-axis-global{display:flex;align-items:center;gap:var(--sm-space-md)}.chart-axis-global[hidden]{display:none}.chart-axis-mode{display:flex;align-items:center;gap:var(--sm-space-xs);white-space:nowrap;font-size:var(--sm-font-small)}.chart-axis-mode select{padding:var(--sm-space-xs) var(--sm-space-sm)}.chart-layout-editor{flex:0 0 auto;padding:var(--sm-space-md);border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background,var(--vscode-editor-background))}.chart-layout-editor[hidden]{display:none}.chart-layout-editor-head{display:flex;align-items:center;gap:var(--sm-space-md);margin-bottom:var(--sm-space-md)}.chart-layout-cards{display:flex;align-items:stretch;gap:var(--sm-space-md);overflow-x:auto;padding-bottom:var(--sm-space-xs)}.chart-layout-card{flex:0 0 270px;padding:var(--sm-space-md);border:1px solid var(--vscode-panel-border);border-radius:var(--sm-radius-md);background:var(--vscode-editor-background)}.chart-layout-card>strong{display:block;margin-bottom:var(--sm-space-sm)}.chart-layout-slots{display:grid;grid-template-columns:1fr 1fr;gap:var(--sm-space-sm)}.chart-layout-slot{position:relative;min-width:0;min-height:38px;padding:var(--sm-space-xs) var(--sm-space-xs) var(--sm-space-xs) var(--sm-space-2xl);border:1px dashed var(--vscode-panel-border);border-radius:var(--sm-radius-legacy-3);transition:border-color .1s,background-color .1s}.chart-layout-slot.drop-target,.chart-layout-new.drop-target{border-color:var(--vscode-focusBorder);background:var(--vscode-list-dropBackground,var(--vscode-list-hoverBackground))}.chart-layout-axis{position:absolute;left:7px;top:11px;color:var(--vscode-descriptionForeground);font:var(--sm-weight-semibold) var(--sm-font-legacy-10) var(--vscode-editor-font-family)}.chart-layout-chip{display:grid;grid-template-columns:14px minmax(0,1fr) auto;gap:var(--sm-space-xs);align-items:center;min-height:26px;padding:var(--sm-space-xs) var(--sm-space-xs);border-radius:var(--sm-radius-legacy-3);background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);cursor:grab}.chart-layout-chip:active{cursor:grabbing}.chart-layout-chip:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:2px}.chart-layout-chip.dragging{opacity:.45}.chart-layout-chip span:nth-child(2){overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.chart-layout-chip small{font-size:var(--sm-font-legacy-10);opacity:.8}.chart-layout-handle{color:inherit}.chart-layout-empty{display:flex;min-height:26px;align-items:center;color:var(--vscode-descriptionForeground);font-size:var(--sm-font-caption)}.chart-layout-new{display:flex;align-items:center;justify-content:center;flex:0 0 220px;min-height:76px;padding:var(--sm-space-md);border:1px dashed var(--vscode-panel-border);border-radius:var(--sm-radius-md);color:var(--vscode-descriptionForeground);transition:border-color .1s,background-color .1s}.chart-legend{position:absolute;left:0;top:0;z-index:3;width:100%;pointer-events:none;font-size:var(--sm-font-small)}.chart-legend:empty{display:none}.chart-legend-group{position:absolute;left:0;width:100%;pointer-events:auto}.chart-legend-title{flex:0 0 auto;min-width:58px;padding-top:var(--sm-space-xs);color:var(--vscode-descriptionForeground);font-weight:var(--sm-weight-semibold)}.chart-legend-items{display:flex;align-items:center;flex:1;min-width:0}.chart-navigation{gap:var(--sm-space-sm)}.view-range,.clip-range{white-space:nowrap}.clip-controls{display:flex;align-items:center;gap:var(--sm-space-xs);flex-wrap:wrap}.clip-controls[hidden]{display:none}.clip-edge-label{font-size:var(--sm-font-small);color:var(--vscode-descriptionForeground)}.chart-canvas-wrap{position:relative;flex:1;min-height:300px;overflow:auto}.chart-canvas-wrap canvas{display:block}.chart-markers{position:absolute;left:0;top:0;pointer-events:none}.chart-tooltip,.chart-marker-tooltip{position:absolute;z-index:10;max-width:520px;max-height:320px;overflow:auto;padding:var(--sm-space-md) var(--sm-space-md);background:var(--vscode-editorHoverWidget-background,var(--vscode-editor-background));border:1px solid var(--vscode-editorHoverWidget-border,var(--vscode-panel-border));box-shadow:0 3px 10px #0006;font-size:var(--sm-font-small)}.chart-tooltip{pointer-events:none}.chart-marker-tooltip{pointer-events:auto;cursor:pointer;outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}.chart-tooltip div,.chart-marker-tooltip div{margin-top:var(--sm-space-xs);white-space:nowrap}
  .chart-navigation[hidden],.range-controls[hidden]{display:none}.range-controls{display:flex;align-items:center;gap:var(--sm-space-sm);flex-wrap:wrap;border-left:3px solid var(--vscode-focusBorder);background:color-mix(in srgb,var(--vscode-focusBorder) 7%,var(--vscode-editor-background))}.range-controls>strong,.clip-edge-label{white-space:nowrap}.range-controls .clip-range{flex:1 1 220px;min-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.range-actions{flex:0 0 auto}.clip-clear{min-width:28px;padding-inline:var(--sm-space-md)}
  .trajectory-layout{display:flex;flex:1;min-height:0}.trajectory-pane{width:250px;flex:0 0 250px;overflow:auto;padding:var(--sm-space-md);border-right:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background,var(--vscode-editor-background))}.trajectory-pane>input,.trajectory-pane>label,.trajectory-pane>button{display:block;width:100%;margin-bottom:var(--sm-space-md)}.trajectory-pane [hidden]{display:none}.trajectory-pane label{font-size:var(--sm-font-small)}.trajectory-pane label select,.trajectory-pane label input[type=number]{display:block;width:100%;margin-top:var(--sm-space-xs)}.trajectory-checks{display:grid;grid-template-columns:1fr 1fr;gap:var(--sm-space-md);margin:var(--sm-space-xs) 0 var(--sm-space-lg)}.trajectory-checks label{white-space:nowrap}.trajectory-main{display:flex;flex:1;min-width:0;min-height:0;flex-direction:column}.trajectory-camera-controls{display:flex;gap:var(--sm-space-md)}.trajectory-camera-controls[hidden]{display:none}.trajectory-canvas-wrap{position:relative;flex:1;min-height:280px;overflow:hidden}.trajectory-canvas-wrap canvas{display:block}.trajectory-canvas-wrap canvas.mode-3d{cursor:grab}.trajectory-canvas-wrap canvas.point-hover:not(.dragging){cursor:pointer}.trajectory-canvas-wrap canvas.mode-3d.dragging{cursor:grabbing}.trajectory-interaction-hint{white-space:nowrap}.trajectory-playback{display:flex;align-items:center;gap:var(--sm-space-md);padding:var(--sm-space-md) var(--sm-space-md);border-top:1px solid var(--vscode-panel-border)}.trajectory-playback .play-seek{flex:1;min-width:100px}.trajectory-playback output{font-family:var(--vscode-editor-font-family);font-size:var(--sm-font-small);text-align:center}
  .trajectory-legend{flex:0 0 auto}.trajectory-legend:empty{display:none}
  .trajectory-canvas-wrap canvas.measurement-mode:not(.dragging){cursor:crosshair}.trajectory-measurement{display:flex;align-items:center;gap:var(--sm-space-md);min-height:35px;padding:var(--sm-space-xs) var(--sm-space-md);border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-editorGroupHeader-tabsBackground,var(--vscode-editor-background));font-size:var(--sm-font-small)}.trajectory-measurement[hidden]{display:none}.trajectory-measurement-value{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--vscode-editor-font-family)}.trajectory-measurement button{flex:0 0 auto}
  .chart-source-actions{display:grid;gap:var(--sm-space-sm);padding:var(--sm-space-md) var(--sm-space-md) 0}.chart-source-actions button{width:100%}
  .remove-source .codicon{font-size:var(--sm-font-heading)}.external-import-host{padding:0 var(--sm-space-md)}.external-import-card{margin-top:var(--sm-space-sm);padding:var(--sm-space-md);border:1px solid var(--vscode-panel-border);border-radius:var(--sm-radius-md);background:var(--vscode-sideBar-background,var(--vscode-editor-background));font-size:var(--sm-font-small)}.external-import-card>strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-bottom:var(--sm-space-md)}.external-field-label{display:block;margin:var(--sm-space-md) 0 var(--sm-space-xs);color:var(--vscode-descriptionForeground)}.external-import-card>select{width:100%}.external-columns-label{margin-top:var(--sm-space-md)}.external-column-list{max-height:170px;overflow:auto}.external-column-row{display:grid;grid-template-columns:minmax(0,1fr) 66px;gap:var(--sm-space-sm);align-items:center;padding:var(--sm-space-2xs) 0}.external-column-row label{display:flex;gap:var(--sm-space-xs);align-items:center;min-width:0;cursor:pointer}.external-column-row label span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.external-column-row input[type=text]{width:66px;min-width:0}.external-import-actions{display:flex;gap:var(--sm-space-sm);margin-top:var(--sm-space-md)}.external-import-actions button{flex:1}.external-import-actions button:disabled{opacity:.55;cursor:default}.external-import-note{margin:var(--sm-space-md) 0 0;line-height:1.3}
  .signal-change-numeric{background:color-mix(in srgb,var(--vscode-charts-yellow,#d7ba7d) var(--signal-change-strength),transparent)}
  .signal-change-state{background:color-mix(in srgb,var(--vscode-charts-purple,#b48ead) 22%,transparent);box-shadow:inset 2px 0 color-mix(in srgb,var(--vscode-charts-purple,#b48ead) 65%,transparent)}
  .signal-change-recovery{position:relative}.signal-change-recovery::after{content:"";position:absolute;top:3px;right:3px;width:4px;height:4px;border-radius:var(--sm-radius-round);background:var(--vscode-charts-blue,#69b8f0);pointer-events:none}
.last-values{display:flex;flex-direction:column;flex:0 0 auto;min-height:0;max-height:none;padding:0;border:0;overflow:hidden;background:var(--vscode-sideBar-background,var(--vscode-editor-background))}.trace-toggle{display:flex;align-items:center;gap:var(--sm-space-xs);flex:0 0 auto;min-height:30px;padding:var(--sm-space-sm) var(--sm-space-md);border:0;border-radius:0;background:transparent;text-align:left;font-weight:var(--sm-weight-semibold);cursor:pointer}.trace-toggle .codicon{font-size:var(--sm-font-heading)}.trace-data{flex:1;min-height:0;overflow:auto}.trace-data[hidden]{display:none}.trace-data>.last-value-mode{margin:var(--sm-space-sm) var(--sm-space-md)}.trace-playback{display:flex;align-items:center;gap:var(--sm-space-md);flex:0 0 auto;min-width:0;padding:var(--sm-space-xs) var(--sm-space-md) var(--sm-space-sm);background:var(--vscode-sideBar-background,var(--vscode-editor-background));z-index:2}.trace-playback-actions{display:flex;align-items:center;gap:var(--sm-space-2xs);flex:0 0 auto;min-height:28px}.trace-time{font:var(--sm-font-small) var(--vscode-editor-font-family);font-variant-numeric:tabular-nums;color:var(--sm-trace-color);flex:0 1 15ch;min-width:8ch;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.trace-seek{display:block;appearance:none;-webkit-appearance:none;flex:1 1 120px;min-width:40px;width:0;height:28px;margin:0;padding:0;border:0;border-radius:0;background:linear-gradient(to right,var(--sm-trace-color) 0 var(--trace-progress,0%),var(--vscode-scrollbarSlider-background,#666) var(--trace-progress,0%) 100%) center / calc(100% - 16px) 4px no-repeat;cursor:pointer}.trace-seek::-webkit-slider-runnable-track{height:4px;border:0;background:transparent}.trace-seek::-webkit-slider-thumb{appearance:none;-webkit-appearance:none;width:16px;height:16px;margin-top:-6px;border:0;border-radius:var(--sm-radius-round);background:var(--sm-trace-color)}.trace-seek:disabled{opacity:.55;cursor:default}.trace-range-end{flex:0 1 15ch;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font:var(--sm-font-small) var(--vscode-editor-font-family);font-variant-numeric:tabular-nums;color:var(--vscode-descriptionForeground)}.trace-speed{flex:0 0 60px;width:60px;padding:var(--sm-space-xs)}.visualize-content{container-type:inline-size}@container (max-width:520px){.trace-range-end{display:none}.trace-playback{gap:var(--sm-space-xs)}.trace-time{flex-basis:12ch}.trace-speed{flex-basis:54px;width:54px}}.trace-splitter{flex:0 0 6px;cursor:row-resize;touch-action:none;background:var(--vscode-panel-border);position:relative}.trace-splitter[hidden]{display:none}.trace-splitter:hover,.trace-splitter:focus-visible,.resizing-trace>.trace-splitter{background:var(--vscode-focusBorder)}.trace-splitter:focus-visible{outline:1px solid var(--vscode-focusBorder)}.resizing-trace{user-select:none;cursor:row-resize}.resizing-trace .visualize-list{pointer-events:none}.last-values table{border-collapse:collapse;width:100%;font-size:var(--sm-font-small)}.last-values td,.last-values th{text-align:left;white-space:nowrap;padding:var(--sm-space-sm) var(--sm-space-md);border-bottom:1px solid var(--vscode-panel-border)}.last-values th{position:sticky;top:0;background:var(--vscode-editor-background)}.visualize-list{flex:1;min-height:0;overflow:auto;padding:0;display:flex;flex-direction:column;gap:var(--sm-space-lg)}.visualize-card{flex:0 0 auto;margin:0 var(--sm-space-lg);border:1px solid var(--vscode-panel-border);border-radius:var(--sm-radius-card);overflow:hidden;min-height:380px;height:470px;resize:vertical;display:flex;flex-direction:column}.visualize-card-header{display:flex;flex-wrap:wrap;flex:0 0 auto;align-items:center;gap:var(--sm-space-sm);padding:var(--sm-space-md) var(--sm-space-md);border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-editorGroupHeader-tabsBackground)}.visualize-card-header input{flex:1 1 100px;width:100px;min-width:60px;font-weight:var(--sm-weight-semibold);border:0;background:transparent}.visualize-card-body{display:flex;flex:1;min-height:0;flex-direction:column}.visualize-card-body>.chart-layout,.visualize-card-body>.trajectory-layout{min-height:0;flex:1}.visualize-card-header button{font-size:var(--sm-font-caption)}.visualize-workspace{display:flex;flex:1;min-height:0;min-width:0}.visualize-content{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0}.visualize-options{flex:0 0 310px;width:310px;max-width:42%;min-width:240px;overflow:auto;border-left:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background,var(--vscode-editor-background))}.visualize-options[hidden],.view-specific-options[hidden],.options-empty[hidden]{display:none}.visualize-options>header{padding:var(--sm-space-lg);border-bottom:1px solid var(--vscode-panel-border)}.options-target{display:flex;flex-direction:column;gap:var(--sm-space-sm);padding:var(--sm-space-lg);font-size:var(--sm-font-small)}.options-target select{width:100%;min-width:0}.options-empty{padding:0 var(--sm-space-lg)}.view-header-actions{display:flex;align-items:center;gap:var(--sm-space-2xs)}.view-settings>.view-toolbar{padding:var(--sm-space-lg);align-items:flex-start;gap:var(--sm-space-md)}.view-settings>.view-toolbar>.spacer{display:none}.view-settings .chart-axis-global{flex-wrap:wrap}.view-settings .chart-pane,.view-settings .trajectory-pane{width:100%;border:0;overflow:visible}.view-settings .chart-pane{display:block!important}.view-settings .pane-toggle{display:none}.visualize-card-body .pane-separator{display:none}.view-settings .chart-layout-cards{flex-direction:column;overflow:visible}.view-settings .chart-layout-card,.view-settings .chart-layout-new{flex:auto;width:100%}.view-settings .chart-layout-editor-head{flex-wrap:wrap}.view-settings .trajectory-tracks{display:grid;grid-template-columns:1fr;gap:var(--sm-space-md);margin-bottom:var(--sm-space-lg)}.view-settings .trajectory-tracks select,.view-settings .trajectory-tracks input{width:100%;min-width:0}.visualize-card.view-unconfigured .visualize-card-body,.visualize-card.view-unconfigured canvas{cursor:pointer}.visualize-card.options-editing{border-color:var(--vscode-focusBorder)}
.selector-signal.option-revealed,.trajectory-track-card.option-revealed{animation:sm-option-reveal 1.6s ease-out}
@keyframes sm-option-reveal{0%,35%{background:color-mix(in srgb,var(--vscode-focusBorder) 30%,transparent)}100%{background:transparent}}.visualize-card-header .visualize-card-title{text-align:left;font-size:var(--sm-font-body);font-weight:var(--sm-weight-semibold);background:transparent;border:0;color:var(--vscode-foreground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.visualize-card-title:focus-visible{outline:1px solid var(--vscode-focusBorder)}
.view-resizer{flex:0 0 6px;height:6px;cursor:row-resize;touch-action:none;background:var(--vscode-panel-border)}.view-resizer:hover,.view-resizer:focus-visible{background:var(--vscode-focusBorder)}.visualize-card{resize:none;min-height:0}
.last-value-table{width:max-content;min-width:100%}.last-values table{border-collapse:separate;border-spacing:0;font-size:var(--sm-font-caption);line-height:16px;font-variant-numeric:tabular-nums}.last-values td,.last-values th{padding:var(--sm-space-xs) var(--sm-space-sm)}.last-values th{z-index:2}.last-values .trace-fixed{position:sticky;z-index:1;background:var(--vscode-editor-background)}.last-values th.trace-fixed{z-index:3}.last-values .trace-fixed-edge{box-shadow:1px 0 var(--vscode-panel-border)}.last-values .trace-pin-column{text-align:center}.last-values .trace-pin-column input{display:block;appearance:auto;width:13px;height:13px;margin:0 auto;padding:0;cursor:pointer}.trace-pin-column .codicon{font-size:var(--sm-font-body);vertical-align:middle}.trace-name>div{width:118px;overflow:hidden;text-overflow:ellipsis}
.last-values .trace-sort{display:flex;align-items:center;justify-content:space-between;gap:var(--sm-space-xs);width:100%;min-height:16px;margin:0;padding:0;border:0;border-radius:0;background:transparent;color:inherit;font:inherit;cursor:pointer}.trace-sort-indicator{flex:0 0 12px;font-size:var(--sm-font-small)}.trace-sort:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:1px}
.trace-pinned-end>td{border-bottom:2px solid var(--vscode-focusBorder)}.last-values tbody>tr:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}.trace-values{min-width:300px;font-family:var(--vscode-editor-font-family)}.trace-signals{display:flex;align-items:baseline;gap:var(--sm-space-lg)}.trace-signal{white-space:nowrap}.trace-signal.carried{opacity:.6;font-style:italic}

.visualize-card:first-child{margin-top:var(--sm-space-lg)}.visualize-card:last-child{margin-bottom:var(--sm-space-lg)}
.visualize-card[data-kind=graph]{height:auto;min-height:0;resize:none}
.visualize-card[data-kind=graph] .visualize-card-body,.visualize-card[data-kind=graph] .chart-layout,.visualize-card[data-kind=graph] .chart-main{flex:0 0 auto}
.visualize-card[data-kind=graph] .chart-main{width:100%}
.visualize-card .chart-canvas-wrap{flex:0 0 auto;min-height:0;overflow:hidden}
.visualize-card .trajectory-canvas-wrap{min-height:0}
.visualize-card-actions{display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:var(--sm-space-sm);min-width:0;max-width:100%}
.visualize-card-actions .view-toolbar{padding:0;min-height:0;border-bottom:0}
.visualize-card-actions .view-range{display:none}
.visualize-card-actions .range-controls{font-size:var(--sm-font-caption);max-width:100%;padding:var(--sm-space-xs)}
.visualize-card-actions .range-controls .clip-range{flex:1 1 100px;min-width:0}
.visualize-card-actions .spacer{display:none}
.visualize-card-actions .chart-navigation button.icon-button{margin-left:0}
.visualize-card-actions>.view-action-group{display:flex;align-items:center;gap:var(--sm-space-2xs);min-width:0;max-width:100%;flex-wrap:wrap;padding:0;border:0;margin:0}.visualize-card-actions>.view-action-group[hidden]{display:none}.visualize-card-actions>.view-action-group:not([hidden])~.view-action-group:not([hidden]){border-left:1px solid var(--vscode-panel-border);padding-left:var(--sm-space-sm)}.visualize-card-actions .chart-navigation,.visualize-card-actions .chart-navigation>.segmented{gap:var(--sm-space-2xs)}.visualize-card-actions .range-controls[hidden]{display:none}

.visualize-card .trajectory-playback{flex-wrap:wrap}
.tabs .view-scope-control{display:flex;flex-direction:row;align-items:center;gap:var(--sm-space-sm);margin-right:var(--sm-space-md);font-size:var(--sm-font-small)}.tabs .view-scope-control[hidden]{display:none}.tabs .spacer{flex:1}
#source-breadcrumb{font-weight:var(--sm-weight-semibold);color:var(--vscode-descriptionForeground)}
.chart-axis-row{display:flex;align-items:center;gap:var(--sm-space-sm)}.chart-axis-row>span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}.chart-layout-cards{flex-direction:column}
.visualize-options>header{display:flex;align-items:center;justify-content:space-between;gap:var(--sm-space-md)}.options-view-name{padding:var(--sm-space-md) var(--sm-space-lg);overflow-wrap:anywhere}.visualize-card-header:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}
.view-settings .toolbar-secondary{display:none}
.visualize-options>header{padding:var(--sm-space-sm) var(--sm-space-md)}.options-view-name{display:flex;align-items:center;gap:var(--sm-space-sm);min-width:0;padding:var(--sm-space-md);border-bottom:1px solid var(--vscode-panel-border);font-size:var(--sm-font-section);font-weight:var(--sm-weight-semibold);color:var(--vscode-foreground)}.options-view-name:empty{display:none}.options-view-name>.codicon{flex:0 0 auto;color:var(--vscode-descriptionForeground)}.options-view-name>span:last-child{min-width:0;overflow-wrap:anywhere}.options-view-name>.options-view-title{flex:1 1 auto;min-width:0;width:100%;font-size:var(--sm-font-section);font-weight:var(--sm-weight-semibold);background:transparent;border:1px solid transparent;color:var(--vscode-foreground);padding:var(--sm-space-2xs) var(--sm-space-xs)}.options-view-name>.options-view-title:hover{border-color:var(--vscode-input-border,var(--vscode-panel-border))}.options-view-name>.options-view-title:focus{background:var(--vscode-input-background);border-color:var(--vscode-focusBorder);outline:none}
.view-settings .signal-selector{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:var(--sm-space-sm);padding:var(--sm-space-md) var(--sm-space-md)}
.view-settings .signal-selector>input{grid-column:1/-1;order:-1}
.view-settings .selector-controls{grid-column:1/-1;margin:0}
.view-settings .selector-group,.view-settings .signal-selector>p{grid-column:1/-1;margin:0}
.view-settings .chart-source-actions{padding:0 var(--sm-space-md) var(--sm-space-sm)}.view-settings .chart-source-actions button{font-size:var(--sm-font-caption);background:transparent;border:0;color:var(--vscode-textLink-foreground,var(--vscode-foreground))}
.display-settings{max-height:none;overflow:visible;border-top:0;border-bottom:1px solid var(--vscode-panel-border);margin:0 0 var(--sm-space-xs);padding:0 var(--sm-space-md);font-size:var(--sm-font-small)}.display-settings[open]{padding-bottom:var(--sm-space-md)}
.display-settings>summary{padding:var(--sm-space-md) 0;cursor:pointer;font-weight:var(--sm-weight-semibold)}.display-settings>.view-toolbar{padding:var(--sm-space-xs) 0;min-height:0;border:0;gap:var(--sm-space-md);align-items:flex-start}.display-settings .spacer{display:none}.display-settings .view-toolbar,.display-settings .segmented,.display-settings .chart-axis-global{min-width:0;max-width:100%;flex-wrap:wrap;overflow:visible}
.trajectory-drawing-group{display:flex;flex-wrap:wrap;gap:var(--sm-space-md) var(--sm-space-lg);min-width:0;margin:0;padding:var(--sm-space-md) 0 var(--sm-space-lg);border:0}.trajectory-drawing-group+.trajectory-drawing-group{border-top:1px solid var(--vscode-panel-border)}.trajectory-drawing-group>legend{padding:0;color:var(--vscode-descriptionForeground);font-size:var(--sm-font-caption)}.trajectory-drawing-group>label{display:block;min-width:0;flex:1 1 100%}.trajectory-drawing-group select,.trajectory-drawing-group input[type=number]{display:block;width:100%;min-width:0;margin-top:var(--sm-space-xs)}.trajectory-axis-settings>label,.trajectory-data-settings>label{display:flex;align-items:center;gap:var(--sm-space-xs);flex:0 1 auto;white-space:nowrap}.trajectory-axis-settings>.equal-aspect-label{flex-basis:100%}.trajectory-drawing-group input[type=checkbox]{margin:0}.trajectory-drawing-group [hidden]{display:none}
.display-settings>label{display:block;margin-bottom:var(--sm-space-md)}.display-settings>label select,.display-settings>label input[type=number]{display:block;width:100%;margin-top:var(--sm-space-xs)}.display-settings [hidden]{display:none}
.view-settings .trajectory-pane{padding:var(--sm-space-md) var(--sm-space-md)}.view-settings .trajectory-tracks{display:flex;flex-direction:column;gap:var(--sm-space-md);margin:0 0 var(--sm-space-md)}
.trajectory-track-card{min-width:0;border-bottom:1px solid var(--vscode-panel-border);padding-bottom:var(--sm-space-md)}
.trajectory-track-header{display:flex;align-items:center;gap:var(--sm-space-sm);margin-bottom:var(--sm-space-xs)}.trajectory-track-color{flex:0 0 8px;width:8px;height:8px;border-radius:var(--sm-radius-round)}
.trajectory-track-header .trajectory-track-name{flex:1;min-width:0;width:0;font-weight:var(--sm-weight-semibold);border:0;background:transparent;padding:var(--sm-space-xs)}
.trajectory-track-header .trajectory-track-name:focus-visible{outline:1px solid var(--vscode-focusBorder)}
.trajectory-pane .trajectory-axis-row{display:grid;grid-template-columns:18px minmax(0,1fr);align-items:center;gap:var(--sm-space-sm);margin:var(--sm-space-xs) 0 0}
.trajectory-pane .trajectory-axis-row select{min-width:0;margin:0;width:100%}.trajectory-add-track{display:flex!important;align-items:center;justify-content:center;gap:var(--sm-space-xs);margin-bottom:0!important}

.range-edge{display:inline-flex;align-items:center;gap:var(--sm-space-2xs);white-space:nowrap}.range-controls{border-left:0;background:transparent;gap:var(--sm-space-sm)}.visualize-card-actions .range-controls{padding:0}.visualize-card-actions .range-controls>strong,.visualize-card-actions .range-controls>.clip-range{display:none}.range-actions,.range-edge>.segmented{gap:var(--sm-space-2xs)}.add-view{display:inline-flex;align-items:center;gap:var(--sm-space-xs)}.visualize-card{position:relative}.visualize-card-nodata{display:none;color:var(--vscode-descriptionForeground);font-size:var(--sm-font-small)}.visualize-card.view-no-data .visualize-card-nodata{display:inline}.visualize-card.view-no-data .visualize-card-body,.visualize-card.view-no-data .view-resizer{display:none}.visualize-card.view-no-data{height:auto!important;min-height:0}.visualize-card.view-no-data .visualize-card-header{border-bottom:0}.visualize-card.view-no-data .visualize-card-header input{flex:0 0 auto;width:var(--title-width,120px);max-width:60%}.visualize-card .visualize-card-actions{visibility:hidden}.visualize-card:hover .visualize-card-actions,.visualize-card-actions:has(:focus-visible){visibility:visible}/* Like a notebook cell's toolbar: the actions sit on the card's top edge, outside the legend, and show on hover. */.visualize-card.title-inline{overflow:visible}.visualize-card.title-inline>.visualize-card-body{overflow:hidden;border-radius:var(--sm-radius-card)}.visualize-card.title-inline .visualize-card-header{position:absolute;top:-17px;right:var(--sm-space-lg);z-index:7;padding:0;border:0;background:transparent;flex-wrap:nowrap;pointer-events:none}.visualize-list{padding-top:var(--sm-space-md)}.visualize-card.title-inline .visualize-card-actions{pointer-events:auto;flex-wrap:nowrap;padding:0 var(--sm-space-xs);border:1px solid var(--vscode-widget-border,var(--vscode-panel-border));border-radius:var(--sm-radius-card);background:var(--vscode-editorWidget-background,var(--vscode-editor-background));box-shadow:0 2px 8px rgba(0,0,0,.28)}.chart-legend .visualize-card-title,.trajectory-legend .visualize-card-title{flex:0 0 auto;width:var(--title-width,120px);max-width:100%;margin:0 var(--sm-space-sm) 0 0;padding:var(--sm-space-2xs) var(--sm-space-xs);text-align:left;font-size:var(--sm-font-body);font-weight:var(--sm-weight-semibold);background:transparent;border:0;color:var(--vscode-foreground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.visualize-view>.view-toolbar .icon-text-button,.view-toolbar .visualize-range .icon-text-button{margin:0}.visualize-range{padding:0;flex-wrap:nowrap}.visualize-range .clip-range{flex:0 0 auto}.visualize-range[hidden],.visualize-zoom-all[hidden],.range-zoom-own[hidden],.zoom-in[hidden],.zoom-out[hidden],.zoom-all-in[hidden],.zoom-all-out[hidden]{display:none}.visualize-range .clip-range{white-space:nowrap}.add-view .codicon{font-size:var(--sm-font-heading)}.visualize-context-menu{max-height:calc(100vh - 8px);max-width:calc(100vw - 8px);min-width:210px;overflow:auto;border-radius:var(--sm-radius-menu)}.visualize-context-menu button{display:flex;align-items:center;gap:var(--sm-space-md);min-height:28px;padding:var(--sm-space-xs) var(--sm-space-md);font-size:var(--sm-font-small);border:0;border-radius:var(--sm-radius-legacy-3)}.visualize-context-menu button .codicon{flex:0 0 16px;font-size:var(--sm-font-heading)}.visualize-context-menu button:disabled{opacity:.4;background:transparent;cursor:default}.visualize-context-menu button:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px;background:var(--vscode-menu-selectionBackground,var(--vscode-list-hoverBackground))}.visualize-context-menu [role=separator]{height:1px;background:var(--vscode-menu-separatorBackground,var(--vscode-panel-border));margin:var(--sm-space-xs) var(--sm-space-sm)}
${ICON_BUTTON_STYLES}
${DATA_TABLE_STYLES}${CHOICE_GROUP_STYLES}${SIGNAL_LEGEND_STYLES}${COMPONENT_STYLES}</style>
<div id="source-breadcrumb" class="toolbar"></div><nav class="tabs" aria-label="${t('Log views', 'ログ表示')}"><button class="tab active" data-view="raw-view">${t('Raw Log', 'RAWログ')}</button><button class="tab" data-view="table-view">${t('Table', 'テーブル')}</button><button class="tab" data-view="visualize-view">Visualize</button><span class="spacer"></span><label class="view-scope-control" hidden>${t('View settings', '表示設定')} <select id="view-settings-scope" aria-label="${t('Where view settings are saved', '表示設定の保存先')}"><option value="file">${t('This file', 'ファイル個別')}</option><option value="group">${t('Shared in group', 'グループ共通')}</option></select></label></nav><div id="clip-scope" class="toolbar muted" hidden></div>
<section id="raw-view" class="view"><div class="toolbar">
  <div id="search-box" class="search-box grow"><input id="search" type="search" placeholder="${t('Keyword', 'キーワード')}" aria-label="${t('Filter RAW Log by Frame name, Signal, CAN ID, or data', 'フレーム名・シグナル名・CAN ID・データのキーワードでRAWログを絞り込み')}"><button id="search-regex" type="button" title="${t('Use Regular Expression', '正規表現を使用')}" aria-label="${t('Use Regular Expression', '正規表現を使用')}" aria-pressed="false">.*</button></div>
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
<section id="table-view" class="view" hidden></section><section id="visualize-view" class="view" hidden></section><div id="context-menu" class="context-menu" hidden></div>`;

const grid = document.getElementById('grid')!;
const header = document.getElementById('header')!;
const sizer = document.getElementById('sizer')!;
const windowEl = document.getElementById('window')!;
bindColumnHover(grid, (element) => element.closest<HTMLElement>('[data-column-index]')?.dataset.columnIndex, (column) => header.querySelectorAll<HTMLElement>(`.head[data-column-index="${column}"]`));
styleIconButton(document.getElementById('search-regex') as HTMLButtonElement, 'regex', t('Use Regular Expression', '正規表現を使用'));
const statusEl = document.getElementById('status')!;
const resultStatusEl = document.getElementById('result-status')!;
const cancelButton = document.getElementById('cancel') as HTMLButtonElement;

function displayWidths(): Readonly<Record<string, number>> { return fitColumnsToView(columns, widths, grid.clientWidth); }
function template(): string { const visible = displayWidths(); return columns.map((column) => `${Math.round(visible[column.id])}px`).join(' '); }
function totalWidth(): number { const visible = displayWidths(); return columns.reduce((sum, column) => sum + visible[column.id], 0); }
/** Column widths also go to the saved view settings, so they survive closing the log. */
function persist(): void { vscode.setState({ widths, regexEnabled, contentMode }); if (tableView) saveLogViewState({ rawWidths: { ...widths } }); }

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
    const cell = document.createElement('div'); cell.className = `head${columnIndex < 4 ? ' sticky-col' : ''}${columnIndex === 3 ? ' sticky-edge' : ''}`; cell.dataset.columnIndex = String(columnIndex); cell.classList.toggle('table-number', ['time', 'dlc', 'length'].includes(columns[columnIndex].id)); cell.classList.toggle('table-name', columns[columnIndex].id === 'name'); cell.classList.toggle('table-center', ['channel', 'direction'].includes(columns[columnIndex].id)); cell.title = column.label; cell.textContent = column.label; cell.setAttribute('role', 'columnheader');
    const handle = document.createElement('span'); handle.className = 'resize'; handle.setAttribute('aria-hidden', 'true');
    handle.addEventListener('mousedown', (event) => {
      event.preventDefault(); const start = event.clientX; const initial = widths[column.id];
      const move = (next: MouseEvent) => { widths[column.id] = Math.max(column.minWidth, Math.min(column.maxWidth, initial + next.clientX - start)); applyWidths(); };
      const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); persist(); };
      window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    });
    handle.addEventListener('dblclick', () => requestAutoFit(column.id));
    bindResizeKeyboard(handle, { label: column.label, width: () => widths[column.id], setWidth: (width) => { widths[column.id] = Math.max(column.minWidth, Math.min(column.maxWidth, width)); applyWidths(); persist(); }, fit: () => requestAutoFit(column.id) });
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
  else for (const [index, tag] of row.decodedContent.split('  ·  ').entries()) { const chip = document.createElement('span'); chip.className = 'tag'; const separator = tag.indexOf('='); if (separator < 0) chip.textContent = tag; else appendTableValue(chip, tag.slice(0, separator), tag.slice(separator + 1), ' = '); const detail = row.decodedSignals?.[index]; if (detail && detail.tag === tag) bindDecodedInspection(chip, row, detail); line.appendChild(chip); }
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
  hideDecodedInspection();
  grid.setAttribute('aria-rowcount', String(total)); sizer.style.height = `${total * ROW_HEIGHT}px`;
  const range = computeVirtualRange(total, grid.scrollTop, grid.clientHeight - header.clientHeight, ROW_HEIGHT);
  const gridTemplate = template(); const offsets = stickyOffsets(); windowEl.style.transform = `translateY(${range.start * ROW_HEIGHT}px)`; windowEl.replaceChildren();
  for (let index = range.start; index < range.end; index++) {
    const row = rows.get(index); const selected = selectionContains(selectionRanges, index); const rowEl = document.createElement('div'); rowEl.className = `row${selected ? ' selected' : ''}${row?.diagnostics.length ? ' row-warning' : ''}`; rowEl.style.gridTemplateColumns = gridTemplate; rowEl.setAttribute('role', 'row'); rowEl.setAttribute('aria-selected', String(selected)); rowEl.dataset.rowIndex = String(index); rowEl.tabIndex = focusedIndex === index ? 0 : -1;
    const values = row ? displayValues(row) : ['', '', t('Loading…', '読み込み中…'), '', '', '', '', ''];
    values.forEach((value, columnIndex) => {
      const cell = document.createElement('div'); cell.className = `cell${columnIndex < 4 ? ' sticky-col' : ''}${columnIndex === 3 ? ' sticky-edge' : ''}${columnIndex === 1 && row ? ` dir-${row.direction}` : ''}`; cell.dataset.columnIndex = String(columnIndex); cell.classList.toggle('table-number', ['time', 'dlc', 'length'].includes(columns[columnIndex].id)); cell.classList.toggle('table-name', columns[columnIndex].id === 'name'); cell.classList.toggle('table-center', ['channel', 'direction'].includes(columns[columnIndex].id)); if (columnIndex < 4) cell.style.left = `${offsets[columnIndex]}px`; cell.title = columnIndex === 3 && row?.diagnostics.length ? `${value || 'Unnamed frame'} · ${row.diagnostics.map((item) => item.message).join(' · ')}` : value; cell.setAttribute('role', 'cell');
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
    if (row) rowEl.dataset.loaded = 'true';
    windowEl.appendChild(rowEl);
  }
  fitVisibleColumns();
  requestRange(range.start, range.end);
}

/** No column cuts off what is on screen: widen any column whose header or loaded cells overflow. */
function fitVisibleColumns(): void {
  const visible = displayWidths(); let changed = false;
  columns.forEach((column, index) => {
    const cells = [...Array.from(header.querySelectorAll<HTMLElement>(`.head[data-column-index="${index}"]`)), ...Array.from(windowEl.querySelectorAll<HTMLElement>(`.row[data-loaded] .cell[data-column-index="${index}"]`))];
    const width = widthToFit(cells, visible[column.id]);
    if (width !== undefined) { widths[column.id] = width; changed = true; }
  });
  if (changed) applyWidths();
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

function measure(text: string): number { return measureTableText(text); }

const autoFitRequests = new Map<number, { readonly target?: string }>();
function requestAutoFit(target?: string, sampleFilter: FrameFilter | null = filter): void {
  const fitRequestId = ++requestId; autoFitRequests.set(fitRequestId, { target });
  vscode.postMessage({ type: 'autoFitSampleRequest', requestId: fitRequestId, filter: sampleFilter ?? undefined });
}
function requestAutomaticWidths(frames: number): void {
  if (!automaticWidthsPending || frames < 1) return;
  automaticWidthsPending = false; requestAutoFit();
}
const DIAGNOSTIC_COUNT_LIMIT = 100;
function diagnosticSpan(group: DiagnosticGroup): string {
  const { firstPosition: first, lastPosition: last } = group;
  if (first === undefined || last === undefined) return '';
  if (group.positionKind === 'line') return first === last ? `line ${first}` : `line ${first}–${last}`;
  return first === last ? `${first.toFixed(6)} s` : `${first.toFixed(6)}–${last.toFixed(6)} s`;
}
/** One grouped line is one diagnostic, so the count always matches the list. */
function diagnosticTotal(): number { return sourceDiagnosticGroups.length + analysisDiagnosticGroups.length; }
function showDiagnosticStatus(): void {
  if (parsing) return;
  statusEl.textContent = `${parseCancelled ? `${t('Cancelled', '中止')} · ` : ''}${diagnosticTotal().toLocaleString()} ${t('diagnostics', '件の診断')}`;
}
function showDiagnostics(): void {
  document.querySelector('#diagnostics summary')!.textContent = `${t('Diagnostics', '診断')} (${diagnosticTotal().toLocaleString()})`;
  const list = document.getElementById('diag-list')!; list.replaceChildren();
  // Identical findings are grouped for the whole log; counts of 100 or more read "100+".
  for (const group of [...sourceDiagnosticGroups, ...analysisDiagnosticGroups]) {
    const line = document.createElement('div'); line.className = `diag diag-${group.severity}`;
    const origin = [group.subject, group.owner].filter(Boolean).join(' · ');
    const count = group.count >= DIAGNOSTIC_COUNT_LIMIT ? `${DIAGNOSTIC_COUNT_LIMIT}+` : String(group.count);
    const span = diagnosticSpan(group);
    line.textContent = `${group.severity.toUpperCase()} ${group.code}${origin ? ` · ${origin}` : ''}: ${group.message} × ${count}${span ? ` (${span})` : ''}`;
    list.appendChild(line);
  }
}

function openOrRegister(row: RawRowDto): void {
  if (row.definitionId) vscode.postMessage({ type: 'openFrameDefinition', definitionId: row.definitionId });
  else vscode.postMessage({ type: 'registerFrame', canId: row.canIdValue, extended: row.extended, frameLength: row.length });
}

function showContextMenu(row: RawRowDto, x: number, y: number): void {
  const count = selectionCount(selectionRanges);
  const rowElement = windowEl.querySelector<HTMLElement>(`.row[data-row-index="${focusedIndex}"]`) ?? grid;
  showActionMenu([
    { label: count === 1 ? t('Copy Row', '行をコピー') : t(`Copy ${count} Rows`, `${count}行をコピー`), icon: 'copy', run: copySelectedRows },
    { label: count === 1 ? t('Open Row in Text Editor', '行をテキストエディタで開く') : t(`Open ${count} Rows in Text Editor`, `${count}行をテキストエディタで開く`), icon: 'go-to-file', run: openSelectedRows },
    row.definitionId ? { label: t('Open Frame Definition', 'フレーム定義を開く'), icon: 'layers', run: () => openOrRegister(row) } : { label: t('Register CAN Frame', 'CANフレームを登録'), icon: 'add', run: () => openOrRegister(row) },
  ], t('RAW Log row actions', 'RAWログの行の操作'), x, y, rowElement, { scroller: grid });
}

function saveLogViewState(partial: Partial<LogViewState>): void {
  logViewState = { ...logViewState, ...partial };
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => vscode.postMessage({ type: 'saveLogViewState', state: logViewState }), 180);
}

function postViewMessage(message: ToExtensionMessage): void {
  vscode.postMessage(message.type === 'createClip' ? { ...message, viewState: logViewState } : message);
}
document.getElementById('view-settings-scope')!.addEventListener('change', (event) => {
  window.clearTimeout(saveTimer);
  vscode.postMessage({ type: 'setViewSettingsScope', scope: (event.target as HTMLSelectElement).value as 'file' | 'group', state: logViewState });
});
function initializeSignalViews(initial: LogViewState | undefined): void {
  if (tableView || visualizeView) return;
  logViewState = initial ?? {};
  if (!saved.widths && logViewState.rawWidths) { widths = { ...widths, ...logViewState.rawWidths }; automaticWidthsPending = false; applyWidths(); }
  tableView = new SignalTableView(document.getElementById('table-view')!, logViewState, postViewMessage, saveLogViewState);
  visualizeView = new VisualizeView(document.getElementById('visualize-view')!, logViewState, postViewMessage, saveLogViewState);
  activateView(logViewState.activeTab ?? 'raw-view');
}

function activateView(id: string): void {
  document.querySelectorAll<HTMLElement>('.view').forEach((view) => { view.hidden = view.id !== id; });
  document.querySelectorAll<HTMLElement>('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.view === id));
  if (id === 'table-view') { visualizeView?.hide(); tableView?.show(); }
  else if (id === 'visualize-view') { tableView?.hide(); visualizeView?.show(); }
  else { tableView?.hide(); visualizeView?.hide(); if (id === 'raw-view') { applyWidths(); scheduleDraw(); } }
  if (id === 'raw-view' || id === 'table-view' || id === 'visualize-view') saveLogViewState({ activeTab: id });
}

window.addEventListener('message', (event: MessageEvent<ToWebviewMessage>) => {
  const message = event.data;
  tableView?.handle(message); visualizeView?.handle(message);
  if (message.type === 'init') { const scope = document.getElementById('view-settings-scope') as HTMLSelectElement; scope.parentElement!.hidden = !message.groupName; scope.value = message.viewSettingsScope ?? 'file'; syncChoiceSelect(scope); document.getElementById('source-breadcrumb')!.textContent = [message.place, message.fileName, message.clip?.name].filter(Boolean).join(' › '); initializeSignalViews(message.viewState); updateChannelOptions(message.channels); sourceFrameCount = message.frames; parsing = message.parsing; pagePending = true; cancelButton.hidden = !parsing; const clipScope = document.getElementById('clip-scope')!; clipScope.hidden = !message.clip; if (message.clip) clipScope.textContent = `${t('Clip','クリップ')}: ${message.clip.name} · ${message.clip.startTimestamp === undefined || message.clip.endTimestamp === undefined ? t('Whole file', 'ファイル全体') : `${message.clip.startTimestamp.toFixed(6)}–${message.clip.endTimestamp.toFixed(6)} s`}`; parseCancelled = false; if (parsing) statusEl.textContent = `${message.fileName} · ${t('parsing', '解析中')}`; else showDiagnosticStatus(); updateResultStatus(); updateEmptyState(); requestRange(0, PAGE_SIZE, true); if (!message.parsing) requestAutomaticWidths(message.frames); }
  else if (message.type === 'page') {
    if (message.requestId !== latestPageRequestId) return;
    total = message.total; pagePending = false; if (!activeFilterCount) unfilteredFrameCount = message.total;
    for (let i = 0; i < message.rows.length; i++) {
      const row = message.rows[i]; rows.set(message.offset + i, row);
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
  else if (message.type === 'parseComplete') { updateChannelOptions(message.channels); sourceFrameCount = message.frames; parsing = false; pagePending = true; cancelButton.hidden = true; parseCancelled = message.cancelled; showDiagnosticStatus(); showDiagnostics(); updateResultStatus(); updateEmptyState(); requestRange(0, PAGE_SIZE, true); requestAutomaticWidths(message.frames); }
  else if (message.type === 'analysisDiagnostics') {
    analysisDiagnosticGroups = message.groups;
    showDiagnostics(); showDiagnosticStatus();
  }
  else if (message.type === 'sourceDiagnostics') {
    sourceDiagnosticGroups = message.groups;
    showDiagnostics(); showDiagnosticStatus();
  }
  else if (message.type === 'autoFitSample') {
    const request = autoFitRequests.get(message.requestId); if (!request) return; autoFitRequests.delete(message.requestId);
    const fitted = autoFitColumns(columns, message.rows, measure);
    widths = request.target ? { ...widths, [request.target]: fitted[request.target] } : { ...widths, ...fitted };
    applyWidths(); persist();
  }
  else if (message.type === 'rowsCopied') showCopyFeedback(message.count);
  else if (message.type === 'definitionsChanged') { selectionRanges = []; selectionAnchor = undefined; focusedIndex = undefined; rows.clear(); pagePending = true; updateSelectionStatus(); updateResultStatus(); updateEmptyState(); showDiagnostics(); lastRequested = ''; requestRange(Math.floor(grid.scrollTop / ROW_HEIGHT), Math.floor(grid.scrollTop / ROW_HEIGHT) + PAGE_SIZE, true); }
});

grid.addEventListener('scroll', scheduleDraw);
window.addEventListener('resize', () => { applyWidths(); scheduleDraw(); });
document.getElementById('search')!.addEventListener('input', updateFilter);
const regexButton = document.getElementById('search-regex')!; regexButton.classList.toggle('active', regexEnabled); regexButton.setAttribute('aria-pressed', String(regexEnabled)); regexButton.addEventListener('click', () => { regexEnabled = !regexEnabled; regexButton.classList.toggle('active', regexEnabled); regexButton.setAttribute('aria-pressed', String(regexEnabled)); persist(); updateFilter(); });
document.getElementById('direction')!.addEventListener('change', updateFilter);
document.getElementById('decoded')!.addEventListener('change', updateFilter);
document.getElementById('channel')!.addEventListener('change', updateFilter);
for (const id of ['time-start', 'time-end']) attachNumberStepper(document.getElementById(id) as HTMLInputElement);
document.getElementById('time-start')!.addEventListener('input', updateFilter);
document.getElementById('time-end')!.addEventListener('input', updateFilter);
document.getElementById('raw-empty-clear')!.addEventListener('click', clearAllFilters);
function updateContentModeButtons(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-content-mode]').forEach((button) => { const active = button.dataset.contentMode === contentMode; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); });
  const search = document.getElementById('search') as HTMLInputElement;
  const description = contentMode === 'raw' ? t('Filter by Frame name, CAN ID, or RAW data', 'フレーム名・CAN ID・RAWデータで絞り込み') : t('Filter by Frame name, Signal, CAN ID, or displayed data', 'フレーム名・シグナル名・CAN ID・表示データで絞り込み');
  search.setAttribute('aria-label', description);
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
  const target = event.target as HTMLElement | null; const editing = target?.matches('input,select,textarea,button,[contenteditable=true]') ?? false;
  const menu = document.getElementById('context-menu')!;
  if (event.key === 'Escape' && !menu.hidden) { event.preventDefault(); menu.hidden = true; windowEl.querySelector<HTMLElement>(`.row[data-row-index="${focusedIndex}"]`)?.focus(); }
  else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c' && selectionRanges.length && !editing) { event.preventDefault(); copySelectedRows(); }
  else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a' && (focusedIndex !== undefined || target === grid) && !editing) { event.preventDefault(); selectionRanges = total ? [{ start: 0, end: total - 1 }] : []; selectionAnchor = 0; focusedIndex = total ? 0 : undefined; refreshSelectionStyles(); }
  else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && (focusedIndex !== undefined || target === grid) && !editing) { event.preventDefault(); const start = focusedIndex ?? (event.key === 'ArrowDown' ? -1 : total); moveRowFocus(start + (event.key === 'ArrowDown' ? 1 : -1), event.shiftKey); }
  else if (event.key === 'Enter' && focusedIndex !== undefined && !editing) { const row = rows.get(focusedIndex); if (row) { event.preventDefault(); openOrRegister(row); } }
  else if (event.shiftKey && event.key === 'F10' && focusedIndex !== undefined && !editing) { const row = rows.get(focusedIndex); const element = windowEl.querySelector<HTMLElement>(`.row[data-row-index="${focusedIndex}"]`); if (row && element) { event.preventDefault(); const rect = element.getBoundingClientRect(); showContextMenu(row, rect.left + 24, rect.top + ROW_HEIGHT); } }
  else if (event.key === 'Escape' && !editing) { if (selectionRanges.length) { selectionRanges = []; selectionAnchor = undefined; refreshSelectionStyles(); } blurTableFocus('#grid, #grid .row'); }
});
document.querySelectorAll<HTMLElement>('.tab').forEach((tab) => tab.addEventListener('click', () => activateView(tab.dataset.view ?? 'raw-view')));

updateContentModeButtons(); buildHeader(); draw(); vscode.postMessage({ type: 'ready' });

for (const [id, label] of [['view-settings-scope', t('Where view settings are saved', '表示設定の保存先')]] as const) enhanceChoiceSelect(document.getElementById(id) as HTMLSelectElement, label);
