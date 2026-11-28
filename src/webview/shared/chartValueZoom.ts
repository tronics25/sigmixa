import type { ChartContext } from './svgCanvas';
import { iconButton } from './iconButton';
import { t } from './i18n';

/** One axis's values, as drawn: `maximum` at the top of the plot, `minimum` at its bottom. */
export interface ValueRange { readonly minimum: number; readonly maximum: number }
/** The plot of one graph in the canvas's CSS pixels. */
export interface ValuePlot { readonly left: number; readonly width: number; readonly top: number; readonly height: number }

/**
 * Which way a drag on a graph selects. Until the pointer has moved more than `threshold` pixels it is still a click;
 * after that, the longer of the two distances from where it was pressed decides, again at every move, so a drag can turn.
 */
export function chartDragDirection(dx: number, dy: number, dragged: boolean, threshold = 6): 'none' | 'time' | 'value' {
  if (!dragged && Math.max(Math.abs(dx), Math.abs(dy)) <= threshold) return 'none';
  return Math.abs(dy) > Math.abs(dx) ? 'value' : 'time';
}

/** The value at height `y` on an axis drawn over `plot`, the height kept inside the plot. */
export function valueAtY(range: ValueRange, y: number, plot: Pick<ValuePlot, 'top' | 'height'>): number {
  const fraction = Math.max(0, Math.min(1, (y - plot.top) / Math.max(1, plot.height)));
  return range.maximum - fraction * (range.maximum - range.minimum);
}

/** Every axis's values between two heights of the plot (in either order): what a vertical selection covers on each axis. */
export function valueSelection(ranges: readonly ValueRange[], y0: number, y1: number, plot: Pick<ValuePlot, 'top' | 'height'>): ValueRange[] {
  const top = Math.min(y0, y1); const bottom = Math.max(y0, y1);
  return ranges.map((range) => ({ minimum: valueAtY(range, bottom, plot), maximum: valueAtY(range, top, plot) }));
}

/** True when a selection covers values at all: a zoom to it would show something. */
export function usableValueSelection(ranges: readonly ValueRange[] | undefined): ranges is readonly ValueRange[] {
  return !!ranges?.length && ranges.every((range) => Number.isFinite(range.minimum) && Number.isFinite(range.maximum) && range.maximum > range.minimum);
}

/**
 * An edge value of a selection, written with as many decimals as one pixel of the axis tells apart (an axis of about
 * 200 pixels), so that both edges of a narrow selection read differently and a wide one is not cluttered.
 */
export function valueEdgeLabel(value: number, span: number): string {
  if (!Number.isFinite(value)) return '—';
  const step = Math.abs(span) / 200; const decimals = step > 0 && Number.isFinite(step) ? Math.max(0, Math.min(9, Math.ceil(-Math.log10(step)))) : 0;
  const text = value.toFixed(decimals); return /^-0(\.0*)?$/.test(text) ? text.slice(1) : text;
}

/** Where the span marker's button goes, in the canvas's CSS pixels. */
export interface ValueSpanButton { readonly x: number; readonly y: number }

/**
 * A vertical span marker inside the plot, beside the value axis: ⊤ ↕ ⊥ from `top` to `bottom`, as a Clip's |← name →| is
 * across time, with room in the middle for its button. With `band`, the selected values are also a see-through band
 * across the plot, like a selected time range. Returns where the button goes.
 */
export function paintValueSpan(context: ChartContext, plot: ValuePlot, top: number, bottom: number, color: string, band: boolean): ValueSpanButton {
  const y0 = Math.max(plot.top, Math.min(plot.top + plot.height, Math.min(top, bottom))); const y1 = Math.max(plot.top, Math.min(plot.top + plot.height, Math.max(top, bottom)));
  const x = Math.round(plot.left + 16) + .5; const middle = (y0 + y1) / 2; const gap = 13;
  context.save(); context.setLineDash([]); context.lineWidth = 1;
  if (band) {
    context.fillStyle = color; context.globalAlpha = .16; context.fillRect(plot.left, y0, plot.width, y1 - y0);
    context.globalAlpha = .8; context.strokeStyle = color; context.beginPath(); context.moveTo(plot.left, Math.round(y0) + .5); context.lineTo(plot.left + plot.width, Math.round(y0) + .5); context.moveTo(plot.left, Math.round(y1) + .5); context.lineTo(plot.left + plot.width, Math.round(y1) + .5); context.stroke();
  }
  context.globalAlpha = .9; context.strokeStyle = color; context.fillStyle = color;
  // End caps at the edges; the shaft and its arrowheads only where there is room for them beside the button.
  context.fillRect(x - 5.5, Math.round(y0), 11, 1); context.fillRect(x - 5.5, Math.round(y1) - 1, 11, 1);
  if (middle - gap - y0 > 8) {
    context.beginPath(); context.moveTo(x, y0 + 2); context.lineTo(x, middle - gap); context.moveTo(x, middle + gap); context.lineTo(x, y1 - 2); context.stroke();
    for (const [tip, direction] of [[y0 + 1, 1], [y1 - 1, -1]] as const) { context.beginPath(); context.moveTo(x, tip); context.lineTo(x - 3.5, tip + direction * 5); context.lineTo(x + 3.5, tip + direction * 5); context.closePath(); context.fill(); }
  }
  context.restore();
  return { x, y: middle };
}

/**
 * A selection edge's value on its axis, in a filled box over the tick labels so it reads as the selection's, not as a tick.
 * `axisX` is the axis line; the box sits on its outer side, as the tick labels do, and is kept inside the plot's height.
 */
export function paintValueEdgeLabel(context: ChartContext, text: string, axisX: number, y: number, rightAxis: boolean, plot: Pick<ValuePlot, 'top' | 'height'>, maxWidth: number, color: string, textColor: string): void {
  context.save(); context.font = '11px sans-serif'; context.textBaseline = 'middle'; context.textAlign = 'left'; context.setLineDash([]);
  const height = 16; const textWidth = context.measureText(text).width; const width = Math.min(Math.max(1, maxWidth), textWidth + 8);
  const left = rightAxis ? axisX + 2 : axisX - 2 - width; const top = Math.max(plot.top - height / 2, Math.min(plot.top + plot.height - height / 2, y - height / 2));
  context.fillStyle = color; context.fillRect(left, top, width, height);
  context.fillStyle = textColor; context.translate(left + 4, top + height / 2 + .5); context.scale(Math.min(1, (width - 8) / Math.max(1, textWidth)), 1); context.fillText(text, 0, 0);
  context.restore();
}

/** The button in the middle of the span marker: zoom to the selected values, or, once zoomed, back to the automatic range. */
export function createValueZoomButton(onPress: (kind: 'zoom' | 'reset') => void): HTMLButtonElement {
  const button = document.createElement('button'); button.type = 'button'; button.className = 'chart-value-zoom'; button.hidden = true;
  button.addEventListener('mousedown', (event) => event.stopPropagation());
  button.addEventListener('click', (event) => { event.stopPropagation(); const kind = button.dataset.kind; if (kind === 'zoom' || kind === 'reset') onPress(kind); });
  return button;
}

/** Shows the button at `at` (canvas CSS pixels) as `kind`, or hides it. */
export function placeValueZoomButton(button: HTMLButtonElement, canvas: HTMLCanvasElement, kind: 'zoom' | 'reset' | undefined, at?: ValueSpanButton): void {
  if (!kind || !at) { button.hidden = true; delete button.dataset.kind; return; }
  if (button.dataset.kind !== kind) iconButton(button, kind === 'zoom' ? 'zoom-in' : 'discard', kind === 'zoom' ? t('Zoom to the selected values', '選択した値の範囲を拡大') : t('Reset the vertical zoom', '縦方向のズームをリセット'));
  button.dataset.kind = kind; button.hidden = false;
  button.style.left = `${canvas.offsetLeft + at.x}px`; button.style.top = `${canvas.offsetTop + at.y}px`;
}

// Over the plot the button needs a face of its own: a framed square in the selection's colour on the graph's background.
export const CHART_VALUE_ZOOM_STYLES = `
button.chart-value-zoom.icon-button{position:absolute;z-index:3;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;flex:none;width:24px;height:24px;min-width:0;max-width:none;min-height:0;margin:0;padding:0;transform:translate(-50%,-50%);border:1px solid var(--vscode-focusBorder);border-radius:var(--sm-radius-control,4px);background:var(--vscode-editor-background);color:var(--vscode-focusBorder)}
button.chart-value-zoom.icon-button:hover{background:var(--vscode-toolbar-hoverBackground,var(--vscode-editor-background))}
button.chart-value-zoom[hidden]{display:none}
button.chart-value-zoom .codicon{font-size:14px;line-height:14px;width:14px;height:14px}
`;
