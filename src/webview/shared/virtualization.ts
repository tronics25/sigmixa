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

/**
 * Browsers cap an element's height (Chromium near 33.5M px), so a sizer of rowCount * rowHeight stops growing
 * past roughly 1.2M rows at 28px and the last rows can never be scrolled to. Above this height the scroll range
 * is compressed and the scroll position is mapped onto the full content height by ratio.
 */
export const MAX_SCROLL_HEIGHT = 16_000_000;

export interface ScaledScroll {
  /** Height to give the sizer element. */
  readonly scrollHeight: number;
  /** Content offset in unscaled pixels (row index * rowHeight space) for a scrollTop. */
  contentOffset(scrollTop: number): number;
  /** scrollTop that shows a content offset (unscaled pixels) at the top of the viewport. */
  scrollTopFor(contentOffset: number): number;
}

export function scaledScroll(rowCount: number, rowHeight: number, viewportHeight: number, maxHeight = MAX_SCROLL_HEIGHT): ScaledScroll {
  const content = Math.max(0, rowCount * rowHeight);
  if (content <= maxHeight) {
    return { scrollHeight: content, contentOffset: (top) => Math.max(0, top), scrollTopFor: (offset) => Math.max(0, offset) };
  }
  const viewport = Math.max(0, Math.min(viewportHeight, maxHeight));
  const maxScroll = maxHeight - viewport; const maxContent = content - viewport;
  const ratio = maxScroll > 0 ? maxContent / maxScroll : 0;
  return {
    scrollHeight: maxHeight,
    contentOffset: (top) => Math.min(maxContent, Math.max(0, top) * ratio),
    scrollTopFor: (offset) => ratio > 0 ? Math.min(maxScroll, Math.max(0, offset) / ratio) : 0
  };
}

/** Rows to draw and where to place the row window (relative to the sizer) for the current scroll position. */
export function computeScaledVirtualRange(
  rowCount: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  overscan = 8
): VirtualRange & { readonly windowTop: number; readonly contentOffset: number; readonly scrollHeight: number } {
  const scroll = scaledScroll(rowCount, rowHeight, viewportHeight);
  const offset = scroll.contentOffset(scrollTop);
  const range = computeVirtualRange(rowCount, offset, viewportHeight, rowHeight, overscan);
  return { ...range, windowTop: range.start * rowHeight - offset + Math.max(0, scrollTop), contentOffset: offset, scrollHeight: scroll.scrollHeight };
}
