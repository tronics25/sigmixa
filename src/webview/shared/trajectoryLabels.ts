/** The space a label takes on a trajectory plot. */
export interface LabelBox { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

const overlaps = (a: LabelBox, b: LabelBox): boolean => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

/**
 * Axis titles stay where they are unless two meet: a later one then moves up or down to the nearest free place. Titles
 * held at the plot's edge can meet when the axes run far past it. A free place, if any, has an edge at a title or at the plot's end.
 */
export function separateTitles<T extends LabelBox>(titles: readonly T[], top: number, bottom: number): T[] {
  const placed: T[] = [];
  for (const title of titles) {
    const places = [title.y, top, bottom - title.height, ...placed.flatMap((other) => [other.y + other.height + 2, other.y - title.height - 2])].sort((a, b) => Math.abs(a - title.y) - Math.abs(b - title.y));
    const place = places.map((y) => ({ ...title, y })).find((item) => item.y >= top && item.y + item.height <= bottom && !placed.some((other) => overlaps(item, other)));
    placed.push(place ?? title);
  }
  return placed;
}

/**
 * Whether a tick value, written left-aligned on its baseline at (x, y) in the context's current font, stays off what is
 * already on the plot. If so it is added to `occupied`. An axis ends at its last tick, so it meets the title; ticks meet
 * each other where axes start together or an axis is seen end-on. What is already there stays: first the titles, which
 * say what an axis is.
 */
export function placeTickLabel(context: Pick<CanvasRenderingContext2D, 'measureText'>, text: string, x: number, y: number, occupied: LabelBox[]): boolean {
  const box = { x, y: y - 11, width: context.measureText(text).width, height: 14 };
  if (occupied.some((item) => overlaps(box, item))) return false;
  occupied.push(box); return true;
}
