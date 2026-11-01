import test from 'node:test';
import assert from 'node:assert/strict';
import { reportGraphs } from '../src/extension/report/reportGraphs';
import { trajectorySeriesColor } from '../src/core/trajectory/trajectory';

test('a trajectory with several XYZ series stays one graph, with its display settings', () => {
  // A view saved by an older version may still hold the presets' mirror flag; the report keeps only the camera.
  const camera = { yaw: 1, pitch: .4, zoom: 2, panX: 3, panY: -4, mirrorHorizontal: true };
  const graphs = reportGraphs({ visualizeViews: [{ id: 'trajectory', kind: 'trajectory', name: 'Vehicle', height: 530, settings: {
    trajectorySeries: [{ id: 'front', name: 'Front', xId: 'fx', yId: 'fy', zId: 'fz' }, { id: 'rear', name: 'Rear', xId: 'rx', yId: 'ry' }],
    trajectoryInvert: { x: true, y: false, z: true }, trajectoryView: camera, trajectoryCoordinateSystem: 'left',
    trajectoryEqualAspect: false, trajectoryShowPoints: false, trajectoryShowGrid: false,
    trajectoryConnectGaps: false, trajectoryTrail: 'last-seconds', trajectoryTrailSeconds: 2.5,
  } }] }, 17.25);
  assert.equal(graphs.length, 1); assert.equal(graphs[0].name, 'Vehicle'); assert.equal(graphs[0].axes, undefined);
  assert.deepEqual(graphs[0].trajectorySeries?.map((series) => [series.name, series.axes]), [['Front', { x: 'fx', y: 'fy', z: 'fz' }], ['Rear', { x: 'rx', y: 'ry', z: undefined }]]);
  assert.deepEqual(graphs[0].signalIds, ['fx', 'fy', 'fz', 'rx', 'ry']);
  for (const graph of graphs) {
    assert.deepEqual(graph.trajectoryView, { yaw: 1, pitch: .4, zoom: 2, panX: 3, panY: -4 });
    assert.equal(graph.coordinateSystem, 'left');
    assert.deepEqual(graph.invert, { x: true, y: false, z: true });
    assert.deepEqual(graph.trajectoryTrail, { type: 'last-seconds', seconds: 2.5 });
    assert.equal(graph.trajectoryCurrentTime, 17.25); assert.equal(graph.height, 530);
    assert.equal(graph.equalAspect, false); assert.equal(graph.showPoints, false);
    assert.equal(graph.showGrid, false); assert.equal(graph.connectGaps, false);
  }
});

test('an unfinished series is left out and the others keep their Visualize colours', () => {
  const [graph] = reportGraphs({ visualizeViews: [{ id: 't', kind: 'trajectory', name: 'Path', settings: { trajectorySeries: [
    { id: 'a', name: 'A', xId: 'ax', yId: 'ay' }, { id: 'empty', name: 'Empty', xId: 'ex' }, { id: 'c', name: 'C', xId: 'cx', yId: 'cy' },
  ] } }] });
  assert.deepEqual(graph.trajectorySeries?.map((series) => series.color), [trajectorySeriesColor(0), trajectorySeriesColor(2)]);
  const [single] = reportGraphs({ visualizeViews: [{ id: 't', kind: 'trajectory', name: 'Path', settings: { trajectorySeries: [{ id: 'a', name: 'A', xId: 'ax', yId: 'ay' }, { id: 'empty', name: 'Empty' }] } }] });
  assert.equal(single.trajectorySeries, undefined); assert.deepEqual(single.axes, { x: 'ax', y: 'ay', z: undefined }); assert.equal(single.name, 'Path');
});

test('legacy trajectory axes use the same defaults as Visualize', () => {
  const [graph] = reportGraphs({ visualizeViews: [{ id: 't', kind: 'trajectory', name: 'Path', settings: { trajectoryXId: 'x', trajectoryYId: 'y' } }] });
  assert.deepEqual(graph.signalIds, ['x', 'y']); assert.equal(graph.showPoints, true);
  assert.deepEqual(graph.trajectoryTrail, { type: 'all' });
});

test('table-only reports do not require a Visualize graph', () => {
  assert.deepEqual(reportGraphs({ tableSelectedIds: ['speed'], visualizeViews: [] }), []);
});

test('a graph with its lanes open keeps them open in the report', () => {
  const [open, closed] = reportGraphs({ visualizeViews: [
    { id: 'a', kind: 'graph', name: 'A', settings: { chartSelectedIds: ['speed'], chartLanesExpanded: true } },
    { id: 'b', kind: 'graph', name: 'B', settings: { chartSelectedIds: ['speed'] } },
  ] });
  assert.equal(open.lanes, true); assert.equal(closed.lanes, undefined);
});

test('each report graph keeps its own Visualize axis order and colours', () => {
  const graphs = reportGraphs({ visualizeViews: [
    { id: 'a', kind: 'graph', name: 'A', settings: { chartSelectedIds: ['rpm', 'speed'], chartGroupLayout: [['unit:rpm', 'family:speed']], chartColors: { rpm: '#111111', speed: '#222222' } } },
    { id: 'b', kind: 'graph', name: 'B', settings: { chartSelectedIds: ['rpm'], chartColors: { rpm: '#333333' } } },
  ] });
  assert.deepEqual(graphs.map((graph) => [graph.axisOrder, graph.colors]), [
    [['unit:rpm', 'family:speed'], { rpm: '#111111', speed: '#222222' }],
    [undefined, { rpm: '#333333' }],
  ]);
});
