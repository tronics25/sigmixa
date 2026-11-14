const originalStyles = new WeakMap<HTMLElement, { backgroundColor: string; boxShadow: string; outline: string; outlineOffset: string; borderRadius: string }>();

/**
 * Emphasize a linked Signal without changing its layout or text contrast. A table heading's frame is an outline drawn
 * just inside it, so what lies on its edges (a pinned column's edge line, a column-edge handle) cannot hide part of it and
 * its own shadow (a pinned column's edge) stays; other elements (Signal list rows, legend entries) keep an inset frame, so
 * their keyboard focus ring (an outline) is never replaced.
 */
/** `heading`: a table's column heading (framed by an inner outline); otherwise an inset frame. */
export function emphasizeSignal(element: HTMLElement, active: boolean, color: string, heading = false): void {
  if (active && !originalStyles.has(element)) {
    originalStyles.set(element, { backgroundColor: element.style.backgroundColor, boxShadow: element.style.boxShadow, outline: element.style.outline, outlineOffset: element.style.outlineOffset, borderRadius: element.style.borderRadius });
  }
  const original = originalStyles.get(element);
  // Tables hide a heading's column-edge line while it is emphasized, so the line does not run over the frame.
  element.classList.toggle('signal-emphasized', active);
  if (!active) {
    if (original) { Object.assign(element.style, original); originalStyles.delete(element); }
    return;
  }
  const frame = `color-mix(in srgb, ${color} 45%, transparent)`;
  element.style.backgroundColor = `color-mix(in srgb, ${color} 12%, var(--vscode-editor-background))`;
  if (heading) { element.style.outline = `1px solid ${frame}`; element.style.outlineOffset = '-2px'; }
  else element.style.boxShadow = `inset 0 0 0 1px ${frame}`;
  element.style.borderRadius = 'var(--sm-radius-md)';
}
