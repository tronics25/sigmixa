import { t } from './i18n';

/**
 * The app's one up/down control for numbers: a single button width split into an upper and a lower chevron.
 * It replaces the browser's own spin buttons, which do not follow the theme. Styles are in COMPONENT_STYLES.
 */
export function stepperButtons(up: () => void, down: () => void, labels?: { readonly up: string; readonly down: string }): HTMLSpanElement {
  const group = document.createElement('span'); group.className = 'stepper-buttons';
  for (const [icon, action, label] of [['chevron-up', up, labels?.up ?? t('Increase', '増やす')], ['chevron-down', down, labels?.down ?? t('Decrease', '減らす')]] as const) {
    const button = document.createElement('button'); button.type = 'button'; button.tabIndex = -1; button.title = label; button.setAttribute('aria-label', label);
    const glyph = document.createElement('span'); glyph.className = `codicon codicon-${icon}`; glyph.setAttribute('aria-hidden', 'true'); button.append(glyph);
    button.addEventListener('click', action); group.append(button);
  }
  return group;
}

/** Puts the shared stepper inside a number input's right edge; stepping fires the same events as typing. */
export function attachNumberStepper(input: HTMLInputElement): HTMLSpanElement {
  const wrap = document.createElement('span'); wrap.className = 'number-stepper'; input.replaceWith(wrap);
  const step = (direction: 1 | -1) => {
    // Computed here because stepUp()/stepDown() throw when step="any".
    const size = Number(input.step) > 0 ? Number(input.step) : 1; const current = Number(input.value);
    let next = input.value === '' || !Number.isFinite(current) ? Number(input.min) || 0 : Number((current + direction * size).toPrecision(12));
    if (input.min !== '' && next < Number(input.min)) next = Number(input.min);
    if (input.max !== '' && next > Number(input.max)) next = Number(input.max);
    input.value = String(next);
    input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  wrap.append(input, stepperButtons(() => step(1), () => step(-1)));
  return wrap;
}
