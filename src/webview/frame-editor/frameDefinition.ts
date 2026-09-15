import type { Diagnostic } from '../../core/diagnostics/diagnostic';
import {
  createManualSignal,
  createManualDerivedSignal,
  formatMultiplexerActivation,
  isSignalActive,
  occupiedBits,
  orderSignalsByDataPosition,
  parseMultiplexerActivation,
  validateFrameDefinition,
  type ManualFrameDefinition,
  type ManualDerivedSignalDefinition,
  type ManualSignalDefinition,
} from '../../core/manual/manualDefinition';
import { adjustResolution, parseResolution, resolutionStepFactor } from '../../core/manual/resolution';
import type { FrameEditorToExtension, FrameEditorToWebview } from '../../extension/frame-editor/frameDefinitionProtocol';
import { formatCanId, parseCanId } from '../../core/frame/canId';
import { autoFitColumns as measureColumnWidths, type SizingColumn } from '../shared/columnSizing';
import { t } from '../shared/i18n';
import { definitionControlKey, definitionSignalColor, signalBitEndpoints } from './definitionInteraction';
import { createCurvePreview, filterStepPreview, lookupPreviewPoints } from './definitionPreview';
import { dependencyDiagram } from './dependencyDiagram';

declare function acquireVsCodeApi(): { postMessage(message: FrameEditorToExtension): void; getState(): unknown; setState(value: unknown): void };
const vscode = acquireVsCodeApi();
const app = document.getElementById('app')!;
let frame: ManualFrameDefinition | undefined;
let serverDiagnostics: readonly Diagnostic[] = [];
let editRevision = 0;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let multiplexerPreview = 0;
let hoveredSignalId: string | undefined;
let editingSignalId: string | undefined;
let selectedSignalId: string | undefined;
let renderPending = false;
let expandedDerivedId: string | undefined;
let expandedDependencyId: string | undefined;
let expandedValueLabelsId: string | undefined;
const valueLabelDrafts = new Map<string, Array<{ raw: string; label: string }>>();
const bitOwners = new Map<HTMLElement, readonly string[]>();
const previewDisposers: Array<() => void> = [];

interface RenderViewState {
  readonly windowX: number;
  readonly windowY: number;
  readonly scrollAreas: Readonly<Record<string, { readonly left: number; readonly top: number }>>;
  readonly activeControlKey?: string;
  readonly selectionStart?: number | null;
  readonly selectionEnd?: number | null;
}

const columnDefinitions: readonly SizingColumn<ManualSignalDefinition>[] = [
  { id: 'name', label: 'NAME', minWidth: 160, maxWidth: 4096, flex: 1, value: (signal) => signal.name },
  { id: 'unit', label: 'UNIT', minWidth: 112, maxWidth: 4096, value: (signal) => signal.unit },
  { id: 'byte', label: 'BYTE', minWidth: 48, maxWidth: 48, value: (signal) => String(signal.byteOffset) },
  { id: 'bit', label: 'BIT', minWidth: 44, maxWidth: 44, value: (signal) => String(signal.bitOffset) },
  { id: 'length', label: 'LENGTH', minWidth: 58, maxWidth: 58, value: (signal) => String(signal.lengthBits) },
  { id: 'signed', label: 'TYPE', minWidth: 96, maxWidth: 96, value: (signal) => signal.signedness },
  { id: 'endian', label: 'BYTE ORDER', minWidth: 92, maxWidth: 92, value: (signal) => signal.byteOrder },
  { id: 'scale', label: 'SCALE', minWidth: 100, maxWidth: 100, value: (signal) => scaleFor(signal).lsbText },
  { id: 'offset', label: 'OFFSET', minWidth: 74, maxWidth: 74, value: (signal) => String(scaleFor(signal).offset) },
  { id: 'minimum', label: 'MIN', minWidth: 74, maxWidth: 74, value: (signal) => signal.minimum === undefined ? '' : String(signal.minimum) },
  { id: 'maximum', label: 'MAX', minWidth: 74, maxWidth: 74, value: (signal) => signal.maximum === undefined ? '' : String(signal.maximum) },
  { id: 'activation', label: 'ACTIVE WHEN', minWidth: 136, maxWidth: 136, value: formatMultiplexerActivation },
  { id: 'actions', label: '', minWidth: 32, maxWidth: 32, value: () => '' },
];

const derivedColumnDefinitions: readonly SizingColumn<ManualDerivedSignalDefinition>[] = [
  { id: 'derivedName', label: 'NAME', minWidth: 160, maxWidth: 4096, flex: 1, value: (signal) => signal.name },
  { id: 'derivedUnit', label: 'UNIT', minWidth: 112, maxWidth: 4096, value: (signal) => signal.unit },
  { id: 'derivedType', label: 'TYPE', minWidth: 140, maxWidth: 140, value: (signal) => signal.operation.type },
  { id: 'definition', label: 'DEFINITION', minWidth: 280, maxWidth: 4096, flex: 3, value: derivedSummary },
  { id: 'derivedActions', label: '', minWidth: 32, maxWidth: 32, value: () => '' },
];

const saved = (vscode.getState() ?? {}) as { widths?: Record<string, number> };
const allColumns = [...columnDefinitions, ...derivedColumnDefinitions];
function initialWidths(stored?: Readonly<Record<string, number>>): Record<string, number> {
  return Object.fromEntries(allColumns.map((column) => [column.id,
    column.minWidth !== column.maxWidth && Number.isFinite(stored?.[column.id])
      ? Math.max(column.minWidth, Math.min(column.maxWidth, stored![column.id])) : column.minWidth]));
}
let widths = initialWidths(saved.widths);

function derivedSummary(signal: ManualDerivedSignalDefinition): string {
  if (signal.operation.type === 'expression') return signal.operation.expression;
  if (signal.operation.type === 'lookup') return `${signal.operation.input} · ${t('Linear interpolation', '線形補間')} · ${signal.operation.points.length} ${t('points', '点')} · ${signal.operation.outOfRange}`;
  return `${signal.operation.input} · ${signal.operation.filter} · ${signal.operation.timeSeconds}s`;
}

app.innerHTML = `<style>
*{box-sizing:border-box}body{margin:0;color:var(--vscode-foreground);background:var(--vscode-editor-background);font-family:var(--vscode-font-family)}#app{padding:14px;min-width:720px}h1{font-size:20px;margin:0 0 12px}h2{font-size:14px;margin:18px 0 8px}.toolbar,.header-fields{display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap}.field{display:flex;flex-direction:column;gap:4px}.field>label,.field>span:first-child{font-size:11px;color:var(--vscode-descriptionForeground)}
input,select,button{font:inherit;color:inherit;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,transparent);border-radius:3px;padding:5px 7px;min-width:0}button{cursor:pointer;background:var(--vscode-button-secondaryBackground)}button:hover{background:var(--vscode-button-secondaryHoverBackground)}button.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}input:focus-visible,select:focus-visible,button:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:1px}.spacer{flex:1}.muted{color:var(--vscode-descriptionForeground);font-size:12px}.error{color:var(--vscode-errorForeground);font-size:12px}.success{color:var(--vscode-testing-iconPassed);font-size:12px}
.check-field{display:flex;align-items:center;gap:6px;height:29px}.check-field input{margin:0;width:auto}.bit-heading{display:flex;align-items:center;gap:8px;margin-top:18px}.bit-heading h2{margin:0}.mux-preview{display:flex;align-items:center;gap:4px}.mux-preview .icon{width:25px;height:25px}.mux-value{min-width:72px;text-align:center;font:12px var(--vscode-editor-font-family)}
.bit-layout{border:1px solid var(--vscode-panel-border);border-radius:4px;padding:8px;overflow:auto}.byte-grid{display:grid;grid-template-columns:repeat(8,minmax(70px,1fr));gap:6px;min-width:620px}.byte{border:1px solid var(--vscode-panel-border);border-radius:3px;padding:4px}.byte-label{text-align:center;font:11px var(--vscode-editor-font-family);color:var(--vscode-descriptionForeground)}.bits{display:grid;grid-template-columns:repeat(8,1fr);gap:1px;margin-top:4px}.bit{height:15px;border:1px dashed var(--vscode-panel-border);font-size:8px;text-align:center;overflow:hidden}.overlap{background:var(--vscode-inputValidation-errorBackground)!important;border-color:var(--vscode-inputValidation-errorBorder)!important}
.table-wrap{overflow:auto;border:1px solid var(--vscode-panel-border);border-radius:4px}.signal-header,.signal-row,.derived-header,.derived-row{display:grid;min-width:max-content;align-items:center}.derived-row{align-items:start}.signal-header,.derived-header{position:sticky;top:0;z-index:2;background:var(--vscode-editor-background);border-bottom:1px solid var(--vscode-panel-border)}.head{position:relative;padding:7px;font-size:10px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.resize{position:absolute;right:-3px;top:0;width:7px;height:100%;cursor:col-resize}.signal-row,.derived-row{border-bottom:1px solid color-mix(in srgb,var(--vscode-panel-border) 55%,transparent)}.cell{position:relative;padding:4px;overflow:visible}.cell input,.cell select{width:100%}.resolution{display:flex;align-items:center;gap:3px}.resolution>input{min-width:70px}.scale-spinner{display:flex;flex-direction:column;flex:0 0 18px}.scale-spinner button{height:13px;min-width:18px;padding:0 2px;border-radius:2px;line-height:9px;color:var(--vscode-foreground)}.scale-spinner button:hover{color:var(--vscode-foreground)}.scale-spinner .codicon{font-size:9px}.icon{display:flex;align-items:center;justify-content:center;min-width:0;padding:4px;color:var(--vscode-descriptionForeground);background:transparent}.icon:hover{color:var(--vscode-errorForeground);background:var(--vscode-toolbar-hoverBackground)}.diagnostics{margin:8px 0;padding:8px 10px;border:1px solid var(--vscode-inputValidation-errorBorder);background:var(--vscode-inputValidation-errorBackground);border-radius:4px}.diagnostics ul{margin:4px 0 0;padding-left:20px}.hidden{display:none}
.expression-wrap{position:relative}.expression-suggestions{position:static;margin-top:3px;max-height:160px;overflow:auto;border:1px solid var(--vscode-widget-border,var(--vscode-panel-border));background:var(--vscode-editorSuggestWidget-background,var(--vscode-editor-background));box-shadow:0 4px 12px #0006}.expression-suggestions button{display:block;width:100%;padding:5px 7px;text-align:left;border:0;border-radius:0;background:transparent}.expression-suggestions button:hover,.expression-suggestions button.active{background:var(--vscode-editorSuggestWidget-selectedBackground,var(--vscode-list-activeSelectionBackground))}
.definition-stack{display:flex;flex-direction:column;gap:5px}.definition-controls{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:5px}.lookup-table{display:grid;grid-template-columns:minmax(100px,1fr) minmax(100px,1fr) 30px;gap:3px;align-items:center}.lookup-head{font-size:10px;font-weight:650;color:var(--vscode-descriptionForeground);padding:2px 5px}.lookup-table .icon{height:27px}.definition-stack>.secondary{align-self:flex-start}
.invalid-row{box-shadow:inset 3px 0 var(--vscode-inputValidation-errorBorder)}.inline-error{display:block;margin-top:3px;color:var(--vscode-errorForeground);font-size:11px;white-space:normal}
#app{min-width:0}.section-heading{display:flex;align-items:center;gap:9px;margin:16px 0 7px}.section-heading h2{margin:0}.section-heading button{padding:3px 7px}.icon:hover{color:var(--vscode-foreground)}.icon.danger:hover{color:var(--vscode-errorForeground)}
.signal-row,.derived-row{position:relative;border-left:3px solid transparent}.signal-row{border-left-color:var(--signal-color)}.signal-header,.derived-header{border-left:3px solid transparent}.signal-row.is-hovered,.derived-row.is-hovered{background:var(--vscode-list-hoverBackground)}.signal-row.is-editing,.derived-row.is-editing{box-shadow:inset 0 0 0 1px var(--vscode-focusBorder)}.signal-row.is-selected,.derived-row.is-selected{border-left-color:var(--vscode-focusBorder)}.signal-row.invalid-row,.derived-row.invalid-row{border-left-color:var(--vscode-inputValidation-errorBorder)}
.bit{height:22px;padding:0;min-width:0;border-radius:2px;font:11px var(--vscode-editor-font-family);color:var(--vscode-foreground);background:transparent;cursor:default}.bit.owned{background:color-mix(in srgb,var(--signal-color) 22%,var(--vscode-editor-background));border-color:color-mix(in srgb,var(--signal-color) 55%,var(--vscode-panel-border));cursor:pointer}.bit.owned:hover{background:color-mix(in srgb,var(--signal-color) 40%,var(--vscode-editor-background))}.bit.is-hovered{outline:1px solid var(--signal-color,var(--vscode-focusBorder));outline-offset:-1px}.bit.is-editing,.bit.is-selected{box-shadow:inset 0 0 0 2px var(--signal-color,var(--vscode-focusBorder))}.bit.is-msb{border-top:3px solid var(--vscode-foreground)}.bit.is-lsb{border-bottom:3px solid var(--vscode-foreground)}.bit-detail{min-height:23px;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:12px var(--vscode-editor-font-family);color:var(--vscode-descriptionForeground);padding:4px 0 0}.bit.overlap{background:var(--vscode-inputValidation-errorBackground)!important;border-color:var(--vscode-inputValidation-errorBorder)!important}.bit:disabled{opacity:1}.definition-summary{cursor:pointer;min-height:29px;line-height:29px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.definition-details[open]>.definition-summary{color:var(--vscode-descriptionForeground)}
.definition-visual{display:grid;grid-template-columns:minmax(140px,1fr) minmax(200px,1fr);gap:10px;align-items:start}.definition-visual .lookup-table{grid-template-columns:minmax(45px,1fr) minmax(45px,1fr) 27px}.definition-preview{min-width:0}.definition-preview svg{display:block;width:100%;height:150px;overflow:visible}.definition-preview text{font:11px var(--vscode-editor-font-family);fill:var(--vscode-descriptionForeground)}.preview-grid{stroke:var(--vscode-panel-border);stroke-width:.6;fill:none}.preview-output,.preview-extension{stroke:var(--vscode-charts-blue);stroke-width:1.7;fill:none}.preview-input{stroke:var(--vscode-descriptionForeground);stroke-dasharray:4 3;stroke-width:1.2;fill:none}.preview-extension{stroke-dasharray:3 3;opacity:.65}.preview-point{fill:var(--vscode-charts-blue);stroke:var(--vscode-editor-background);stroke-width:1;cursor:pointer}.lookup-table input.is-point-active{border-color:var(--vscode-focusBorder)}.preview-caption{font-size:11px;color:var(--vscode-descriptionForeground);margin:0 0 3px}
body{font-size:var(--vscode-font-size,13px)}
.header-fields>.field{flex:0 0 auto;min-width:0}.header-fields>.frame-name-field{flex:1 1 240px;min-width:180px}.frame-name-field>input{width:100%!important}.frame-length-field select{width:160px}.header-fields .check-field{height:29px;min-width:90px}
.signal-header,.signal-row,.derived-header,.derived-row{width:100%;min-width:var(--definition-min-width)}
.cell{min-width:0}.head{padding:7px 4px}.cell input,.cell select{padding:5px 4px;font-size:12px;height:29px}.cell:first-child input,.expression-wrap>input{font-size:inherit}
.cell input[type=number]{appearance:textfield;font-variant-numeric:tabular-nums}.cell input[type=number]::-webkit-inner-spin-button,.cell input[type=number]::-webkit-outer-spin-button{appearance:none;margin:0}
.resolution>input{flex:1 1 0;min-width:0}.scale-spinner{flex:0 0 16px}.scale-spinner button{min-width:16px}
.definition-visual{grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr))}.definition-controls{grid-template-columns:repeat(auto-fit,minmax(min(100%,110px),1fr))}
.definition-stack .field input[type=number]{width:100px;max-width:100%}.definition-visual .lookup-table{grid-template-columns:repeat(2,minmax(0,112px)) 24px;max-width:254px}
.bit-heading,.section-heading{flex-wrap:wrap}.value-label-editor{width:100%}.dependency-diagram{max-width:100%}
</style><div id="content"><p class="muted">${t('Loading frame definition…', 'フレーム定義を読み込み中…')}</p></div>`;

const content = document.getElementById('content')!;
const template = (columns: readonly { readonly id: string }[]) => columns.map((column) => {
  const flex = allColumns.find((item) => item.id === column.id)?.flex;
  return flex ? `minmax(${Math.round(widths[column.id])}px,${flex}fr)` : `${Math.round(widths[column.id])}px`;
}).join(' ');
function setTableMinimum(table: HTMLElement, columns: readonly { readonly id: string }[]): void {
  table.style.setProperty('--definition-min-width', `${columns.reduce((sum, column) => sum + widths[column.id], 3)}px`);
}
function applyTableWidths(columns: readonly { readonly id: string }[], selector: string): void {
  for (const row of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
    row.style.gridTemplateColumns = template(columns);
    if (row.parentElement) setTableMinimum(row.parentElement, columns);
  }
}
const persist = () => { vscode.setState({ widths }); vscode.postMessage({ type: 'saveViewState', widths }); };
const signalColumns = () => frame?.multiplexing ? columnDefinitions : columnDefinitions.filter((column) => column.id !== 'activation');

function changed(): void {
  editRevision++;
  serverDiagnostics = [];
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveFrame, 150);
}
function updateFrame(patch: Partial<ManualFrameDefinition>): void { if (frame) { frame = { ...frame, ...patch }; changed(); } }
function updateSignal(id: string, transform: (signal: ManualSignalDefinition) => ManualSignalDefinition): void {
  if (frame) { frame = { ...frame, signals: frame.signals.map((signal) => signal.id === id ? transform(signal) : signal) }; changed(); }
}
function updateMultiplexerActivation(id: string, text: string): void {
  if (!frame) return;
  const always = !text.trim() || /^always$/i.test(text.trim());
  const multiplexing = parseMultiplexerActivation(text);
  if (!always && !multiplexing) return;
  const makeMultiplexer = multiplexing?.type === 'multiplexer';
  updateFrame({ signals: frame.signals.map((signal) => ({
    ...signal,
    multiplexing: signal.id === id ? multiplexing : makeMultiplexer && signal.multiplexing?.type === 'multiplexer' ? undefined : signal.multiplexing,
  })) });
}
function updateDerivedSignal(id: string, transform: (signal: ManualDerivedSignalDefinition) => ManualDerivedSignalDefinition): void {
  if (frame) { frame = { ...frame, derivedSignals: (frame.derivedSignals ?? []).map((signal) => signal.id === id ? transform(signal) : signal) }; changed(); refreshDependencyDiagram(); }
}
function uuid(): string { return `signal-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`; }

function inputField(label: string, value: string, onChange: (value: string) => void, options: { type?: string; width?: string; disabled?: boolean } = {}): HTMLElement {
  const wrap = document.createElement('div'); wrap.className = 'field';
  const caption = document.createElement('label'); caption.textContent = label;
  const input = document.createElement('input'); input.type = options.type ?? 'text'; input.value = value; input.style.width = options.width ?? '150px'; input.disabled = options.disabled ?? false;
  input.addEventListener('change', () => { onChange(input.value); serverDiagnostics = []; render(); });
  wrap.append(caption, input); return wrap;
}

function render(): void {
  if (renderPending) return;
  renderPending = true;
  const viewport = { windowX: window.scrollX, windowY: window.scrollY };
  requestAnimationFrame(() => { renderPending = false; renderNow(viewport); });
}

function renderNow(viewport: { windowX: number; windowY: number }): void {
  if (!frame) return;
  const view = { ...captureRenderView(), ...viewport };
  previewDisposers.splice(0).forEach((dispose) => dispose());
  bitOwners.clear();
  hoveredSignalId = undefined;
  content.replaceChildren();
  const title = document.createElement('h1'); title.textContent = t('Frame Definition', 'フレーム定義');
  const fields = document.createElement('div'); fields.className = 'header-fields';
  const pluginOwned = frame.origin?.type === 'plugin';
  fields.append(
    inputField('CAN ID', formatCanId(frame.canId, frame.extended), (value) => {
      const parsed = parseCanId(value); updateFrame(parsed ?? { canId: Number.NaN, extended: false });
    }, { width: '108px', disabled: pluginOwned }),
    inputField(t('Frame name', 'フレーム名'), frame.name, (value) => updateFrame({ name: value }), { width: '100%' })
  );
  fields.children[1].classList.add('frame-name-field');
  const lengthField = document.createElement('label'); lengthField.className = 'field'; lengthField.innerHTML = `<span>${t('Frame length', 'フレーム長')}</span>`;
  const length = document.createElement('select');
  lengthField.classList.add('frame-length-field');
  for (const value of [0,1,2,3,4,5,6,7,8,12,16,20,24,32,48,64]) { const option = document.createElement('option'); option.value = String(value); option.textContent = `${value} bytes${value > 8 ? ' (CAN FD)' : ''}`; option.selected = frame.frameLength === value; length.appendChild(option); }
  length.addEventListener('change', () => { updateFrame({ frameLength: Number(length.value) }); serverDiagnostics = []; render(); }); lengthField.appendChild(length); fields.appendChild(lengthField);
  const multiplexingField = document.createElement('label'); multiplexingField.className = 'field';
  const multiplexingCaption = document.createElement('span'); multiplexingCaption.textContent = 'Multiplexing';
  const multiplexingControl = document.createElement('span'); multiplexingControl.className = 'check-field';
  const multiplexing = document.createElement('input'); multiplexing.type = 'checkbox'; multiplexing.checked = frame.multiplexing === true;
  const multiplexingText = document.createElement('span'); multiplexingText.textContent = multiplexing.checked ? 'ON' : 'OFF';
  multiplexing.addEventListener('change', () => { updateFrame({ multiplexing: multiplexing.checked || undefined, ...(!multiplexing.checked ? { signals: frame?.signals.map((signal) => ({ ...signal, multiplexing: undefined })) } : {}) }); multiplexerPreview = 0; render(); });
  multiplexingControl.append(multiplexing, multiplexingText); multiplexingField.append(multiplexingCaption, multiplexingControl); fields.appendChild(multiplexingField);
  if (pluginOwned) { const ownership = document.createElement('div'); ownership.className = 'muted'; const pluginId = frame.origin?.type === 'plugin' ? frame.origin.pluginId : ''; ownership.textContent = t(`Provided by ${pluginId} · CAN ID is read-only`, `${pluginId} が提供 · CAN IDは読み取り専用`); fields.appendChild(ownership); }
  content.append(title, fields);

  const bitHeading = document.createElement('div'); bitHeading.className = 'bit-heading'; const bitTitle = document.createElement('h2'); bitTitle.textContent = t('Bit Layout', 'ビット配置'); bitHeading.appendChild(bitTitle);
  if (frame.multiplexing) {
    const selector = frame.signals.find((signal) => signal.multiplexing?.type === 'multiplexer'); const maximum = selector ? Math.min(2 ** Math.min(selector.lengthBits, 32) - 1, Number.MAX_SAFE_INTEGER) : 0;
    multiplexerPreview = Math.max(0, Math.min(maximum, multiplexerPreview));
    const preview = document.createElement('span'); preview.className = 'mux-preview';
    const previous = iconButton('chevron-left', t('Previous Multiplexer value', '前のMultiplexer値'), () => { multiplexerPreview = Math.max(0, multiplexerPreview - 1); render(); }); previous.disabled = multiplexerPreview <= 0;
    const value = document.createElement('span'); value.className = 'mux-value'; value.textContent = `MUX ${multiplexerPreview}`;
    const next = iconButton('chevron-right', t('Next Multiplexer value', '次のMultiplexer値'), () => { multiplexerPreview = Math.min(maximum, multiplexerPreview + 1); render(); }); next.disabled = multiplexerPreview >= maximum;
    preview.append(previous, value, next); bitHeading.appendChild(preview);
  }
  content.append(bitHeading, buildBitLayout(frame));
  const signalTitle = document.createElement('h2'); signalTitle.textContent = t('Signal Definitions', 'Signal定義');
  const toolbar = document.createElement('div'); toolbar.className = 'section-heading';
  const add = button(t('+ Add Signal', '+ Signalを追加'), () => { const previous = frame?.signals[frame.signals.length - 1]; if (frame) updateFrame({ signals: [...frame.signals, createManualSignal(uuid(), previous, frame.frameLength)] }); render(); }, true);
  toolbar.append(signalTitle, add); content.append(toolbar, buildSignalTable(frame));
  const derivedTitle = document.createElement('h2'); derivedTitle.textContent = t('Derived Signal Definitions', '派生Signal定義');
  const derivedToolbar = document.createElement('div'); derivedToolbar.className = 'section-heading';
  const addDerived = button(t('+ Add Derived Signal', '+ 派生Signalを追加'), () => { expandedDerivedId = uuid(); if (frame) updateFrame({ derivedSignals: [...(frame.derivedSignals ?? []), createManualDerivedSignal(expandedDerivedId)] }); render(); }, true);
  derivedToolbar.append(derivedTitle, addDerived); content.append(derivedToolbar, buildDerivedTable(frame));
  const validation = validationDiagnostics();
  if (validation.length) content.appendChild(buildDiagnostics(validation));
  content.querySelectorAll<HTMLElement>('.header-fields input,.header-fields select').forEach((control, index) => { control.dataset.controlKey = `frame:${index}`; });
  restoreRenderView(view);
  updateLinkedHighlights();
}

function captureRenderView(): RenderViewState {
  const scrollAreas: Record<string, { left: number; top: number }> = {};
  document.querySelectorAll<HTMLElement>('[data-scroll-key]').forEach((element) => {
    const key = element.dataset.scrollKey;
    if (key) scrollAreas[key] = { left: element.scrollLeft, top: element.scrollTop };
  });
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  const selection = active instanceof HTMLInputElement ? active : undefined;
  return {
    windowX: window.scrollX,
    windowY: window.scrollY,
    scrollAreas,
    activeControlKey: active?.dataset.controlKey,
    selectionStart: selection?.selectionStart,
    selectionEnd: selection?.selectionEnd,
  };
}

function restoreRenderView(view: RenderViewState): void {
  document.querySelectorAll<HTMLElement>('[data-scroll-key]').forEach((element) => {
    const saved = element.dataset.scrollKey ? view.scrollAreas[element.dataset.scrollKey] : undefined;
    if (saved) { element.scrollLeft = saved.left; element.scrollTop = saved.top; }
  });
  if (view.activeControlKey !== undefined) {
    const control = Array.from(content.querySelectorAll<HTMLElement>('[data-control-key]')).find((item) => item.dataset.controlKey === view.activeControlKey);
    control?.focus({ preventScroll: true });
    if (control instanceof HTMLInputElement && view.selectionStart != null && view.selectionEnd != null) {
      control.setSelectionRange(view.selectionStart, view.selectionEnd);
    }
  }
  window.scrollTo(view.windowX, view.windowY);
  requestAnimationFrame(() => window.scrollTo(view.windowX, view.windowY));
}

function buildBitLayout(value: ManualFrameDefinition): HTMLElement {
  const owner = new Map<number, number[]>();
  value.signals.forEach((signal, signalIndex) => { if (signalBitEndpoints(signal).start === undefined || (value.multiplexing && !isSignalActive(signal, multiplexerPreview))) return; for (const bit of occupiedBits(signal)) { const entries = owner.get(bit) ?? []; entries.push(signalIndex); owner.set(bit, entries); } });
  const wrap = document.createElement('div'); wrap.className = 'bit-layout'; wrap.dataset.scrollKey = 'bit-layout'; const grid = document.createElement('div'); grid.className = 'byte-grid';
  for (let byte = 0; byte < value.frameLength; byte++) {
    const box = document.createElement('div'); box.className = 'byte'; const label = document.createElement('div'); label.className = 'byte-label'; label.textContent = `BYTE ${byte}`; const bits = document.createElement('div'); bits.className = 'bits';
    for (let bit = 7; bit >= 0; bit--) {
      const element = document.createElement('button'); element.type = 'button'; element.className = 'bit'; element.dataset.bit = String(byte * 8 + bit); element.tabIndex = -1;
      const owners = (owner.get(byte * 8 + bit) ?? []).map((index) => value.signals[index]); element.textContent = String(bit); element.disabled = owners.length === 0;
      if (owners.length) { element.classList.add('owned'); element.style.setProperty('--signal-color', definitionSignalColor(owners[0].id)); }
      if (owners.length > 1) element.classList.add('overlap');
      const label = `BYTE ${byte} · BIT ${bit}${owners.length ? ` · ${owners.map((signal) => signal.name).join(' / ')}` : ''}`;
      element.title = label; element.setAttribute('aria-label', label); bitOwners.set(element, owners.map((signal) => signal.id));
      element.addEventListener('mouseenter', () => { hoveredSignalId = owners[0]?.id; updateLinkedHighlights(); });
      element.addEventListener('mouseleave', () => { hoveredSignalId = undefined; updateLinkedHighlights(); });
      element.addEventListener('focus', () => { hoveredSignalId = owners[0]?.id; updateLinkedHighlights(); });
      element.addEventListener('blur', () => { hoveredSignalId = undefined; updateLinkedHighlights(); });
      element.addEventListener('click', () => {
        const selected = owners.find((signal, index) => owners[(index + owners.length - 1) % owners.length]?.id === selectedSignalId) ?? owners[0];
        if (!selected) return; selectedSignalId = selected.id;
        const row = Array.from(content.querySelectorAll<HTMLElement>('[data-signal-id]')).find((item) => item.dataset.signalId === selected.id);
        row?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); row?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true }); updateLinkedHighlights();
      });
      bits.appendChild(element);
    }
    box.append(label, bits); grid.appendChild(box);
  }
  const owned = Array.from(grid.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')); if (owned[0]) owned[0].tabIndex = 0;
  grid.addEventListener('keydown', (event) => {
    const buttons = Array.from(grid.querySelectorAll<HTMLButtonElement>('button')); const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (current < 0) return;
    const directions: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -64, ArrowDown: 64 };
    const step = directions[event.key]; if (!step) return;
    let index = current + step; while (index >= 0 && index < buttons.length && buttons[index].disabled) index += step;
    if (!buttons[index]) return; event.preventDefault(); buttons.forEach((button) => { button.tabIndex = -1; }); buttons[index].tabIndex = 0; buttons[index].focus({ preventScroll: true });
  });
  const detail = document.createElement('span'); detail.className = 'bit-detail'; detail.dataset.bitDetail = 'true';
  wrap.append(grid, detail); return wrap;
}

function linkSignalRow(row: HTMLElement, id: string, columns: readonly { id: string }[]): void {
  row.dataset.signalId = id; row.style.setProperty('--signal-color', definitionSignalColor(id));
  Array.from(row.children).forEach((cell, column) => cell.querySelectorAll<HTMLElement>('input,select,button,summary').forEach((control, index) => { control.dataset.controlKey = definitionControlKey(id, columns[column].id, index); }));
  row.querySelectorAll<HTMLInputElement>('input').forEach((input) => { input.addEventListener('mouseenter', () => { input.title = input.value; }); });
  row.addEventListener('mouseenter', () => { hoveredSignalId = id; updateLinkedHighlights(); });
  row.addEventListener('mouseleave', () => { hoveredSignalId = undefined; updateLinkedHighlights(); });
  row.addEventListener('focusin', () => { editingSignalId = id; updateLinkedHighlights(); });
  row.addEventListener('focusout', () => queueMicrotask(() => { if (row.isConnected && !row.contains(document.activeElement) && editingSignalId === id) { editingSignalId = undefined; updateLinkedHighlights(); } }));
  row.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab' || event.ctrlKey || event.metaKey || event.altKey) return;
    const controls = Array.from(row.querySelectorAll<HTMLElement>('input,select,button,summary')).filter((element) => element.tabIndex >= 0 && !element.matches(':disabled') && element.getClientRects().length > 0);
    const index = controls.indexOf(document.activeElement as HTMLElement); const next = controls[index + (event.shiftKey ? -1 : 1)];
    if (index < 0 || !next) return;
    event.preventDefault(); next.focus({ preventScroll: true });
    const scroll = row.closest<HTMLElement>('.table-wrap');
    if (scroll) { const bounds = scroll.getBoundingClientRect(); const rect = next.getBoundingClientRect(); if (rect.right > bounds.right) scroll.scrollLeft += rect.right - bounds.right + 4; else if (rect.left < bounds.left) scroll.scrollLeft -= bounds.left - rect.left + 4; }
  });
}

function updateLinkedHighlights(): void {
  const direct = frame?.signals.find((signal) => signal.id === (editingSignalId ?? hoveredSignalId ?? selectedSignalId));
  const endpoints = direct ? signalBitEndpoints(direct) : {};
  for (const row of Array.from(content.querySelectorAll<HTMLElement>('[data-signal-id]'))) {
    row.classList.toggle('is-hovered', row.dataset.signalId === hoveredSignalId);
    row.classList.toggle('is-editing', row.dataset.signalId === editingSignalId);
    row.classList.toggle('is-selected', row.dataset.signalId === selectedSignalId);
  }
  for (const [element, owners] of bitOwners) {
    element.classList.toggle('is-hovered', !!hoveredSignalId && owners.includes(hoveredSignalId));
    element.classList.toggle('is-editing', !!editingSignalId && owners.includes(editingSignalId));
    element.classList.toggle('is-selected', !!selectedSignalId && owners.includes(selectedSignalId));
    const bit = Number(element.dataset.bit);
    element.classList.toggle('is-msb', owners.includes(direct?.id ?? '') && bit === endpoints.msb);
    element.classList.toggle('is-lsb', owners.includes(direct?.id ?? '') && bit === endpoints.lsb);
  }
  const detail = content.querySelector<HTMLElement>('[data-bit-detail]');
  if (detail) {
    const position = (bit: number | undefined) => bit === undefined ? '—' : `${Math.floor(bit / 8)}.${bit % 8}`;
    detail.textContent = direct ? `${direct.name} · ${direct.byteOrder.toUpperCase()} · ${direct.lengthBits} bit · MSB ${position(endpoints.msb)} / LSB ${position(endpoints.lsb)}${frame?.multiplexing && !isSignalActive(direct, multiplexerPreview) ? ` · ${t('Inactive at this MUX', '現在のMUXでは非アクティブ')}` : ''}` : '';
    detail.title = detail.textContent;
  }
}

function buildSignalTable(value: ManualFrameDefinition): HTMLElement {
  const columns = signalColumns(); const wrap = document.createElement('div'); wrap.className = 'table-wrap'; wrap.dataset.scrollKey = 'signal-table'; const header = document.createElement('div'); header.className = 'signal-header'; header.style.gridTemplateColumns = template(columns);
  setTableMinimum(wrap, columns);
  columns.forEach((column) => header.appendChild(definitionHeader(column, columns, () => frame?.signals ?? [], '.signal-header,.signal-row'))); wrap.appendChild(header);
  const validation = validateFrameDefinition(value).diagnostics;
  for (const signal of value.signals) { const row = document.createElement('div'); const signalErrors = validation.filter((item) => item.details?.signalId === signal.id); row.className = `signal-row${signalErrors.length ? ' invalid-row' : ''}`; row.title = signalErrors.map((item) => item.message).join('\n'); row.style.gridTemplateColumns = template(columns);
    const cells = [
      cell(signalNameInput(signal)),
      cell(sizedTextInput(signal.unit, (next) => updateSignal(signal.id, (current) => ({ ...current, unit: next })), 'unit', columns, '.signal-header,.signal-row')),
      cell(numberInput(signal.byteOffset, 0, 63, (next) => updateSignal(signal.id, (current) => ({ ...current, byteOffset: next })))),
      cell(numberInput(signal.bitOffset, 0, 7, (next) => updateSignal(signal.id, (current) => ({ ...current, bitOffset: next })))),
      cell(numberInput(signal.lengthBits, 1, 64, (next) => updateSignal(signal.id, (current) => ({ ...current, lengthBits: next })))),
      cell(selectInput([['unsigned',t('Unsigned','符号なし')],['signed',t('Signed','符号あり')]], signal.signedness, (next) => updateSignal(signal.id, (current) => ({ ...current, signedness: next as 'unsigned' | 'signed' })))),
      cell(selectInput([['little','LITTLE'],['big','BIG']], signal.byteOrder, (next) => updateSignal(signal.id, (current) => ({ ...current, byteOrder: next as 'little' | 'big' })))),
      cell(scaleInput(signal)), cell(offsetInput(signal)),
      cell(optionalNumberInput(signal.minimum, (next) => updateSignal(signal.id, (current) => ({ ...current, minimum: next })))),
      cell(optionalNumberInput(signal.maximum, (next) => updateSignal(signal.id, (current) => ({ ...current, maximum: next }))))
    ];
    if (value.multiplexing) cells.push(cell(multiplexerActivationInput(signal)));
    cells.push(cell(trashButton(`Delete ${signal.name}`, () => { if (frame) updateFrame({ signals: frame.signals.filter((item) => item.id !== signal.id) }); render(); })));
    row.append(...cells); linkSignalRow(row, signal.id, columns); wrap.appendChild(row);
    if (expandedValueLabelsId === signal.id) wrap.appendChild(valueLabelsEditor(signal));
  }
  if (!value.signals.length) { const empty = document.createElement('p'); empty.className = 'muted'; empty.style.padding = '8px'; empty.textContent = t('No manual signals are defined.', 'Signalが定義されていません。'); wrap.appendChild(empty); }
  return wrap;
}

function signalNameInput(signal: ManualSignalDefinition): HTMLElement {
  const wrap = document.createElement('div'); wrap.style.cssText = 'display:flex;align-items:center;gap:3px';
  const input = sizedTextInput(signal.name, (next) => updateSignal(signal.id, (current) => ({ ...current, name: next })), 'name', signalColumns(), '.signal-header,.signal-row');
  const toggle = iconButton('symbol-enum', t('Value labels', '値ラベル'), () => { expandedValueLabelsId = expandedValueLabelsId === signal.id ? undefined : signal.id; render(); });
  toggle.setAttribute('aria-expanded', String(expandedValueLabelsId === signal.id)); toggle.style.flex = '0 0 24px'; toggle.style.color = 'var(--vscode-descriptionForeground)';
  const labelCount = Object.keys(signal.valueLabels ?? {}).length;
  if (labelCount) {
    toggle.title = `${t('Value labels', '値ラベル')}: ${labelCount}`;
    toggle.style.position = 'relative';
    toggle.style.color = 'var(--vscode-textLink-foreground)';
    const indicator = document.createElement('span');
    indicator.className = 'value-label-indicator'; indicator.setAttribute('aria-hidden', 'true');
    indicator.style.cssText = 'position:absolute;right:1px;top:1px;width:4px;height:4px;border-radius:50%;background:currentColor;pointer-events:none';
    toggle.append(indicator);
  }
  wrap.append(input, toggle); return wrap;
}

function valueLabelsEditor(signal: ManualSignalDefinition): HTMLElement {
  const panel = document.createElement('div'); panel.className = 'value-label-editor'; panel.style.cssText = 'padding:8px 12px;border-bottom:1px solid var(--vscode-panel-border);max-width:560px';
  const title = document.createElement('div'); title.textContent = `${signal.name} · ${t('Value labels', '値ラベル')}`; title.style.cssText = 'font-size:12px;margin-bottom:6px'; panel.append(title);
  const entries = valueLabelDrafts.get(signal.id) ?? Object.entries(signal.valueLabels ?? {}).map(([raw, label]) => ({ raw, label })); valueLabelDrafts.set(signal.id, entries);
  const error = document.createElement('div'); error.className = 'inline-error'; error.setAttribute('role', 'status');
  const commit = (save = true) => {
    const labels: Record<string, string> = {}; const seen = new Set<string>(); let message = '';
    for (const entry of entries) {
      if (!/^-?(?:0|[1-9]\d*)$/.test(entry.raw) || entry.raw === '-0') { message = t('Enter a decimal RAW integer.', 'RAW値は10進整数で入力してください。'); break; }
      if (seen.has(entry.raw)) { message = t('RAW values must be unique.', 'RAW値が重複しています。'); break; }
      seen.add(entry.raw); labels[entry.raw] = entry.label;
    }
    const current = frame?.signals.find((item) => item.id === signal.id);
    if (!message && frame && current) message = validateFrameDefinition({ ...frame, signals: [{ ...current, valueLabels: labels }], derivedSignals: [] }).diagnostics.find((item) => item.code.startsWith('SIGNAL_VALUE_LABEL'))?.message ?? '';
    error.textContent = message;
    if (!message && save) updateSignal(signal.id, (current) => ({ ...current, valueLabels: Object.keys(labels).length ? labels : undefined }));
  };
  const headings = document.createElement('div'); headings.style.cssText = 'display:grid;grid-template-columns:120px 1fr 24px;gap:6px;font-size:11px;color:var(--vscode-descriptionForeground)'; headings.append(document.createTextNode('RAW'));
  const labelHeading = document.createElement('span'); labelHeading.textContent = t('Label', 'ラベル'); headings.append(labelHeading); panel.append(headings);
  entries.forEach((entry, index) => {
    const row = document.createElement('div'); row.style.cssText = 'display:grid;grid-template-columns:120px 1fr 24px;gap:6px;margin-top:4px';
    const raw = document.createElement('input'); raw.value = entry.raw; raw.setAttribute('aria-label', `RAW ${index + 1}`); raw.dataset.controlKey = `value-label:${signal.id}:${index}:raw`;
    const label = document.createElement('input'); label.value = entry.label; label.setAttribute('aria-label', `${t('Label', 'ラベル')} ${index + 1}`); label.dataset.controlKey = `value-label:${signal.id}:${index}:label`;
    raw.addEventListener('input', () => { entry.raw = raw.value; commit(); }); label.addEventListener('input', () => { entry.label = label.value; commit(); });
    row.append(raw, label, trashButton(t('Delete value label', '値ラベルを削除'), () => { entries.splice(index, 1); commit(); render(); })); panel.append(row);
  });
  const add = button(t('+ Add value label', '+ 値ラベルを追加'), () => { const used = new Set(entries.map((entry) => entry.raw)); let raw = signal.signedness === 'signed' ? -(2n ** BigInt(signal.lengthBits - 1)) : 0n; if (!used.has('0')) raw = 0n; while (used.has(raw.toString())) raw++; entries.push({ raw: raw.toString(), label: '' }); commit(); render(); });
  add.style.marginTop = '6px'; panel.append(add, error); commit(false); return panel;
}

function buildDerivedTable(value: ManualFrameDefinition): HTMLElement {
  const derived = value.derivedSignals ?? []; const wrap = document.createElement('div'); wrap.className = 'table-wrap'; wrap.dataset.scrollKey = 'derived-table'; const header = document.createElement('div'); header.className = 'derived-header'; header.style.gridTemplateColumns = template(derivedColumnDefinitions);
  setTableMinimum(wrap, derivedColumnDefinitions);
  for (const column of derivedColumnDefinitions) header.appendChild(definitionHeader(column, derivedColumnDefinitions, () => frame?.derivedSignals ?? [], '.derived-header,.derived-row')); wrap.appendChild(header);
  const validation = validateFrameDefinition(value).diagnostics;
  derived.forEach((signal, index) => {
    const errors = validation.filter((item) => item.details?.signalId === signal.id); const row = document.createElement('div'); row.className = `derived-row${errors.length ? ' invalid-row' : ''}`; row.title = errors.map((item) => item.message).join('\n'); row.style.gridTemplateColumns = template(derivedColumnDefinitions);
    const available = [...value.signals.map((item) => item.name), ...derived.slice(0, index).map((item) => item.name)].filter(Boolean);
    row.append(
      cell(derivedNameInput(signal)),
      cell(sizedTextInput(signal.unit, (next) => updateDerivedSignal(signal.id, (current) => ({ ...current, unit: next })), 'derivedUnit', derivedColumnDefinitions, '.derived-header,.derived-row')),
      cell(selectInput([['expression',t('Expression','計算式')],['lookup',t('Linear interpolation','線形補間')],['filter',t('Filter','フィルター')]], signal.operation.type, (next) => { expandedDerivedId = signal.id; updateDerivedSignal(signal.id, (current) => ({ ...current, operation: operationForType(next as ManualDerivedSignalDefinition['operation']['type'], current.operation, available) })); })),
      cell(derivedDefinitionInput(signal, available)),
      cell(trashButton(`Delete ${signal.name}`, () => { if (frame) updateFrame({ derivedSignals: (frame.derivedSignals ?? []).filter((item) => item.id !== signal.id) }); render(); }))
    ); linkSignalRow(row, signal.id, derivedColumnDefinitions); wrap.appendChild(row);
    if (expandedDependencyId === signal.id) wrap.appendChild(makeDependencyDiagram(value, signal.id));
  });
  if (!derived.length) { const empty = document.createElement('p'); empty.className = 'muted'; empty.style.padding = '8px'; empty.textContent = t('No Derived Signals are defined.', '派生Signalが定義されていません。'); wrap.appendChild(empty); }
  return wrap;
}

function derivedNameInput(signal: ManualDerivedSignalDefinition): HTMLElement {
  const wrap = document.createElement('div'); wrap.style.cssText = 'display:flex;align-items:center;gap:3px';
  const input = sizedTextInput(signal.name, (next) => updateDerivedSignal(signal.id, (current) => ({ ...current, name: next })), 'derivedName', derivedColumnDefinitions, '.derived-header,.derived-row');
  const toggle = iconButton('type-hierarchy-sub', t('Signal flow', 'Signal接続図'), () => { expandedDependencyId = expandedDependencyId === signal.id ? undefined : signal.id; render(); }); toggle.setAttribute('aria-expanded', String(expandedDependencyId === signal.id)); toggle.style.cssText = 'flex:0 0 24px;color:var(--vscode-descriptionForeground)'; wrap.append(input, toggle); return wrap;
}
function makeDependencyDiagram(value: ManualFrameDefinition, id: string): HTMLElement {
  return dependencyDiagram(value, id, (selected) => {
    const row = Array.from(content.querySelectorAll<HTMLElement>('.signal-row,.derived-row')).find((element) => element.dataset.signalId === selected);
    row?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); row?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true }); selectedSignalId = selected; updateLinkedHighlights();
  });
}
function refreshDependencyDiagram(): void {
  const previous = content.querySelector<HTMLElement>('.dependency-diagram');
  if (previous && frame && expandedDependencyId) { const next = makeDependencyDiagram(frame, expandedDependencyId); const left = previous.scrollLeft; const top = previous.scrollTop; previous.replaceWith(next); next.scrollLeft = left; next.scrollTop = top; }
}

function operationForType(type: ManualDerivedSignalDefinition['operation']['type'], current: ManualDerivedSignalDefinition['operation'], available: readonly string[]): ManualDerivedSignalDefinition['operation'] {
  if (type === current.type) return current;
  if (type === 'expression') return { type, expression: available[0] ? `[${available[0]}]` : '' };
  if (type === 'lookup') return { type, input: available[0] ?? '', outOfRange: 'clamp', points: [{ input: 0, output: 0 }, { input: 1, output: 1 }] };
  return { type, input: available[0] ?? '', filter: 'low-pass', timeSeconds: 1 };
}

function derivedDefinitionInput(signal: ManualDerivedSignalDefinition, available: readonly string[]): HTMLElement {
  if (signal.operation.type === 'expression') return expressionInput(signal, available);
  const details = document.createElement('details'); details.className = 'definition-details'; details.open = expandedDerivedId === signal.id; details.dataset.derivedId = signal.id;
  const summary = document.createElement('summary'); summary.className = 'definition-summary';
  summary.textContent = signal.operation.type === 'lookup' ? `${signal.operation.input || '—'} · ${signal.operation.points.length} ${t('points', '点')}` : `${signal.operation.input || '—'} · ${signal.operation.filter === 'low-pass' ? t('Time constant', '時定数') : t('Window', '時間窓')} ${signal.operation.timeSeconds} s`;
  details.append(summary, signal.operation.type === 'lookup' ? lookupInput(signal, available) : filterInput(signal, available));
  summary.addEventListener('click', (event) => {
    event.preventDefault(); const open = !details.open; expandedDerivedId = open ? signal.id : undefined;
    content.querySelectorAll<HTMLDetailsElement>('.definition-details').forEach((other) => { other.open = other === details && open; });
  });
  return details;
}

function signalNameSelect(names: readonly string[], value: string, change: (value: string) => void): HTMLSelectElement {
  const options: Array<readonly [string, string]> = [['', t('Select input Signal…', '入力Signalを選択…')], ...names.map((name) => [name, name] as const)];
  return selectInput(options, value, change);
}

function lookupInput(signal: ManualDerivedSignalDefinition, available: readonly string[]): HTMLElement {
  const wrap = document.createElement('div'); wrap.className = 'definition-stack'; if (signal.operation.type !== 'lookup') return wrap; const operation = signal.operation;
  const controls = document.createElement('div'); controls.className = 'definition-controls';
  controls.append(
    signalNameSelect(available, operation.input, (next) => updateDerivedSignal(signal.id, (current) => ({ ...current, operation: current.operation.type === 'lookup' ? { ...current.operation, input: next } : current.operation }))),
    selectInput([['clamp',t('Clamp outside range','範囲外を端値に固定')],['error',t('Error outside range','範囲外をエラー')]], operation.outOfRange, (next) => updateDerivedSignal(signal.id, (current) => ({ ...current, operation: current.operation.type === 'lookup' ? { ...current.operation, outOfRange: next as 'clamp' | 'error' } : current.operation })))
  );
  const table = document.createElement('div'); table.className = 'lookup-table';
  const pointInputs: Array<{ input: HTMLInputElement; output: HTMLInputElement }> = [];
  const preview = createCurvePreview({ title: t('Linear interpolation', '線形補間'), xLabel: t('INPUT', '入力'), yLabel: signal.unit ? `${t('OUTPUT', '出力')} (${signal.unit})` : t('OUTPUT', '出力'), lines: [{ points: lookupPreviewPoints(operation.points) }], clamp: operation.outOfRange === 'clamp', onSelect: (index) => pointInputs[index]?.output.focus({ preventScroll: true }) });
  previewDisposers.push(preview.dispose);
  const inputHead = document.createElement('span'); inputHead.className = 'lookup-head'; inputHead.textContent = 'INPUT';
  const outputHead = document.createElement('span'); outputHead.className = 'lookup-head'; outputHead.textContent = 'OUTPUT';
  table.append(inputHead, outputHead, document.createElement('span'));
  operation.points.forEach((point, index) => {
    const input = numberInput(point.input, -Number.MAX_VALUE, Number.MAX_VALUE, (next) => updateLookupPoint(signal.id, index, { input: next }));
    const output = numberInput(point.output, -Number.MAX_VALUE, Number.MAX_VALUE, (next) => updateLookupPoint(signal.id, index, { output: next }));
    pointInputs.push({ input, output });
    for (const control of [input, output]) {
      control.addEventListener('focus', () => { preview.select(index); pointInputs.forEach((pair, row) => { pair.input.classList.toggle('is-point-active', row === index); pair.output.classList.toggle('is-point-active', row === index); }); });
      control.addEventListener('input', () => preview.update([{ points: lookupPreviewPoints(pointInputs.map((pair) => ({ input: pair.input.valueAsNumber, output: pair.output.valueAsNumber }))) }]));
    }
    table.append(
      input,
      output,
      trashButton(`Delete Lookup point ${index + 1}`, () => { updateDerivedSignal(signal.id, (current) => ({ ...current, operation: current.operation.type === 'lookup' ? { ...current.operation, points: current.operation.points.filter((_, pointIndex) => pointIndex !== index) } : current.operation })); render(); })
    );
  });
  const add = button(t('+ Add Point', '+ 点を追加'), () => { updateDerivedSignal(signal.id, (current) => { if (current.operation.type !== 'lookup') return current; const last = current.operation.points.at(-1); return { ...current, operation: { ...current.operation, points: [...current.operation.points, { input: (last?.input ?? 0) + 1, output: last?.output ?? 0 }] } }; }); render(); }); add.className = 'secondary';
  const visual = document.createElement('div'); visual.className = 'definition-visual'; const editing = document.createElement('div'); editing.append(table, add); visual.append(editing, preview.element);
  wrap.append(controls, visual); return wrap;
}

function updateLookupPoint(id: string, index: number, patch: { readonly input?: number; readonly output?: number }): void {
  updateDerivedSignal(id, (current) => current.operation.type !== 'lookup' ? current : { ...current, operation: { ...current.operation, points: current.operation.points.map((point, pointIndex) => pointIndex === index ? { ...point, ...patch } : point) } });
}

function filterInput(signal: ManualDerivedSignalDefinition, available: readonly string[]): HTMLElement {
  const wrap = document.createElement('div'); wrap.className = 'definition-stack'; if (signal.operation.type !== 'filter') return wrap; const operation = signal.operation; const controls = document.createElement('div'); controls.className = 'definition-controls';
  controls.append(
    signalNameSelect(available, operation.input, (next) => updateDerivedSignal(signal.id, (current) => ({ ...current, operation: current.operation.type === 'filter' ? { ...current.operation, input: next } : current.operation }))),
    selectInput([['low-pass',t('Low-pass','ローパス')],['moving-average',t('Moving average','移動平均')]], operation.filter, (next) => updateDerivedSignal(signal.id, (current) => ({ ...current, operation: current.operation.type === 'filter' ? { ...current.operation, filter: next as 'low-pass' | 'moving-average' } : current.operation })))
  );
  const time = document.createElement('label'); time.className = 'field'; const caption = document.createElement('span'); caption.textContent = operation.filter === 'low-pass' ? t('Time constant (seconds)', '時定数（秒）') : t('Window (seconds)', '時間窓（秒）');
  const input = numberInput(operation.timeSeconds, 0.000001, Number.MAX_VALUE, (next) => updateDerivedSignal(signal.id, (current) => ({ ...current, operation: current.operation.type === 'filter' ? { ...current.operation, timeSeconds: next } : current.operation })));
  time.append(caption, input);
  const preview = createCurvePreview({ title: t('Example step response', 'ステップ応答の例'), xLabel: 's', yLabel: t('Relative value', '相対値'), lines: filterStepPreview(operation) }); previewDisposers.push(preview.dispose);
  input.addEventListener('input', () => preview.update(filterStepPreview({ ...operation, timeSeconds: input.valueAsNumber })));
  const visual = document.createElement('div'); visual.className = 'definition-visual'; const example = document.createElement('div'); const label = document.createElement('p'); label.className = 'preview-caption'; label.textContent = t('Example step response · dashed: input / solid: output', 'ステップ応答の例 · 破線: 入力 / 実線: 出力'); example.append(label, preview.element); visual.append(time, example);
  wrap.append(controls, visual); return wrap;
}

function textInput(value: string, change: (value: string) => void): HTMLInputElement { const input = document.createElement('input'); input.value = value; input.addEventListener('change', () => { change(input.value); serverDiagnostics = []; render(); }); return input; }
function multiplexerActivationInput(signal: ManualSignalDefinition): HTMLInputElement {
  const input = document.createElement('input'); input.value = formatMultiplexerActivation(signal); input.placeholder = 'Always / Multiplexer / 1, 2-4';
  input.addEventListener('change', () => {
    const text = input.value.trim(); const valid = !text || /^always$/i.test(text) || parseMultiplexerActivation(text) !== undefined;
    if (!valid) { input.setCustomValidity(t('Enter Always, Multiplexer, a value, or ranges such as 1, 2-4.', 'Always、Multiplexer、値、または1, 2-4のような範囲を入力してください。')); input.reportValidity(); return; }
    input.setCustomValidity(''); updateMultiplexerActivation(signal.id, text); serverDiagnostics = []; render();
  });
  return input;
}
function numberInput(value: number, min: number, max: number, change: (value: number) => void): HTMLInputElement { const input = document.createElement('input'); input.type = 'number'; input.min = String(min); input.max = String(max); input.value = String(value); input.addEventListener('change', () => { change(Number(input.value)); serverDiagnostics = []; render(); }); return input; }
function optionalNumberInput(value: number | undefined, change: (value: number | undefined) => void): HTMLInputElement { const input = document.createElement('input'); input.type = 'number'; input.value = value === undefined ? '' : String(value); input.addEventListener('change', () => { change(input.value.trim() ? Number(input.value) : undefined); serverDiagnostics = []; render(); }); return input; }
function selectInput(options: readonly (readonly [string,string])[], value: string, change: (value: string) => void): HTMLSelectElement { const select = document.createElement('select'); for (const [id,label] of options) { const option = document.createElement('option'); option.value = id; option.textContent = label; option.selected = id === value; select.appendChild(option); } select.addEventListener('change', () => { change(select.value); serverDiagnostics = []; render(); }); return select; }
function scaleFor(signal: ManualSignalDefinition): { readonly type: 'scale-offset'; readonly lsb: number; readonly lsbText: string; readonly offset: number } { return signal.conversion; }
function scaleInput(signal: ManualSignalDefinition): HTMLElement { const conversion = scaleFor(signal); const container = document.createElement('div'); const wrap = document.createElement('div'); wrap.className = 'resolution'; const factor = resolutionStepFactor(conversion.lsbText); const input = document.createElement('input'); input.value = conversion.lsbText; input.setAttribute('aria-label', `Scale for ${signal.name}`); const parsed = parseResolution(input.value); if (!parsed.valid) input.setAttribute('aria-invalid','true'); input.addEventListener('change', () => { const result = parseResolution(input.value); updateSignal(signal.id, (current) => ({ ...current, conversion: { ...scaleFor(current), lsbText: input.value, ...(result.valid ? { lsb: result.resolution.value } : {}) } })); render(); }); const spinner = document.createElement('span'); spinner.className = 'scale-spinner'; const up = iconButton('chevron-up', `Scale ×${factor}`, () => stepScale(signal, 'increase')); const down = iconButton('chevron-down', `Scale ÷${factor}`, () => stepScale(signal, 'decrease')); spinner.append(up, down); wrap.append(input, spinner); container.appendChild(wrap); if (!parsed.valid) { const error = document.createElement('span'); error.className = 'inline-error'; error.textContent = parsed.error; container.appendChild(error); } return container; }
function stepScale(signal: ManualSignalDefinition, direction: 'increase'|'decrease'): void { const current = scaleFor(signal); const adjusted = adjustResolution(current.lsbText, direction); if (!adjusted.valid) return; updateSignal(signal.id, (item) => ({ ...item, conversion: { ...scaleFor(item), lsb: adjusted.resolution.value, lsbText: adjusted.resolution.text } })); render(); }
function offsetInput(signal: ManualSignalDefinition): HTMLElement { const conversion = scaleFor(signal); return numberInput(conversion.offset, -Number.MAX_VALUE, Number.MAX_VALUE, (next) => updateSignal(signal.id, (current) => ({ ...current, conversion: { ...scaleFor(current), offset: next } }))); }
function expressionInput(signal: ManualDerivedSignalDefinition, names: readonly string[]): HTMLElement {
  const wrap = document.createElement('div'); wrap.className = 'expression-wrap';
  const expression = signal.operation.type === 'expression' ? signal.operation.expression : '';
  const updateExpression = (value: string) => updateDerivedSignal(signal.id, (current) => ({ ...current, operation: current.operation.type === 'expression' ? { ...current.operation, expression: value } : current.operation }));
  const input = document.createElement('input'); input.value = expression; input.placeholder = '[Vehicle Speed] * 3.6'; input.setAttribute('aria-label', `Expression for ${signal.name}`);
  const suggestions = document.createElement('div'); suggestions.className = 'expression-suggestions hidden';
  let candidates: readonly string[] = []; let active = 0; let replaceStart = -1;
  const close = () => { suggestions.classList.add('hidden'); suggestions.replaceChildren(); };
  const insert = (name: string) => {
    const cursor = input.selectionStart ?? input.value.length; const start = replaceStart >= 0 ? replaceStart : cursor;
    input.value = `${input.value.slice(0, start)}[${name}]${input.value.slice(cursor)}`;
    updateExpression(input.value);
    const nextCursor = start + name.length + 2; input.focus(); input.setSelectionRange(nextCursor, nextCursor); close();
  };
  const refresh = () => {
    const cursor = input.selectionStart ?? input.value.length; const before = input.value.slice(0, cursor); const open = before.lastIndexOf('['); const bracketClose = before.lastIndexOf(']');
    if (open <= bracketClose) { close(); return; }
    replaceStart = open; const query = before.slice(open + 1).trim().toLocaleLowerCase(); candidates = names.filter((name) => name.toLocaleLowerCase().includes(query)); active = 0; suggestions.replaceChildren();
    candidates.forEach((name, index) => { const option = button(name, () => insert(name)); option.type = 'button'; option.className = index === active ? 'active' : ''; option.addEventListener('mousedown', (event) => event.preventDefault()); suggestions.appendChild(option); });
    suggestions.classList.toggle('hidden', candidates.length === 0);
  };
  const selectActive = (delta: number) => { if (!candidates.length) return; active = (active + delta + candidates.length) % candidates.length; Array.from(suggestions.children).forEach((child, index) => child.classList.toggle('active', index === active)); };
  input.addEventListener('input', () => { updateExpression(input.value); refresh(); }); input.addEventListener('click', refresh); input.addEventListener('keydown', (event) => {
    if (suggestions.classList.contains('hidden')) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); selectActive(event.key === 'ArrowDown' ? 1 : -1); }
    else if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); if (candidates[active]) insert(candidates[active]); }
    else if (event.key === 'Escape') { event.preventDefault(); close(); }
  });
  input.addEventListener('blur', () => setTimeout(close, 0));
  input.addEventListener('change', () => { updateExpression(input.value); serverDiagnostics = []; render(); });
  wrap.append(input, suggestions); return wrap;
}
function cell(child: Node): HTMLElement { const element = document.createElement('div'); element.className = 'cell'; element.appendChild(child); return element; }
function definitionHeader<Row>(column: SizingColumn<Row>, columns: readonly SizingColumn<Row>[], rows: () => readonly Row[], selector: string): HTMLElement {
  const head = document.createElement('div'); head.className = 'head'; head.textContent = column.label; head.title = column.label; head.dataset.columnId = column.id;
  if (column.minWidth !== column.maxWidth) {
    const resize = document.createElement('span'); resize.className = 'resize';
    resize.addEventListener('mousedown', (event) => startResize(event, column, columns, selector));
    resize.addEventListener('dblclick', () => {
      widths[column.id] = autoFitColumns([column], rows(), measureText)[column.id];
      applyTableWidths(columns, selector); persist();
    });
    head.append(resize);
  }
  return head;
}
function button(label: string, click: () => void, primary = false): HTMLButtonElement { const element = document.createElement('button'); element.textContent = label; if (primary) element.className = 'primary'; element.addEventListener('click', click); return element; }
function iconButton(icon: string, title: string, click: () => void): HTMLButtonElement { const element = document.createElement('button'); element.type = 'button'; element.className = 'icon'; element.title = title; element.setAttribute('aria-label', title); const glyph = document.createElement('span'); glyph.className = `codicon codicon-${icon}`; glyph.setAttribute('aria-hidden', 'true'); element.appendChild(glyph); element.addEventListener('click', click); return element; }
function trashButton(title: string, click: () => void): HTMLButtonElement { const result = iconButton('trash', title, click); result.classList.add('danger'); return result; }
const textMeasureContext = document.createElement('canvas').getContext('2d');
function measureText(text: string): number { if (!textMeasureContext) return text.length * 8; textMeasureContext.font = getComputedStyle(document.body).font; return textMeasureContext.measureText(text).width; }
// Include the input padding, cell padding and adjacent controls, not just the text.
function autoFitColumns<Row>(columns: readonly SizingColumn<Row>[], rows: readonly Row[], measure: (text: string) => number): Readonly<Record<string, number>> {
  return Object.assign({}, ...columns.map((column) => {
    const nameColumn = column.id === 'name' || column.id === 'derivedName';
    const unitColumn = column.id === 'unit' || column.id === 'derivedUnit';
    const input = nameColumn || unitColumn ? document.querySelector<HTMLInputElement>(`${column.id.startsWith('derived') ? '.derived-row' : '.signal-row'} .cell:nth-child(${unitColumn ? 2 : 1}) input`) : null;
    // Measure the actual input font and the space occupied by its cell, padding and icon.
    const style = input ? getComputedStyle(input) : undefined;
    const padding = input && style ? Math.ceil(input.closest('.cell')!.getBoundingClientRect().width - input.clientWidth + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + 2) : nameColumn ? 60 : unitColumn ? 24 : column.id === 'scale' ? 76 : 32;
    const measureValue = style && textMeasureContext ? (text: string) => { textMeasureContext!.font = style.font; return textMeasureContext!.measureText(text).width; } : measure;
    return measureColumnWidths([column], rows, measureValue, padding);
  }));
}
function sizedTextInput(value: string, update: (value: string) => void, id: string, columns: readonly { readonly id: string }[], selector: string): HTMLInputElement {
  const input = document.createElement('input'); input.value = value; input.title = value;
  input.style.cssText = 'flex:1 1 0;min-width:0';
  input.addEventListener('input', () => {
    input.title = input.value;
    update(input.value);
    resizeTextColumn(id, columns, selector, false);
  });
  input.addEventListener('blur', () => {
    // Let the next control receive the click/focus before changing its position.
    requestAnimationFrame(() => { if (input.isConnected) resizeTextColumn(id, columns, selector, true); });
  });
  return input;
}
function resizeTextColumn(id: string, columns: readonly { readonly id: string }[], selector: string, fit: boolean): void {
  if (!frame) return;
  const needed = columnDefinitions.some((column) => column.id === id)
    ? autoFitColumns(columnDefinitions.filter((column) => column.id === id), frame.signals, measureText)[id]
    : autoFitColumns(derivedColumnDefinitions.filter((column) => column.id === id), frame.derivedSignals ?? [], measureText)[id];
  const next = fit ? needed : Math.max(widths[id], needed);
  if (next === widths[id]) { if (fit) persist(); return; }
  widths[id] = next;
  // Update only the grid: preserve the input, caret, focus and page scroll.
  applyTableWidths(columns, selector);
  if (fit) persist(); else vscode.setState({ widths });
}
function fitTextColumnsOnEntry(): void {
  if (!frame) return;
  const fitted = { ...autoFitColumns(columnDefinitions.filter((column) => column.id === 'name' || column.id === 'unit'), frame.signals, measureText), ...autoFitColumns(derivedColumnDefinitions.filter((column) => column.id === 'derivedName' || column.id === 'derivedUnit'), frame.derivedSignals ?? [], measureText) };
  for (const [id, width] of Object.entries(fitted)) widths[id] = Math.max(widths[id] ?? 0, width);
}
function startResize<T>(event: MouseEvent, column: SizingColumn<T>, columns: readonly { readonly id: string }[], selector: string): void {
  event.preventDefault(); const start = event.clientX;
  const initial = (event.currentTarget as HTMLElement).parentElement!.getBoundingClientRect().width;
  const move = (next: MouseEvent) => {
    widths[column.id] = Math.max(column.minWidth, Math.min(column.maxWidth, initial + next.clientX - start));
    applyTableWidths(columns, selector);
  };
  const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); persist(); };
  window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
}
function buildDiagnostics(items: readonly Diagnostic[]): HTMLElement { const box = document.createElement('div'); box.className = 'diagnostics'; const strong = document.createElement('strong'); strong.textContent = t(`Definition has ${items.length} issue${items.length === 1 ? '' : 's'}`, `定義に${items.length}件の問題があります`); const list = document.createElement('ul'); for (const item of items.slice(0, 20)) { const row = document.createElement('li'); row.textContent = item.message; list.appendChild(row); } box.append(strong,list); return box; }
function saveFrame(): void {
  saveTimer = undefined;
  if (!frame) return;
  const validation = validateFrameDefinition(frame);
  serverDiagnostics = validation.diagnostics;
  if (!validation.valid) {
    refreshValidation();
    return;
  }
  const revision = editRevision;
  vscode.postMessage({ type: 'save', revision, frame: structuredClone(frame) });
}

function validationDiagnostics(): readonly Diagnostic[] {
  if (!frame) return [];
  return [...new Map([...validateFrameDefinition(frame).diagnostics, ...serverDiagnostics].map((item) => [`${item.code}:${item.details?.signalId ?? ''}:${item.message}`, item])).values()];
}

function refreshValidation(): void {
  const diagnostics = validationDiagnostics();
  content.querySelector('.diagnostics')?.remove();
  for (const row of Array.from(content.querySelectorAll<HTMLElement>('[data-signal-id]'))) {
    const errors = diagnostics.filter((item) => item.details?.signalId === row.dataset.signalId);
    row.classList.toggle('invalid-row', errors.length > 0); row.title = errors.map((item) => item.message).join('\n');
  }
  if (diagnostics.length) content.appendChild(buildDiagnostics(diagnostics));
}

function sortSignalsForPageEntry(): void {
  if (!frame) return;
  fitTextColumnsOnEntry();
  const signals = orderSignalsByDataPosition(frame.signals);
  if (signals.every((signal, index) => signal.id === frame?.signals[index]?.id)) { render(); return; }
  frame = { ...frame, signals };
  changed();
  render();
}

window.addEventListener('message', (event: MessageEvent<FrameEditorToWebview>) => {
  const message = event.data;
  if (message.type === 'init') {
    expandedDependencyId = undefined;
    valueLabelDrafts.clear(); expandedValueLabelsId = undefined;
    const initial = structuredClone(message.frame); frame = { ...initial, signals: orderSignalsByDataPosition(initial.signals) };
    widths = initialWidths(message.widths ?? saved.widths);
    fitTextColumnsOnEntry();
    editingSignalId = undefined; selectedSignalId = undefined; expandedDerivedId = undefined; serverDiagnostics = []; render();
  } else if (message.type === 'sortSignals') sortSignalsForPageEntry();
  else if (message.type === 'saveResult') { if (message.revision < editRevision) return; serverDiagnostics = message.diagnostics; if (message.saved && message.frame) frame = structuredClone(message.frame); refreshValidation(); }
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (saveTimer) { clearTimeout(saveTimer); saveFrame(); }
    return;
  }
  sortSignalsForPageEntry();
});
window.addEventListener('beforeunload', () => { if (saveTimer) { clearTimeout(saveTimer); saveFrame(); } });
vscode.postMessage({ type: 'ready' });
