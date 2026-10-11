import { enhanceChoiceSelect, focusChoiceSelect } from './choiceGroup';
import { iconButton } from './iconButton';
import type { SignalDefinition } from '../../core/signal/signal';
import type { SignalGroupDto } from '../../extension/editors/rawLogProtocol';
import { t } from './i18n';
import { signalUnitGroup, type SignalGrouping } from './signalGrouping';

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
  readonly onHighlightChange?: (signalId: string | undefined) => void;
  readonly onRemoveSignal?: (definition: SignalDefinition, group: SignalGroupDto) => void;
  readonly grouping?: SignalGrouping;
  readonly onGroupingChange?: (grouping: SignalGrouping) => void;
}

export class SignalSelector {
  private definitions = new Map<string, SignalDefinition>();
  private groups: readonly SignalGroupDto[] = [];
  private unitGroups: readonly SignalGroupDto[] = [];
  private readonly sources = new Map<string, SignalGroupDto>();
  private grouping: SignalGrouping;
  private search = '';
  /** The Signals the log has samples of; undefined lists every definition. */
  private measured: ReadonlySet<string> | undefined;
  private unmeasuredOption = false;
  private showUnmeasured = false;
  private readonly searchCollapsed = new Set<string>();
  private readonly expandedByMode = { frame: new Set<string>(), unit: new Set<string>() };
  private get expanded(): Set<string> { return this.expandedByMode[this.grouping]; }
  get groupingMode(): SignalGrouping { return this.grouping; }
  private closeColorPopup: (() => void) | undefined;

  constructor(private readonly options: SignalSelectorOptions) {
    this.grouping = options.grouping === 'unit' ? 'unit' : 'frame';
    if (!document.getElementById('signal-grouping-style')) {
      const style = document.createElement('style'); style.id = 'signal-grouping-style';
      style.textContent = `
        .selector-controls{display:flex;align-items:center;justify-content:space-between;gap:var(--sm-space-md);min-width:0;margin:var(--sm-space-sm) 0}
        .selector-all{display:flex;align-items:center;gap:var(--sm-space-xs);min-width:0;font-size:var(--sm-font-small);white-space:nowrap;cursor:pointer}
        .selector-all input{margin:0;flex-shrink:0}
        .selector-controls select{min-width:0;max-width:50%;padding:var(--sm-space-xs) var(--sm-space-xs);font-size:var(--sm-font-small)}
        .selector-group-count,.selector-selection-count{font-size:var(--sm-font-caption);font-weight:var(--sm-weight-regular);color:var(--vscode-descriptionForeground);font-variant-numeric:tabular-nums;white-space:nowrap}
        .selector-group-count{padding-left:var(--sm-space-xs)}
        .selector-group-head{font-size:var(--sm-font-small)}
        /* One indent step per level: the All box, then a group's box (after its 28px expander), then a Signal's box under the group's name. */
        .signal-selector .selector-all{padding-left:0}
        .signal-selector>.selector-search-row{display:flex;align-items:center;gap:var(--sm-space-xs);min-width:0}
        .selector-search-row>input{flex:1 1 auto;min-width:0;width:auto}
        .selector-search-row>button{flex:0 0 auto}
        .view-settings .signal-selector>.selector-search-row{grid-column:1/-1;order:-1}
        .selector-signal.is-unmeasured>span{color:var(--vscode-descriptionForeground);font-style:italic}
        .signal-selector .selector-signal{padding-left:48px}
        /* The two ways of grouping share the full width, half each. */
        .selector-grouping-row .choice-group{display:flex;flex:1 1 100%;width:100%}
        .selector-grouping-row .choice-group>button{flex:1 1 0;min-width:0;justify-content:center;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        button.selector-group-name{min-width:0;padding:var(--sm-space-xs) 0;border:0;background:transparent;text-align:left;font:inherit;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}
        button.selector-group-name:hover{background:transparent;color:var(--vscode-textLink-foreground,var(--vscode-foreground))}
      `;
      document.head.append(style);
    }
  }

  /**
   * `availability.measuredIds` narrows the list to the Signals the log has, plus whatever is already chosen.
   * `availability.unmeasuredOption` adds the switch that lists the others too (view settings shared in a group).
   */
  setCatalog(definitions: readonly SignalDefinition[], groups: readonly SignalGroupDto[], availability?: { readonly measuredIds?: readonly string[]; readonly unmeasuredOption?: boolean }): void {
    this.measured = availability?.measuredIds ? new Set(availability.measuredIds) : undefined;
    this.unmeasuredOption = availability?.unmeasuredOption === true;
    this.definitions = new Map(definitions.map((definition) => [definition.id, definition]));
    this.groups = groups;
    this.sources.clear();
    for (const group of groups) for (const id of group.signalIds) this.sources.set(id, group);
    const units = new Map<string, { id: string; label: string; order: number; signalIds: string[] }>();
    for (const definition of definitions) {
      const unit = signalUnitGroup(definition.unit);
      const group = units.get(unit.key) ?? { id: unit.key, label: unit.label, order: unit.order, signalIds: [] };
      group.signalIds.push(definition.id); units.set(unit.key, group);
    }
    this.unitGroups = [...units.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
    for (const mode of ['frame', 'unit'] as const) {
      const next = mode === 'frame' ? this.groups : this.unitGroups;
      const nextIds = new Set(next.map((group) => group.id));
      const expanded = this.expandedByMode[mode];
      for (const id of [...expanded]) if (!nextIds.has(id)) expanded.delete(id);
    }
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
    host.replaceChildren(); host.classList.add('signal-selector');
    const search = document.createElement('input'); search.type = 'search'; search.placeholder = t('Search signals…', 'シグナルを検索…'); search.value = this.search; search.setAttribute('aria-label', t('Search signals', 'シグナルを検索'));
    // Filtering redraws the list, search box included. While an IME is composing (Japanese input), the box must stay as it
    // is, or the composition is lost; the list is filtered when the composition is confirmed.
    const applySearch = () => { this.search = search.value; this.searchCollapsed.clear(); this.render(); requestAnimationFrame(() => { const next = host.querySelector<HTMLInputElement>('input[type=search]'); next?.focus(); next?.setSelectionRange(this.search.length, this.search.length); }); };
    let composing = false;
    search.addEventListener('compositionstart', () => { composing = true; });
    search.addEventListener('compositionend', () => { composing = false; applySearch(); });
    search.addEventListener('input', (event) => { if (composing || (event as InputEvent).isComposing) return; applySearch(); });
    const controls = document.createElement('div'); controls.className = 'selector-controls';
    const filtering = Boolean(this.search.trim());
    const visible = this.visibleGroups();
    const visibleIds = [...new Set(visible.flatMap((group) => group.signalIds))];
    const selectedCount = visibleIds.filter((id) => selected.has(id)).length;
    const allLabel = document.createElement('label'); allLabel.className = 'selector-all';
    const all = document.createElement('input'); all.type = 'checkbox';
    all.checked = visibleIds.length > 0 && selectedCount === visibleIds.length;
    all.indeterminate = selectedCount > 0 && selectedCount < visibleIds.length;
    all.disabled = visibleIds.length === 0;
    const allName = all.checked
      ? (filtering ? t('Clear search results', '検索結果をすべて解除') : t('Clear all', 'すべて解除'))
      : (filtering ? t('Select search results', '検索結果をすべて選択') : t('Select all', 'すべて選択'));
    all.setAttribute('aria-label', allName);
    all.addEventListener('change', () => {
      this.toggleAll(all.checked);
      host.querySelector<HTMLInputElement>('.selector-all input')?.focus({ preventScroll: true });
    });
    const allCaption = document.createElement('span'); allCaption.textContent = filtering ? t('Results', '検索結果') : t('All', 'すべて');
    const count = document.createElement('small'); count.className = 'selector-selection-count'; count.textContent = `${selectedCount}/${visibleIds.length}`;
    allLabel.append(all, allCaption, count);
    const grouping = document.createElement('select'); grouping.className = 'selector-grouping';
    grouping.setAttribute('aria-label', t('Group signals by', 'シグナルの分類'));
    for (const [mode, caption] of [['frame', t('By frame', 'フレーム別')], ['unit', t('By unit system', '単位系別')]] as const) {
      const option = document.createElement('option'); option.value = mode; option.textContent = caption; grouping.append(option);
    }
    grouping.value = this.grouping;
    grouping.addEventListener('change', () => {
      this.options.onHighlightChange?.(undefined);
      this.grouping = grouping.value === 'unit' ? 'unit' : 'frame'; this.searchCollapsed.clear();
      this.render(); this.options.onGroupingChange?.(this.grouping);
      const next = host.querySelector<HTMLSelectElement>('.selector-grouping'); if (next) focusChoiceSelect(next);
    });
    // How the list is grouped comes first, then the line that selects everything in it.
    const groupingRow = document.createElement('div'); groupingRow.className = 'selector-controls selector-grouping-row'; groupingRow.append(grouping);
    controls.append(allLabel); host.append(search, groupingRow);
    // Narrowing the list belongs with the search: a small toggle at the end of the search box, lit while the list is
    // narrowed to the log. It only appears where Signals of other logs may be wanted (view settings shared in a group).
    const hiddenCount = this.unmeasuredCount();
    if (this.unmeasuredOption && hiddenCount > 0) {
      const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'icon-button selector-log-filter';
      iconButton(toggle, 'filter', this.showUnmeasured
        ? t('Showing every Signal. Click to show only the Signals in this log.', 'すべてのシグナルを表示中。クリックでこのログにあるシグナルだけに絞り込みます。')
        : t('Only Signals in this log', 'このログのシグナルだけ表示'));
      toggle.setAttribute('aria-pressed', String(!this.showUnmeasured));
      toggle.addEventListener('click', () => { this.showUnmeasured = !this.showUnmeasured; this.render(); host.querySelector<HTMLButtonElement>('.selector-log-filter')?.focus({ preventScroll: true }); });
      const row = document.createElement('div'); row.className = 'selector-search-row'; host.insertBefore(row, search); row.append(search, toggle);
    }
    host.append(controls); enhanceChoiceSelect(grouping);
    if (!visible.length) { const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = filtering || !this.measured || this.showUnmeasured ? t('No matching Signals.', '一致するシグナルはありません。') : t('This log has no Signals.', 'このログにシグナルはありません。'); host.appendChild(empty); restoreScroll(); return; }
    const nameCounts = new Map<string, number>();
    for (const definition of this.definitions.values()) nameCounts.set(definition.name, (nameCounts.get(definition.name) ?? 0) + 1);
    for (const group of visible) {
      const section = document.createElement('div'); section.className = 'selector-group'; section.dataset.groupId = group.id;
      const header = document.createElement('div'); header.className = 'selector-group-head';
      const expanded = filtering ? !this.searchCollapsed.has(group.id) : this.expanded.has(group.id);
      const toggleExpanded = (focusSelector: string) => {
        const state = filtering ? this.searchCollapsed : this.expanded;
        state.has(group.id) ? state.delete(group.id) : state.add(group.id);
        this.render();
        const updated = Array.from(host.querySelectorAll<HTMLElement>('.selector-group')).find((item) => item.dataset.groupId === group.id);
        updated?.querySelector<HTMLButtonElement>(focusSelector)?.focus({ preventScroll: true });
      };
      const expand = button('', () => toggleExpanded('.selector-expand')); expand.className = 'selector-expand'; expand.title = expanded ? t(`Collapse ${group.label}`, `${group.label}を折りたたむ`) : t(`Expand ${group.label}`, `${group.label}を展開`); iconButton(expand, expanded ? 'chevron-down' : 'chevron-right', expand.title); expand.setAttribute('aria-expanded', String(expanded));
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox';
      const signalIds = group.signalIds;
      const selectedCount = signalIds.filter((id) => selected.has(id)).length; checkbox.checked = signalIds.length > 0 && selectedCount === signalIds.length; checkbox.indeterminate = selectedCount > 0 && selectedCount < signalIds.length;
      checkbox.setAttribute('aria-label', t(`Select Signals in ${group.label}`, `${group.label}内のシグナルを選択`));
      checkbox.addEventListener('change', () => { const next = new Set(selected); const turnOn = signalIds.some((id) => !next.has(id)); for (const id of signalIds) turnOn ? next.add(id) : next.delete(id); this.replaceSelection(next); });
      const label = button(group.label, () => toggleExpanded('.selector-group-name')); label.className = 'selector-group-name'; label.title = group.label; label.setAttribute('aria-expanded', String(expanded)); header.append(expand, checkbox, label);
      header.style.gridTemplateColumns = '28px 20px minmax(0,1fr) auto';
      const count = document.createElement('small'); count.className = 'selector-group-count'; count.textContent = `${selectedCount}/${signalIds.length}`;
      header.append(count);
      section.appendChild(header);
      if (expanded) for (const id of signalIds) {
        const definition = this.definitions.get(id); if (!definition) continue;
        const row = document.createElement('label'); row.className = 'selector-signal'; row.dataset.signalId = id; const child = document.createElement('input'); child.type = 'checkbox'; child.checked = selected.has(id);
        row.addEventListener('mouseenter', () => this.options.onHighlightChange?.(id));
        row.addEventListener('mouseleave', () => this.options.onHighlightChange?.(row.querySelector(':focus-visible') ? id : undefined));
        row.addEventListener('focusin', () => { if (row.querySelector(':focus-visible')) this.options.onHighlightChange?.(id); });
        row.addEventListener('focusout', () => { if (!row.matches(':hover')) this.options.onHighlightChange?.(undefined); });
        child.addEventListener('change', () => { const next = new Set(selected); child.checked ? next.add(id) : next.delete(id); this.replaceSelection(next); });
        const source = this.sources.get(id) ?? group;
        const text = document.createElement('span'); const collision = (nameCounts.get(definition.name) ?? 0) > 1; text.textContent = `${definition.name}${definition.unit ? ` (${definition.unit})` : ''}${collision ? ` · ${source.label}` : ''}`; text.title = `${text.textContent}${!collision && this.grouping === 'unit' ? ` · ${source.label}` : ''}`;
        if (this.measured && !this.measured.has(id)) { row.classList.add('is-unmeasured'); text.title = `${text.title} · ${t('Not in this log', 'このログにはありません')}`; }
        row.append(child, text);
        const colorControl = this.options.colors && this.options.onColorChange;
        const removeControl = source.remove?.type === 'external-csv' && this.options.onRemoveSignal;
        row.style.gridTemplateColumns = `20px minmax(0,1fr)${colorControl ? ' 22px' : ''}${removeControl ? ' 28px' : ''}`;
        if (this.options.colors && this.options.onColorChange) row.appendChild(this.colorButton(id));
        if (removeControl) row.appendChild(this.removeSignalButton(definition, source));
        section.appendChild(row);
      }
      host.appendChild(section);
    }
    restoreScroll();
  }

  /** Shows one Signal's row: clears a search that hides it, expands its group, scrolls to it and focuses its checkbox. */
  reveal(id: string): void {
    if (!this.definitions.has(id)) return;
    if (!this.visibleGroups().some((group) => group.signalIds.includes(id))) { this.search = ''; this.searchCollapsed.clear(); }
    const filtering = Boolean(this.search.trim());
    const group = this.visibleGroups().find((item) => item.signalIds.includes(id)); if (!group) return;
    if (filtering) this.searchCollapsed.delete(group.id); else this.expanded.add(group.id);
    this.render();
    const row = Array.from(this.options.host.querySelectorAll<HTMLElement>('.selector-signal')).find((item) => item.dataset.signalId === id); if (!row) return;
    row.scrollIntoView({ block: 'nearest' });
    row.querySelector<HTMLInputElement>('input[type=checkbox]')?.focus({ preventScroll: true, focusVisible: true } as FocusOptions);
    row.classList.remove('option-revealed'); void row.offsetWidth; row.classList.add('option-revealed');
    this.options.onHighlightChange?.(id);
  }

  /** A Signal is listed when the log has it, when it is already chosen, or when the others were asked for. */
  private listed(id: string): boolean { return !this.measured || this.measured.has(id) || this.options.selected.has(id) || (this.unmeasuredOption && this.showUnmeasured); }

  /** How many Signals the switch would add or is adding. */
  private unmeasuredCount(): number { const measured = this.measured; if (!measured) return 0; let count = 0; for (const id of this.definitions.keys()) if (!measured.has(id) && !this.options.selected.has(id)) count++; return count; }

  private visibleGroups(): readonly SignalGroupDto[] {
    const query = this.search.trim().toLowerCase();
    return (this.grouping === 'unit' ? this.unitGroups : this.groups).map((group) => {
      const listed = group.signalIds.filter((id) => this.listed(id));
      return { ...group, signalIds: !query || group.label.toLowerCase().includes(query) ? listed : listed.filter((id) => this.matches(this.definitions.get(id))) };
    }).filter((group) => group.signalIds.length > 0);
  }

  private matches(definition: SignalDefinition | undefined): boolean {
    if (!definition) return false; const query = this.search.trim().toLowerCase();
    return !query || `${definition.name} ${definition.unit ?? ''} ${this.sources.get(definition.id)?.label ?? ''}`.toLowerCase().includes(query);
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
    control.title = t(`Choose color for ${signalName}`, `${signalName}の色を選択`); control.setAttribute('aria-label', control.title); control.setAttribute('aria-haspopup', 'dialog'); control.setAttribute('aria-expanded', 'false');
    control.addEventListener('click', (event) => {
      event.preventDefault(); event.stopPropagation();
      if (this.closeColorPopup) { this.closeColorPopup(); return; }
      this.openColorPopup(id, current, control);
    });
    return control;
  }

  private removeSignalButton(definition: SignalDefinition, group: SignalGroupDto): HTMLButtonElement {
    const control = document.createElement('button'); control.type = 'button'; control.className = 'remove-source';
    control.title = t(`Remove ${definition.name}`, `${definition.name}を削除`); control.setAttribute('aria-label', control.title);
    iconButton(control, 'trash', control.title);
    control.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); this.options.onRemoveSignal?.(definition, group); });
    return control;
  }

  private openColorPopup(id: string, current: string, control: HTMLButtonElement): void {
    const popup = document.createElement('div'); popup.className = 'color-popup'; popup.setAttribute('role', 'dialog'); popup.setAttribute('aria-label', t('Signal color presets', 'シグナルの色プリセット'));
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
