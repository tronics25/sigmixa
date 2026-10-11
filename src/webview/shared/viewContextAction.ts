import { glyphName } from './glyph';
export interface ViewContextAction {
  readonly label: string;
  readonly icon: string;
  readonly enabled?: boolean;
  readonly checked?: boolean;
  readonly run: () => void;
}

/** Reuse the toolbar action and its current availability, including async changes. */
export function buttonContextAction(button: HTMLButtonElement, label?: string): ViewContextAction {
  return {
    label: label ?? button.getAttribute('aria-label') ?? button.title ?? button.textContent ?? '',
    icon: glyphName(button.querySelector('.codicon')) ?? 'circle-small',
    enabled: !button.disabled,
    ...(button.hasAttribute('aria-pressed') ? { checked: button.getAttribute('aria-pressed') === 'true' } : {}),
    run: () => { if (!button.disabled) button.click(); },
  };
}
