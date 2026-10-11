import type { RawRowDto } from '../../extension/editors/rawLogProtocol';
import { t } from '../shared/i18n';

type Detail = NonNullable<RawRowDto['decodedSignals']>[number];

/** Physical bit masks; BIG uses MSB-first offsets, matching the decoder. */
export function signalByteMasks(detail: Detail): ReadonlyMap<number, number> {
  const masks = new Map<number, number>();
  if (detail.byteOffset === undefined || detail.bitOffset === undefined || detail.lengthBits === undefined || !detail.byteOrder) return masks;
  if (!Number.isInteger(detail.byteOffset) || detail.byteOffset < 0 || !Number.isInteger(detail.bitOffset) || detail.bitOffset < 0 || detail.bitOffset > 7 || !Number.isInteger(detail.lengthBits) || detail.lengthBits < 1 || detail.lengthBits > 64) return masks;
  for (let index = 0; index < detail.lengthBits; index++) {
    const position = detail.bitOffset + index; const byte = detail.byteOffset + Math.floor(position / 8);
    const bit = detail.byteOrder === 'big' ? 7 - position % 8 : position % 8;
    masks.set(byte, (masks.get(byte) ?? 0) | (1 << bit));
  }
  return masks;
}

let popup: HTMLDivElement | undefined;
let active: HTMLElement | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
function hide(): void { if (timer) clearTimeout(timer); timer = undefined; popup?.remove(); popup = undefined; active?.removeAttribute('aria-describedby'); active = undefined; }
export const hideDecodedInspection = hide;

export function bindDecodedInspection(chip: HTMLElement, row: RawRowDto, detail: Detail): void {
  if (!signalByteMasks(detail).size && !detail.derived) return;
  chip.tabIndex = 0;
  chip.title = '';
  const show = () => {
    hide(); if (!chip.isConnected) return;
    active = chip; popup = document.createElement('div'); popup.id = 'decoded-inspection'; popup.setAttribute('role', 'tooltip'); chip.setAttribute('aria-describedby', popup.id);
    popup.style.cssText = 'position:fixed;z-index:1000;pointer-events:none;padding:var(--sm-space-md);border:1px solid var(--vscode-editorHoverWidget-border,var(--vscode-panel-border));border-radius:var(--sm-radius-md);background:var(--vscode-editorHoverWidget-background,var(--vscode-editor-background));color:var(--vscode-foreground);box-shadow:0 3px 10px #0004;font:var(--sm-font-caption) var(--vscode-editor-font-family);max-width:calc(100vw - 16px)';
    const parts = explanationParts(detail);
    const heading = document.createElement('div'); heading.textContent = parts ? `${detail.tag} · ${parts.kind}` : `${detail.tag} · RAW ${detail.raw ?? '—'} · ${detail.byteOrder!.toUpperCase()}`; heading.style.cssText = 'max-width:380px;overflow-wrap:anywhere;margin-bottom:var(--sm-space-sm)'; popup.append(heading);
    if (parts) {
      // Same shape as a Frame Signal's popup: labelled value cells first (the inputs highlighted), then the calculation.
      popup.setAttribute('aria-label', explanationLines(detail).join('\n'));
      const grid = document.createElement('div'); grid.style.cssText = 'display:flex;flex-wrap:wrap;gap:var(--sm-space-xs);max-width:480px';
      for (const item of parts.cells) {
        const cell = document.createElement('div'); cell.style.cssText = 'text-align:center;padding:var(--sm-space-xs) var(--sm-space-md);border-radius:var(--sm-radius-sm);min-width:26px';
        const label = document.createElement('small'); label.textContent = item.label; label.style.cssText = 'display:block;color:var(--vscode-descriptionForeground);font-size:var(--sm-font-legacy-9)';
        cell.append(label, document.createTextNode(item.value));
        if (item.input) { cell.style.background = 'var(--vscode-editor-selectionBackground)'; cell.style.outline = '1px solid var(--vscode-focusBorder)'; } else cell.style.outline = '1px solid var(--vscode-panel-border)';
        grid.append(cell);
      }
      popup.append(grid);
      for (const text of parts.steps) { const step = document.createElement('div'); step.textContent = text; step.style.cssText = 'max-width:480px;overflow-wrap:anywhere;margin-top:var(--sm-space-sm);color:var(--vscode-descriptionForeground)'; popup.append(step); }
      const result = document.createElement('div'); result.textContent = `= ${parts.result}`; result.style.cssText = 'margin-top:var(--sm-space-sm);font-weight:700'; popup.append(result);
    } else {
    const grid = document.createElement('div'); grid.style.cssText = 'display:grid;grid-template-columns:repeat(8,minmax(26px,1fr));gap:var(--sm-space-xs)';
    const masks = signalByteMasks(detail);
    row.rawContent.split(' ').forEach((hex, byte) => {
      const cell = document.createElement('div'); cell.style.cssText = 'text-align:center;padding:var(--sm-space-xs);border-radius:var(--sm-radius-sm)';
      const offset = document.createElement('small'); offset.textContent = String(byte); offset.style.cssText = 'display:block;color:var(--vscode-descriptionForeground);font-size:var(--sm-font-legacy-9)';
      cell.append(offset, document.createTextNode(hex)); if (masks.has(byte)) { cell.style.background = 'var(--vscode-editor-selectionBackground)'; cell.style.outline = '1px solid var(--vscode-focusBorder)'; }
      grid.append(cell);
    });
    popup.append(grid);
    const bits = document.createElement('div'); bits.style.cssText = 'margin-top:var(--sm-space-sm);display:flex;gap:var(--sm-space-md);flex-wrap:wrap';
    for (const [byte, mask] of masks) {
      const group = document.createElement('span'); group.append(document.createTextNode(`B${byte} `)); const value = parseInt(row.rawContent.split(' ')[byte] ?? '0', 16);
      for (let bit = 7; bit >= 0; bit--) { const digit = document.createElement('span'); digit.textContent = String((value >> bit) & 1); digit.style.opacity = mask & (1 << bit) ? '1' : '.3'; if (mask & (1 << bit)) digit.style.fontWeight = '700'; group.append(digit); }
      bits.append(group);
    }
    bits.setAttribute('aria-label', t('Signal bits, bit 7 to bit 0', 'シグナルのビット（bit 7からbit 0）')); popup.append(bits);
    if (detail.calculation) { const calculation = document.createElement('div'); calculation.textContent = detail.calculation; calculation.style.marginTop = 'var(--sm-space-sm)'; popup.append(calculation); }
    }
    document.body.append(popup);
    const rect = chip.getBoundingClientRect(); const size = popup.getBoundingClientRect(); popup.style.left = `${Math.max(8, Math.min(innerWidth - size.width - 8, rect.left))}px`; popup.style.top = `${Math.max(8, rect.bottom + size.height + 8 <= innerHeight ? rect.bottom + 6 : rect.top - size.height - 6)}px`;
  };
  chip.addEventListener('mouseenter', () => { hide(); timer = setTimeout(show, 200); });
  chip.addEventListener('mouseleave', hide);
  chip.addEventListener('focus', show); chip.addEventListener('blur', hide);
}

if (typeof window !== 'undefined') {
  window.addEventListener('scroll', hide, true); window.addEventListener('resize', hide);
  window.addEventListener('keydown', (event) => { if (event.key === 'Escape') hide(); });
  window.addEventListener('pointerdown', hide); window.addEventListener('blur', hide);
}

const numberText = (value: number | undefined): string => value === undefined ? '—' : Number(value.toPrecision(12)).toString();

export interface ExplanationParts { readonly kind: string; readonly cells: readonly { readonly label: string; readonly value: string; readonly input?: boolean }[]; readonly steps: readonly string[]; readonly result: string }

/** A derived Signal's explanation in the popup's parts: the kind, labelled values (inputs first), the calculation steps and the result. */
export function explanationParts(detail: Detail): ExplanationParts | undefined {
  const data = detail.derived; if (!data) return undefined;
  const op = data.operation; const withUnit = (value: number | undefined, unit?: string) => value === undefined ? t('Unavailable', '取得できません') : `${numberText(value)}${unit ? ` ${unit}` : ''}`;
  const cells: { label: string; value: string; input?: boolean }[] = data.inputs.map((input) => ({ label: input.name, value: withUnit(input.value, input.unit), input: true }));
  const steps: string[] = []; const input = numberText(data.inputs[0]?.value);
  let kind: string;
  if (op.type === 'expression') { kind = t('Expression', '計算式'); steps.push(op.expression); }
  else if (op.type === 'lookup') {
    kind = t('Linear interpolation', '線形補間');
    data.bounds.forEach((point, index) => cells.push({ label: data.bounds.length === 2 ? (index ? t('Upper point', '上の点') : t('Lower point', '下の点')) : t('Endpoint', '端点'), value: `${numberText(point.input)} → ${numberText(point.output)}` }));
    if (data.bounds.length === 2) { const [a, b] = data.bounds; steps.push(`${numberText(a.output)} + (${numberText(b.output)} − ${numberText(a.output)}) × (${input} − ${numberText(a.input)}) / (${numberText(b.input)} − ${numberText(a.input)})`); }
    else steps.push(t('At or beyond the end of the table: the endpoint value is used.', '表の端または範囲外のため、端点の値を使います。'));
  } else {
    const evidence = data.filterEvidence; const lowPass = op.filter === 'low-pass';
    kind = lowPass ? t('Low-pass filter', 'ローパスフィルター') : t('Moving average', '移動平均');
    cells.push({ label: lowPass ? t('Time constant', '時定数') : t('Window', '時間窓'), value: `${numberText(op.timeSeconds)} s` });
    if (!evidence) steps.push(t('Output from the sequential log analysis', 'ログを先頭から解析した出力'));
    else if (!lowPass) { cells.push({ label: t('Sum', '合計'), value: numberText(evidence.sum) }, { label: t('Samples', 'サンプル数'), value: String(evidence.sampleCount ?? '—') }); steps.push(`${numberText(evidence.sum)} / ${evidence.sampleCount}`); }
    else if (evidence.previousValue === undefined) steps.push(t('Initial/reset sample: output equals input', '初回・時刻リセット: 入力値を出力'));
    else {
      const alpha = 1 - Math.exp(-evidence.deltaSeconds / op.timeSeconds);
      cells.push({ label: t('Previous output', '前回の出力'), value: numberText(evidence.previousValue) }, { label: 'Δt', value: `${numberText(evidence.deltaSeconds)} s` }, { label: 'α', value: numberText(alpha) });
      steps.push(`α = 1 − exp(−Δt / ${numberText(op.timeSeconds)})`, `${numberText(evidence.previousValue)} + α × (${input} − ${numberText(evidence.previousValue)})`);
    }
  }
  return { kind, cells, steps, result: withUnit(data.result, data.unit) };
}

/** The same explanation as plain lines, for assistive technology. */
export function explanationLines(detail: Detail): string[] {
  const data = detail.derived; if (!data) return [];
  const op = data.operation;
  const lines: string[] = [];
  if (op.type === 'expression') lines.push(`${t('Expression', '計算式')}: ${op.expression}`);
  else if (op.type === 'lookup') lines.push(t('Linear interpolation', '線形補間'),
    `${t('Out of range', '範囲外')}: ${op.outOfRange === 'clamp' ? t('Clamp to endpoint', '端点の値を使用') : t('Error', 'エラー')}`);
  else lines.push(`${op.filter === 'low-pass' ? t('Low-pass filter · time constant', 'ローパスフィルター・時定数') : t('Moving average · window', '移動平均・時間窓')}: ${numberText(op.timeSeconds)} s`);
  lines.push(...data.inputs.map(input => `${input.name} = ${input.value === undefined ? t('Unavailable', '取得できません') : numberText(input.value)}${input.unit ? ` ${input.unit}` : ''}`));
  if (op.type === 'lookup') {
    lines.push(...data.bounds.map(point => `(${numberText(point.input)}, ${numberText(point.output)})`));
    if (data.bounds.length === 2) { const [a, b] = data.bounds; lines.push(`${numberText(a.output)} + (${numberText(b.output)} − ${numberText(a.output)}) × (${numberText(data.inputs[0]?.value)} − ${numberText(a.input)}) / (${numberText(b.input)} − ${numberText(a.input)})`); }
    else lines.push(t('Endpoint value', '端点の値'));
  }
  if (op.type === 'filter') {
    const evidence = data.filterEvidence;
    if (!evidence) lines.push(t('Output from the sequential log analysis', 'ログを先頭から解析した出力'));
    else if (op.filter === 'moving-average') lines.push(`${t('Sum / sample count', '合計 / サンプル数')}: ${numberText(evidence.sum)} / ${evidence.sampleCount}`);
    else if (evidence.previousValue === undefined) lines.push(t('Initial/reset sample: output equals input', '初回・時刻リセット: 入力値を出力'));
    else { const alpha = 1 - Math.exp(-evidence.deltaSeconds / op.timeSeconds); lines.push(`Δt = ${numberText(evidence.deltaSeconds)} s`, `α = 1 − exp(−Δt / ${numberText(op.timeSeconds)}) = ${numberText(alpha)}`, `${numberText(evidence.previousValue)} + α × (${numberText(data.inputs[0]?.value)} − ${numberText(evidence.previousValue)})`); }
  }
  lines.push(`${t('Result', '結果')}: ${numberText(data.result)}${data.unit ? ` ${data.unit}` : ''}`);
  return lines;
}
