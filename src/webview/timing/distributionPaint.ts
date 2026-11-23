import type { DistributionRowDto } from '../../extension/editors/rawLogProtocol';
import { t } from '../shared/i18n';
import { css } from './frameTimingPaint';
import type { ChartContext } from '../shared/svgCanvas';

const HEADER = 22;
const ROW = 62;
const BARS = 34;
const STAT_WIDTH = 78;
/** Bars a row asks for. */
export const DISTRIBUTION_BINS = 40;
const COLORS = [['--vscode-charts-blue', '#3794ff'], ['--vscode-charts-green', '#89d185'], ['--vscode-charts-orange', '#d18616'], ['--vscode-charts-purple', '#b180d7'], ['--vscode-charts-yellow', '#cca700']] as const;

export function distributionHeight(rows: number): number { return HEADER + Math.max(1, rows) * ROW + 4; }

/** A value as text: six significant digits at most, without trailing zeros. */
export function valueText(value: number | undefined): string { return value === undefined ? '–' : Math.abs(value) >= 1e9 || (value !== 0 && Math.abs(value) < 1e-4) ? value.toExponential(3) : String(Number(value.toPrecision(6))); }

/** The columns of a row: the name, the bars over the Signal's value span, and the statistics (fewer of them in a narrow view). */
function layout(width: number): { name: number; plotLeft: number; plotWidth: number; stats: readonly Stat[]; statsLeft: number } {
  const all: readonly Stat[] = ['count', 'min', 'max', 'mean', 'sd']; const stats = width >= 760 ? all : width >= 520 ? all.slice(1, 4) : [];
  const name = Math.max(72, Math.min(220, Math.round(width * .24))); const statsLeft = width - 12 - stats.length * STAT_WIDTH; const plotLeft = name + 12;
  return { name, plotLeft, plotWidth: Math.max(40, statsLeft - 16 - plotLeft), stats, statsLeft };
}
type Stat = 'count' | 'min' | 'max' | 'mean' | 'sd';
const statLabel = (stat: Stat) => stat === 'count' ? t('Count', '件数') : stat === 'min' ? t('Min', '最小') : stat === 'max' ? t('Max', '最大') : stat === 'mean' ? t('Mean', '平均') : 'σ';
const statText = (row: DistributionRowDto, stat: Stat) => stat === 'count' ? row.count.toLocaleString() : valueText(row[stat]);

/**
 * Draws one row per Signal: its name and unit, how its values in the span are spread over its whole value span (with a
 * line from the least to the greatest value in the span, and a dashed mark at the mean), and the statistics. `marks` are
 * values to point out on the bars, by Signal: the value at the Trace position, or at the time under the pointer.
 */
export function paintDistribution(context: ChartContext, width: number, rows: readonly DistributionRowDto[], marks?: { readonly values: ReadonlyMap<string, number>; readonly color: string }): void {
  const { name, plotLeft, plotWidth, stats, statsLeft } = layout(width);
  const foreground = css('--vscode-foreground', '#ccc'); const muted = css('--vscode-descriptionForeground', '#999'); const grid = css('--vscode-panel-border', '#444'); const family = css('--vscode-font-family', 'sans-serif');
  context.textBaseline = 'middle'; context.lineWidth = 1; context.font = `11px ${family}`; context.fillStyle = muted; context.textAlign = 'right';
  stats.forEach((stat, at) => context.fillText(statLabel(stat), statsLeft + (at + 1) * STAT_WIDTH, HEADER / 2));
  context.strokeStyle = grid; context.beginPath(); context.moveTo(12, HEADER + .5); context.lineTo(width - 12, HEADER + .5); context.stroke();
  rows.forEach((row, index) => {
    const top = HEADER + index * ROW; const base = top + 8 + BARS; const [colorName, fallback] = COLORS[index % COLORS.length]; const color = css(colorName, fallback);
    context.textAlign = 'left'; context.font = `12px ${family}`; context.fillStyle = foreground; context.fillText(ellipsize(context, row.name, name), 12, top + 22);
    context.font = `11px ${family}`; context.fillStyle = muted; if (row.unit) context.fillText(ellipsize(context, row.unit, name), 12, top + 39);
    const most = Math.max(1, ...row.bins); const barWidth = plotWidth / row.bins.length; const x = (value: number) => plotLeft + (row.hi > row.lo ? (value - row.lo) / (row.hi - row.lo) : .5) * plotWidth;
    context.fillStyle = color; context.globalAlpha = .8;
    row.bins.forEach((count, bin) => { if (!count) return; const height = Math.max(1.5, count / most * BARS); context.fillRect(plotLeft + bin * barWidth + (barWidth > 3 ? .5 : 0), base - height, Math.max(1, barWidth - (barWidth > 3 ? 1 : 0)), height); });
    context.globalAlpha = 1; context.strokeStyle = grid; context.beginPath(); context.moveTo(plotLeft, base + .5); context.lineTo(plotLeft + plotWidth, base + .5); context.stroke();
    if (row.min !== undefined && row.max !== undefined && row.mean !== undefined) {
      // From the least to the greatest value in the span, and the mean.
      context.strokeStyle = color; context.lineWidth = 2; context.beginPath(); context.moveTo(x(row.min), base + 3); context.lineTo(Math.max(x(row.min) + 1, x(row.max)), base + 3); context.stroke(); context.lineWidth = 1;
      const mean = Math.round(x(row.mean)) + .5; context.strokeStyle = foreground; context.setLineDash([3, 3]); context.beginPath(); context.moveTo(mean, top + 6); context.lineTo(mean, base); context.stroke(); context.setLineDash([]);
    }
    const marked = marks?.values.get(row.signalId);
    if (marked !== undefined && Number.isFinite(marked)) {
      const at = Math.round(Math.max(plotLeft, Math.min(plotLeft + plotWidth, x(marked)))) + .5; context.strokeStyle = marks!.color; context.fillStyle = marks!.color; context.lineWidth = 1.5;
      context.beginPath(); context.moveTo(at, top + 6); context.lineTo(at, base + 5); context.stroke(); context.lineWidth = 1;
      context.beginPath(); context.moveTo(at - 4, top + 2); context.lineTo(at + 4, top + 2); context.lineTo(at, top + 8); context.closePath(); context.fill();
    }
    context.fillStyle = muted; context.fillText(valueText(row.lo), plotLeft, base + 13); context.textAlign = 'right'; context.fillText(valueText(row.hi), plotLeft + plotWidth, base + 13);
    context.fillStyle = foreground; context.font = `12px ${css('--vscode-editor-font-family', 'monospace')}`;
    stats.forEach((stat, at) => context.fillText(statText(row, stat), statsLeft + (at + 1) * STAT_WIDTH, top + 8 + BARS / 2));
    context.strokeStyle = grid; context.globalAlpha = .48; context.beginPath(); context.moveTo(12, Math.round(top + ROW) + .5); context.lineTo(width - 12, Math.round(top + ROW) + .5); context.stroke(); context.globalAlpha = 1;
  });
}

/** What the pointer is over, as the lines of a hover box: a bar's value span and samples, else the row's statistics. */
export function distributionTipLines(rows: readonly DistributionRowDto[], width: number, offsetX: number, offsetY: number): string[] | undefined {
  const row = rows[Math.floor((offsetY - HEADER) / ROW)]; if (!row || offsetY < HEADER) return undefined;
  const { plotLeft, plotWidth } = layout(width); const unit = row.unit ? ` ${row.unit}` : ''; const lines = [row.name];
  const bin = Math.floor((offsetX - plotLeft) / plotWidth * row.bins.length);
  if (bin >= 0 && bin < row.bins.length && row.count) {
    const step = (row.hi - row.lo) / row.bins.length; const count = row.bins[bin];
    lines.push(step > 0 ? `${valueText(row.lo + bin * step)} – ${valueText(row.lo + (bin + 1) * step)}${unit}` : `${valueText(row.lo)}${unit}`, `${count.toLocaleString()} ${t('samples', '件')} (${(count / row.count * 100).toFixed(1)} %)`);
  } else {
    lines.push(`${t('Count', '件数')} ${row.count.toLocaleString()}`);
    if (row.count) lines.push(`${t('Min', '最小')} ${valueText(row.min)}${unit}`, `${t('Max', '最大')} ${valueText(row.max)}${unit}`, `${t('Mean', '平均')} ${valueText(row.mean)}${unit}`, `σ ${valueText(row.sd)}${unit}`);
  }
  return lines;
}

function ellipsize(context: ChartContext, text: string, maxWidth: number): string {
  if (context.measureText(text).width <= maxWidth) return text; let low = 0; let high = text.length;
  while (low < high) { const middle = Math.ceil((low + high) / 2); if (context.measureText(`${text.slice(0, middle)}…`).width <= maxWidth) low = middle; else high = middle - 1; }
  return `${text.slice(0, low)}…`;
}
