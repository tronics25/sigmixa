import { t } from '../shared/i18n';

export interface CanIdChoice { readonly key: string; readonly canId: string; readonly name: string }

/**
 * A list of CAN IDs to choose from, in a view's settings: the same search box, "All" row and rows as the Signal list of
 * a graph. A CAN ID is a Frame, so its row is a Frame's row of that list: the box and the name where a Frame's are, with
 * no Signals to open below it.
 */
export class CanIdList {
  private search = '';
  private ids: readonly CanIdChoice[] = [];

  private readonly host: HTMLElement;

  /** `parent` is the view's settings; the list is one element in it, as a graph's Signal list is. */
  constructor(parent: HTMLElement, private readonly options: { chosen(key: string): boolean; change(keys: readonly string[], chosen: boolean): void }) { this.host = document.createElement('div'); parent.append(this.host); }

  setIds(ids: readonly CanIdChoice[]): void { this.ids = ids; this.render(); }

  render(): void {
    const { host, options } = this; const scrollTop = host.scrollTop; host.replaceChildren(); host.classList.add('signal-selector', 'can-id-list');
    const search = document.createElement('input'); search.type = 'search'; search.placeholder = t('Search CAN IDs…', 'CAN IDを検索…'); search.value = this.search; search.setAttribute('aria-label', search.placeholder);
    // Filtering redraws the list, search box included; while an IME is composing the box must stay as it is.
    const apply = () => { this.search = search.value; this.render(); requestAnimationFrame(() => { const next = host.querySelector<HTMLInputElement>('input[type=search]'); next?.focus(); next?.setSelectionRange(this.search.length, this.search.length); }); };
    let composing = false;
    search.addEventListener('compositionstart', () => { composing = true; }); search.addEventListener('compositionend', () => { composing = false; apply(); });
    search.addEventListener('input', (event) => { if (composing || (event as InputEvent).isComposing) return; apply(); });
    host.append(search);
    const text = this.search.trim().toLowerCase(); const shown = text ? this.ids.filter((id) => `${id.canId} ${id.name}`.toLowerCase().includes(text)) : this.ids;
    {
      const chosen = shown.filter((id) => options.chosen(id.key)).length;
      const controls = document.createElement('div'); controls.className = 'selector-controls'; const label = document.createElement('label'); label.className = 'selector-all';
      const all = document.createElement('input'); all.type = 'checkbox'; all.checked = shown.length > 0 && chosen === shown.length; all.indeterminate = chosen > 0 && chosen < shown.length; all.disabled = !shown.length;
      all.setAttribute('aria-label', all.checked ? t('Clear all', 'すべて解除') : t('Select all', 'すべて選択'));
      all.addEventListener('change', () => { options.change(shown.map((id) => id.key), all.checked); this.render(); host.querySelector<HTMLInputElement>('.selector-all input')?.focus({ preventScroll: true }); });
      const caption = document.createElement('span'); caption.textContent = text ? t('Results', '検索結果') : t('All', 'すべて');
      const count = document.createElement('small'); count.className = 'selector-selection-count'; count.textContent = `${chosen}/${shown.length}`;
      label.append(all, caption, count); controls.append(label); host.append(controls);
    }
    if (!shown.length) { const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = t('No matching CAN IDs.', '一致するCAN IDはありません。'); host.append(empty); }
    const list = document.createElement('div'); list.className = 'can-id-rows';
    for (const id of shown) {
      // The row of a Frame in the Signal list: the place of its expand button stays empty.
      const group = document.createElement('div'); group.className = 'selector-group'; const row = document.createElement('label'); row.className = 'selector-group-head can-id-row'; row.dataset.key = id.key; row.style.gridTemplateColumns = '28px 20px minmax(0,1fr)';
      const input = document.createElement('input'); input.type = 'checkbox'; input.checked = options.chosen(id.key);
      input.addEventListener('change', () => { options.change([id.key], input.checked); this.render(); host.querySelector<HTMLInputElement>(`.can-id-row[data-key="${CSS.escape(id.key)}"] input`)?.focus({ preventScroll: true }); });
      const name = document.createElement('span'); name.className = 'selector-group-name can-id-name'; name.textContent = `${id.canId}${id.name ? ` ${id.name}` : ''}`; name.title = name.textContent;
      row.append(document.createElement('span'), input, name); group.append(row); list.append(group);
    }
    host.append(list); host.scrollTop = scrollTop;
  }
}
