import type { ComparisonGraphDefinition } from '../../core/project/comparison';
import { trajectoryViewFrom } from '../../core/trajectory/trajectory';
import type { LogViewState } from '../editors/rawLogProtocol';

/** The Visualize tab's graphs as report graphs. A trajectory view with several XYZ series becomes one trajectory per series. */
export function reportGraphs(state: Partial<LogViewState>, trajectoryCurrentTime?: number, defaultName = 'Graph'): ComparisonGraphDefinition[] {
  const views = state.visualizeViews ?? [{ id: 'graph', kind: 'graph' as const, name: defaultName, settings: state }];
  return views.flatMap((view): ComparisonGraphDefinition[] => {
    const settings = view.settings ?? {};
    if (view.kind === 'graph') return [{ id: view.id, kind: 'graph', name: view.name, signalIds: [...(settings.chartSelectedIds ?? [])], mode: settings.chartMode, connectGaps: settings.chartConnectGaps, ...(settings.chartAxisRange ? { axisRange: { mode: settings.chartAxisRange.mode === 'global' ? 'global' : 'visible', includeZero: settings.chartAxisRange.includeZero } } : {}), ...(view.height ? { height: view.height } : {}), ...(settings.chartLanesExpanded ? { lanes: true } : {}) }];
    const series = settings.trajectorySeries?.length ? settings.trajectorySeries : [{ id: 'series', name: '', xId: settings.trajectoryXId, yId: settings.trajectoryYId, zId: settings.trajectoryZId }];
    return series.filter((item) => item.xId && item.yId).map((item) => ({
      id: `${view.id}:${item.id}`, kind: 'trajectory', name: series.length > 1 ? `${view.name} · ${item.name}` : view.name,
      axes: { x: item.xId, y: item.yId, z: item.zId }, signalIds: [item.xId, item.yId, item.zId].filter((id): id is string => Boolean(id)),
      equalAspect: settings.trajectoryEqualAspect, showPoints: settings.trajectoryShowPoints !== false,
      showGrid: settings.trajectoryShowGrid, connectGaps: settings.trajectoryConnectGaps,
      invert: settings.trajectoryInvert, trajectoryView: settings.trajectoryView && trajectoryViewFrom(settings.trajectoryView), trajectoryViewFit: settings.trajectoryViewFit, coordinateSystem: settings.trajectoryCoordinateSystem,
      trajectoryTrail: settings.trajectoryTrail === 'last-seconds'
        ? { type: 'last-seconds', seconds: settings.trajectoryTrailSeconds ?? 10 }
        : { type: settings.trajectoryTrail ?? 'all' },
      trajectoryCurrentTime, height: view.height,
    }));
  });
}
