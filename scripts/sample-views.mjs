// Prepared Visualize views for the sample: several graph and trajectory views per log, as 2.0.0 saves them.
// Each graph shows at most two unit systems on real-value axes; `axes` lists them in axis order.

export const COLORS = [
  '#2563eb', '#f97316', '#16a34a', '#dc2626', '#7c3aed', '#0891b2', '#ca8a04', '#db2777', '#4b5563', '#65a30d',
];

export function graph(id, name, signalIds, axes, height = 240) {
  return {
    id, kind: 'graph', name, height,
    settings: {
      chartSelectedIds: signalIds, chartColors: Object.fromEntries(signalIds.map((signalId, index) => [signalId, COLORS[index % COLORS.length]])),
      chartMode: 'raw', chartConnectGaps: true, chartAxisRange: { mode: 'visible', includeZero: false }, chartGroupLayout: [axes], chartSignalGrouping: 'frame',
    },
  };
}

/** `series`: [{ id, name, xId, yId, zId? }]; without zId the view is 2D. */
export function trajectory(id, name, series, options = {}) {
  return {
    id, kind: 'trajectory', name, height: options.height ?? 380,
    settings: {
      trajectorySeries: series, trajectoryXId: series[0].xId, trajectoryYId: series[0].yId, ...(series[0].zId ? { trajectoryZId: series[0].zId } : {}),
      trajectoryInvert: { x: false, y: false, z: false }, trajectoryEqualAspect: options.equalAspect ?? true, trajectoryConnectGaps: options.connectGaps ?? true,
      trajectoryShowGrid: true, trajectoryShowPoints: options.showPoints ?? false, trajectoryTrail: options.trail ?? 'all', trajectoryTrailSeconds: 10,
      ...(options.view ? { trajectoryView: options.view } : {}),
    },
  };
}

export const TRACE_COLUMNS = ['channel', 'direction', 'receivedAt', 'age', 'count', 'interval', 'minInterval', 'maxInterval', 'expected', 'deviation'];
/** Pinned trace rows are CAN IDs: standard IDs as `s:<decimal>`. */
export const pinned = (...canIds) => canIds.map((canId) => `s:${canId}`);

/** Views for brake analysis: 300 (and 3C0 in the trace), which every brake log carries. */
export function brakeViews(name, extraViews = []) {
  return logView([
    graph('view-brake', `${name}: Brake Pressure and Wheel Speed`, ['sig-brake-pressure', 'sig-wheel-speed-fl'], ['family:pressure', 'family:speed']),
    graph('view-pedal', 'Brake Pedal', ['sig-pedal'], ['family:percentage'], 200),
    ...extraViews,
  ], { traceSettings: { pinnedIds: pinned(0x300, 0x3c0), defaultMode: 'decoded', columns: TRACE_COLUMNS, sort: 'canId', descending: false } });
}

export function logView(views, extra = {}) {
  return {
    // Graph settings start closed, so the views use the full width.
    activeTab: 'visualize-view', visualizeViews: views, visualizeSelectedViewId: views[0].id, visualizeOptionsCollapsed: true,
    chartSignalGrouping: 'frame', tableSignalGrouping: 'frame',
    ...extra,
  };
}
