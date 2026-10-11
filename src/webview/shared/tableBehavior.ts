import { emphasizeSignal } from './signalEmphasis';
import { t } from './i18n';

/** Width step for keyboard resizing; Shift makes it coarser. */
const KEY_STEP = 8;

/**
 * Hovering a cell emphasizes the header of its column, the same way in every table.
 * `columnOf` names the column of a hovered element; `headersOf` returns that column's header cells.
 */
export function bindColumnHover(container: HTMLElement, columnOf: (element: Element) => string | undefined, headersOf: (column: string) => ArrayLike<HTMLElement>): { refresh(): void } {
  let current: string | undefined;
  const set = (column: string | undefined, force = false) => {
    if (column === current && !force) return;
    if (current !== undefined) for (const head of Array.from(headersOf(current))) emphasizeSignal(head, false, '');
    current = column;
    if (column !== undefined) for (const head of Array.from(headersOf(column))) emphasizeSignal(head, true, 'var(--vscode-focusBorder)');
  };
  container.addEventListener('mouseover', (event) => set(columnOf(event.target as Element)));
  container.addEventListener('mouseleave', () => set(undefined));
  container.addEventListener('scroll', () => set(undefined), true);
  // Tables that rebuild their header call refresh() so the emphasis follows the new header cells.
  return { refresh: () => set(current, true) };
}

export interface ResizeHandleOptions {
  readonly label: string;
  readonly width: () => number;
  readonly setWidth: (width: number) => void;
  readonly fit: () => void;
}

/** Column resize handles are focusable separators: ←/→ resize, Enter fits the content. */
export function bindResizeKeyboard(handle: HTMLElement, options: ResizeHandleOptions): void {
  handle.tabIndex = 0;
  handle.removeAttribute('aria-hidden');
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'vertical');
  handle.setAttribute('aria-label', t(`${options.label} column width`, `${options.label}列幅`));

  handle.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); options.fit(); return; }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault(); event.stopPropagation();
    const step = (event.shiftKey ? KEY_STEP * 4 : KEY_STEP) * (event.key === 'ArrowRight' ? 1 : -1);
    options.setWidth(options.width() + step);
  });
  handle.addEventListener('click', (event) => event.stopPropagation());
}

/**
 * No table cuts off its cells or headers. Given the rendered cells of one column (header included),
 * returns the width the column needs, or undefined when nothing overflows. Callers only ever widen,
 * so a column that already fits never creeps wider and scrolling or playback never shrinks it.
 */
export function widthToFit(cells: ArrayLike<HTMLElement>, currentWidth: number): number | undefined {
  let needed = currentWidth;
  for (const cell of Array.from(cells)) {
    const overflow = contentOverflow(cell);
    if (overflow > 1) needed = Math.max(needed, currentWidth + overflow + 2);
  }
  return needed > currentWidth ? Math.ceil(needed) : undefined;
}

/** How far a cell's content (or an input's text) extends past its box. */
function contentOverflow(cell: HTMLElement): number {
  let overflow = cell.scrollWidth - cell.clientWidth;
  for (const element of Array.from(cell.querySelectorAll<HTMLElement>('input:not([type=checkbox]),[data-fit-content]'))) {
    overflow = Math.max(overflow, element.scrollWidth - element.clientWidth);
  }
  return overflow;
}

/** Esc leaves a table: the focused row or table container loses focus, so its focus outline goes away with the selection. */
export function blurTableFocus(selector: string): boolean {
  const active = document.activeElement as HTMLElement | null;
  if (!active?.matches(selector)) return false;
  active.blur(); return true;
}
