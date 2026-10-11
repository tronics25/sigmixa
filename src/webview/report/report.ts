// The shim must run before the comparison page asks for `acquireVsCodeApi`.
import { brandIconSvg } from '../shared/brandMark';
import { reportData } from './reportShim';
import '../comparison/comparison';
import { t } from '../shared/i18n';
import { REPORT_TABLE_STYLES, renderReportTable } from './reportTable';

const style = document.createElement('style');
style.textContent = `
body{margin:0}
.report-shell{height:100vh;display:flex;flex-direction:column}
.report-shell #app{height:auto;flex:1;min-height:0}
.report-header{flex:0 0 auto;display:flex;flex-wrap:wrap;align-items:baseline;gap:var(--sm-space-xs) var(--sm-space-lg);padding:var(--sm-space-md) var(--sm-space-lg);border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background)}
.report-header h1{margin:0;font-size:var(--sm-font-page-title);font-weight:var(--sm-weight-semibold)}
.report-header .muted{font-size:var(--sm-font-small)}.report-brand{display:inline-flex;align-self:center;opacity:.8}.report-credit{margin-left:auto;white-space:nowrap}
.report-notices{flex-basis:100%;margin:0;padding:0 0 0 var(--sm-space-lg);color:var(--vscode-editorWarning-foreground);font-size:var(--sm-font-small)}
.report-tabs{flex:0 0 auto;display:flex;gap:var(--sm-space-xs);padding:var(--sm-space-sm) var(--sm-space-lg) 0;border-bottom:1px solid var(--vscode-panel-border)}
.report-tabs button{border:0;border-bottom:2px solid transparent;border-radius:0;background:transparent;padding:var(--sm-space-sm) var(--sm-space-md)}
.report-tabs button[aria-selected=true]{border-bottom-color:var(--vscode-focusBorder);color:var(--vscode-foreground);font-weight:var(--sm-weight-semibold)}
.report-tabs[hidden]{display:none}
#report-table{display:flex;flex:1;min-height:0}
#report-table[hidden],.report-shell #app[hidden]{display:none}
/* A report shows results; it cannot open logs or change what is compared. */
body[data-report] .target-open,body[data-report] .target-remove{display:none}
body[data-report=log] .targets,body[data-report=log] .line-hint{display:none}
${REPORT_TABLE_STYLES}`;
document.head.appendChild(style);

const header = document.querySelector<HTMLElement>('.report-header')!;
const title = document.createElement('h1'); title.textContent = reportData.title;
const meta = document.createElement('span'); meta.className = 'muted';
meta.textContent = reportData.source.join(' · ');
const icon = document.createElement('span'); icon.className = 'report-brand'; icon.innerHTML = brandIconSvg(18); icon.title = 'SigMixa';
// The credit is always in English, at the right end of the title row.
const created = new Date(reportData.generatedAt); const two = (value: number) => String(value).padStart(2, '0');
const credit = document.createElement('span'); credit.className = 'muted report-credit';
credit.textContent = `Created ${created.getFullYear()}-${two(created.getMonth() + 1)}-${two(created.getDate())} ${two(created.getHours())}:${two(created.getMinutes())}:${two(created.getSeconds())} with SigMixa ${reportData.appVersion}`;
header.append(icon, title, meta, credit);
if (reportData.notices.length) {
  const notices = document.createElement('ul'); notices.className = 'report-notices';
  for (const text of reportData.notices) notices.appendChild(Object.assign(document.createElement('li'), { textContent: text }));
  header.appendChild(notices);
}
document.title = reportData.title;

const tabs = document.querySelector<HTMLElement>('.report-tabs')!; const graphs = document.getElementById('app')!; const tableHost = document.getElementById('report-table')!;
if (reportData.table) {
  renderReportTable(tableHost, reportData.table, reportData.definitions);
  for (const [id, label] of [['graphs', t('Graphs', 'グラフ')], ['table', t('Table', 'テーブル')]] as const) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.setAttribute('role', 'tab'); button.setAttribute('aria-selected', String(id === 'graphs'));
    button.addEventListener('click', () => { tabs.querySelectorAll('button').forEach((item) => item.setAttribute('aria-selected', String(item === button))); graphs.hidden = id !== 'graphs'; tableHost.hidden = id !== 'table'; window.dispatchEvent(new Event('resize')); });
    tabs.appendChild(button);
  }
} else tabs.hidden = true;
