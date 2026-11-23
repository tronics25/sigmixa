import type { FrameTimingRowDto } from '../../extension/editors/rawLogProtocol';
import { chartAxisGeometry } from '../shared/chartAxes';
import { t } from '../shared/i18n';
import type { ChartContext } from '../shared/svgCanvas';

export interface TimingSpan { readonly start: number; readonly end: number }

export const ROW_HEIGHT = 26;
export const TOP = 6;
export const AXIS_HEIGHT = 24;
/** Frames closer than this many pixels cannot be told apart as lines: the row then shows how full each slice is. */
export const LINE_SPACING = 5;
export const SLICE_WIDTH = 6;
const COLORS = [['--vscode-charts-blue', '#3794ff'], ['--vscode-charts-green', '#89d185'], ['--vscode-charts-orange', '#d18616'], ['--vscode-charts-purple', '#b180d7'], ['--vscode-charts-yellow', '#cca700']] as const;

export interface TimingGutters { readonly left: number; readonly right: number }
/**
 * Where the rows are drawn. Without `gutters`, the same as a Visualize graph with an axis on each side, so the time axes
 * of the cards line up; the report gives the gutters of its own graphs.
 */
export function timingGeometry(width: number, gutters?: TimingGutters): { left: number; right: number; plotWidth: number } {
  if (gutters) return { ...gutters, plotWidth: Math.max(1, width - gutters.left - gutters.right) };
  const { left, right } = chartAxisGeometry(width, 2); const start = Math.max(left, 92); return { left: start, right, plotWidth: Math.max(1, width - start - right) };
}
export function timingHeight(rows: number, rowHeight = ROW_HEIGHT): number { return TOP + Math.max(1, rows) * rowHeight + AXIS_HEIGHT; }
/** How tall a frame timing row is: with a Frame name among the rows, each row has a line for the name above its frames. */
export function timingRowHeight(rows: readonly { readonly name: string }[]): number { return rows.some((row) => row.name) ? 40 : ROW_HEIGHT; }

/** The selected time range, drawn over the rows between `top` and `top + height` as on a graph. */
export function paintSelection(context: ChartContext, width: number, view: TimingSpan, selection: TimingSpan | undefined, top: number, height: number, gutters?: TimingGutters): void {
  if (!selection) return; const { left, plotWidth } = timingGeometry(width, gutters); const span = view.end - view.start || 1;
  const from = Math.max(view.start, Math.min(selection.start, selection.end)); const to = Math.min(view.end, Math.max(selection.start, selection.end)); if (to < from) return;
  const start = left + (from - view.start) / span * plotWidth; const end = left + (to - view.start) / span * plotWidth; const color = css('--vscode-focusBorder', '#007acc');
  context.save(); context.fillStyle = color; context.globalAlpha = .16; context.fillRect(start, top, end - start, height); context.globalAlpha = .8; context.strokeStyle = color; context.lineWidth = 1; context.strokeRect(start, top, end - start, height); context.restore();
}

/** What the pointer is over in a row, as the lines of a hover box: a frame, a gap, or the row itself. `perPixel` is seconds per pixel. */
export function timingTipLines(row: FrameTimingRowDto, time: number, perPixel: number, timeText: (time: number) => string): string[] {
  const lines: string[] = [`${row.canId}${row.name ? `  ${row.name}` : ''}`];
  const gap = row.gaps.find((item) => time > item.start && time < item.end);
  const nearest = row.times?.length ? row.times.reduce((best, value) => Math.abs(value - time) < Math.abs(best - time) ? value : best) : undefined;
  if (nearest !== undefined && Math.abs(nearest - time) <= perPixel * 5) {
    lines.push(timeText(nearest)); if (row.eventTimes?.includes(nearest)) lines.push(t('Sent on an event, between the cycle frames', '周期の間にイベントで送信')); const index = row.times!.indexOf(nearest); const previous = index > 0 ? row.times![index - 1] : undefined;
    if (previous !== undefined) { const interval = (nearest - previous) * 1000; lines.push(`${t('Since the previous frame', '前回から')} ${milliseconds(interval)} ms${row.periodMs === undefined ? '' : `  (${interval - row.periodMs >= 0 ? '+' : ''}${milliseconds(interval - row.periodMs)} ms)`}`); }
  } else if (gap) {
    const length = (gap.end - gap.start) * 1000; lines.push(`${t('No frames for', '受信なし')} ${milliseconds(length)} ms`);
    if (row.periodMs) lines.push(t(`About ${Math.max(1, Math.round(length / row.periodMs) - 1)} frame(s) at a period of ${milliseconds(row.periodMs)} ms`, `周期 ${milliseconds(row.periodMs)} ms で約 ${Math.max(1, Math.round(length / row.periodMs) - 1)} 件分`));
  } else lines.push(`${periodText(row)} · ${row.count.toLocaleString()} / ${row.total.toLocaleString()} ${t('frames', '件')}`);
  // The send mode, wherever the pointer is in the row.
  const mode = sendModeText(row); if (mode) lines.push(mode);
  return lines;
}

/** Places the hover box beside the pointer, inside the window. */
export function showTimingTip(tip: HTMLElement, lines: readonly string[], event: Pick<MouseEvent, 'clientX' | 'clientY'>): void {
  tip.replaceChildren(...lines.map((text, index) => { const line = document.createElement('div'); line.textContent = text; if (index === 0) line.className = 'frame-timing-tip-head'; return line; }));
  tip.hidden = false; const box = tip.getBoundingClientRect();
  let x = event.clientX + 14; if (x + box.width > window.innerWidth - 4) x = event.clientX - box.width - 14;
  let y = event.clientY + 14; if (y + box.height > window.innerHeight - 4) y = event.clientY - box.height - 14;
  tip.style.left = `${Math.max(0, x)}px`; tip.style.top = `${Math.max(0, y)}px`;
}

/**
 * Draws the rows on the span `view`. `data` is the span the rows' times and slices were read for: while the view moves on
 * before new rows arrive, they are drawn where that span now is. `lines` are marks across every row (the Trace position,
 * the time under the pointer).
 */
export function paintFrameTiming(context: ChartContext, width: number, rows: readonly FrameTimingRowDto[], view: TimingSpan, data: TimingSpan | undefined, ticks: (start: number, end: number, intervals: number) => readonly { readonly timestamp: number; readonly label: string }[], lines: readonly { readonly time: number | undefined; readonly color: string; readonly alpha: number }[] = [], gutters?: TimingGutters): void {
  const { left, right, plotWidth } = timingGeometry(width, gutters);
  // In a narrow gutter the CAN ID is set smaller and closer to the edge, so an extended ID still fits.
  const narrow = left < 92; const chipLeft = narrow ? 3 : 12; const chipPad = narrow ? 5 : 7;
  const rowHeight = timingRowHeight(rows); const named = rowHeight > ROW_HEIGHT; const bottom = TOP + rows.length * rowHeight; const span = view.end - view.start || 1;
  const x = (time: number) => left + (time - view.start) / span * plotWidth;
  const foreground = css('--vscode-foreground', '#ccc'); const muted = css('--vscode-descriptionForeground', '#999'); const grid = css('--vscode-panel-border', '#444'); const danger = css('--vscode-errorForeground', '#f14c4c');
  const family = css('--vscode-font-family', 'sans-serif'); const mono = css('--vscode-editor-font-family', 'monospace');
  context.textBaseline = 'middle'; context.lineWidth = 1;
  // Time axis: the grid lines of the graphs.
  context.font = `11px ${family}`; context.strokeStyle = grid; context.fillStyle = muted; context.textAlign = 'center';
  for (const tick of ticks(view.start, view.end, Math.max(1, Math.min(5, Math.floor(plotWidth / 100))))) {
    const px = Math.round(x(tick.timestamp)) + .5; if (px < left - 1 || px > left + plotWidth + 1) continue;
    context.globalAlpha = .48; context.beginPath(); context.moveTo(px, TOP); context.lineTo(px, bottom); context.stroke(); context.globalAlpha = 1;
    const half = context.measureText(tick.label).width / 2; context.fillText(tick.label, Math.max(left + half, Math.min(px, width - right - half)), bottom + AXIS_HEIGHT / 2);
  }
  context.beginPath(); context.moveTo(left, bottom + .5); context.lineTo(width - right, bottom + .5); context.stroke();
  rows.forEach((row, index) => {
    const top = TOP + index * rowHeight; const middle = named ? top + rowHeight - 13 : top + rowHeight / 2; const [colorName, colorFallback] = COLORS[index % COLORS.length]; const color = css(colorName, colorFallback);
    // The CAN ID, as a chip in the row's colour; the period at the other end.
    context.font = `${narrow ? 11 : 12}px ${mono}`; const chip = Math.min(left - chipLeft - 4, context.measureText(row.canId).width + chipPad * 2);
    context.fillStyle = color; context.globalAlpha = .14; roundRect(context, chipLeft, middle - 9, chip, 18, 4); context.fill(); context.globalAlpha = 1;
    context.strokeStyle = color; roundRect(context, chipLeft + .5, middle - 8.5, chip - 1, 17, 4); context.stroke();
    context.fillStyle = foreground; context.textAlign = 'left'; context.fillText(row.canId, chipLeft + chipPad, middle + .5);
    context.font = `11px ${family}`; context.fillStyle = muted; context.fillText(periodText(row), width - right + 8, middle);
    context.strokeStyle = grid; context.globalAlpha = .48; context.beginPath(); context.moveTo(left, Math.round(top + rowHeight) + .5); context.lineTo(width - right, Math.round(top + rowHeight) + .5); context.stroke(); context.globalAlpha = 1;
    // The Frame name, on its own line above the frames, where it has room.
    if (named && row.name) { context.font = `11px ${family}`; context.fillStyle = foreground; context.textAlign = 'left'; context.fillText(ellipsize(context, row.name, plotWidth), left, top + 9); }
    context.save(); context.beginPath(); context.rect(left, middle - 13, plotWidth, 26); context.clip();
    context.fillStyle = color;
    if (row.times) {
      for (const time of row.times) { const px = Math.round(x(time)); context.fillRect(px - 1, middle - 8, 2, 16); }
      // Frames sent on events between the cycle frames (periodic + events) get a dot above their line.
      if (row.eventTimes?.length) {
        context.fillStyle = css('--vscode-charts-yellow', '#cca700');
        for (const time of row.eventTimes) { if (time < view.start || time > view.end) continue; const px = Math.round(x(time)); context.fillRect(px - 1, middle - 8, 2, 16); context.beginPath(); context.arc(px, middle - 10.5, 2.5, 0, Math.PI * 2); context.fill(); }
        context.fillStyle = color;
      }
    }
    else if (row.bins?.length) {
      // The slices belong to the span that was asked for; while the view moves on they are drawn where that span now is.
      const read = data ?? view; const sliceSeconds = (read.end - read.start) / row.bins.length; const slice = sliceSeconds / span * plotWidth;
      const expected = row.periodMs ? sliceSeconds / (row.periodMs / 1000) : Math.max(1, ...row.bins);
      row.bins.forEach((count, at) => { if (!count) return; context.globalAlpha = .25 + .6 * Math.min(1, count / Math.max(1, expected)); context.fillRect(x(read.start + at * sliceSeconds), middle - 7, Math.max(1, slice - 1), 14); });
      context.globalAlpha = 1;
    }
    for (const gap of row.gaps) {
      if (gap.end < view.start || gap.start > view.end) continue;
      const from = x(gap.start) + 3; const to = Math.max(from + 4, x(gap.end) - 3);
      context.fillStyle = danger; context.globalAlpha = .2; roundRect(context, from, middle - 10, to - from, 20, 4); context.fill(); context.globalAlpha = 1;
      context.strokeStyle = danger; context.setLineDash([4, 3]); roundRect(context, from + .5, middle - 9.5, to - from - 1, 19, 4); context.stroke(); context.setLineDash([]);
      const length = (gap.end - gap.start) * 1000; const label = `${length >= 1000 ? `${(length / 1000).toFixed(2)} s` : `${milliseconds(length)} ms`} ${t('no frames', '受信なし')}`;
      const visibleFrom = Math.max(from, left); const visibleTo = Math.min(to, left + plotWidth);
      if (visibleTo - visibleFrom > context.measureText(label).width + 12) { context.fillStyle = danger; context.textAlign = 'center'; context.fillText(label, (visibleFrom + visibleTo) / 2, middle + .5); context.textAlign = 'left'; }
    }
    context.restore();
  });
  for (const mark of lines) { if (mark.time === undefined || mark.time < view.start || mark.time > view.end) continue; const px = Math.round(x(mark.time)) + .5; context.strokeStyle = mark.color; context.globalAlpha = mark.alpha; context.beginPath(); context.moveTo(px, TOP); context.lineTo(px, bottom); context.stroke(); context.globalAlpha = 1; }
}

/** "Send mode: periodic (estimated)": how the CAN ID is sent, and whether that was read from the log. */
export function sendModeText(row: Pick<FrameTimingRowDto, 'mode' | 'modeEstimated'>): string | undefined {
  if (!row.mode) return undefined;
  const name = row.mode === 'periodic' ? t('periodic', '周期') : row.mode === 'event' ? t('on events', 'イベント') : t('periodic + events', '周期＋イベント');
  return `${t('Send mode', '送信モード')}: ${name}${row.modeEstimated ? t(' (estimated)', '（推定）') : ''}`;
}
export function periodText(row: FrameTimingRowDto): string { return row.periodMs === undefined ? t('Event', 'イベント') : `${row.estimated ? '≈ ' : ''}${milliseconds(row.periodMs)} ms`; }
export function milliseconds(value: number): string { return Math.abs(value) >= 100 ? value.toFixed(1).replace(/\.0$/, '') : value.toFixed(2).replace(/\.?0+$/, ''); }
export function css(name: string, fallback: string): string { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback; }
export function roundRect(context: ChartContext, x: number, y: number, width: number, height: number, radius: number): void {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2)); context.beginPath(); context.moveTo(x + r, y); context.lineTo(x + width - r, y); context.arcTo(x + width, y, x + width, y + r, r); context.lineTo(x + width, y + height - r); context.arcTo(x + width, y + height, x + width - r, y + height, r); context.lineTo(x + r, y + height); context.arcTo(x, y + height, x, y + height - r, r); context.lineTo(x, y + r); context.arcTo(x, y, x + r, y, r); context.closePath();
}
/** Cuts a text to a width, with an ellipsis. */
export function ellipsize(context: ChartContext, text: string, maxWidth: number): string {
  if (context.measureText(text).width <= maxWidth) return text; let low = 0; let high = text.length;
  while (low < high) { const middle = Math.ceil((low + high) / 2); if (context.measureText(`${text.slice(0, middle)}…`).width <= maxWidth) low = middle; else high = middle - 1; }
  return `${text.slice(0, low)}…`;
}

/** The view that shows `gap`, keeping `view`'s span when it fits; undefined when `view` already shows it. */
export function viewShowing(view: { readonly start: number; readonly end: number }, full: { readonly start: number; readonly end: number }, gap: { readonly start: number; readonly end: number }): { start: number; end: number } | undefined {
  if (gap.start >= view.start && gap.end <= view.end) return undefined;
  const length = gap.end - gap.start; let span = view.end - view.start;
  if (length * 1.2 > span) span = length * 1.2;
  const fullSpan = full.end - full.start; if (span >= fullSpan) return { start: full.start, end: full.end };
  const start = Math.max(full.start, Math.min(full.end - span, (gap.start + gap.end) / 2 - span / 2));
  return { start, end: start + span };
}
