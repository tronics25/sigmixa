import type { ComparisonGraphDefinition } from '../../core/project/comparison';
import type { RawLogDocument } from '../editors/rawLogDocument';
import type { LogViewState } from '../editors/rawLogProtocol';
import { t } from '../i18n';
import type { ReportAnalysis, ReportFrameIntervals } from './reportData';

/** How many more Signals than its views show a report embeds, for views added or changed in the report. */
const MORE_STATES = 24;
const MORE_DISTRIBUTIONS = 16;

/**
 * The frame timing, receive interval, state timeline and distribution views of Visualize as views of a log report, with
 * what they are drawn from. The data is embedded whether or not Visualize has such views, so they can be added in the
 * report: every CAN ID's receive times, the Signals with state names, and the distribution of the graphs' Signals.
 * `notices` gets a line for whatever is embedded as a summary only. `catalogOf` gives the Signal list entries of the
 * embedded Signals, as the report's own catalog is made.
 */
export function reportAnalysis(document: RawLogDocument, state: Partial<LogViewState>, range: { start: number; end: number }, graphSignalIds: readonly string[], notices: string[], catalogOf?: (signalIds: ReadonlySet<string>) => Pick<ReportAnalysis, 'definitions' | 'groups'>): { views: ComparisonGraphDefinition[]; analysis?: ReportAnalysis } {
  const frames = document.reportFrameTiming(range); const views: ComparisonGraphDefinition[] = []; const intervals: ReportFrameIntervals[] = [];
  const stateIds: string[] = []; const distributionIds: string[] = [];
  for (const view of state.visualizeViews ?? []) {
    const settings = view.settings ?? {}; const head = { id: view.id, name: view.name, signalIds: [] as string[] };
    if (view.kind === 'frameTiming') views.push({ ...head, kind: 'frameTiming', hiddenCanKeys: [...(settings.frameTimingHiddenKeys ?? [])] });
    else if (view.kind === 'frameInterval') {
      const keys: string[] = [];
      // As in Visualize: chosen CAN IDs (none, when all were deselected), else the one saved before, else the default.
      for (const wanted of settings.frameIntervalKeys ?? [settings.frameIntervalKey]) {
        const data = document.reportFrameIntervals(wanted, range); if (!data?.key || keys.includes(data.key)) continue; keys.push(data.key);
        // A CAN ID is drawn from its receive times; when those are too many to embed, from its intervals per slice.
        if (!frames.find((row) => row.key === data.key)?.times && !intervals.some((item) => item.key === data.key)) intervals.push({ ...data, times: undefined, ...(data.times ? document.reportFrameIntervals(data.key, range, 0) : {}) });
      }
      if (keys.length || settings.frameIntervalKeys?.length === 0) views.push({ ...head, kind: 'frameInterval', canKeys: keys });
    } else if (view.kind === 'stateTimeline') { const ids = [...(settings.stateTimelineIds ?? document.newViewSignals('stateTimeline'))]; stateIds.push(...ids); views.push({ ...head, kind: 'stateTimeline', signalIds: ids }); }
    else if (view.kind === 'distribution') { const ids = [...(settings.distributionIds ?? document.newViewSignals('distribution'))]; distributionIds.push(...ids); views.push({ ...head, kind: 'distribution', signalIds: ids }); }
  }
  // A CAN ID with too many frames to embed its receive times gets its intervals per slice too, so a receive interval view
  // can still be added for it in the report.
  for (const row of frames) if (!row.times && !intervals.some((item) => item.key === row.key)) { const data = document.reportFrameIntervals(row.key, range, 0); if (data?.key) intervals.push({ ...data, times: undefined }); }
  const states = document.reportStateTimeline([...new Set([...stateIds, ...document.newViewSignals('stateTimeline', MORE_STATES)])], range);
  const distributions = document.reportDistribution([...new Set([...distributionIds, ...graphSignalIds.slice(0, MORE_DISTRIBUTIONS), ...document.newViewSignals('distribution')])], range);
  if (views.some((view) => view.kind === 'frameTiming') && frames.some((row) => !row.times)) notices.push(t('Frame timing: CAN IDs with very many frames show how many frames each slice of time has, not every frame.', 'フレームタイミング: フレーム数が非常に多いCAN IDは、1件ごとではなく時間ごとの件数で表示します。'));
  if (views.some((view) => view.kind === 'frameInterval' && view.canKeys?.some((key) => intervals.some((item) => item.key === key)))) notices.push(t('Receive interval: a CAN ID with very many frames shows the range of its intervals in each slice of time, not every frame.', '受信間隔: フレーム数が非常に多いCAN IDは、1件ごとではなく時間ごとの範囲で表示します。'));
  if (states.some((row) => row.bins && stateIds.includes(row.signalId))) notices.push(t('State timeline: Signals that change very often show the longest-lasting state in each slice of time, not every change.', '状態タイムライン: 変化が非常に多いシグナルは、変化ごとではなく時間ごとに最も長い状態で表示します。'));
  const empty = !frames.length && !states.length && !distributions.length;
  const catalog = catalogOf?.(new Set([...states.map((row) => row.signalId), ...distributions.map((row) => row.signalId)]));
  return { views, ...(empty ? {} : { analysis: { frames, intervals, states, distributions, ...catalog } }) };
}

/** The report's graphs and analysis views in the order their views have in Visualize; anything else keeps its place after them. */
export function inVisualizeOrder(state: Partial<LogViewState>, definitions: readonly ComparisonGraphDefinition[]): ComparisonGraphDefinition[] {
  const order = (state.visualizeViews ?? []).map((view) => view.id); const rank = (id: string) => { const at = order.indexOf(id); return at < 0 ? order.length : at; };
  return definitions.map((definition, index) => ({ definition, index })).sort((left, right) => rank(left.definition.id) - rank(right.definition.id) || left.index - right.index).map((item) => item.definition);
}
