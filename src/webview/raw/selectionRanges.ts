export interface SelectionRange { readonly start: number; readonly end: number; }

export function normalizeSelectionRanges(ranges: readonly SelectionRange[]): SelectionRange[] {
  const sorted = ranges
    .map((range) => ({ start: Math.max(0, Math.floor(Math.min(range.start, range.end))), end: Math.max(0, Math.floor(Math.max(range.start, range.end))) }))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const result: SelectionRange[] = [];
  for (const range of sorted) {
    const previous = result[result.length - 1];
    if (previous && range.start <= previous.end + 1) result[result.length - 1] = { start: previous.start, end: Math.max(previous.end, range.end) };
    else result.push(range);
  }
  return result;
}

export function addSelectionRange(ranges: readonly SelectionRange[], start: number, end = start): SelectionRange[] {
  return normalizeSelectionRanges([...ranges, { start, end }]);
}

export function removeSelectionIndex(ranges: readonly SelectionRange[], index: number): SelectionRange[] {
  const result: SelectionRange[] = [];
  for (const range of ranges) {
    if (index < range.start || index > range.end) result.push(range);
    else {
      if (range.start < index) result.push({ start: range.start, end: index - 1 });
      if (index < range.end) result.push({ start: index + 1, end: range.end });
    }
  }
  return result;
}

export function selectionContains(ranges: readonly SelectionRange[], index: number): boolean {
  return ranges.some((range) => index >= range.start && index <= range.end);
}

export function selectionCount(ranges: readonly SelectionRange[]): number {
  return ranges.reduce((sum, range) => sum + range.end - range.start + 1, 0);
}
