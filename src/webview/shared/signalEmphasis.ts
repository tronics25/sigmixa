const originalStyles = new WeakMap<HTMLElement, { backgroundColor: string; boxShadow: string; borderRadius: string }>();

/** Emphasize a linked Signal without changing its layout or text contrast. */
export function emphasizeSignal(element: HTMLElement, active: boolean, color: string): void {
  if (active && !originalStyles.has(element)) {
    originalStyles.set(element, { backgroundColor: element.style.backgroundColor, boxShadow: element.style.boxShadow, borderRadius: element.style.borderRadius });
  }
  const original = originalStyles.get(element);
  if (!active) {
    if (original) { Object.assign(element.style, original); originalStyles.delete(element); }
    return;
  }
  element.style.backgroundColor = `color-mix(in srgb, ${color} 12%, var(--vscode-editor-background))`;
  element.style.boxShadow = `inset 0 0 0 1px color-mix(in srgb, ${color} 45%, transparent)`;
  element.style.borderRadius = '4px';
}
