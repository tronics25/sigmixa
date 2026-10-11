/**
 * Icons VS Code's icon font does not have, drawn on its 16 px grid with its line weight so they sit beside the font's icons.
 * `export` is the widely used "out of the tray" mark; the font's own export icon (a bar and an arrow) is not well known.
 */
const OWN_ICONS: Readonly<Record<string, string>> = {
  export: '<path d="M2.5 9.5v4h11v-4"/><path d="M8 10.5v-8"/><path d="M5 5.5l3-3 3 3"/>',
};

/** Turns a span into the icon named `icon`: one of SigMixa's own drawings, or else the icon font's. */
export function setGlyph(glyph: HTMLElement, icon: string, extraClass = ''): void {
  const own = OWN_ICONS[icon]; const className = `${extraClass ? `${extraClass} ` : ''}codicon ${own ? 'sm-glyph' : `codicon-${icon}`}`;
  if (glyph.className === className && glyph.dataset.icon === icon) return;
  glyph.className = className; glyph.dataset.icon = icon;
  glyph.innerHTML = own ? `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" style="display:block">${own}</svg>` : '';
}

/** The name of the icon a glyph shows, as given to `setGlyph`. */
export function glyphName(glyph: Element | null | undefined): string | undefined {
  return (glyph as HTMLElement | null | undefined)?.dataset.icon ?? Array.from(glyph?.classList ?? []).find((name) => name.startsWith('codicon-'))?.slice(8);
}
