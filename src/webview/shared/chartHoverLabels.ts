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

/** Centers a compact Timestamp badge on the cursor and stacks it upward when another badge occupies the same space. */
export function layoutTimestampMarker(cursorX: number, width: number, height: number, left: number, right: number, bottom: number, occupied: readonly HoverLabelRect[] = [], top = 0): HoverLabelRect {
  const availableWidth = Math.max(1, right - left - 4); const markerWidth = Math.min(width, availableWidth);
  const base = {
    x: Math.max(left + 2, Math.min(right - markerWidth - 2, cursorX - markerWidth / 2)),
    y: bottom - height - 2,
    width: markerWidth,
    height,
  };
  const step = height + 3; const rows = Math.max(0, Math.floor((base.y - top) / step));
  for (let row = 0; row <= rows; row++) {
    const candidate = { ...base, y: base.y - row * step };
    if (occupied.every((rect) => !rectsOverlap(candidate, rect))) return candidate;
  }
  return base;
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
