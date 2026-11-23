// Runs after the shim and before the comparison page: the page makes its cards as soon as it starts.
import type { ReportViewKind } from '../../core/project/comparison';
import { comparisonParts } from '../comparison/comparisonParts';
import { reportData } from './reportShim';
import { REPORT_VIEW_KINDS, ReportViewCard, isReportViewKind, newReportView } from './reportViewCard';

const analysis = reportData.analysis;
if (analysis) {
  comparisonParts.makeCard = (definition, host, list, optionsHost) => isReportViewKind(definition.kind) ? new ReportViewCard(definition, host, list, optionsHost, analysis) : undefined;
  // **Add view** lists the kinds the report has something to draw from.
  for (const kind of Object.keys(REPORT_VIEW_KINDS) as ReportViewKind[]) {
    if (newReportView(kind, analysis)) comparisonParts.moreViews.push({ kind, label: REPORT_VIEW_KINDS[kind].label(), icon: REPORT_VIEW_KINDS[kind].icon, settings: () => newReportView(kind, analysis) ?? {} });
  }
}
