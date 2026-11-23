import type { ChartContext } from './svgCanvas';
export interface HoverLabelInput {
  readonly y: number;
}

export type PositionedHoverLabel<T extends HoverLabelInput> = T & { readonly labelY: number };

export interface HoverLabelRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface HoverLabelBoxInput extends HoverLabelInput {
  readonly cursorX: number;
  readonly width: number;
  readonly height: number;
}

export type PositionedHoverLabelBox<T extends HoverLabelBoxInput> = T & {
  readonly labelY: number;
  readonly boxX: number;
  readonly boxY: number;
  readonly placeLeft: boolean;
  readonly rect: HoverLabelRect;
};

/** Places compact hover labels without obscuring one another while retaining their exact intersection Y. */
export function layoutHoverLabels<T extends HoverLabelInput>(items: readonly T[], top: number, bottom: number, gap = 18): readonly PositionedHoverLabel<T>[] {
  if (!items.length || bottom < top) return [];
  const sorted = items.filter((item) => Number.isFinite(item.y)).map((item) => ({ ...item, labelY: Math.max(top, Math.min(bottom, item.y)) })).sort((left, right) => left.labelY - right.labelY);
  for (let index = 1; index < sorted.length; index++) sorted[index].labelY = Math.max(sorted[index].labelY, sorted[index - 1].labelY + gap);
  if (sorted.length && sorted[sorted.length - 1].labelY > bottom) {
    sorted[sorted.length - 1].labelY = bottom;
    for (let index = sorted.length - 2; index >= 0; index--) sorted[index].labelY = Math.min(sorted[index].labelY, sorted[index + 1].labelY - gap);
    if (sorted[0].labelY < top) {
      const availableGap = sorted.length > 1 ? (bottom - top) / (sorted.length - 1) : 0;
      sorted.forEach((item, index) => { item.labelY = top + availableGap * index; });
    }
  }
  return sorted;
}

/** Places one marker's labels around already occupied labels, trying both sides before moving vertically. */
export function layoutHoverLabelBoxes<T extends HoverLabelBoxInput>(
  items: readonly T[],
  bounds: { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number },
  occupied: readonly HoverLabelRect[] = [],
  gap = 18
): readonly PositionedHoverLabelBox<T>[] {
  if (!items.length || bounds.right <= bounds.left || bounds.bottom <= bounds.top) return [];
  const halfHeight = Math.max(...items.map((item) => item.height / 2));
  const verticallyArranged = layoutHoverLabels(items, bounds.top + halfHeight, bounds.bottom - halfHeight, gap);
  const blocked = [...occupied]; const result: PositionedHoverLabelBox<T>[] = [];
  for (const item of verticallyArranged) {
    const preferredLeft = item.cursorX > (bounds.left + bounds.right) / 2;
    const centers = verticalCandidates(item.labelY, bounds.top + item.height / 2, bounds.bottom - item.height / 2, gap);
    const candidates = centers.flatMap((labelY) => [preferredLeft, !preferredLeft].map((placeLeft) => {
      const desiredX = placeLeft ? item.cursorX - item.width - 8 : item.cursorX + 8;
      const boxX = Math.max(bounds.left + 2, Math.min(bounds.right - item.width - 2, desiredX));
      const rect = { x: boxX, y: labelY - item.height / 2, width: item.width, height: item.height };
      return { labelY, boxX, boxY: rect.y, placeLeft, rect };
    }));
    const selected = candidates.find((candidate) => blocked.every((rect) => !rectsOverlap(candidate.rect, rect)))
      ?? candidates.reduce((best, candidate) => overlapArea(candidate.rect, blocked) < overlapArea(best.rect, blocked) ? candidate : best);
    const positioned = { ...item, ...selected }; result.push(positioned); blocked.push(selected.rect);
  }
  return result;
}

/**
 * Keep Timestamp badges in the existing time-axis gutter, never over plotted data. A badge takes the first row where it
 * is free. With `maxRows`, it stays within that many rows: when they are all taken at its time, it moves sideways on a row
 * to the nearest free place (its connector still points at its time), so the gutter, and the graph's height, stay as they are.
 */
export function layoutTimestampMarker(cursorX: number, width: number, height: number, left: number, right: number, bottom: number, occupied: readonly HoverLabelRect[] = [], _top = 0, maxRows = Number.POSITIVE_INFINITY): HoverLabelRect {
  const availableWidth = Math.max(1, right - left - 4); const markerWidth = Math.min(width, availableWidth);
  const minX = left + 2; const maxX = Math.max(minX, right - markerWidth - 2);
  const base = {
    x: Math.max(minX, Math.min(maxX, cursorX - markerWidth / 2)),
    y: bottom + 5,
    width: markerWidth,
    height,
  };
  const rows = Math.max(1, Math.min(occupied.length + 1, maxRows));
  for (let row = 0; row < rows; row++) {
    const candidate = { ...base, y: base.y + row * (height + 3) };
    if (occupied.every((rect) => !rectsOverlap(candidate, rect))) return candidate;
  }
  if (!Number.isFinite(maxRows)) return base;
  let best: HoverLabelRect | undefined; let bestDistance = Number.POSITIVE_INFINITY;
  for (let row = 0; row < rows; row++) {
    const y = base.y + row * (height + 3);
    for (const rect of occupied) for (const x of [rect.x + rect.width + 4, rect.x - markerWidth - 4]) {
      if (x < minX || x > maxX) continue; const candidate = { ...base, x, y }; const distance = Math.abs(x - base.x);
      if (distance < bestDistance && occupied.every((other) => !rectsOverlap(candidate, other))) { best = candidate; bestDistance = distance; }
    }
  }
  return best ?? base;
}

/** How many rows of Timestamp badges a gutter of `gutter` pixels holds, the row on the axis labels included. */
export function timestampGutterRows(gutter: number): number { return Math.floor(Math.max(0, gutter) / 21) + 1; }

export function timestampGutter(context: ChartContext, labels: readonly { x: number; text: string }[], left: number, right: number): number {
  const occupied: HoverLabelRect[] = [];
  for (const label of labels) occupied.push(layoutTimestampMarker(label.x, context.measureText(label.text).width + 12, 18, left, right, 0, occupied));
  return Math.max(0, ...occupied.map((rect) => rect.y + rect.height + 5 - 28));
}

export function paintTimestampConnector(context: ChartContext, cursorX: number, bottom: number, rect: HoverLabelRect): void {
  context.save(); context.lineWidth = 1; context.beginPath(); context.moveTo(cursorX, bottom);
  context.lineTo(cursorX, rect.y - 2); context.lineTo(Math.max(rect.x, Math.min(rect.x + rect.width, cursorX)), rect.y);
  context.stroke(); context.restore();
}

function verticalCandidates(preferred: number, top: number, bottom: number, gap: number): readonly number[] {
  if (bottom < top) return [(top + bottom) / 2];
  const result: number[] = []; const seen = new Set<number>(); const steps = Math.ceil((bottom - top) / Math.max(1, gap)) + 1;
  for (let step = 0; step <= steps; step++) for (const direction of step === 0 ? [0] : [1, -1]) {
    const value = Math.max(top, Math.min(bottom, preferred + direction * step * gap)); const key = Math.round(value * 1000);
    if (!seen.has(key)) { seen.add(key); result.push(value); }
  }
  return result;
}

function rectsOverlap(left: HoverLabelRect, right: HoverLabelRect): boolean {
  return left.x < right.x + right.width + 3 && left.x + left.width + 3 > right.x && left.y < right.y + right.height + 3 && left.y + left.height + 3 > right.y;
}

function overlapArea(candidate: HoverLabelRect, occupied: readonly HoverLabelRect[]): number {
  return occupied.reduce((sum, item) => sum + Math.max(0, Math.min(candidate.x + candidate.width, item.x + item.width) - Math.max(candidate.x, item.x)) * Math.max(0, Math.min(candidate.y + candidate.height, item.y + item.height) - Math.max(candidate.y, item.y)), 0);
}

/** One value box: the Signal's value at a marker or at the hover position. `emphasized` follows the legend's hover emphasis. */
export interface ValueBox { readonly y: number; readonly sampleX: number; readonly sampleY: number; readonly text: string; readonly color: string; readonly lineDash?: number[]; readonly emphasized?: boolean }

/**
 * Draws value boxes next to `cursorX` without overlapping `occupied`, and adds their areas to it. An emphasized box has
 * bolder text and a thicker border, and its width is measured in that font so the text is never cut off.
 */
export function paintValueBoxes(context: ChartContext, cursorX: number, values: readonly ValueBox[], bounds: { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number }, occupied: HoverLabelRect[], fonts: { readonly family: string; readonly background: string }): void {
  const font = (emphasized?: boolean) => `${emphasized ? 800 : 600} 11px ${fonts.family}`;
  context.save(); context.textBaseline = 'middle';
  const measured = values.map((value) => { context.font = font(value.emphasized); return { ...value, cursorX, width: context.measureText(value.text).width + 10, height: 16 }; });
  const positioned = layoutHoverLabelBoxes(measured, bounds, occupied);
  for (const value of positioned) {
    context.setLineDash(value.lineDash ?? []); context.strokeStyle = value.color; context.lineWidth = 1; context.globalAlpha = .7; context.beginPath();
    if (value.sampleX >= bounds.left && value.sampleX <= bounds.right && value.sampleY >= bounds.top && value.sampleY <= bounds.bottom) { context.arc(value.sampleX, value.sampleY, 3, 0, Math.PI * 2); context.fillStyle = value.color; context.fill(); context.moveTo(value.sampleX, value.sampleY); context.lineTo(value.placeLeft ? value.boxX + value.width : value.boxX, value.labelY); context.stroke(); }
    context.setLineDash([]); context.globalAlpha = .92; context.fillStyle = fonts.background; context.fillRect(value.boxX, value.boxY, value.width, value.height);
    context.globalAlpha = 1; context.strokeStyle = value.color; context.lineWidth = value.emphasized ? 2 : 1;
    const inset = value.emphasized ? 1 : 0; context.strokeRect(value.boxX + inset, value.boxY + inset, value.width - inset * 2, value.height - inset * 2);
    context.font = font(value.emphasized); context.fillStyle = value.color; context.fillText(value.text, value.boxX + 5, value.labelY);
  }
  occupied.push(...positioned.map((value) => value.rect));
  context.restore();
}
