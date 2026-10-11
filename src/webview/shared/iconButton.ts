import { setGlyph } from './glyph';
/** Converts a secondary action to a compact VS Code-style icon button without losing its accessible name. */
export function iconButton(button: HTMLButtonElement, icon: string, label: string): HTMLButtonElement {
  // Preserve the pointer target during live updates, including between pointerdown and pointerup.
  let glyph = button.firstElementChild as HTMLElement | null;
  if (button.childNodes.length !== 1 || !glyph?.classList.contains('codicon')) {
    glyph = document.createElement('span'); glyph.setAttribute('aria-hidden', 'true'); button.replaceChildren(glyph);
  }
  setGlyph(glyph, icon);
  button.classList.add('icon-button'); button.title = label; button.setAttribute('aria-label', label);
  return button;
}

/** An icon with its name beside it, for the few actions of a top bar where there is room to say what they do. */
export function labeledIconButton(button: HTMLButtonElement, icon: string, text: string, tooltip = text): HTMLButtonElement {
  const glyph = document.createElement('span'); setGlyph(glyph, icon); glyph.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span'); label.className = 'icon-text-label'; label.textContent = text;
  button.replaceChildren(glyph, label); button.classList.add('icon-text-button'); button.setAttribute('aria-label', tooltip);
  return button;
}
/** What a view tells the card that holds it: whether its legend row shows the card's title, and whether it has nothing to draw. */
export interface ViewCardState { readonly inlineTitle: boolean; readonly noData: boolean }

export function secondaryToolbar(...buttons: HTMLButtonElement[]): HTMLSpanElement {
  const group = document.createElement('span'); group.className = 'toolbar-secondary'; group.setAttribute('role', 'group'); buttons.forEach((button) => group.appendChild(button)); return group;
}
/** Groups view-header actions by purpose; CSS supplies separators between visible groups. */
export function viewActionGroup(label: string, ...controls: HTMLElement[]): HTMLDivElement {
  const group = document.createElement('div'); group.className = 'view-action-group';
  group.setAttribute('role', 'group'); group.setAttribute('aria-label', label); group.append(...controls); return group;
}

/** Shared across every webview: 28 px target, 16 px glyph, no resting frame. */
export const ICON_BUTTON_STYLES = `
button.icon-button{box-sizing:border-box;display:inline-flex;flex:0 0 28px;width:28px;height:28px;min-width:28px;min-height:28px;max-width:28px;padding:0;margin:0;align-items:center;justify-content:center;vertical-align:middle;border:0;border-radius:var(--sm-radius-legacy-3);box-shadow:none;background:transparent;color:var(--vscode-icon-foreground,var(--vscode-foreground));cursor:pointer;line-height:1}
button.icon-button .codicon{font-size:var(--sm-font-heading);line-height:16px;width:16px;height:16px}
button.icon-button:hover:not(:disabled){background:var(--vscode-toolbar-hoverBackground,var(--vscode-list-hoverBackground))}
button.icon-button.primary,button.icon-button[aria-pressed=true]{color:var(--vscode-focusBorder);background:color-mix(in srgb,var(--vscode-focusBorder) 13%,transparent)}
button.icon-button.danger{color:var(--vscode-errorForeground)}
button.icon-button:disabled{opacity:.34;cursor:default}
button.icon-button:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}
button.icon-button[hidden]{display:none}
button.icon-text-button{box-sizing:border-box;display:inline-flex;flex:0 0 auto;align-items:center;gap:var(--sm-space-xs);height:26px;padding:0 var(--sm-space-md);margin:0;border:0;border-radius:var(--sm-radius-legacy-3);box-shadow:none;background:transparent;color:var(--vscode-foreground);font-size:var(--sm-font-small);white-space:nowrap;cursor:pointer}
button.icon-text-button .codicon{font-size:var(--sm-font-heading);line-height:16px;width:16px;height:16px}
button.icon-text-button:hover:not(:disabled){background:var(--vscode-toolbar-hoverBackground,var(--vscode-list-hoverBackground))}
button.icon-text-button:disabled{opacity:.34;cursor:default}
button.icon-text-button:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}
button.icon-text-button[hidden]{display:none}
`;
