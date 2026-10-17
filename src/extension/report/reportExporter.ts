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
import { packReportData } from './reportPacking';
import { reportTableCells, reportTableColumns, reportTableRows } from './reportTableCells';

/**
 * A report holds every sample and every table row: nothing is left out. The file stays small because the data is packed
 * without loss (`packReportData`) and rebuilt as it was when the report opens.
 */
const ALL = 50_000_000;

/** Samples of one target, every one of them. */
export function reportSeries(document: RawLogDocument, signalIds: readonly string[], range: { start: number; end: number } | undefined, map: (id: string) => string = (id) => id): ComparisonSeriesDto[] {
  if (!signalIds.length) return [];
  return document.reportSeries(signalIds, range, ALL).map((item) => ({ signalId: map(item.definition.id), series: { ...item, events: item.events ?? [] } }));
}

/**
 * The table of a log report: every Signal the report shows. `tableIds` are the Table's Signals, `graphIds` those of the
 * graphs and trajectories; `series` are the report's graph series, used for Signals that have no rows of their own.
 */
export function reportTable(document: RawLogDocument, tableIds: readonly string[], options: { columnOrder?: readonly string[]; graphIds?: readonly string[]; series?: readonly ComparisonSeriesDto[] } = {}): ReportTable | undefined {
  const ids = [...new Set([...tableIds, ...(options.graphIds ?? [])])]; if (!ids.length) return undefined;
  const { rows: eventRows } = document.reportTable(ids, ALL);
  const inRows = new Set<string>(); for (const row of eventRows) for (const [id, sample] of row.values) if (Number.isFinite(sample.value)) inRows.add(id);
  const others = (options.series ?? []).filter((item) => ids.includes(item.signalId) && !inRows.has(item.signalId)).map((item) => ({ signalId: item.signalId, samples: item.series.samples }));
  const rows = reportTableRows(eventRows, others);
  const filled = new Set(inRows); for (const item of others) if (item.samples.some((sample) => !sample.carried && Number.isFinite(sample.value))) filled.add(item.signalId);
  const known = new Set(document.signalCatalog().map((definition) => definition.id));
  const { signalIds, emptyIds } = reportTableColumns(tableIds, options.columnOrder, options.graphIds ?? [], (id) => filled.has(id), (id) => known.has(id));
  if (!signalIds.length) return undefined;
  const { values, labels, rowLabels } = reportTableCells(signalIds, rows.map((row) => signalIds.map((id) => row.values.get(id))));
  return { signalIds, timestamps: rows.map((row) => row.timestamp), values, labels, ...(Object.keys(rowLabels).length ? { rowLabels } : {}), totalRows: rows.length, ...(emptyIds.length ? { emptySignalIds: emptyIds } : {}) };
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
  const json = JSON.stringify(packReportData(data)).replace(/</g, '\\u003c').split(String.fromCharCode(0x2028)).join('\\u2028').split(String.fromCharCode(0x2029)).join('\\u2029');
  const lang = language.toLowerCase().startsWith('ja') ? 'ja' : 'en';
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="generator" content="SigMixa ${escapeHtml(data.appVersion)}"><title>${escapeHtml(data.title)}</title><style>${REPORT_THEME}</style><style>${icons}</style></head><body><div class="report-shell"><header class="report-header"></header><nav class="report-tabs" role="tablist"></nav><main id="app"></main><section id="report-table" hidden></section></div><script type="application/json" id="report-data">${json}</script><script>${bundle}</script></body></html>`;
}

function escapeHtml(text: string): string { return text.replace(/[&<>"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]!); }
