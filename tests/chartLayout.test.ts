import { chartAxisGeometry } from '../src/webview/shared/chartAxes';
import assert from 'node:assert/strict';
import test from 'node:test';
import { arrangeSingleChartGroups, arrangeChartGroups, findGraphIndexBySignals, moveChartGroup, moveChartGroupToNewGraph } from '../src/webview/shared/chartLayout';

const groups = ['speed', 'rpm', 'torque', 'power'].map((key) => ({ key }));

test('chart groups use automatic pairs until a custom layout is supplied', () => {
  assert.deepEqual(arrangeChartGroups(groups).map((graph) => graph.map((group) => group.key)), [['speed', 'rpm'], ['torque', 'power']]);
  assert.deepEqual(arrangeChartGroups(groups, [['torque', 'rpm']]).map((graph) => graph.map((group) => group.key)), [['torque', 'rpm'], ['speed', 'power']]);
});

test('dropping on an occupied axis swaps systems without losing one', () => {
  assert.deepEqual(moveChartGroup([['speed', 'rpm'], ['torque', 'power']], 'speed', 1, 1), [['power', 'rpm'], ['torque', 'speed']]);
});

test('systems can move to an available axis or a separate graph', () => {
  assert.deepEqual(moveChartGroup([['speed', 'rpm'], ['torque']], 'rpm', 1, 1), [['speed'], ['torque', 'rpm']]);
  assert.deepEqual(moveChartGroupToNewGraph([['speed', 'rpm'], ['torque']], 'speed'), [['rpm'], ['torque'], ['speed']]);
});

test('graph overlays follow their captured Signals after graph reordering', () => {
  assert.equal(findGraphIndexBySignals([['torque'], ['speed', 'rpm']], ['speed', 'rpm']), 1);
  assert.equal(findGraphIndexBySignals([['rpm'], ['torque']], ['speed', 'rpm']), 0);
  assert.equal(findGraphIndexBySignals([['torque']], ['speed', 'rpm']), undefined);
});

test('a single graph keeps every unit system from a legacy multi-row layout', () => {
  const selected = [...groups, { key: 'temperature' }, { key: 'pressure' }];
  const result = arrangeSingleChartGroups(selected, [['torque', 'rpm'], ['speed', 'power'], ['torque', 'removed']]);
  assert.deepEqual(result.map((group) => group.key), ['torque', 'rpm', 'speed', 'power', 'temperature', 'pressure']);
  assert.equal(new Set(result).size, selected.length);
  assert.deepEqual(arrangeSingleChartGroups(selected), selected);
});

test('multiple Y axes preserve plot space without overflowing a narrow view', () => {
  for (const width of [240, 640, 1000, 1600]) {
    for (const count of [1, 2, 3, 4, 10, 20]) {
      const geometry = chartAxisGeometry(width, count);
      assert.ok(geometry.plotWidth >= width * .5 - 1e-9);
      assert.ok(Math.abs(geometry.left + geometry.right + geometry.plotWidth - width) < 1e-9);
      assert.equal(geometry.left, Math.ceil(count / 2) * geometry.axisWidth);
      assert.ok(geometry.axisWidth > 0);
    }
  }
  assert.deepEqual(chartAxisGeometry(640, 2), { left: 92, right: 92, plotWidth: 456, axisWidth: 92 });
});
