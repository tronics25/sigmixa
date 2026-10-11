import { reorderComparisonTargets, sampleTimes, setComparisonTargetOffset, snapAnchor, stepAnchor, type ComparisonDefinition } from '../../core/project/comparison';
import type { SignalSample } from '../../core/signal/signal';
import type { ComparisonSeriesDto, ComparisonToExtension, ComparisonToWebview } from '../../extension/comparison/comparisonProtocol';
import type { ReportData } from '../../extension/report/reportData';

/**
 * Stands in for the extension inside a standalone report: the comparison page talks to it exactly as it
 * talks to VS Code, and every answer comes from the data embedded in the HTML file. Nothing is fetched.
 */
export const reportData = JSON.parse(document.getElementById('report-data')!.textContent!) as ReportData;

let comparison: ComparisonDefinition = reportData.comparison;
const seriesByTarget = new Map(reportData.series.map((entry) => [entry.targetId, new Map(entry.items.map((item) => [item.signalId, item]))]));
const targetTimes = new Map<string, number[]>();

function send(message: ComparisonToWebview): void { setTimeout(() => window.dispatchEvent(new MessageEvent('message', { data: message })), 0); }
function start(targetId: string): number { return reportData.targets.find((target) => target.id === targetId)?.start ?? 0; }

/** Sample times of one target, used to step the time shift the way the extension steps CAN timestamps. */
function times(targetId: string): number[] {
  let value = targetTimes.get(targetId);
  if (!value) { value = [...new Set([...(seriesByTarget.get(targetId)?.values() ?? [])].flatMap((item) => item.series.samples.map((sample) => sample.timestamp)))].sort((a, b) => a - b); targetTimes.set(targetId, value); }
  return value;
}

function nearest(samples: readonly SignalSample[], timestamp: number): SignalSample | undefined {
  let low = 0; let high = samples.length - 1; if (high < 0) return undefined;
  while (low < high) { const middle = (low + high) >> 1; if (samples[middle].timestamp < timestamp) low = middle + 1; else high = middle; }
  const after = samples[low]; const before = samples[low - 1];
  return before && Math.abs(before.timestamp - timestamp) <= Math.abs(after.timestamp - timestamp) ? before : after;
}

function handle(message: ComparisonToExtension): void {
  switch (message.type) {
    case 'ready':
      send({ type: 'init', comparison }); send({ type: 'targets', targets: reportData.targets });
      send({ type: 'catalog', definitions: reportData.definitions, groups: reportData.groups, availability: reportData.availability }); if (reportData.clipSpans?.length) send({ type: 'clipSpans', clips: reportData.clipSpans }); send({ type: 'reload' });
      return;
    case 'seriesRequest': {
      const wanted = new Set(message.signalIds);
      send({ type: 'series', requestId: message.requestId, graphId: message.graphId, seriesByTarget: reportData.targets.map((target) => ({ targetId: target.id, series: [...(seriesByTarget.get(target.id)?.values() ?? [])].filter((item: ComparisonSeriesDto) => wanted.has(item.signalId)) })) });
      return;
    }
    case 'measuredSignalsRequest': {
      const series = seriesByTarget.get(message.targetId);
      const samples = message.signalIds.flatMap((signalId) => { const sample = series?.get(signalId) ? nearest(series.get(signalId)!.series.samples, message.timestamp) : undefined; return sample ? [{ signalId, sample }] : []; });
      send({ type: 'measuredSignals', requestId: message.requestId, samples }); return;
    }
    case 'shiftOffset': case 'setOffset': case 'resetOffset': {
      // The same stepping as the comparison screen (it may shift either way, past the first or last time), over the times
      // the report has: its samples.
      const list = times(message.targetId); const base = start(message.targetId); const current = comparison.targets.find((target) => target.id === message.targetId)?.offset ?? 0;
      if (!list.length) return;
      const frameTimes = sampleTimes(list); let anchor = snapAnchor(frameTimes, base + current);
      if (message.type === 'resetOffset') anchor = base;
      else if (message.type === 'setOffset') anchor = snapAnchor(frameTimes, base + message.offset);
      else { const steps = Math.max(1, Math.min(100, Math.floor(message.steps ?? 1))); for (let step = 0; step < steps; step++) anchor = stepAnchor(frameTimes, anchor, message.direction); }
      comparison = setComparisonTargetOffset(comparison, message.targetId, anchor - base); send({ type: 'comparison', comparison }); return;
    }
    case 'reorderTargets': comparison = reorderComparisonTargets(comparison, message.order); send({ type: 'comparison', comparison }); return;
    case 'update': comparison = { ...comparison, ...message.comparison }; return;
    case 'exportAll': case 'saveComparisonImage': {
      if (!message.pngDataUrl) return;
      const link = document.createElement('a'); link.href = message.pngDataUrl; link.download = `${reportData.title.replace(/[\\/:*?"<>|]+/g, '_')}.png`; link.click(); return;
    }
    default: return;
  }
}

(window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({ postMessage: handle, getState: () => undefined, setState: () => undefined });
document.body.dataset.report = reportData.kind;
