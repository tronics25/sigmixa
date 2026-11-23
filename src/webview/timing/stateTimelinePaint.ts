import type { StateRowDto } from '../../extension/editors/rawLogProtocol';
import { t } from '../shared/i18n';
import { AXIS_HEIGHT, ROW_HEIGHT, TOP, css, roundRect, timingGeometry, type TimingGutters, type TimingSpan } from './frameTimingPaint';
import type { ChartContext } from '../shared/svgCanvas';

/** Runs narrower than this many pixels cannot be told apart: the row then shows the longest-lasting state per slice. */
export const RUN_SPACING = 3;
export const STATE_SLICE_WIDTH = 4;
const COLORS = [['--vscode-charts-green', '#89d185'], ['--vscode-charts-blue', '#3794ff'], ['--vscode-charts-orange', '#d18616'], ['--vscode-charts-purple', '#b180d7'], ['--vscode-charts-yellow', '#cca700'], ['--vscode-charts-red', '#f14c4c']] as const;

/**
 * Draws the rows on the span `view`. `readFor` is the span the rows' runs and slices were read for. `cursor` is the time
 * whose state is written at the right end of each row; `lines` are marks across every row.
 */
export function paintStateTimeline(context: ChartContext, width: number, rows: readonly StateRowDto[], view: TimingSpan, readFor: TimingSpan | undefined, ticks: (start: number, end: number, intervals: number) => readonly { readonly timestamp: number; readonly label: string }[], cursor: number | undefined, lines: readonly { readonly time: number | undefined; readonly color: string; readonly alpha: number }[] = [], gutters?: TimingGutters): void {
  const read = readFor ?? view; const { left, right, plotWidth } = timingGeometry(width, gutters); const rowHeight = stateRowHeight(gutters, rows, width); const named = rowHeight > ROW_HEIGHT; const bottom = TOP + rows.length * rowHeight; const span = view.end - view.start || 1;
  const x = (time: number) => left + (time - view.start) / span * plotWidth;
  const foreground = css('--vscode-foreground', '#ccc'); const muted = css('--vscode-descriptionForeground', '#999'); const grid = css('--vscode-panel-border', '#444'); const family = css('--vscode-font-family', 'sans-serif');
  // The lowest value of a Signal (off, inactive, the first mode) is drawn quietly; the other states take the colours in turn.
  const colorOf = (row: StateRowDto, state: number) => { if (state === 0 && row.states.length > 1) return muted; const [name, fallback] = COLORS[(row.states.length > 1 ? state - 1 : state) % COLORS.length]; return css(name, fallback); };
  context.textBaseline = 'middle'; context.lineWidth = 1; context.font = `11px ${family}`; context.strokeStyle = grid; context.fillStyle = muted; context.textAlign = 'center';
  for (const tick of ticks(view.start, view.end, Math.max(1, Math.min(5, Math.floor(plotWidth / 100))))) {
    const px = Math.round(x(tick.timestamp)) + .5; if (px < left - 1 || px > left + plotWidth + 1) continue;
    context.globalAlpha = .48; context.beginPath(); context.moveTo(px, TOP); context.lineTo(px, bottom); context.stroke(); context.globalAlpha = 1;
    const half = context.measureText(tick.label).width / 2; context.fillText(tick.label, Math.max(left + half, Math.min(px, width - right - half)), bottom + AXIS_HEIGHT / 2);
  }
  context.beginPath(); context.moveTo(left, bottom + .5); context.lineTo(width - right, bottom + .5); context.stroke();
  rows.forEach((row, index) => {
    const top = TOP + index * rowHeight; const middle = named ? top + rowHeight - 12 : top + rowHeight / 2;
    // In a narrow gutter the name is written above the row's band, where it has room.
    context.fillStyle = foreground; context.textAlign = 'left';
    if (named) { context.font = `11px ${family}`; context.fillText(ellipsize(context, row.name, plotWidth), left, top + 9); }
    else { context.font = `12px ${family}`; context.fillText(ellipsize(context, row.name, left - 20), 12, middle); }
    // At the right end: the state at the time under the pointer (or at the Trace position).
    const now = cursor === undefined ? undefined : stateAt(row, cursor, read);
    context.font = `11px ${family}`; if (now) { context.fillStyle = muted; context.fillText(ellipsize(context, stateText(row, now.state, false), right - 12), width - right + 8, middle); }
    context.strokeStyle = grid; context.globalAlpha = .48; context.beginPath(); context.moveTo(left, Math.round(top + rowHeight) + .5); context.lineTo(width - right, Math.round(top + rowHeight) + .5); context.stroke(); context.globalAlpha = 1;
    context.save(); context.beginPath(); context.rect(left, middle - 12, plotWidth, 24); context.clip();
    if (row.tooMany) { context.fillStyle = muted; context.fillText(t('Changes too often to show as states.', '値の変化が多く、状態として表示できません。'), left + 8, middle); }
    else if (row.runs) for (const run of row.runs) {
      const from = x(run.start); const to = Math.max(from + 1, x(run.end)); if (to < left || from > left + plotWidth) continue; const color = colorOf(row, run.state);
      context.fillStyle = color; context.globalAlpha = .28; roundRect(context, from, middle - 8, to - from, 16, 3); context.fill(); context.globalAlpha = 1; context.fillRect(from, middle - 8, Math.min(2, to - from), 16);
      const label = stateText(row, run.state, false); const visibleFrom = Math.max(from, left); const visibleTo = Math.min(to, left + plotWidth);
      if (visibleTo - visibleFrom > context.measureText(label).width + 14) { context.fillStyle = foreground; context.fillText(label, visibleFrom + 8, middle + .5); }
    }
    else if (row.bins?.length) {
      const sliceSeconds = (read.end - read.start) / row.bins.length; const slice = sliceSeconds / span * plotWidth;
      row.bins.forEach((bin, at) => { if (!bin) return; context.fillStyle = colorOf(row, bin.state); context.globalAlpha = bin.mixed ? .5 : .28; context.fillRect(x(read.start + at * sliceSeconds), middle - 8, slice + .5, 16); });
      context.globalAlpha = 1;
    }
    context.restore();
  });
  for (const mark of lines) { if (mark.time === undefined || mark.time < view.start || mark.time > view.end) continue; const px = Math.round(x(mark.time)) + .5; context.strokeStyle = mark.color; context.globalAlpha = mark.alpha; context.beginPath(); context.moveTo(px, TOP); context.lineTo(px, bottom); context.stroke(); context.globalAlpha = 1; }
}

/**
 * How tall a row is. A Signal name is written in the left gutter when every name of the view fits there; otherwise (a
 * narrow gutter, as in the report, or a long name) each row has its name on a line above the band, as frame timing has.
 */
export function stateRowHeight(gutters?: TimingGutters, rows: readonly { readonly name: string }[] = [], width = 0): number {
  if (gutters && gutters.left < 92) return 40;
  const room = timingGeometry(width, gutters).left - 20; const context = measureContext();
  if (!context) return ROW_HEIGHT; context.font = `12px ${css('--vscode-font-family', 'sans-serif')}`;
  return rows.some((row) => context.measureText(row.name).width > room) ? 40 : ROW_HEIGHT;
}
export function stateTimelineHeight(rows: readonly { readonly name: string }[], width: number, gutters?: TimingGutters): number { return TOP + Math.max(1, rows.length) * stateRowHeight(gutters, rows, width) + AXIS_HEIGHT; }
let measuring: ChartContext | null | undefined;
function measureContext(): ChartContext | null { return measuring ??= typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d'); }

/** The state of a row at a time, from what is drawn: its index, and the run when single runs are held. */
export function stateAt(row: StateRowDto, time: number, readFor: TimingSpan | undefined): { state: number; run?: TimingSpan; mixed?: boolean } | undefined {
  // At the moment of a change the new state holds (a run ends where the next begins), so the later run is taken.
  if (row.runs) { let run: (typeof row.runs)[number] | undefined; for (let index = row.runs.length - 1; index >= 0; index--) { const item = row.runs[index]; if (time >= item.start && time <= item.end) { run = item; break; } } return run && { state: run.state, run }; }
  if (!row.bins?.length || !readFor) return undefined;
  const bin = row.bins[Math.floor((time - readFor.start) / ((readFor.end - readFor.start) / row.bins.length))]; return bin ? { state: bin.state, mixed: bin.mixed } : undefined;
}

/** What the pointer is over in a row, as the lines of a hover box; only the heading when there is nothing at `time`. */
export function stateTipLines(row: StateRowDto, time: number | undefined, readFor: TimingSpan | undefined, rangeText: (start: number, end: number) => string): string[] {
  const lines = [row.name]; const at = time === undefined ? undefined : stateAt(row, time, readFor);
  if (row.tooMany) lines.push(t('Changes too often to show as states.', '値の変化が多く、状態として表示できません。'));
  else if (at) {
    lines.push(stateText(row, at.state, true));
    if (at.run) lines.push(rangeText(at.run.start, at.run.end), `${(at.run.end - at.run.start).toFixed(3)} s`);
    else if (at.mixed) lines.push(t('Several states here: zoom in to tell them apart.', 'この位置に複数の状態があります。拡大すると見分けられます。'));
  }
  return lines;
}

/** A state as text: its name, or its value with the unit; `full` gives both the name and the value. */
export function stateText(row: StateRowDto, state: number, full: boolean): string {
  const item = row.states[state]; if (!item) return '';
  const value = `${item.value}${row.unit ? ` ${row.unit}` : ''}`; return item.label === undefined ? value : full ? `${item.label} (${item.value})` : item.label;
}
function ellipsize(context: ChartContext, text: string, maxWidth: number): string {
  if (context.measureText(text).width <= maxWidth) return text; let low = 0; let high = text.length;
  while (low < high) { const middle = Math.ceil((low + high) / 2); if (context.measureText(`${text.slice(0, middle)}…`).width <= maxWidth) low = middle; else high = middle - 1; }
  return `${text.slice(0, low)}…`;
}
