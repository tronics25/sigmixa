import type { ComparisonDefinition, ComparisonGraphDefinition, ComparisonTarget } from '../../core/project/comparison';
import type { SignalDefinition } from '../../core/signal/signal';
import type { ComparisonTargetStateDto, ComparisonToExtension, ComparisonToWebview } from '../../extension/comparison/comparisonProtocol';
import type { SignalGroupDto } from '../../extension/editors/rawLogProtocol';
import { CHOICE_GROUP_STYLES } from '../shared/choiceGroup';
import { closeActionMenu, showActionMenu } from '../shared/contextMenu';
import { COMPONENT_STYLES, DESIGN_TOKENS } from '../shared/designTokens';
import { t } from '../shared/i18n';
import { ICON_BUTTON_STYLES, iconButton, labeledIconButton } from '../shared/iconButton';
import { SharedTimeAxis } from '../../core/timeline/sharedTimeAxis';
import { MeasuredSamples } from '../shared/measuredSamples';
import { bindPressRepeat } from '../shared/pressRepeat';
import { SIGNAL_LEGEND_STYLES } from '../shared/signalLegend';
import { SIGNAL_COLOR_PRESETS } from '../shared/signalSelector';
import type { ViewContextAction } from '../shared/viewContextAction';
import { COMPARISON_STYLES } from './comparisonStyles';
import { composeImageSheet } from '../shared/imageSheet';
import { dashFor, format, GraphCard, type ComparisonCard, type GraphHost } from './graphCard';
import { TrajectoryCard } from './trajectoryCard';
import { bindFindShortcut } from '../shared/findShortcut';

declare function acquireVsCodeApi(): { postMessage(message: ComparisonToExtension): void };
const vscode = acquireVsCodeApi();
const app = document.getElementById('app')!;

let comparison: ComparisonDefinition | undefined;
let targets: readonly ComparisonTargetStateDto[] = [];
let draggedTarget: string | undefined;
let definitions: readonly SignalDefinition[] = [];
let groups: readonly SignalGroupDto[] = [];
let availability: Readonly<Record<string, readonly string[]>> = {};
let measuredIds: readonly string[] | undefined;
let clipSpans: readonly { readonly id: string; readonly name: string; readonly start: number; readonly end: number }[] = [];
const colors = new Map<string, string>();
const cards: ComparisonCard[] = [];
let selectedGraphId: string | undefined;
let optionsOpen = false;
let hoverTime: number | undefined;
let highlightedSignal: string | undefined;
let requestCounter = 0;
const pendingSeries = new Map<number, string>();

app.innerHTML = `<style>${DESIGN_TOKENS}${COMPARISON_STYLES}${ICON_BUTTON_STYLES}${CHOICE_GROUP_STYLES}${SIGNAL_LEGEND_STYLES}${COMPONENT_STYLES}</style>
<section class="targets" aria-label="${t('Compared files and Clips', '比較するファイル／クリップ')}"><div class="targets-head"><strong>${t('Compared files and Clips', '比較するファイル／クリップ')}</strong><span class="targets-count muted"></span></div><div class="target-rows"></div></section>
<div class="visualize-workspace"><div class="visualize-content"><div class="view-toolbar"><button class="add-graph" type="button"><span class="codicon codicon-add" aria-hidden="true"></span> ${t('Add graph', 'グラフを追加')}</button><span class="spacer"></span><span class="muted line-hint">${t('Line style = file/Clip; in time series, color = Signal', '線種＝ファイル／クリップ、時系列の線の色＝シグナル')}</span><div class="range-controls comparison-range" role="group" aria-label="${t('Selected range', '選択範囲')}" hidden><span class="clip-range muted"></span><button class="range-zoom" type="button"></button><button class="range-clear" type="button"></button></div><button class="zoom-all-in" type="button"></button><button class="zoom-all-out" type="button"></button><button class="zoom-all-reset" type="button"></button><button class="save-sheet" type="button"></button></div><div class="visualize-list"></div></div>
<aside class="visualize-options" aria-label="${t('Graph settings', 'グラフ設定')}" hidden><header><strong>${t('Graph settings', 'グラフ設定')}</strong><button class="close-view-options" type="button"></button></header><div class="options-view-name"></div><p class="options-empty muted">${t('Add a graph to configure it.', 'グラフを追加すると設定できます。')}</p><div class="view-options-panels"></div></aside></div>`;

const list = app.querySelector<HTMLElement>('.visualize-list')!;
const optionsPanel = app.querySelector<HTMLElement>('.visualize-options')!;
const optionsHost = app.querySelector<HTMLElement>('.view-options-panels')!;
iconButton(app.querySelector<HTMLButtonElement>('.close-view-options')!, 'close', t('Close graph settings', 'グラフ設定を閉じる')).addEventListener('click', () => { optionsOpen = false; updateOptions(); cards.find((card) => card.id === selectedGraphId)?.focusHeader(); });

const measured = new MeasuredSamples((requestId, query) => post({ type: 'measuredSignalsRequest', requestId, targetId: query.sourceId!, signalIds: query.signalIds, timestamp: query.timestamp }), () => cards.forEach((card) => card.scheduleDraw()));

// Time belongs to the whole comparison: every graph shows the same span, zoomed from here (or with the wheel on any graph).
const time = new SharedTimeAxis();
const zoomAllIn = labeledIconButton(app.querySelector<HTMLButtonElement>('.zoom-all-in')!, 'zoom-in', t('Zoom in', '拡大'));
const zoomAllOut = labeledIconButton(app.querySelector<HTMLButtonElement>('.zoom-all-out')!, 'zoom-out', t('Zoom out', '縮小'));
const zoomAllReset = labeledIconButton(app.querySelector<HTMLButtonElement>('.zoom-all-reset')!, 'discard', t('Reset', 'リセット'), t('Reset zoom', 'ズームをリセット'));
bindPressRepeat(zoomAllIn, () => time.zoom(1 / 1.5), { intervalMs: 180 }); bindPressRepeat(zoomAllOut, () => time.zoom(1.5), { intervalMs: 180 });
zoomAllReset.addEventListener('click', () => time.reset());
// The selected range is the comparison's too: shown on every graph, with its actions here. While a range is selected the
// step zoom gives way to "Zoom to range", as in Visualize.
let selection: { start: number; end: number } | undefined;
const rangeControls = app.querySelector<HTMLElement>('.comparison-range')!;
const trim = (value: number) => value.toFixed(6).replace(/\.?0+$/, '');
const setSelection = (range: { start: number; end: number } | undefined) => {
  selection = range && range.end > range.start ? range : undefined; rangeControls.hidden = !selection; zoomAllIn.hidden = !!selection; zoomAllOut.hidden = !!selection;
  if (selection) rangeControls.querySelector('.clip-range')!.textContent = `${trim(selection.start)}–${trim(selection.end)} s · ${trim(selection.end - selection.start)} s`;
  cards.forEach((card) => card.scheduleDraw());
};
labeledIconButton(app.querySelector<HTMLButtonElement>('.range-zoom')!, 'zoom-in', t('Zoom to range', '選択範囲を拡大')).addEventListener('click', () => { const range = selection; if (!range) return; setSelection(undefined); time.setView(range); });
labeledIconButton(app.querySelector<HTMLButtonElement>('.range-clear')!, 'close', t('Clear', '解除'), t('Clear selected range', '選択範囲を解除')).addEventListener('click', () => setSelection(undefined));
const updateTimeButtons = () => { zoomAllIn.disabled = !time.canZoomIn; zoomAllOut.disabled = !time.zoomed; zoomAllReset.disabled = !time.zoomed; };
time.subscribe(() => { updateTimeButtons(); cards.forEach((card) => card.scheduleDraw()); }); updateTimeButtons();
labeledIconButton(app.querySelector<HTMLButtonElement>('.save-sheet')!, 'export', t('Export', 'エクスポート')).addEventListener('click', () => saveSheet());
/** Export: all graphs on one PNG/SVG sheet (the subtitle says which line style is which file/Clip), or the HTML report. */
function saveSheet(): void {
  const images = cards.flatMap((card) => { const image = card.renderImage(card.name, 800); return image ? [image] : []; }); if (!comparison) return;
  if (!images.length) { post({ type: 'exportAll' }); return; }
  const names = comparison.targets.filter((target) => !hidden(target.id)).map((target) => { const state = targets.find((item) => item.id === target.id); const style = dashStyle(targetIndex(target.id)); return `${state?.name ?? target.id}（${t(style === 'solid' ? 'solid' : style === 'dashed' ? 'dashed' : 'dotted', style === 'solid' ? '実線' : style === 'dashed' ? '破線' : '点線')}）`; });
  const style = getComputedStyle(document.documentElement); const color = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  const sheet = composeImageSheet(`${t('Comparison', '比較')}: ${comparison.targets.filter((target) => !hidden(target.id)).map((target) => targets.find((item) => item.id === target.id)?.name ?? target.id).join('・')}`, `${new Date().toLocaleString()} · ${names.join(' ／ ')}`, images, { background: color('--vscode-editor-background', '#1e1e1e'), foreground: color('--vscode-foreground', '#ddd'), muted: color('--vscode-descriptionForeground', '#999') });
  post({ type: 'exportAll', ...sheet });
}
const addGraphButton = app.querySelector<HTMLButtonElement>('.add-graph')!;
addGraphButton.setAttribute('aria-haspopup', 'menu');
addGraphButton.addEventListener('click', () => {
  const rect = addGraphButton.getBoundingClientRect();
  showActionMenu((['graph', 'trajectory'] as const).map((kind) => ({ label: kind === 'graph' ? t('Time series', '時系列') : t('Trajectory', '軌跡'), icon: kind === 'graph' ? 'graph-line' : 'compass', run: () => addGraph(kind) })), t('Add graph', 'グラフを追加'), rect.left, rect.bottom + 4, addGraphButton, { trigger: addGraphButton });
});
function addGraph(kind: 'graph' | 'trajectory'): void {
  if (!comparison) return;
  const base = kind === 'graph' ? t('Graph', 'グラフ') : t('Trajectory', '軌跡');
  let index = comparison.graphs.filter((graph) => (graph.kind ?? 'graph') === kind).length + 1; while (comparison.graphs.some((graph) => graph.name === `${base} ${index}`)) index++;
  const definition: ComparisonGraphDefinition = { id: crypto.randomUUID(), kind, name: `${base} ${index}`, signalIds: [] };
  comparison = { ...comparison, graphs: [...comparison.graphs, definition] }; persist();
  const card = addCard(definition); selectGraph(card, true); card.element.scrollIntoView({ block: 'nearest' }); card.focusHeader();
}

function post(message: ComparisonToExtension): void { vscode.postMessage(message); }
function persist(): void { if (comparison) post({ type: 'update', comparison: { graphs: comparison.graphs, colors: Object.fromEntries(colors), hiddenTargetIds: comparison.hiddenTargetIds } }); }
function targetIndex(targetId: string): number { return comparison?.targets.findIndex((target) => target.id === targetId) ?? 0; }
function anchor(targetId: string): number | undefined { const state = targets.find((item) => item.id === targetId); const target = comparison?.targets.find((item) => item.id === targetId); return state?.status === 'ready' && state.start !== undefined && target ? state.start + target.offset : undefined; }
function hidden(targetId: string): boolean { return comparison?.hiddenTargetIds?.includes(targetId) ?? false; }
function color(signalId: string): string {
  let value = colors.get(signalId);
  if (!value) { const index = definitions.findIndex((definition) => definition.id === signalId); value = SIGNAL_COLOR_PRESETS[(index < 0 ? colors.size : index) % SIGNAL_COLOR_PRESETS.length]; colors.set(signalId, value); }
  return value;
}

const host: GraphHost = {
  targets: () => targets, targetIndex, anchor, hidden,
  definitions: () => definitions, groups: () => groups,
  colors, color, measured, time,
  selection: () => selection, setSelection,
  // Clips are in their log's time; the graphs' axis starts at the target's (shifted) start.
  clipSpans: () => { const target = clipSpans.length ? comparison?.targets[0] : undefined; const start = target ? anchor(target.id) : undefined; return start === undefined ? [] : clipSpans.map((clip) => ({ ...clip, start: clip.start - start, end: clip.end - start })); },
  refreshMeasured: () => measured.update(cards.flatMap((card) => card.markerQueries())),
  hoverTime: () => hoverTime,
  setHoverTime: (time) => { if (time === hoverTime) return; hoverTime = time; cards.forEach((card) => card.scheduleDraw()); },
  requestSeries: (graphId, signalIds, maxPoints, joined) => { const requestId = ++requestCounter; pendingSeries.set(requestId, graphId); post({ type: 'seriesRequest', requestId, graphId, signalIds, maxPoints, joined }); return requestId; },
  changed: (card) => { if (!comparison) return; comparison = { ...comparison, graphs: comparison.graphs.map((graph) => graph.id === card.id ? card.definition : graph) }; persist(); if (card.id === selectedGraphId) updateOptionsHeading(); },
  colorsChanged: () => { persist(); cards.forEach((card) => card.draw()); },
  select: (card, reveal) => selectGraph(card, reveal),
  selectedGraph: () => cards.find((card) => card.id === selectedGraphId),
  optionsOpen: () => optionsOpen,
  duplicate: (card) => { const definition = { ...structuredClone(card.definition), id: crypto.randomUUID(), name: `${card.name} (${t('copy', 'コピー')})` }; insertGraphs(card, [definition]); },
  move: (card, direction) => moveGraph(card, direction),
  remove: (card) => removeGraph(card),
  insertAfter: (card, next) => insertGraphs(card, next),
  showMenu: (actions: readonly (ViewContextAction | null)[], label, x, y, returnFocus) => showActionMenu(actions, label, x, y, returnFocus, { scroller: list }),
  saveImage: (pngDataUrl, svg) => post({ type: 'saveComparisonImage', pngDataUrl, svg }),
  highlight: (signalId) => { if (highlightedSignal === signalId) return; highlightedSignal = signalId; cards.forEach((card) => card.highlight()); },
  highlighted: () => highlightedSignal,
  isFirst: (card) => cards[0] === card,
  isLast: (card) => cards[cards.length - 1] === card,
};

function addCard(definition: ComparisonGraphDefinition, before?: ComparisonCard): ComparisonCard {
  const card: ComparisonCard = definition.kind === 'trajectory' ? new TrajectoryCard(definition, host, list, optionsHost) : new GraphCard(definition, host, list, optionsHost);
  if (before) { list.insertBefore(card.element, before.element); cards.splice(cards.indexOf(before), 0, card); } else cards.push(card);
  card.setCatalog(definitions, groups, measuredIds); card.request();
  updateOptions(); return card;
}

function insertGraphs(after: ComparisonCard, next: readonly ComparisonGraphDefinition[]): void {
  if (!comparison || !next.length) return;
  const index = comparison.graphs.findIndex((graph) => graph.id === after.id) + 1;
  comparison = { ...comparison, graphs: [...comparison.graphs.slice(0, index), ...next, ...comparison.graphs.slice(index)] }; persist();
  const before = cards[cards.indexOf(after) + 1];
  let last: ComparisonCard | undefined; for (const definition of next) last = addCard(definition, before);
  if (last) { selectGraph(last, optionsOpen); last.element.scrollIntoView({ block: 'nearest' }); }
}

function moveGraph(card: ComparisonCard, direction: -1 | 1): void {
  if (!comparison) return; const index = cards.indexOf(card); const target = index + direction; if (target < 0 || target >= cards.length) return;
  cards.splice(index, 1); cards.splice(target, 0, card); list.insertBefore(card.element, cards[target + 1]?.element ?? null);
  comparison = { ...comparison, graphs: cards.map((item) => item.definition) }; persist(); cards.forEach((item) => item.draw());
}

function removeGraph(card: ComparisonCard): void {
  if (!comparison) return; card.dispose(); cards.splice(cards.indexOf(card), 1);
  comparison = { ...comparison, graphs: comparison.graphs.filter((graph) => graph.id !== card.id) }; persist();
  if (selectedGraphId === card.id) selectedGraphId = cards[0]?.id;
  host.refreshMeasured(); updateOptions(); cards.forEach((item) => item.draw());
}

function selectGraph(card: ComparisonCard, reveal: boolean): void { selectedGraphId = card.id; if (reveal) optionsOpen = true; updateOptions(); }

function updateOptions(): void {
  optionsPanel.hidden = !optionsOpen;
  if (!cards.some((card) => card.id === selectedGraphId)) selectedGraphId = cards[0]?.id;
  for (const card of cards) card.setEditing(optionsOpen && card.id === selectedGraphId);
  app.querySelector<HTMLElement>('.options-empty')!.hidden = cards.length > 0;
  updateOptionsHeading();
}

function updateOptionsHeading(): void {
  const heading = app.querySelector<HTMLElement>('.options-view-name')!; heading.replaceChildren();
  const card = cards.find((item) => item.id === selectedGraphId); if (!card) return;
  const icon = document.createElement('span'); icon.className = 'codicon codicon-graph-line'; icon.setAttribute('aria-hidden', 'true');
  const name = document.createElement('span'); name.textContent = card.name; heading.append(icon, name);
}

// ---- targets strip ---------------------------------------------------------------------------------

function renderTargets(): void {
  const rows = app.querySelector<HTMLElement>('.target-rows')!; rows.replaceChildren();
  if (!comparison) return;
  app.querySelector('.targets-count')!.textContent = t(`${comparison.targets.length} items`, `${comparison.targets.length} 件`);
  for (const target of comparison.targets) {
    const state = targets.find((item) => item.id === target.id);
    const row = document.createElement('div'); row.className = `target-row${hidden(target.id) ? ' hidden-target' : ''}`; row.dataset.targetId = target.id;
    const visible = document.createElement('input'); visible.type = 'checkbox'; visible.checked = !hidden(target.id); visible.setAttribute('aria-label', t('Show in graphs', 'グラフに表示'));
    visible.addEventListener('change', () => {
      if (!comparison) return; const set = new Set(comparison.hiddenTargetIds ?? []); visible.checked ? set.delete(target.id) : set.add(target.id);
      comparison = { ...comparison, hiddenTargetIds: [...set] }; persist(); row.classList.toggle('hidden-target', !visible.checked); host.refreshMeasured(); cards.forEach((card) => card.draw());
    });
    const sample = document.createElement('span'); sample.className = 'line-sample'; sample.style.borderTopStyle = dashStyle(targetIndex(target.id)); sample.title = t('Line style in the graphs', 'グラフでの線種');
    const labelElement = document.createElement('span'); labelElement.className = 'target-label';
    const name = document.createElement('strong'); name.textContent = state?.name ?? '…';
    const detail = document.createElement('small'); detail.textContent = state ? [state.kind === 'clip' ? state.fileName : undefined, state.groupName, state.rangeLabel].filter(Boolean).join(' · ') : '';
    labelElement.append(name, detail); labelElement.title = state?.filePath ?? '';
    const align = document.createElement('span'); align.className = 'target-align';
    if (state?.status === 'ready') align.append(shiftButton(target.id, -1), offsetOutput(target), shiftButton(target.id, 1));
    const status = document.createElement('span'); status.className = `target-status${state?.status === 'error' ? ' error' : ''}`;
    if (!state || state.status === 'loading') status.innerHTML = `<span class="codicon codicon-loading" aria-hidden="true"></span>${t('Loading…', '読み込み中…')}`;
    else if (state.status === 'error') { status.innerHTML = '<span class="codicon codicon-error" aria-hidden="true"></span>'; status.append(state.message ?? t('Could not load', '読み込めません')); }
    if (state?.status !== 'ready') align.appendChild(status);
    const open = iconButton(document.createElement('button'), 'go-to-file', state?.kind === 'clip' ? t('Open this Clip', 'このクリップを開く') : t('Open this log', 'このログを開く')); open.classList.add('target-open'); open.type = 'button'; open.disabled = state?.status === 'error';
    open.addEventListener('click', () => post({ type: 'openTarget', targetId: target.id }));
    const remove = iconButton(document.createElement('button'), 'close', t('Remove from this comparison', 'この比較から外す')); remove.classList.add('target-remove'); remove.type = 'button'; remove.disabled = comparison.targets.length <= 2;
    remove.addEventListener('click', () => post({ type: 'removeTarget', targetId: target.id }));
    const handle = document.createElement('span'); handle.className = 'drag-handle codicon codicon-gripper';
    row.draggable = true; row.tabIndex = 0;
    row.addEventListener('dragstart', (event) => { if (!(event.target as Element).closest?.('.drag-handle') && event.target !== row) { event.preventDefault(); return; } draggedTarget = target.id; event.dataTransfer?.setData('text/plain', target.id); row.classList.add('dragging'); });
    row.addEventListener('dragend', () => { draggedTarget = undefined; rows.querySelectorAll('.dragging,.drop-before,.drop-after').forEach((element) => element.classList.remove('dragging', 'drop-before', 'drop-after')); });
    row.addEventListener('dragover', (event) => { if (!draggedTarget || draggedTarget === target.id) return; event.preventDefault(); const after = event.offsetY > row.clientHeight / 2; row.classList.toggle('drop-after', after); row.classList.toggle('drop-before', !after); });
    row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after'));
    row.addEventListener('drop', (event) => {
      event.preventDefault(); if (!draggedTarget || !comparison) return; const after = row.classList.contains('drop-after');
      const order = comparison.targets.map((item) => item.id).filter((id) => id !== draggedTarget); order.splice(order.indexOf(target.id) + (after ? 1 : 0), 0, draggedTarget); post({ type: 'reorderTargets', order });
    });
    row.addEventListener('keydown', (event) => {
      if (event.target !== row || !event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') || !comparison) return; event.preventDefault();
      const order = comparison.targets.map((item) => item.id); const index = order.indexOf(target.id); const next = index + (event.key === 'ArrowUp' ? -1 : 1); if (next < 0 || next >= order.length) return;
      [order[index], order[next]] = [order[next], order[index]]; post({ type: 'reorderTargets', order }); focusTarget = target.id;
    });
    row.append(handle, visible, sample, kindIcon(target.kind), labelElement, align, open, remove); rows.appendChild(row);
  }
}

let focusTarget: string | undefined;

function kindIcon(kind: 'file' | 'clip'): HTMLElement {
  const icon = document.createElement('span'); icon.className = `kind codicon codicon-${kind === 'clip' ? 'symbol-event' : 'file-binary'}`;
  icon.title = kind === 'clip' ? t('Clip', 'クリップ') : t('Whole file', 'ファイル全体'); return icon;
}

function dashStyle(index: number): string { const pattern = dashFor(index); return !pattern.length ? 'solid' : pattern[0] > 4 ? 'dashed' : 'dotted'; }

function shiftButton(targetId: string, direction: -1 | 1): HTMLButtonElement {
  const label = direction < 0 ? t('Previous CAN Timestamp; hold to repeat', '前のCANタイムスタンプへ・長押しで連続') : t('Next CAN Timestamp; hold to repeat', '次のCANタイムスタンプへ・長押しで連続');
  const button = iconButton(document.createElement('button'), direction < 0 ? 'chevron-left' : 'chevron-right', label); button.type = 'button';
  bindPressRepeat(button, () => post({ type: 'shiftOffset', targetId, direction }), { intervalMs: 85 }); return button;
}

/** Drag, wheel or arrow keys shift any target in time, either way; double-click (or Home) resets it to 0. */
function offsetOutput(target: ComparisonTarget): HTMLOutputElement {
  const output = document.createElement('output'); output.tabIndex = 0; output.textContent = offsetText(target.offset);
  const title = t('Time shift. Drag, wheel or ←/→ to align; double-click to reset.', '時間シフト。ドラッグ・ホイール・←/→で合わせる、ダブルクリックで0に戻す'); output.title = title; output.setAttribute('aria-label', title);
  let wheel = 0; let dragging = false; let moved = false; let startX = 0; let startOffset = 0; let preview = 0; let pointerId = 0;
  // A mouse wheel moves one frame per notch; a trackpad's small deltas add up, one frame per 24 px.
  output.addEventListener('wheel', (event) => {
    event.preventDefault(); if (dragging) return; const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY; if (!delta) return;
    if (event.deltaMode !== 0 || Math.abs(delta) >= 50) { wheel = 0; post({ type: 'shiftOffset', targetId: target.id, direction: delta < 0 ? -1 : 1 }); return; }
    if (Math.sign(wheel) !== Math.sign(delta)) wheel = 0; wheel += delta; const steps = Math.min(20, Math.floor(Math.abs(wheel) / 24)); if (!steps) return;
    const direction = wheel < 0 ? -1 : 1; wheel -= direction * steps * 24; post({ type: 'shiftOffset', targetId: target.id, direction, steps });
  }, { passive: false });
  output.addEventListener('pointerdown', (event) => { if (event.button !== 0) return; dragging = true; moved = false; pointerId = event.pointerId; startX = event.clientX; startOffset = currentOffset(target.id); preview = startOffset; output.setPointerCapture(pointerId); output.classList.add('dragging'); event.preventDefault(); output.focus(); });
  output.addEventListener('pointermove', (event) => {
    if (!dragging || event.pointerId !== pointerId) return; const delta = event.clientX - startX; if (Math.abs(delta) < 3) return; moved = true;
    const state = targets.find((item) => item.id === target.id); const span = (state?.end ?? 1) - (state?.start ?? 0) || 1; const width = Math.max(320, list.clientWidth - 120);
    preview = startOffset + delta * span / width; setLocalOffset(target.id, preview); output.textContent = offsetText(preview);
  });
  const finish = (event: PointerEvent, commit: boolean) => {
    if (!dragging || event.pointerId !== pointerId) return; dragging = false; output.classList.remove('dragging'); if (output.hasPointerCapture(pointerId)) output.releasePointerCapture(pointerId);
    // Releasing keeps where the drag ended (snapped to the nearest frame); a press without a drag changes nothing.
    if (moved && commit) post({ type: 'setOffset', targetId: target.id, offset: preview }); else if (moved) { setLocalOffset(target.id, startOffset); output.textContent = offsetText(startOffset); }
  };
  output.addEventListener('dblclick', (event) => { event.preventDefault(); post({ type: 'resetOffset', targetId: target.id }); });
  output.addEventListener('pointerup', (event) => finish(event, true)); output.addEventListener('pointercancel', (event) => finish(event, false));
  output.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); post({ type: 'shiftOffset', targetId: target.id, direction: event.key === 'ArrowLeft' ? -1 : 1 }); }
    else if (event.key === 'Home') { event.preventDefault(); post({ type: 'resetOffset', targetId: target.id }); }
  });
  return output;
}

function currentOffset(targetId: string): number { return comparison?.targets.find((item) => item.id === targetId)?.offset ?? 0; }
function setLocalOffset(targetId: string, offset: number): void {
  if (!comparison) return; comparison = { ...comparison, targets: comparison.targets.map((target) => target.id === targetId ? { ...target, offset } : target) };
  measured.invalidate(); host.refreshMeasured(); cards.forEach((card) => card.scheduleDraw());
}
function offsetText(offset: number): string { return `${offset >= 0 ? '+' : ''}${format(offset)} s`; }

// ---- messages --------------------------------------------------------------------------------------

function applyComparison(next: ComparisonDefinition): void {
  const previous = comparison; comparison = next;
  for (const [id, value] of Object.entries(next.colors ?? {})) colors.set(id, value);
  const ids = new Set(next.graphs.map((graph) => graph.id));
  for (const card of [...cards]) if (!ids.has(card.id)) { card.dispose(); cards.splice(cards.indexOf(card), 1); }
  next.graphs.forEach((graph) => { const card = cards.find((item) => item.id === graph.id); if (card) card.setDefinition(graph); else addCard(graph); });
  cards.sort((a, b) => next.graphs.findIndex((graph) => graph.id === a.id) - next.graphs.findIndex((graph) => graph.id === b.id)).forEach((card) => list.appendChild(card.element));
  if (!previous || previous.targets.some((target, index) => next.targets[index]?.id !== target.id || next.targets[index]?.offset !== target.offset) || previous.targets.length !== next.targets.length ) { measured.invalidate(); host.refreshMeasured(); }
  const sameTargets = previous && previous.targets.length === next.targets.length && previous.targets.every((target, index) => target.id === next.targets[index].id) && (previous.hiddenTargetIds ?? []).join() === (next.hiddenTargetIds ?? []).join();
  // Keep the rows while only offsets change, so a held ◀/▶ or a drag keeps its element.
  if (sameTargets) updateTargetOffsets(); else renderTargets();
  if (focusTarget) { app.querySelector<HTMLElement>(`.target-row[data-target-id="${focusTarget}"]`)?.focus(); focusTarget = undefined; }
  updateOptions(); cards.forEach((card) => card.draw());
}

function updateTargetOffsets(): void {
  for (const row of Array.from(app.querySelectorAll<HTMLElement>('.target-row'))) {
    const output = row.querySelector<HTMLOutputElement>('.target-align output'); const target = comparison?.targets.find((item) => item.id === row.dataset.targetId);
    if (output && target && !output.classList.contains('dragging')) output.textContent = offsetText(target.offset);
  }
}

window.addEventListener('message', (event: MessageEvent<ComparisonToWebview>) => {
  const message = event.data;
  switch (message.type) {
    case 'init': applyComparison(message.comparison); return;
    case 'comparison': applyComparison(message.comparison); return;
    case 'targets': targets = message.targets; renderTargets(); cards.forEach((card) => card.draw()); return;
    case 'clipSpans': clipSpans = message.clips; cards.forEach((card) => card.scheduleDraw()); return;
    case 'catalog':
      definitions = message.definitions; groups = message.groups; availability = message.availability; measuredIds = message.measuredIds;
      for (const card of cards) card.setCatalog(definitions, groups, measuredIds);
      return;
    case 'series': { const graphId = pendingSeries.get(message.requestId); pendingSeries.delete(message.requestId); cards.find((card) => card.id === graphId)?.receive(message.requestId, message.seriesByTarget); return; }
    case 'measuredSignals': measured.receive(message.requestId, message.samples); return;
    case 'reload': measured.invalidate(); cards.forEach((card) => card.request()); renderTargets(); return;
  }
});

window.addEventListener('blur', () => closeActionMenu());
bindFindShortcut();
post({ type: 'ready' });
