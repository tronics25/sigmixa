import { reportGraphs as mapReportGraphs } from './reportGraphs';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ComparisonGraphDefinition } from '../../core/project/comparison';
import type { SignalDefinition } from '../../core/signal/signal';
import type { ComparisonSeriesDto } from '../comparison/comparisonProtocol';
import type { RawLogDocument } from '../editors/rawLogDocument';
import type { LogViewState, SignalGroupDto } from '../editors/rawLogProtocol';
import { t } from '../i18n';
import type { ReportData, ReportTable } from './reportData';
import { REPORT_THEME } from './reportTheme';

export type ReportDetail = 'standard' | 'full';
const STANDARD_POINTS = 20_000;
const STANDARD_ROWS = 20_000;
const FULL = 50_000_000;

/** Asks how much data to include. Standard keeps reports light; full keeps every sample. */
export async function chooseReportDetail(): Promise<ReportDetail | undefined> {
  const choice = await vscode.window.showQuickPick([
    { label: t('Standard', '標準'), description: t(`Up to ${STANDARD_POINTS.toLocaleString()} points per Signal and ${STANDARD_ROWS.toLocaleString()} table rows`, `1 シグナルあたり最大 ${STANDARD_POINTS.toLocaleString()} 点、表は最大 ${STANDARD_ROWS.toLocaleString()} 行`), detail: t('Thinned evenly when there is more; the report says what was thinned.', 'それより多い場合は均等に間引き、間引いた内容をレポートに記載します。'), value: 'standard' as const },
    { label: t('All samples', '全点'), description: t('Every sample and table row', 'すべてのサンプルと表の行'), detail: t('Large logs make large files that open slowly.', '大きなログでは、ファイルが大きく開くのも遅くなります。'), value: 'full' as const },
  ], { title: t('Export HTML report', 'HTMLレポートを出力'), placeHolder: t('How much data to include', '含めるデータ量') });
  return choice?.value;
}

/** Samples of one target, with a notice for every Signal that had to be thinned. */
export function reportSeries(document: RawLogDocument, signalIds: readonly string[], range: { start: number; end: number } | undefined, detail: ReportDetail, notices: string[], targetName?: string, map: (id: string) => string = (id) => id): ComparisonSeriesDto[] {
  if (!signalIds.length) return [];
  const series = document.reportSeries(signalIds, range, detail === 'full' ? FULL : STANDARD_POINTS);
  for (const item of series) if (item.totalSamplesInRange > item.samples.length) notices.push(t(`${targetName ? `${targetName}: ` : ''}${item.definition.name}: ${item.totalSamplesInRange.toLocaleString()} → ${item.samples.length.toLocaleString()} points (thinned)`, `${targetName ? `${targetName}: ` : ''}${item.definition.name}: ${item.totalSamplesInRange.toLocaleString()} 点 → ${item.samples.length.toLocaleString()} 点（間引き）`));
  return series.map((item) => ({ signalId: map(item.definition.id), series: { ...item, events: item.events ?? [] } }));
}

export function reportTable(document: RawLogDocument, signalIds: readonly string[], detail: ReportDetail, notices: string[]): ReportTable | undefined {
  if (!signalIds.length) return undefined;
  const { rows, total } = document.reportTable(signalIds, detail === 'full' ? FULL : STANDARD_ROWS);
  if (total > rows.length) notices.push(t(`Table: ${total.toLocaleString()} → ${rows.length.toLocaleString()} rows (thinned)`, `テーブル: ${total.toLocaleString()} 行 → ${rows.length.toLocaleString()} 行（間引き）`));
  const labels: Record<string, Record<string, string>> = {};
  const values = signalIds.map((id) => rows.map((row) => { const sample = row.values.get(id); if (!sample || !Number.isFinite(sample.value)) return null; if (sample.valueLabel) (labels[id] ??= {})[String(sample.value)] = sample.valueLabel; return sample.value; }));
  return { signalIds: [...signalIds], timestamps: rows.map((row) => row.timestamp), values, labels, totalRows: total };
}

/** Preserve the localized name for legacy workspaces with no explicit Visualize views. */
export function reportGraphs(state: Partial<LogViewState>, trajectoryCurrentTime?: number): ComparisonGraphDefinition[] {
  return mapReportGraphs(state, trajectoryCurrentTime, t('Graph', 'グラフ'));
}

/** Keeps only the Signals the report contains, so the Signal lists match the data. */
export function reportCatalog(definitions: readonly SignalDefinition[], groups: readonly SignalGroupDto[], included: ReadonlySet<string>) {
  return {
    definitions: definitions.filter((definition) => included.has(definition.id)),
    groups: groups.map((group) => ({ id: group.id, label: group.label, signalIds: group.signalIds.filter((id) => included.has(id)) })).filter((group) => group.signalIds.length),
  };
}

/** Writes one self-contained HTML file: theme, icons, viewer script and data are all inline. */
export async function saveReport(extensionUri: vscode.Uri, data: ReportData, defaultName: string): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  const target = await vscode.window.showSaveDialog({ title: t('Save HTML report', 'HTMLレポートを保存'), defaultUri: root ? vscode.Uri.joinPath(root, `${defaultName.replace(/[\\/:*?"<>|]+/g, '_')}.html`) : undefined, filters: { HTML: ['html'] } });
  if (!target) return;
  const html = reportHtml(extensionUri.fsPath, data, vscode.env.language);
  await vscode.workspace.fs.writeFile(target, Buffer.from(html, 'utf8'));
  const open = t('Open in browser', 'ブラウザで開く');
  const size = html.length > 1024 * 1024 ? `${(html.length / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(html.length / 1024)} KB`;
  const answer = await vscode.window.showInformationMessage(t(`Saved the HTML report (${size}).`, `HTMLレポートを保存しました（${size}）。`), open);
  if (answer === open) await vscode.env.openExternal(target);
}

/** The whole report as one HTML document. `extensionPath` holds the built viewer and the icon font. */
export function reportHtml(extensionPath: string, data: ReportData, language: string): string {
  const bundle = fs.readFileSync(path.join(extensionPath, 'out', 'webview', 'report.js'), 'utf8').replace(/<\/script/gi, '<\\/script');
  const font = fs.readFileSync(path.join(extensionPath, 'media', 'codicons', 'codicon.ttf')).toString('base64');
  const icons = fs.readFileSync(path.join(extensionPath, 'media', 'codicons', 'codicon.css'), 'utf8').replace(/url\(["']?\.\/codicon\.ttf[^)"']*["']?\)/, `url("data:font/ttf;base64,${font}")`);
  const json = JSON.stringify(data).replace(/</g, '\\u003c').split(String.fromCharCode(0x2028)).join('\\u2028').split(String.fromCharCode(0x2029)).join('\\u2029');
  const lang = language.toLowerCase().startsWith('ja') ? 'ja' : 'en';
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="generator" content="SigMixa ${escapeHtml(data.appVersion)}"><title>${escapeHtml(data.title)}</title><style>${REPORT_THEME}</style><style>${icons}</style></head><body><div class="report-shell"><header class="report-header"></header><nav class="report-tabs" role="tablist"></nav><main id="app"></main><section id="report-table" hidden></section></div><script type="application/json" id="report-data">${json}</script><script>${bundle}</script></body></html>`;
}

function escapeHtml(text: string): string { return text.replace(/[&<>"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]!); }
