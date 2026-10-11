import { t } from './i18n';
/** Matches the original RAW / Decoded control: adjacent buttons, no outer capsule. */
export const CHOICE_GROUP_STYLES = `
.choice-source[hidden]{display:none!important}
.choice-group{display:inline-flex;align-items:stretch;gap:0;padding:0;border:0;background:transparent}
.choice-group>button{font:inherit;color:inherit;margin:0;padding:var(--sm-space-xs) var(--sm-space-md);border:1px solid var(--vscode-input-border,transparent);border-radius:0;background:var(--vscode-button-secondaryBackground);white-space:nowrap;cursor:pointer}
.choice-group>button:first-child{border-radius:var(--sm-radius-legacy-3) 0 0 var(--sm-radius-legacy-3)}.choice-group>button:last-child{border-radius:0 var(--sm-radius-legacy-3) var(--sm-radius-legacy-3) 0}
.choice-group>button:hover:not(:disabled){background:var(--vscode-button-secondaryHoverBackground)}
.choice-group>button[aria-pressed=true],.choice-group>button.active,.choice-group>button.primary{color:var(--vscode-inputOption-activeForeground);background:var(--vscode-inputOption-activeBackground);border-color:var(--vscode-inputOption-activeBorder,var(--vscode-focusBorder));font-weight:inherit}
.choice-group>button:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:1px;position:relative;z-index:1}
.choice-group>button:disabled{opacity:.55;cursor:default}
.choice-field{display:flex;flex-direction:column;align-items:flex-start;gap:var(--sm-space-xs);font-size:var(--sm-font-small);min-width:0}
.choice-field.chart-axis-mode{flex-direction:row;align-items:center}
.choice-field>.choice-group{max-width:100%;flex-wrap:wrap}
.selector-controls .choice-group{font-size:var(--sm-font-small);flex-shrink:0}.selector-controls{flex-wrap:wrap}
.cell .choice-group,.data-table td .choice-group{font:var(--sm-font-small) var(--vscode-font-family)}
.cell .choice-group>button,.data-table td .choice-group>button{padding:var(--sm-space-xs) var(--sm-space-xs);min-height:26px}
`;

const choices = new WeakMap<HTMLSelectElement, { sync: () => void; group: HTMLElement }>();

/** Keep the existing value/change contract and expose fixed, small enums as buttons. */
export function enhanceChoiceSelect(select: HTMLSelectElement, label?: string): void {
  if (choices.has(select) || select.options.length < 2 || select.options.length > 3) return;
  if (!document.getElementById('choice-group-style')) {
    const style = document.createElement('style'); style.id = 'choice-group-style'; style.textContent = CHOICE_GROUP_STYLES; document.head.append(style);
  }
  const group = document.createElement('div'); group.className = 'choice-group'; group.setAttribute('role', 'group');
  group.setAttribute('aria-label', label || select.getAttribute('aria-label') || select.title || t('Choose', '選択'));
  const options = Array.from(select.options);
  const buttons = options.map((option) => {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = option.textContent; button.title = option.title || option.textContent || '';
    button.dataset.choiceValue = option.value; if (select.dataset.controlKey) button.dataset.controlKey = `${select.dataset.controlKey}:choice:${option.value}`;
    button.addEventListener('click', () => {
      if (select.value === option.value || select.disabled || option.disabled) return;
      select.value = option.value; sync(); select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    group.append(button); return button;
  });
  const sync = () => buttons.forEach((button, index) => {
    const active = options[index].value === select.value; button.setAttribute('aria-pressed', String(active)); button.tabIndex = active || (select.selectedIndex < 0 && index === options.findIndex((option) => !option.disabled)) ? 0 : -1;
    button.disabled = select.disabled || options[index].disabled;
  });
  group.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const enabled = buttons.filter((button) => !button.disabled); if (!enabled.length) return;
    const index = enabled.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1 : (index + (event.key === 'ArrowLeft' ? -1 : 1) + enabled.length) % enabled.length;
    event.preventDefault(); enabled[next].focus(); enabled[next].click();
  });
  if (select.parentElement instanceof HTMLLabelElement) {
    const parent = select.parentElement; const field = document.createElement('div'); for (const attribute of Array.from(parent.attributes)) if (attribute.name !== 'for') field.setAttribute(attribute.name, attribute.value); field.classList.add('choice-field');
    parent.replaceWith(field); field.append(...Array.from(parent.childNodes));
  }
  select.hidden = true; select.classList.add('choice-source'); select.after(group); select.addEventListener('change', sync);
  choices.set(select, { sync, group }); sync();
}

export function syncChoiceSelect(select: HTMLSelectElement): void { choices.get(select)?.sync(); }
export function focusChoiceSelect(select: HTMLSelectElement): void { choices.get(select)?.group.querySelector<HTMLButtonElement>('[aria-pressed=true]')?.focus({ preventScroll: true }); }
