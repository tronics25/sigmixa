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
  if (!signalByteMasks(detail).size) return;
  chip.tabIndex = 0;
  chip.title = '';
  const show = () => {
    hide(); if (!chip.isConnected) return;
    active = chip; popup = document.createElement('div'); popup.id = 'decoded-inspection'; popup.setAttribute('role', 'tooltip'); chip.setAttribute('aria-describedby', popup.id);
    popup.style.cssText = 'position:fixed;z-index:1000;pointer-events:none;padding:8px;border:1px solid var(--vscode-editorHoverWidget-border,var(--vscode-panel-border));border-radius:4px;background:var(--vscode-editorHoverWidget-background,var(--vscode-editor-background));color:var(--vscode-foreground);box-shadow:0 3px 10px #0004;font:11px var(--vscode-editor-font-family);max-width:calc(100vw - 16px)';
    const heading = document.createElement('div'); heading.textContent = `${detail.tag} · RAW ${detail.raw ?? '—'} · ${detail.byteOrder!.toUpperCase()}`; heading.style.cssText = 'max-width:380px;overflow-wrap:anywhere;margin-bottom:6px'; popup.append(heading);
    const grid = document.createElement('div'); grid.style.cssText = 'display:grid;grid-template-columns:repeat(8,minmax(26px,1fr));gap:3px';
    const masks = signalByteMasks(detail);
    row.rawContent.split(' ').forEach((hex, byte) => {
      const cell = document.createElement('div'); cell.style.cssText = 'text-align:center;padding:3px;border-radius:2px';
      const offset = document.createElement('small'); offset.textContent = String(byte); offset.style.cssText = 'display:block;color:var(--vscode-descriptionForeground);font-size:9px';
      cell.append(offset, document.createTextNode(hex)); if (masks.has(byte)) { cell.style.background = 'var(--vscode-editor-selectionBackground)'; cell.style.outline = '1px solid var(--vscode-focusBorder)'; }
      grid.append(cell);
    });
    popup.append(grid);
    const bits = document.createElement('div'); bits.style.cssText = 'margin-top:6px;display:flex;gap:8px;flex-wrap:wrap';
    for (const [byte, mask] of masks) {
      const group = document.createElement('span'); group.append(document.createTextNode(`B${byte} `)); const value = parseInt(row.rawContent.split(' ')[byte] ?? '0', 16);
      for (let bit = 7; bit >= 0; bit--) { const digit = document.createElement('span'); digit.textContent = String((value >> bit) & 1); digit.style.opacity = mask & (1 << bit) ? '1' : '.3'; if (mask & (1 << bit)) digit.style.fontWeight = '700'; group.append(digit); }
      bits.append(group);
    }
    bits.setAttribute('aria-label', t('Signal bits, bit 7 to bit 0', 'Signalのビット（bit 7からbit 0）')); popup.append(bits); document.body.append(popup);
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
