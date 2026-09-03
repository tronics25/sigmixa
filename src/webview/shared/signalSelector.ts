import type { SignalDefinition } from '../../core/signal/signal';
import type { SignalGroupDto } from '../../extension/editors/rawLogProtocol';

/** Curated graph colors shared by automatic assignment and the compact picker. */
export const SIGNAL_COLOR_PRESETS = [
  '#2563eb', '#dc2626', '#16a34a', '#d97706',
  '#7c3aed', '#0891b2', '#db2777', '#65a30d',
  '#4f46e5', '#ea580c', '#0d9488', '#be123c',
  '#334155', '#a16207', '#15803d', '#9333ea',
] as const;

export interface SignalSelectorOptions {
  readonly host: HTMLElement;
  readonly selected: Set<string>;
  readonly onSelectionChange: (selected: ReadonlySet<string>) => void;
  readonly colors?: Map<string, string>;
  readonly onColorChange?: (signalId: string, color: string) => void;
  readonly onRemoveSignal?: (definition: SignalDefinition, group: SignalGroupDto) => void;
}

export class SignalSelector {
  private definitions = new Map<string, SignalDefinition>();
  private groups: readonly SignalGroupDto[] = [];
  private search = '';
  private readonly expanded = new Set<string>();
  private closeColorPopup: (() => void) | undefined;

  constructor(private readonly options: SignalSelectorOptions) {}

  setCatalog(definitions: readonly SignalDefinition[], groups: readonly SignalGroupDto[]): void {
    this.definitions = new Map(definitions.map((definition) => [definition.id, definition]));
    this.groups = groups;
    for (const group of groups) this.expanded.add(group.id);
    this.render();
  }

  render(): void {
    this.closeColorPopup?.();
    const { host, selected } = this.options;
    // The scrolling element is the surrounding pane, not the selector host.
    // Replacing the host's children temporarily collapses its height and would
    // otherwise clamp the pane back to the first Signal on every checkbox click.
    const scrollContainer = host.closest<HTMLElement>('.signal-pane') ?? host;
    const previousScrollTop = scrollContainer.scrollTop;
    const restoreScroll = () => { scrollContainer.scrollTop = Math.min(previousScrollTop, Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight)); };
    host.replaceChildren(); host.className = 'signal-selector';
    const search = document.createElement('input'); search.type = 'search'; search.placeholder = 'Search Signals…'; search.value = this.search; search.setAttribute('aria-label', 'Search Signals');
    search.addEventListener('input', () => { this.search = search.value; this.render(); requestAnimationFrame(() => { const next = host.querySelector<HTMLInputElement>('input[type=search]'); next?.focus(); next?.setSelectionRange(this.search.length, this.search.length); }); });
    const actions = document.createElement('div'); actions.className = 'selector-actions';
    const selectAll = button('Select all', () => this.toggleAll(true)); const clear = button('Clear all', () => this.toggleAll(false)); actions.append(selectAll, clear); host.append(search, actions);
    const visible = this.visibleGroups();
    if (!visible.length) { const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = 'No matching Signals.'; host.appendChild(empty); restoreScroll(); return; }
    const nameCounts = new Map<string, number>();
    for (const definition of this.definitions.values()) nameCounts.set(definition.name, (nameCounts.get(definition.name) ?? 0) + 1);
    for (const group of visible) {
      const section = document.createElement('div'); section.className = 'selector-group';
      const header = document.createElement('div'); header.className = 'selector-group-head';
      const expand = button(this.expanded.has(group.id) ? '▾' : '▸', () => { this.expanded.has(group.id) ? this.expanded.delete(group.id) : this.expanded.add(group.id); this.render(); }); expand.className = 'selector-expand';
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox';
      const signalIds = group.signalIds.filter((id) => this.matches(this.definitions.get(id)));
      const selectedCount = signalIds.filter((id) => selected.has(id)).length; checkbox.checked = signalIds.length > 0 && selectedCount === signalIds.length; checkbox.indeterminate = selectedCount > 0 && selectedCount < signalIds.length;
      checkbox.addEventListener('change', () => { const next = new Set(selected); const turnOn = signalIds.some((id) => !next.has(id)); for (const id of signalIds) turnOn ? next.add(id) : next.delete(id); this.replaceSelection(next); });
      const label = document.createElement('span'); label.textContent = group.label; label.title = group.label; header.append(expand, checkbox, label);
      section.appendChild(header);
      if (this.expanded.has(group.id)) for (const id of signalIds) {
        const definition = this.definitions.get(id); if (!definition) continue;
        const row = document.createElement('label'); row.className = 'selector-signal'; const child = document.createElement('input'); child.type = 'checkbox'; child.checked = selected.has(id);
        child.addEventListener('change', () => { const next = new Set(selected); child.checked ? next.add(id) : next.delete(id); this.replaceSelection(next); });
        const text = document.createElement('span'); const collision = (nameCounts.get(definition.name) ?? 0) > 1; text.textContent = `${definition.name}${definition.unit ? ` (${definition.unit})` : ''}${collision ? ` · ${group.label}` : ''}`; text.title = text.textContent;
        row.append(child, text);
        if (this.options.colors && this.options.onColorChange) row.appendChild(this.colorButton(id));
        if (group.remove?.type === 'external-csv' && this.options.onRemoveSignal) row.appendChild(this.removeSignalButton(definition, group));
        section.appendChild(row);
      }
      host.appendChild(section);
    }
    restoreScroll();
  }

  private visibleGroups(): readonly SignalGroupDto[] {
    return this.groups.map((group) => ({ ...group, signalIds: group.signalIds.filter((id) => this.matches(this.definitions.get(id))) })).filter((group) => group.signalIds.length > 0);
  }

  private matches(definition: SignalDefinition | undefined): boolean {
    if (!definition) return false; const query = this.search.trim().toLowerCase();
    return !query || `${definition.name} ${definition.unit ?? ''}`.toLowerCase().includes(query);
  }

  private toggleAll(on: boolean): void {
    const next = new Set(this.options.selected);
    for (const group of this.visibleGroups()) for (const id of group.signalIds) on ? next.add(id) : next.delete(id);
    this.replaceSelection(next);
  }

  private replaceSelection(next: Set<string>): void {
    this.options.selected.clear(); for (const id of next) this.options.selected.add(id);
    this.options.onSelectionChange(this.options.selected); this.render();
  }

  private colorButton(id: string): HTMLButtonElement {
    const current = this.options.colors?.get(id) ?? SIGNAL_COLOR_PRESETS[Math.abs(hash(id)) % SIGNAL_COLOR_PRESETS.length];
    const signalName = this.definitions.get(id)?.name ?? 'Signal';
    const control = document.createElement('button'); control.type = 'button'; control.className = 'color-button'; control.style.backgroundColor = current;
    control.title = `Choose color for ${signalName}`; control.setAttribute('aria-label', `Choose color for ${signalName}`); control.setAttribute('aria-haspopup', 'dialog'); control.setAttribute('aria-expanded', 'false');
    control.addEventListener('click', (event) => {
      event.preventDefault(); event.stopPropagation();
      if (this.closeColorPopup) { this.closeColorPopup(); return; }
      this.openColorPopup(id, current, control);
    });
    return control;
  }

  private removeSignalButton(definition: SignalDefinition, group: SignalGroupDto): HTMLButtonElement {
    const control = document.createElement('button'); control.type = 'button'; control.className = 'remove-source';
    control.title = `Remove ${definition.name}`; control.setAttribute('aria-label', `Remove ${definition.name}`);
    const icon = document.createElement('i'); icon.className = 'codicon codicon-trash'; icon.setAttribute('aria-hidden', 'true'); control.appendChild(icon);
    control.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); this.options.onRemoveSignal?.(definition, group); });
    return control;
  }

  private openColorPopup(id: string, current: string, control: HTMLButtonElement): void {
    const popup = document.createElement('div'); popup.className = 'color-popup'; popup.setAttribute('role', 'dialog'); popup.setAttribute('aria-label', 'Signal color presets');
    const swatches = SIGNAL_COLOR_PRESETS.map((color) => {
      const swatch = document.createElement('button'); swatch.type = 'button'; swatch.className = 'color-swatch'; swatch.style.backgroundColor = color; swatch.title = color;
      swatch.setAttribute('aria-label', `Use ${color}`); swatch.setAttribute('aria-pressed', String(color.toLowerCase() === current.toLowerCase()));
      if (color.toLowerCase() === current.toLowerCase()) swatch.classList.add('selected');
      swatch.addEventListener('click', (event) => {
        event.preventDefault(); event.stopPropagation(); this.closeColorPopup?.();
        this.options.colors?.set(id, color); this.options.onColorChange?.(id, color); this.render();
      });
      return swatch;
    });
    popup.append(...swatches); document.body.appendChild(popup); control.setAttribute('aria-expanded', 'true');

    const anchor = control.getBoundingClientRect(); const popupRect = popup.getBoundingClientRect(); const edge = 8;
    popup.style.left = `${Math.max(edge, Math.min(anchor.left, window.innerWidth - popupRect.width - edge))}px`;
    const below = anchor.bottom + 4; popup.style.top = `${below + popupRect.height <= window.innerHeight - edge ? below : Math.max(edge, anchor.top - popupRect.height - 4)}px`;

    const close = () => {
      popup.remove(); control.setAttribute('aria-expanded', 'false'); document.removeEventListener('pointerdown', outside, true);
      if (this.closeColorPopup === close) this.closeColorPopup = undefined;
    };
    const outside = (event: PointerEvent) => { if (!popup.contains(event.target as Node) && event.target !== control) close(); };
    this.closeColorPopup = close; document.addEventListener('pointerdown', outside, true);
    popup.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); control.focus(); return; }
      const index = swatches.indexOf(document.activeElement as HTMLButtonElement); if (index < 0) return;
      const moves: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -4, ArrowDown: 4, Home: -index, End: swatches.length - 1 - index };
      const move = moves[event.key]; if (move === undefined) return; event.preventDefault(); swatches[Math.max(0, Math.min(swatches.length - 1, index + move))].focus();
    });
    (swatches.find((swatch) => swatch.classList.contains('selected')) ?? swatches[0]).focus();
  }
}

function button(label: string, action: () => void): HTMLButtonElement { const result = document.createElement('button'); result.type = 'button'; result.textContent = label; result.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); action(); }); return result; }
function hash(value: string): number { let result = 0; for (const char of value) result = ((result << 5) - result + char.charCodeAt(0)) | 0; return result; }
