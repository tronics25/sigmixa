import { t } from './i18n';

/**
 * A handle on the left edge of a side panel (the graph settings): dragging it changes the panel's width, the same in
 * Visualize and on the comparison screen. Like column widths, the width is not saved.
 */
export function bindSidePanelResizer(panel: HTMLElement, minWidth = 240): void {
  const handle = document.createElement('div'); handle.className = 'side-panel-resizer';
  handle.setAttribute('role', 'separator'); handle.setAttribute('aria-orientation', 'vertical'); handle.setAttribute('aria-label', t('Resize graph settings', 'グラフ設定の幅を変更'));
  panel.before(handle);
  handle.addEventListener('mousedown', (event) => {
    event.preventDefault();
    const start = event.clientX; const initial = panel.getBoundingClientRect().width;
    // Never wider than leaves the graphs a third of the space.
    const maxWidth = Math.max(minWidth, (panel.parentElement?.getBoundingClientRect().width ?? initial * 3) * 2 / 3);
    handle.classList.add('dragging');
    const move = (next: MouseEvent) => {
      const width = Math.round(Math.max(minWidth, Math.min(maxWidth, initial - (next.clientX - start))));
      panel.style.flexBasis = `${width}px`; panel.style.width = `${width}px`;
      // Still leaves the graphs a third when the window is made narrower later.
      panel.style.maxWidth = '67%';
    };
    const up = () => { handle.classList.remove('dragging'); window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  });
}
