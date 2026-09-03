export interface VirtualRange {
  readonly start: number;
  readonly end: number;
}

export function computeVirtualRange(
  rowCount: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  overscan = 8
): VirtualRange {
  if (rowCount <= 0 || viewportHeight <= 0 || rowHeight <= 0) return { start: 0, end: 0 };
  const first = Math.max(0, Math.floor(scrollTop / rowHeight));
  const visible = Math.ceil(viewportHeight / rowHeight);
  const start = Math.max(0, first - overscan);
  const end = Math.min(rowCount, first + visible + overscan);
  return { start, end };
}
