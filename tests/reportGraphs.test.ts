import test from 'node:test';
import assert from 'node:assert/strict';
import { reportGraphs } from '../src/extension/report/reportGraphs';

test('each exported XYZ series retains its source trajectory display settings', () => {
  // A view saved by an older version may still hold the presets' mirror flag; the report keeps only the camera.
  const camera = { yaw: 1, pitch: .4, zoom: 2, panX: 3, panY: -4, mirrorHorizontal: true };
  const graphs = reportGraphs({ visualizeViews: [{ id: 'trajectory', kind: 'trajectory', name: 'Vehicle', height: 530, settings: {
    trajectorySeries: [{ id: 'front', name: 'Front', xId: 'fx', yId: 'fy', zId: 'fz' }, { id: 'rear', name: 'Rear', xId: 'rx', yId: 'ry' }],
    trajectoryInvert: { x: true, y: false, z: true }, trajectoryView: camera, trajectoryCoordinateSystem: 'left',
    trajectoryEqualAspect: false, trajectoryShowPoints: false, trajectoryShowGrid: false,
    trajectoryConnectGaps: false, trajectoryTrail: 'last-seconds', trajectoryTrailSeconds: 2.5,
  } }] }, 17.25);
  assert.deepEqual(graphs.map((graph) => graph.axes), [{ x: 'fx', y: 'fy', z: 'fz' }, { x: 'rx', y: 'ry', z: undefined }]);
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

test('legacy trajectory axes use the same defaults as Visualize', () => {
  const [graph] = reportGraphs({ visualizeViews: [{ id: 't', kind: 'trajectory', name: 'Path', settings: { trajectoryXId: 'x', trajectoryYId: 'y' } }] });
  assert.deepEqual(graph.signalIds, ['x', 'y']); assert.equal(graph.showPoints, true);
  assert.deepEqual(graph.trajectoryTrail, { type: 'all' });
});

test('table-only reports do not require a Visualize graph', () => {
  assert.deepEqual(reportGraphs({ tableSelectedIds: ['speed'], visualizeViews: [] }), []);
});
