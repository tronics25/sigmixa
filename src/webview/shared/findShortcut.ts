/**
 * ⌘F / Ctrl+F moves to the search box on screen (the first visible one), as Find does in other apps. Pages without a search box
 * use VS Code's own find bar instead (`enableFindWidget`), so this is only bound on pages that have their own search.
 */
export function bindFindShortcut(root: ParentNode = document): void {
  window.addEventListener('keydown', (event) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'f') return;
    const box = Array.from(root.querySelectorAll<HTMLInputElement>('input[type="search"]')).find((input) => !input.disabled && input.getClientRects().length > 0);
    if (!box) return;
    event.preventDefault(); box.focus(); box.select();
  });
}
