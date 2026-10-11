import { setGlyph } from './glyph';
import type { ViewContextAction } from './viewContextAction';

let closeOpenMenu: (() => void) | undefined;

/** Closes the menu that is open, if any. */
export function closeActionMenu(): void { closeOpenMenu?.(); }

/**
 * The one context menu used by every view: icon + label rows, ↑/↓/Home/End to move, Esc to close
 * (focus returns to `returnFocus`), and it closes on outside click, blur, resize or scrolling `scroller`.
 */
export function showActionMenu(actions: readonly (ViewContextAction | null)[], label: string, x: number, y: number, returnFocus: HTMLElement, options: { trigger?: HTMLButtonElement; scroller?: HTMLElement } = {}): void {
  closeOpenMenu?.();
  const { trigger, scroller } = options;
  const menu = document.createElement('div'); menu.className = 'context-menu visualize-context-menu'; menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', label);
  trigger?.setAttribute('aria-expanded', 'true');
  const lifetime = new AbortController();
  const close = () => { menu.remove(); lifetime.abort(); trigger?.setAttribute('aria-expanded', 'false'); closeOpenMenu = undefined; };
  closeOpenMenu = close;
  const buttons: HTMLButtonElement[] = [];
  for (const item of actions) {
    if (!item) { const separator = document.createElement('div'); separator.setAttribute('role', 'separator'); menu.appendChild(separator); continue; }
    const button = document.createElement('button'); button.type = 'button'; button.tabIndex = -1;
    button.setAttribute('role', item.checked === undefined ? 'menuitem' : 'menuitemcheckbox');
    if (item.checked !== undefined) button.setAttribute('aria-checked', String(item.checked));
    button.disabled = item.enabled === false;
    const icon = document.createElement('span'); setGlyph(icon, item.checked ? 'check' : item.icon); icon.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span'); text.textContent = item.label; button.append(icon, text);
    button.addEventListener('click', (event) => { event.stopPropagation(); close(); item.run(); });
    buttons.push(button); menu.appendChild(button);
  }
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - rect.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 4))}px`;
  document.addEventListener('pointerdown', (event) => { if (!menu.contains(event.target as Node) && !trigger?.contains(event.target as Node)) close(); }, { capture: true, signal: lifetime.signal });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); returnFocus.focus({ preventScroll: true }); }
    else if (event.key === 'Tab') close();
    else if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation(); const enabled = buttons.filter((button) => !button.disabled);
      const current = enabled.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1 : (current + (event.key === 'ArrowUp' ? -1 : 1) + enabled.length) % enabled.length;
      enabled[next]?.focus();
    }
  }, { capture: true, signal: lifetime.signal });
  window.addEventListener('blur', close, { signal: lifetime.signal });
  window.addEventListener('resize', close, { signal: lifetime.signal });
  scroller?.addEventListener('scroll', close, { signal: lifetime.signal });
  buttons.find((button) => !button.disabled)?.focus({ preventScroll: true });
}
