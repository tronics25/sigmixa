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
  private readonly expandedByMode = { frame: new Set<string>(), unit: new Set<string>() };
  private get expanded(): Set<string> { return this.expandedByMode[this.grouping]; }
  get groupingMode(): SignalGrouping { return this.grouping; }
  private closeColorPopup: (() => void) | undefined;

  constructor(private readonly options: SignalSelectorOptions) {
    this.grouping = options.grouping === 'unit' ? 'unit' : 'frame';
    if (!document.getElementById('signal-grouping-style')) {
      const style = document.createElement('style'); style.id = 'signal-grouping-style';
      style.textContent = '.selector-grouping{display:flex;margin-bottom:7px}.selector-grouping button{flex:1;border-radius:0;padding:4px 7px}.selector-grouping button:first-child{border-radius:3px 0 0 3px}.selector-grouping button:last-child{border-radius:0 3px 3px 0}.selector-grouping button[aria-pressed=true]{background:var(--vscode-inputOption-activeBackground,var(--vscode-button-background));color:var(--vscode-inputOption-activeForeground,var(--vscode-button-foreground));border-color:var(--vscode-inputOption-activeBorder,var(--vscode-focusBorder))}.selector-group-count{font-size:10px;font-weight:400;color:var(--vscode-descriptionForeground);padding-left:5px}';
      document.head.append(style);
    }
  }

  setCatalog(definitions: readonly SignalDefinition[], groups: readonly SignalGroupDto[]): void {
    const previous = { frame: this.groups, unit: this.unitGroups };
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
      const priorIds = new Set(previous[mode].map((group) => group.id));
      const nextIds = new Set(next.map((group) => group.id));
      const expanded = this.expandedByMode[mode];
      for (const id of [...expanded]) if (!nextIds.has(id)) expanded.delete(id);
      for (const group of next) if (!priorIds.has(group.id)) expanded.add(group.id);
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
    const grouping = document.createElement('div'); grouping.className = 'selector-grouping'; grouping.setAttribute('role', 'group'); grouping.setAttribute('aria-label', t('Group Signals by', 'Signalの分類'));
    for (const [mode, caption] of [['frame', 'Frame'], ['unit', t('Unit system', '単位系')]] as const) {
      const toggle = button(caption, () => {
        this.options.onHighlightChange?.(undefined);
        this.grouping = mode; this.render(); this.options.onGroupingChange?.(mode);
        host.querySelector<HTMLButtonElement>(`.selector-grouping button[data-grouping="${mode}"]`)?.focus({ preventScroll: true });
      });
      toggle.dataset.grouping = mode; toggle.setAttribute('aria-pressed', String(this.grouping === mode)); grouping.append(toggle);
    }
    host.append(grouping);
    const search = document.createElement('input'); search.type = 'search'; search.placeholder = t('Search Signals…', 'Signalを検索…'); search.value = this.search; search.setAttribute('aria-label', t('Search Signals', 'Signalを検索'));
    search.addEventListener('input', () => { this.search = search.value; this.render(); requestAnimationFrame(() => { const next = host.querySelector<HTMLInputElement>('input[type=search]'); next?.focus(); next?.setSelectionRange(this.search.length, this.search.length); }); });
    const actions = document.createElement('div'); actions.className = 'selector-actions';
    const filtering = Boolean(this.search.trim());
    const selectAll = button(filtering ? t('Select results', '検索結果を選択') : t('Select all', 'すべて選択'), () => this.toggleAll(true));
    const clear = button(filtering ? t('Clear results', '検索結果を解除') : t('Clear all', 'すべて解除'), () => this.toggleAll(false)); actions.append(selectAll, clear); host.append(search, actions);
    const visible = this.visibleGroups();
    if (!visible.length) { const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = t('No matching Signals.', '一致するSignalはありません。'); host.appendChild(empty); restoreScroll(); return; }
    const nameCounts = new Map<string, number>();
    for (const definition of this.definitions.values()) nameCounts.set(definition.name, (nameCounts.get(definition.name) ?? 0) + 1);
    for (const group of visible) {
      const section = document.createElement('div'); section.className = 'selector-group';
      const header = document.createElement('div'); header.className = 'selector-group-head';
      const expanded = this.expanded.has(group.id); const expand = button(expanded ? '▾' : '▸', () => { this.expanded.has(group.id) ? this.expanded.delete(group.id) : this.expanded.add(group.id); this.render(); }); expand.className = 'selector-expand'; expand.title = expanded ? t(`Collapse ${group.label}`, `${group.label}を折りたたむ`) : t(`Expand ${group.label}`, `${group.label}を展開`); expand.setAttribute('aria-label', expand.title); expand.setAttribute('aria-expanded', String(expanded));
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox';
      const signalIds = group.signalIds;
      const selectedCount = signalIds.filter((id) => selected.has(id)).length; checkbox.checked = signalIds.length > 0 && selectedCount === signalIds.length; checkbox.indeterminate = selectedCount > 0 && selectedCount < signalIds.length;
      checkbox.setAttribute('aria-label', t(`Select Signals in ${group.label}`, `${group.label}内のSignalを選択`));
      checkbox.addEventListener('change', () => { const next = new Set(selected); const turnOn = signalIds.some((id) => !next.has(id)); for (const id of signalIds) turnOn ? next.add(id) : next.delete(id); this.replaceSelection(next); });
      const label = document.createElement('span'); label.textContent = group.label; label.title = group.label; header.append(expand, checkbox, label);
      header.style.gridTemplateColumns = '24px 20px minmax(0,1fr) auto';
      const count = document.createElement('small'); count.className = 'selector-group-count'; count.textContent = `${selectedCount}/${signalIds.length}`;
      count.title = t(`${selectedCount} of ${signalIds.length} selected`, `${signalIds.length}件中${selectedCount}件を選択`); header.append(count);
      section.appendChild(header);
      if (this.expanded.has(group.id)) for (const id of signalIds) {
        const definition = this.definitions.get(id); if (!definition) continue;
        const row = document.createElement('label'); row.className = 'selector-signal'; row.dataset.signalId = id; const child = document.createElement('input'); child.type = 'checkbox'; child.checked = selected.has(id);
        row.addEventListener('mouseenter', () => this.options.onHighlightChange?.(id));
        row.addEventListener('mouseleave', () => this.options.onHighlightChange?.(row.querySelector(':focus-visible') ? id : undefined));
        row.addEventListener('focusin', () => { if (row.querySelector(':focus-visible')) this.options.onHighlightChange?.(id); });
        row.addEventListener('focusout', () => { if (!row.matches(':hover')) this.options.onHighlightChange?.(undefined); });
        child.addEventListener('change', () => { const next = new Set(selected); child.checked ? next.add(id) : next.delete(id); this.replaceSelection(next); });
        const source = this.sources.get(id) ?? group;
        const text = document.createElement('span'); const collision = (nameCounts.get(definition.name) ?? 0) > 1; text.textContent = `${definition.name}${definition.unit ? ` (${definition.unit})` : ''}${collision ? ` · ${source.label}` : ''}`; text.title = `${text.textContent}${!collision && this.grouping === 'unit' ? ` · ${source.label}` : ''}`;
        row.append(child, text);
        const colorControl = this.options.colors && this.options.onColorChange;
        const removeControl = source.remove?.type === 'external-csv' && this.options.onRemoveSignal;
        row.style.gridTemplateColumns = `20px minmax(0,1fr)${colorControl ? ' 22px' : ''}${removeControl ? ' 22px' : ''}`;
        if (this.options.colors && this.options.onColorChange) row.appendChild(this.colorButton(id));
        if (removeControl) row.appendChild(this.removeSignalButton(definition, source));
        section.appendChild(row);
      }
      host.appendChild(section);
    }
    restoreScroll();
  }

  private visibleGroups(): readonly SignalGroupDto[] {
    const query = this.search.trim().toLowerCase();
    return (this.grouping === 'unit' ? this.unitGroups : this.groups).map((group) => ({
      ...group,
      signalIds: !query || group.label.toLowerCase().includes(query) ? group.signalIds : group.signalIds.filter((id) => this.matches(this.definitions.get(id))),
    })).filter((group) => group.signalIds.length > 0);
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
    const icon = document.createElement('i'); icon.className = 'codicon codicon-trash'; icon.setAttribute('aria-hidden', 'true'); control.appendChild(icon);
    control.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); this.options.onRemoveSignal?.(definition, group); });
    return control;
  }

  private openColorPopup(id: string, current: string, control: HTMLButtonElement): void {
    const popup = document.createElement('div'); popup.className = 'color-popup'; popup.setAttribute('role', 'dialog'); popup.setAttribute('aria-label', t('Signal color presets', 'Signalの色プリセット'));
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
