/** Text controls keep their own Escape behavior; graph shortcuts must not discard their edits. */
export function isTextEditing(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]'));
}
