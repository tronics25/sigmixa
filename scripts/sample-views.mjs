// Prepared Visualize views for the sample: several graph and trajectory views per log, as 2.0.0 saves them.
// Each graph shows at most two unit systems on real-value axes; `axes` lists them in axis order.

export const COLORS = [
  '#2563eb', '#f97316', '#16a34a', '#dc2626', '#7c3aed', '#0891b2', '#ca8a04', '#db2777', '#4b5563', '#65a30d',
];
/** Colours by meaning, the same in every view: speed blue, engine green, accelerator orange, brake red. */
export const SIGNAL_COLORS = {
  'sig-speed': '#2563eb', 'sig-smoothed-speed': '#93c5fd', 'sig-motion-speed': '#2563eb', 'sig-wheel-speed-fl': '#0ea5e9', 'sig-wheel-speed-fr': '#6366f1',
  'sig-engine-speed': '#16a34a', 'sig-engine-torque': '#7c3aed', 'sig-accelerator': '#f97316',
  'sig-brake-pressure': '#dc2626', 'sig-pedal': '#ec4899', 'sig-pedal-pressure-ratio': '#7c3aed',
  'sig-coolant-temp': '#0891b2', 'sig-temp': '#db2777',
  'sig-gear-position': '#ca8a04', 'sig-drive-mode': '#65a30d', 'sig-drive-state': '#65a30d', 'sig-door-module-state': '#4b5563',
  'sig-turn-left': '#d946ef', 'sig-turn-right': '#8b5cf6',
  'sig-object-distance': '#0d9488', 'mdf::Vehicle%20Speed': '#2563eb', 'mdf:Reference:Vehicle%20Speed': '#93c5fd', 'mdf::Coolant%20Temperature': '#0891b2', 'mdf:Reference:Coolant%20Temperature': '#67e8f9', 'sig-batt': '#ca8a04', 'sig-mechanical-power': '#16a34a', 'sig-smoothed-brake-pressure': '#f97316', 'sig-brake-level': '#dc2626', 'sig-gnss-satellites': '#db2777', 'sig-obstacle-distance': '#0d9488', 'sig-mux-mode': '#7c3aed', 'sig-gnss-fix': '#16a34a', 'sig-transmission-gear': '#16a34a', 'sig-road-type': '#2563eb', 'sig-brake-phase': '#dc2626', 'sig-collision-warning': '#0d9488', 'sig-relative-speed': '#7c3aed', 'sig-wheel-speed-difference': '#0ea5e9', 'sig-steering-angle': '#7c3aed', 'sig-inner-wheel-difference': '#f97316',
  'sig-pose-z': '#0891b2', 'sig-gnss-z': '#f97316', 'sig-road-grade': '#ca8a04',
};

export function graph(id, name, signalIds, axes, height = 240, options = {}) {
  return {
    id, kind: 'graph', name, height,
    settings: {
      chartSelectedIds: signalIds, chartColors: Object.fromEntries(signalIds.map((signalId, index) => [signalId, SIGNAL_COLORS[signalId] ?? COLORS[index % COLORS.length]])),
      chartMode: 'raw', chartConnectGaps: true, chartAxisRange: { mode: 'visible', includeZero: false }, chartGroupLayout: [axes], chartSignalGrouping: 'frame',
      ...(options.lanes ? { chartLanesExpanded: true } : {}),
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

// The views that size themselves to their content: no height.
/** CAN ID key of the timing views: `s:<decimal>` (standard) or `e:<decimal>` (extended). */
export const canKey = (canId, extended = false) => `${extended ? 'e' : 's'}:${canId}`;
export const stateTimeline = (id, name, signalIds) => ({ id, kind: 'stateTimeline', name, settings: { stateTimelineIds: signalIds } });
export const distribution = (id, name, signalIds) => ({ id, kind: 'distribution', name, settings: { distributionIds: signalIds } });
export const frameTiming = (id, name, hiddenKeys = []) => ({ id, kind: 'frameTiming', name, settings: { frameTimingHiddenKeys: hiddenKeys } });
export const frameInterval = (id, name, keys) => ({ id, kind: 'frameInterval', name, settings: { frameIntervalKeys: keys } });

export const TRACE_COLUMNS = ['channel', 'direction', 'receivedAt', 'age', 'count', 'interval', 'minInterval', 'maxInterval', 'expected', 'deviation'];
/** Pinned trace rows are CAN IDs: standard IDs as `s:<decimal>`. */
export const pinned = (...canIds) => canIds.map((canId) => `s:${canId}`);

/** Views for brake analysis: 300 (and 3C0 in the trace), which every brake log carries. */
export function brakeViews(extraViews = []) {
  return logView([
    // The driver's input, the pressure it gives, and the wheel slowing down.
    graph('view-pedal', 'Brake Pedal', ['sig-pedal'], ['family:percentage'], 200),
    graph('view-brake', 'Brake Pressure and Wheel Speed', ['sig-brake-pressure', 'sig-wheel-speed-fl'], ['family:pressure', 'family:speed']),
    ...extraViews,
  ], { traceSettings: { pinnedIds: pinned(0x300, 0x3c0), defaultMode: 'decoded', columns: TRACE_COLUMNS, sort: 'canId', descending: false } });
}

/** A log's own views ("This file"), kept beside the group's: the log opens with the group's, and the switch shows these. */
export const fileView = (views, extra = {}, scope = 'group') => ({ ...logView(views, extra), viewStateScope: scope });

export function logView(views, extra = {}) {
  return {
    // Graph settings start closed, so the views use the full width.
    activeTab: 'visualize-view', visualizeViews: views, visualizeSelectedViewId: views[0].id, visualizeOptionsCollapsed: true,
    chartSignalGrouping: 'frame', tableSignalGrouping: 'frame',
    ...extra,
  };
}
