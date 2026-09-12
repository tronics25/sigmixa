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
import { autoFitColumns, type SizingColumn } from '../shared/columnSizing';
import { t } from '../shared/i18n';

declare function acquireVsCodeApi(): { postMessage(message: FrameEditorToExtension): void; getState(): unknown; setState(value: unknown): void };
const vscode = acquireVsCodeApi();
const app = document.getElementById('app')!;
let frame: ManualFrameDefinition | undefined;
let serverDiagnostics: readonly Diagnostic[] = [];
let editRevision = 0;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let multiplexerPreview = 0;

interface RenderViewState {
  readonly windowX: number;
  readonly windowY: number;
  readonly scrollAreas: Readonly<Record<string, { readonly left: number; readonly top: number }>>;
  readonly activeControlIndex?: number;
  readonly selectionStart?: number | null;
  readonly selectionEnd?: number | null;
}

const columnDefinitions: readonly SizingColumn<ManualSignalDefinition>[] = [
  { id: 'name', label: 'NAME', minWidth: 130, maxWidth: 280, value: (signal) => signal.name },
  { id: 'unit', label: 'UNIT', minWidth: 75, maxWidth: 180, value: (signal) => signal.unit },
  { id: 'byte', label: 'BYTE', minWidth: 70, maxWidth: 100, value: (signal) => String(signal.byteOffset) },
  { id: 'bit', label: 'BIT', minWidth: 62, maxWidth: 90, value: (signal) => String(signal.bitOffset) },
  { id: 'length', label: 'LENGTH', minWidth: 82, maxWidth: 110, value: (signal) => String(signal.lengthBits) },
  { id: 'signed', label: 'TYPE', minWidth: 100, maxWidth: 130, value: (signal) => signal.signedness },
  { id: 'endian', label: 'BYTE ORDER', minWidth: 112, maxWidth: 145, value: (signal) => signal.byteOrder },
  { id: 'scale', label: 'SCALE', minWidth: 130, maxWidth: 220, value: (signal) => scaleFor(signal).lsbText },
  { id: 'offset', label: 'OFFSET', minWidth: 90, maxWidth: 130, value: (signal) => String(scaleFor(signal).offset) },
  { id: 'minimum', label: 'MIN', minWidth: 85, maxWidth: 130, value: (signal) => signal.minimum === undefined ? '' : String(signal.minimum) },
  { id: 'maximum', label: 'MAX', minWidth: 85, maxWidth: 130, value: (signal) => signal.maximum === undefined ? '' : String(signal.maximum) },
  { id: 'activation', label: 'ACTIVE WHEN', minWidth: 135, maxWidth: 220, value: formatMultiplexerActivation },
  { id: 'actions', label: '', minWidth: 52, maxWidth: 52, value: () => '' },
];

const derivedColumnDefinitions: readonly SizingColumn<ManualDerivedSignalDefinition>[] = [
  { id: 'derivedName', label: 'NAME', minWidth: 150, maxWidth: 320, value: (signal) => signal.name },
  { id: 'derivedUnit', label: 'UNIT', minWidth: 80, maxWidth: 180, value: (signal) => signal.unit },
  { id: 'derivedType', label: 'TYPE', minWidth: 140, maxWidth: 190, value: (signal) => signal.operation.type },
  { id: 'definition', label: 'DEFINITION', minWidth: 360, maxWidth: 900, value: derivedSummary },
  { id: 'derivedActions', label: '', minWidth: 52, maxWidth: 52, value: () => '' },
];

const saved = (vscode.getState() ?? {}) as { widths?: Record<string, number> };
let widths: Record<string, number> = {
  name: 150, unit: 80, byte: 72, bit: 64, length: 84, signed: 105, endian: 116,
  scale: saved.widths?.scale ?? saved.widths?.lsb ?? 170, offset: 94, minimum: 90, maximum: 90, activation: 150, actions: 52,
  derivedName: 180, derivedUnit: 90, derivedType: 160, definition: saved.widths?.definition ?? saved.widths?.expression ?? 520, derivedActions: 52, ...saved.widths,
};

function derivedSummary(signal: ManualDerivedSignalDefinition): string {
  if (signal.operation.type === 'expression') return signal.operation.expression;
  if (signal.operation.type === 'lookup') return `${signal.operation.input} · ${t('Linear interpolation', '線形補間')} · ${signal.operation.points.length} points · ${signal.operation.outOfRange}`;
  return `${signal.operation.input} · ${signal.operation.filter} · ${signal.operation.timeSeconds}s`;
}

app.innerHTML = `<style>
*{box-sizing:border-box}body{margin:0;color:var(--vscode-foreground);background:var(--vscode-editor-background);font-family:var(--vscode-font-family)}#app{padding:14px;min-width:720px}h1{font-size:20px;margin:0 0 12px}h2{font-size:14px;margin:18px 0 8px}.toolbar,.header-fields{display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap}.field{display:flex;flex-direction:column;gap:4px}.field label{font-size:11px;color:var(--vscode-descriptionForeground)}
input,select,button{font:inherit;color:inherit;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,transparent);border-radius:3px;padding:5px 7px;min-width:0}button{cursor:pointer;background:var(--vscode-button-secondaryBackground)}button:hover{background:var(--vscode-button-secondaryHoverBackground)}button.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}input:focus-visible,select:focus-visible,button:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:1px}.spacer{flex:1}.muted{color:var(--vscode-descriptionForeground);font-size:12px}.error{color:var(--vscode-errorForeground);font-size:12px}.success{color:var(--vscode-testing-iconPassed);font-size:12px}
.check-field{display:flex;align-items:center;gap:6px;height:29px}.check-field input{margin:0;width:auto}.bit-heading{display:flex;align-items:center;gap:8px;margin-top:18px}.bit-heading h2{margin:0}.mux-preview{display:flex;align-items:center;gap:4px}.mux-preview .icon{width:25px;height:25px}.mux-value{min-width:72px;text-align:center;font:12px var(--vscode-editor-font-family)}
.bit-layout{border:1px solid var(--vscode-panel-border);border-radius:4px;padding:8px;overflow:auto}.byte-grid{display:grid;grid-template-columns:repeat(8,minmax(70px,1fr));gap:6px;min-width:620px}.byte{border:1px solid var(--vscode-panel-border);border-radius:3px;padding:4px}.byte-label{text-align:center;font:11px var(--vscode-editor-font-family);color:var(--vscode-descriptionForeground)}.bits{display:grid;grid-template-columns:repeat(8,1fr);gap:1px;margin-top:4px}.bit{height:15px;border:1px dashed var(--vscode-panel-border);font-size:8px;text-align:center;overflow:hidden}.overlap{background:var(--vscode-inputValidation-errorBackground)!important;border-color:var(--vscode-inputValidation-errorBorder)!important}
.table-wrap{overflow:auto;border:1px solid var(--vscode-panel-border);border-radius:4px}.signal-header,.signal-row,.derived-header,.derived-row{display:grid;min-width:max-content;align-items:center}.derived-row{align-items:start}.signal-header,.derived-header{position:sticky;top:0;z-index:2;background:var(--vscode-editor-background);border-bottom:1px solid var(--vscode-panel-border)}.head{position:relative;padding:7px;font-size:10px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.resize{position:absolute;right:-3px;top:0;width:7px;height:100%;cursor:col-resize}.signal-row,.derived-row{border-bottom:1px solid color-mix(in srgb,var(--vscode-panel-border) 55%,transparent)}.cell{position:relative;padding:4px;overflow:visible}.cell input,.cell select{width:100%}.resolution{display:flex;align-items:center;gap:3px}.resolution>input{min-width:70px}.scale-spinner{display:flex;flex-direction:column;flex:0 0 18px}.scale-spinner button{height:13px;min-width:18px;padding:0 2px;border-radius:2px;line-height:9px;color:var(--vscode-foreground)}.scale-spinner button:hover{color:var(--vscode-foreground)}.scale-spinner .codicon{font-size:9px}.icon{display:flex;align-items:center;justify-content:center;min-width:0;padding:4px;color:var(--vscode-descriptionForeground);background:transparent}.icon:hover{color:var(--vscode-errorForeground);background:var(--vscode-toolbar-hoverBackground)}.diagnostics{margin:8px 0;padding:8px 10px;border:1px solid var(--vscode-inputValidation-errorBorder);background:var(--vscode-inputValidation-errorBackground);border-radius:4px}.diagnostics ul{margin:4px 0 0;padding-left:20px}.hidden{display:none}
.expression-wrap{position:relative}.expression-suggestions{position:static;margin-top:3px;max-height:160px;overflow:auto;border:1px solid var(--vscode-widget-border,var(--vscode-panel-border));background:var(--vscode-editorSuggestWidget-background,var(--vscode-editor-background));box-shadow:0 4px 12px #0006}.expression-suggestions button{display:block;width:100%;padding:5px 7px;text-align:left;border:0;border-radius:0;background:transparent}.expression-suggestions button:hover,.expression-suggestions button.active{background:var(--vscode-editorSuggestWidget-selectedBackground,var(--vscode-list-activeSelectionBackground))}
.definition-stack{display:flex;flex-direction:column;gap:5px}.definition-controls{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:5px}.lookup-table{display:grid;grid-template-columns:minmax(100px,1fr) minmax(100px,1fr) 30px;gap:3px;align-items:center}.lookup-head{font-size:10px;font-weight:650;color:var(--vscode-descriptionForeground);padding:2px 5px}.lookup-table .icon{height:27px}.definition-stack>.secondary{align-self:flex-start}
.invalid-row{box-shadow:inset 3px 0 var(--vscode-inputValidation-errorBorder)}.inline-error{display:block;margin-top:3px;color:var(--vscode-errorForeground);font-size:10px;white-space:normal}
</style><div id="content"><p class="muted">${t('Loading frame definition…', 'フレーム定義を読み込み中…')}</p></div>`;

const content = document.getElementById('content')!;
const template = (columns: readonly { readonly id: string }[]) => columns.map((column) => `${Math.round(widths[column.id])}px`).join(' ');
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
  if (frame) { frame = { ...frame, derivedSignals: (frame.derivedSignals ?? []).map((signal) => signal.id === id ? transform(signal) : signal) }; changed(); }
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
  if (!frame) return;
  const view = captureRenderView();
  content.replaceChildren();
  const title = document.createElement('h1'); title.textContent = t('Frame Definition', 'フレーム定義');
  const fields = document.createElement('div'); fields.className = 'header-fields';
  const pluginOwned = frame.origin?.type === 'plugin';
  fields.append(
    inputField('CAN ID', formatCanId(frame.canId, frame.extended), (value) => {
      const parsed = parseCanId(value); updateFrame(parsed ?? { canId: Number.NaN, extended: false });
    }, { width: '130px', disabled: pluginOwned }),
    inputField(t('Frame name', 'フレーム名'), frame.name, (value) => updateFrame({ name: value }), { width: '240px' })
  );
  const lengthField = document.createElement('label'); lengthField.className = 'field'; lengthField.innerHTML = `<span>${t('Frame length', 'フレーム長')}</span>`;
  const length = document.createElement('select');
  for (const value of [0,1,2,3,4,5,6,7,8,12,16,20,24,32,48,64]) { const option = document.createElement('option'); option.value = String(value); option.textContent = `${value} bytes${value > 8 ? ' (CAN FD)' : ''}`; option.selected = frame.frameLength === value; length.appendChild(option); }
  length.addEventListener('change', () => { updateFrame({ frameLength: Number(length.value) }); serverDiagnostics = []; render(); }); lengthField.appendChild(length); fields.appendChild(lengthField);
  const multiplexingField = document.createElement('label'); multiplexingField.className = 'field';
  const multiplexingCaption = document.createElement('span'); multiplexingCaption.textContent = 'Multiplexing';
  const multiplexingControl = document.createElement('span'); multiplexingControl.className = 'check-field';
  const multiplexing = document.createElement('input'); multiplexing.type = 'checkbox'; multiplexing.checked = frame.multiplexing === true;
  const multiplexingText = document.createElement('span'); multiplexingText.textContent = multiplexing.checked ? 'ON' : 'OFF';
  multiplexing.addEventListener('change', () => { updateFrame({ multiplexing: multiplexing.checked || undefined, ...(!multiplexing.checked ? { signals: frame?.signals.map((signal) => ({ ...signal, multiplexing: undefined })) } : {}) }); multiplexerPreview = 0; render(); });
  multiplexingControl.append(multiplexing, multiplexingText); multiplexingField.append(multiplexingCaption, multiplexingControl); fields.appendChild(multiplexingField);
  if (pluginOwned) { const ownership = document.createElement('div'); ownership.className = 'muted'; ownership.textContent = `Provided by ${frame.origin?.type === 'plugin' ? frame.origin.pluginId : ''} · CAN ID is read-only`; fields.appendChild(ownership); }
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
  const signalTitle = document.createElement('h2'); signalTitle.textContent = t('Signal Definitions', 'Signal定義'); content.appendChild(signalTitle);
  const toolbar = document.createElement('div'); toolbar.className = 'toolbar'; toolbar.style.margin = '12px 0 7px';
  const add = button(t('+ Add Signal', '+ Signalを追加'), () => { const previous = frame?.signals[frame.signals.length - 1]; if (frame) updateFrame({ signals: [...frame.signals, createManualSignal(uuid(), previous, frame.frameLength)] }); render(); }, true);
  const autoFit = button(t('Auto Fit', '自動調整'), () => { if (!frame) return; const columns = signalColumns(); widths = { ...widths, ...autoFitColumns(columns, frame.signals, measureText) }; persist(); render(); });
  toolbar.append(add, autoFit); content.append(toolbar, buildSignalTable(frame));
  const derivedTitle = document.createElement('h2'); derivedTitle.textContent = t('Derived Signal Definitions', '派生Signal定義'); content.appendChild(derivedTitle);
  const derivedToolbar = document.createElement('div'); derivedToolbar.className = 'toolbar'; derivedToolbar.style.margin = '12px 0 7px';
  const addDerived = button(t('+ Add Derived Signal', '+ 派生Signalを追加'), () => { if (frame) updateFrame({ derivedSignals: [...(frame.derivedSignals ?? []), createManualDerivedSignal(uuid())] }); render(); }, true);
  const autoFitDerived = button(t('Auto Fit', '自動調整'), () => { if (!frame) return; widths = { ...widths, ...autoFitColumns(derivedColumnDefinitions, frame.derivedSignals ?? [], measureText) }; persist(); render(); });
  const derivedNote = document.createElement('span'); derivedNote.className = 'muted'; derivedNote.textContent = t('Definitions may reference extracted Signals and only the Derived Signals above the current row.', '抽出Signalと、現在行より上の派生Signalだけを参照できます。');
  derivedToolbar.append(addDerived, autoFitDerived, derivedNote); content.append(derivedToolbar, buildDerivedTable(frame));
  const validation = [...validateFrameDefinition(frame).diagnostics, ...serverDiagnostics];
  if (validation.length) content.appendChild(buildDiagnostics(validation));
  const note = document.createElement('p'); note.className = 'muted'; note.textContent = t('Signal Definitions always apply Scale + Offset after bit extraction. Changing byte, bit, or length never changes byte order; a new Signal inherits the previous byte order.', 'Signal定義ではビット抽出後に常にScale + Offsetを適用します。Byte、Bit、Lengthを変更してもByte Orderは変わらず、新しいSignalは直前のByte Orderを引き継ぎます。'); content.appendChild(note);
  restoreRenderView(view);
}

function captureRenderView(): RenderViewState {
  const scrollAreas: Record<string, { left: number; top: number }> = {};
  document.querySelectorAll<HTMLElement>('[data-scroll-key]').forEach((element) => {
    const key = element.dataset.scrollKey;
    if (key) scrollAreas[key] = { left: element.scrollLeft, top: element.scrollTop };
  });
  const controls = Array.from(content.querySelectorAll<HTMLElement>('input,select,button'));
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  const activeControlIndex = active ? controls.indexOf(active) : -1;
  const selection = active instanceof HTMLInputElement ? active : undefined;
  return {
    windowX: window.scrollX,
    windowY: window.scrollY,
    scrollAreas,
    ...(activeControlIndex >= 0 ? { activeControlIndex } : {}),
    selectionStart: selection?.selectionStart,
    selectionEnd: selection?.selectionEnd,
  };
}

function restoreRenderView(view: RenderViewState): void {
  document.querySelectorAll<HTMLElement>('[data-scroll-key]').forEach((element) => {
    const saved = element.dataset.scrollKey ? view.scrollAreas[element.dataset.scrollKey] : undefined;
    if (saved) { element.scrollLeft = saved.left; element.scrollTop = saved.top; }
  });
  if (view.activeControlIndex !== undefined) {
    const control = content.querySelectorAll<HTMLElement>('input,select,button')[view.activeControlIndex];
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
  value.signals.forEach((signal, signalIndex) => { if (value.multiplexing && !isSignalActive(signal, multiplexerPreview)) return; for (const bit of occupiedBits(signal)) { const entries = owner.get(bit) ?? []; entries.push(signalIndex); owner.set(bit, entries); } });
  const wrap = document.createElement('div'); wrap.className = 'bit-layout'; wrap.dataset.scrollKey = 'bit-layout'; const grid = document.createElement('div'); grid.className = 'byte-grid';
  for (let byte = 0; byte < value.frameLength; byte++) {
    const box = document.createElement('div'); box.className = 'byte'; const label = document.createElement('div'); label.className = 'byte-label'; label.textContent = `BYTE ${byte}`; const bits = document.createElement('div'); bits.className = 'bits';
    for (let bit = 7; bit >= 0; bit--) { const cell = document.createElement('div'); cell.className = 'bit'; const owners = owner.get(byte * 8 + bit) ?? []; cell.textContent = String(bit); if (owners.length > 1) cell.classList.add('overlap'); else if (owners.length === 1) { cell.style.background = `hsl(${owners[0] * 67 % 360} 55% 42% / .65)`; cell.style.borderStyle = 'solid'; cell.title = value.signals[owners[0]].name; } bits.appendChild(cell); }
    box.append(label, bits); grid.appendChild(box);
  }
  wrap.appendChild(grid); return wrap;
}

function buildSignalTable(value: ManualFrameDefinition): HTMLElement {
  const columns = signalColumns(); const wrap = document.createElement('div'); wrap.className = 'table-wrap'; wrap.dataset.scrollKey = 'signal-table'; const header = document.createElement('div'); header.className = 'signal-header'; header.style.gridTemplateColumns = template(columns);
  columns.forEach((column) => { const cell = document.createElement('div'); cell.className = 'head'; cell.textContent = column.label; cell.title = column.label; const resize = document.createElement('span'); resize.className = 'resize'; resize.addEventListener('mousedown', (event) => startResize(event, column, columns, '.signal-header,.signal-row')); resize.addEventListener('dblclick', () => { if (!frame) return; const fitted = autoFitColumns([column], frame.signals, measureText); widths[column.id] = fitted[column.id]; persist(); render(); }); cell.appendChild(resize); header.appendChild(cell); }); wrap.appendChild(header);
  const validation = validateFrameDefinition(value).diagnostics;
  for (const signal of value.signals) { const row = document.createElement('div'); const signalErrors = validation.filter((item) => item.details?.signalId === signal.id); row.className = `signal-row${signalErrors.length ? ' invalid-row' : ''}`; row.title = signalErrors.map((item) => item.message).join('\n'); row.style.gridTemplateColumns = template(columns);
    const cells = [
      cell(textInput(signal.name, (next) => updateSignal(signal.id, (current) => ({ ...current, name: next })))),
      cell(textInput(signal.unit, (next) => updateSignal(signal.id, (current) => ({ ...current, unit: next })))),
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
    row.append(...cells); wrap.appendChild(row);
  }
  if (!value.signals.length) { const empty = document.createElement('p'); empty.className = 'muted'; empty.style.padding = '8px'; empty.textContent = t('No manual signals are defined.', 'Signalが定義されていません。'); wrap.appendChild(empty); }
  return wrap;
}

function buildDerivedTable(value: ManualFrameDefinition): HTMLElement {
  const derived = value.derivedSignals ?? []; const wrap = document.createElement('div'); wrap.className = 'table-wrap'; wrap.dataset.scrollKey = 'derived-table'; const header = document.createElement('div'); header.className = 'derived-header'; header.style.gridTemplateColumns = template(derivedColumnDefinitions);
  for (const column of derivedColumnDefinitions) { const head = document.createElement('div'); head.className = 'head'; head.textContent = column.label; head.title = column.label; const resize = document.createElement('span'); resize.className = 'resize'; resize.addEventListener('mousedown', (event) => startResize(event, column, derivedColumnDefinitions, '.derived-header,.derived-row')); resize.addEventListener('dblclick', () => { const fitted = autoFitColumns([column], derived, measureText); widths[column.id] = fitted[column.id]; persist(); render(); }); head.appendChild(resize); header.appendChild(head); } wrap.appendChild(header);
  const validation = validateFrameDefinition(value).diagnostics;
  derived.forEach((signal, index) => {
    const errors = validation.filter((item) => item.details?.signalId === signal.id); const row = document.createElement('div'); row.className = `derived-row${errors.length ? ' invalid-row' : ''}`; row.title = errors.map((item) => item.message).join('\n'); row.style.gridTemplateColumns = template(derivedColumnDefinitions);
    const available = [...value.signals.map((item) => item.name), ...derived.slice(0, index).map((item) => item.name)].filter(Boolean);
    row.append(
      cell(textInput(signal.name, (next) => updateDerivedSignal(signal.id, (current) => ({ ...current, name: next })))),
      cell(textInput(signal.unit, (next) => updateDerivedSignal(signal.id, (current) => ({ ...current, unit: next })))),
      cell(selectInput([['expression',t('Expression','計算式')],['lookup',t('Linear interpolation','線形補間')],['filter',t('Filter','フィルター')]], signal.operation.type, (next) => updateDerivedSignal(signal.id, (current) => ({ ...current, operation: operationForType(next as ManualDerivedSignalDefinition['operation']['type'], current.operation, available) })))),
      cell(derivedDefinitionInput(signal, available)),
      cell(trashButton(`Delete ${signal.name}`, () => { if (frame) updateFrame({ derivedSignals: (frame.derivedSignals ?? []).filter((item) => item.id !== signal.id) }); render(); }))
    ); wrap.appendChild(row);
  });
  if (!derived.length) { const empty = document.createElement('p'); empty.className = 'muted'; empty.style.padding = '8px'; empty.textContent = t('No Derived Signals are defined.', '派生Signalが定義されていません。'); wrap.appendChild(empty); }
  return wrap;
}

function operationForType(type: ManualDerivedSignalDefinition['operation']['type'], current: ManualDerivedSignalDefinition['operation'], available: readonly string[]): ManualDerivedSignalDefinition['operation'] {
  if (type === current.type) return current;
  if (type === 'expression') return { type, expression: available[0] ? `[${available[0]}]` : '' };
  if (type === 'lookup') return { type, input: available[0] ?? '', outOfRange: 'clamp', points: [{ input: 0, output: 0 }, { input: 1, output: 1 }] };
  return { type, input: available[0] ?? '', filter: 'low-pass', timeSeconds: 1 };
}

function derivedDefinitionInput(signal: ManualDerivedSignalDefinition, available: readonly string[]): HTMLElement {
  if (signal.operation.type === 'expression') return expressionInput(signal, available);
  if (signal.operation.type === 'lookup') return lookupInput(signal, available);
  return filterInput(signal, available);
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
  const inputHead = document.createElement('span'); inputHead.className = 'lookup-head'; inputHead.textContent = 'INPUT';
  const outputHead = document.createElement('span'); outputHead.className = 'lookup-head'; outputHead.textContent = 'OUTPUT';
  table.append(inputHead, outputHead, document.createElement('span'));
  operation.points.forEach((point, index) => {
    table.append(
      numberInput(point.input, -Number.MAX_VALUE, Number.MAX_VALUE, (next) => updateLookupPoint(signal.id, index, { input: next })),
      numberInput(point.output, -Number.MAX_VALUE, Number.MAX_VALUE, (next) => updateLookupPoint(signal.id, index, { output: next })),
      trashButton(`Delete Lookup point ${index + 1}`, () => { updateDerivedSignal(signal.id, (current) => ({ ...current, operation: current.operation.type === 'lookup' ? { ...current.operation, points: current.operation.points.filter((_, pointIndex) => pointIndex !== index) } : current.operation })); render(); })
    );
  });
  const add = button(t('+ Add Point', '+ 点を追加'), () => { updateDerivedSignal(signal.id, (current) => { if (current.operation.type !== 'lookup') return current; const last = current.operation.points.at(-1); return { ...current, operation: { ...current.operation, points: [...current.operation.points, { input: (last?.input ?? 0) + 1, output: last?.output ?? 0 }] } }; }); render(); }); add.className = 'secondary';
  wrap.append(controls, table, add); return wrap;
}

function updateLookupPoint(id: string, index: number, patch: { readonly input?: number; readonly output?: number }): void {
  updateDerivedSignal(id, (current) => current.operation.type !== 'lookup' ? current : { ...current, operation: { ...current.operation, points: current.operation.points.map((point, pointIndex) => pointIndex === index ? { ...point, ...patch } : point).sort((left, right) => left.input - right.input) } });
}

function filterInput(signal: ManualDerivedSignalDefinition, available: readonly string[]): HTMLElement {
  const wrap = document.createElement('div'); wrap.className = 'definition-stack'; if (signal.operation.type !== 'filter') return wrap; const operation = signal.operation; const controls = document.createElement('div'); controls.className = 'definition-controls';
  controls.append(
    signalNameSelect(available, operation.input, (next) => updateDerivedSignal(signal.id, (current) => ({ ...current, operation: current.operation.type === 'filter' ? { ...current.operation, input: next } : current.operation }))),
    selectInput([['low-pass',t('Low-pass','ローパス')],['moving-average',t('Moving average','移動平均')]], operation.filter, (next) => updateDerivedSignal(signal.id, (current) => ({ ...current, operation: current.operation.type === 'filter' ? { ...current.operation, filter: next as 'low-pass' | 'moving-average' } : current.operation })))
  );
  const time = document.createElement('label'); time.className = 'field'; const caption = document.createElement('span'); caption.textContent = operation.filter === 'low-pass' ? 'Time constant (seconds)' : 'Window (seconds)';
  time.append(caption, numberInput(operation.timeSeconds, 0.000001, Number.MAX_VALUE, (next) => updateDerivedSignal(signal.id, (current) => ({ ...current, operation: current.operation.type === 'filter' ? { ...current.operation, timeSeconds: next } : current.operation }))));
  wrap.append(controls, time); return wrap;
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
function button(label: string, click: () => void, primary = false): HTMLButtonElement { const element = document.createElement('button'); element.textContent = label; if (primary) element.className = 'primary'; element.addEventListener('click', click); return element; }
function iconButton(icon: string, title: string, click: () => void): HTMLButtonElement { const element = document.createElement('button'); element.type = 'button'; element.className = 'icon'; element.title = title; element.setAttribute('aria-label', title); const glyph = document.createElement('span'); glyph.className = `codicon codicon-${icon}`; glyph.setAttribute('aria-hidden', 'true'); element.appendChild(glyph); element.addEventListener('click', click); return element; }
function trashButton(title: string, click: () => void): HTMLButtonElement { return iconButton('trash', title, click); }
function measureText(text: string): number { const canvas = document.createElement('canvas'); const context = canvas.getContext('2d'); if (!context) return text.length * 8; context.font = getComputedStyle(document.body).font; return context.measureText(text).width; }
function startResize<T>(event: MouseEvent, column: SizingColumn<T>, columns: readonly { readonly id: string }[], selector: string): void { event.preventDefault(); const start = event.clientX; const initial = widths[column.id]; const move = (next: MouseEvent) => { widths[column.id] = Math.max(column.minWidth, Math.min(column.maxWidth, initial + next.clientX - start)); document.querySelectorAll<HTMLElement>(selector).forEach((item) => item.style.gridTemplateColumns = template(columns)); }; const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); persist(); }; window.addEventListener('mousemove', move); window.addEventListener('mouseup', up); }
function buildDiagnostics(items: readonly Diagnostic[]): HTMLElement { const box = document.createElement('div'); box.className = 'diagnostics'; const strong = document.createElement('strong'); strong.textContent = t(`Definition has ${items.length} issue${items.length === 1 ? '' : 's'}`, `定義に${items.length}件の問題があります`); const list = document.createElement('ul'); for (const item of items.slice(0, 20)) { const row = document.createElement('li'); row.textContent = item.message; list.appendChild(row); } box.append(strong,list); return box; }
function saveFrame(): void {
  saveTimer = undefined;
  if (!frame) return;
  const validation = validateFrameDefinition(frame);
  serverDiagnostics = validation.diagnostics;
  if (!validation.valid) {
    render();
    return;
  }
  const revision = editRevision;
  vscode.postMessage({ type: 'save', revision, frame: structuredClone(frame) });
}

function sortSignalsForPageEntry(): void {
  if (!frame) return;
  const signals = orderSignalsByDataPosition(frame.signals);
  if (signals.every((signal, index) => signal.id === frame?.signals[index]?.id)) return;
  frame = { ...frame, signals };
  changed();
  render();
}

window.addEventListener('message', (event: MessageEvent<FrameEditorToWebview>) => { const message = event.data; if (message.type === 'init') { const initial = structuredClone(message.frame); frame = { ...initial, signals: orderSignalsByDataPosition(initial.signals) }; if (message.widths) widths = { ...widths, ...message.widths }; serverDiagnostics = []; render(); } else if (message.type === 'sortSignals') { sortSignalsForPageEntry(); } else if (message.type === 'saveResult') { if (message.revision < editRevision) return; serverDiagnostics = message.diagnostics; if (message.saved && message.frame) frame = structuredClone(message.frame); else render(); } });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (saveTimer) { clearTimeout(saveTimer); saveFrame(); }
    return;
  }
  sortSignalsForPageEntry();
});
window.addEventListener('beforeunload', () => { if (saveTimer) { clearTimeout(saveTimer); saveFrame(); } });
vscode.postMessage({ type: 'ready' });
