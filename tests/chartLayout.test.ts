import assert from 'node:assert/strict';
import test from 'node:test';
import { arrangeChartGroups, findGraphIndexBySignals, moveChartGroup, moveChartGroupToNewGraph } from '../src/webview/shared/chartLayout';

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
