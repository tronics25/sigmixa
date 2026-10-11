let measure: CanvasRenderingContext2D | undefined;

/** Sizes the title to its text, so the legend follows it directly. */
export function fitCardTitle(title: HTMLInputElement): void {
  const context = measure ??= document.createElement('canvas').getContext('2d')!; const style = getComputedStyle(title);
  context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  title.style.setProperty('--title-width', `${Math.ceil(context.measureText(title.value || ' ').width) + 16}px`);
}

/** Empties a legend row but leaves the card's title in it, so a title being edited keeps its focus and caret. */
export function clearLegend(legend: HTMLElement, title: HTMLElement): void { for (const child of Array.from(legend.children)) if (child !== title) child.remove(); }

/**
 * As in Visualize: with a legend, the title starts the legend row and the header holds only the actions, shown on the card's
 * top edge while it is hovered or focused. Without a legend the title stays in the header.
 */
export function placeCardTitle(card: HTMLElement, header: HTMLElement, legend: HTMLElement, title: HTMLInputElement, inline: boolean): void {
  card.classList.toggle('title-inline', inline);
  if (inline) { if (legend.firstElementChild !== title) legend.prepend(title); } else if (title.parentElement !== header) header.prepend(title);
  fitCardTitle(title);
}
