/** Converts a secondary action to a compact VS Code-style icon button without losing its accessible name. */
export function iconButton(button: HTMLButtonElement, icon: string, label: string): HTMLButtonElement {
  const glyph = document.createElement('span'); glyph.className = `codicon codicon-${icon}`; glyph.setAttribute('aria-hidden', 'true');
  button.replaceChildren(glyph); button.classList.add('icon-button'); button.title = label; button.setAttribute('aria-label', label);
  return button;
}

export function secondaryToolbar(...buttons: HTMLButtonElement[]): HTMLSpanElement {
  const group = document.createElement('span'); group.className = 'toolbar-secondary'; group.setAttribute('role', 'group'); buttons.forEach((button) => group.appendChild(button)); return group;
}
