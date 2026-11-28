import assert from 'node:assert/strict';
import test from 'node:test';
import { chartDragDirection, usableValueSelection, valueAtY, valueEdgeLabel, valueSelection } from '../src/webview/shared/chartValueZoom';

const plot = { top: 30, height: 200 };

test('a press is a click until it moves more than the threshold, either way', () => {
  assert.equal(chartDragDirection(6, 0, false), 'none');
  assert.equal(chartDragDirection(0, -6, false), 'none');
  assert.equal(chartDragDirection(4, 5, false), 'none');
  assert.equal(chartDragDirection(7, 2, false), 'time');
  assert.equal(chartDragDirection(2, 7, false), 'value');
  assert.equal(chartDragDirection(-3, -9, false), 'value');
});

test('the longer distance from the press decides at every move, so a drag can turn', () => {
  assert.equal(chartDragDirection(40, 10, true), 'time');
  assert.equal(chartDragDirection(40, 60, true), 'value');
  assert.equal(chartDragDirection(80, 60, true), 'time');
  // Once dragging, coming back near the press still selects: a short drag is not a click again.
  assert.equal(chartDragDirection(1, 2, true), 'value');
  // An exact diagonal stays a time selection, as before vertical selection existed.
  assert.equal(chartDragDirection(30, 30, true), 'time');
});

test('heights map to values with the maximum at the top, kept inside the plot', () => {
  const axis = { minimum: 10, maximum: 20 };
  assert.equal(valueAtY(axis, 30, plot), 20);
  assert.equal(valueAtY(axis, 230, plot), 10);
  assert.equal(valueAtY(axis, 130, plot), 15);
  assert.equal(valueAtY(axis, -100, plot), 20);
  assert.equal(valueAtY(axis, 999, plot), 10);
});

test('a vertical selection covers each axis in its own unit, dragged up or down', () => {
  const axes = [{ minimum: 10, maximum: 20 }, { minimum: 0, maximum: 4000 }];
  const down = valueSelection(axes, 80, 180, plot); const up = valueSelection(axes, 180, 80, plot);
  assert.deepEqual(down, up);
  assert.deepEqual(down, [{ minimum: 12.5, maximum: 17.5 }, { minimum: 1000, maximum: 3000 }]);
  // Normalized display: one 0–100 % axis.
  assert.deepEqual(valueSelection([{ minimum: 0, maximum: 100 }], 30, 130, plot), [{ minimum: 50, maximum: 100 }]);
  // Negative values keep their order.
  assert.deepEqual(valueSelection([{ minimum: -5, maximum: 5 }], 130, 230, plot), [{ minimum: -5, maximum: 0 }]);
});

test('only a selection with height can be zoomed to', () => {
  assert.equal(usableValueSelection(undefined), false);
  assert.equal(usableValueSelection([]), false);
  assert.equal(usableValueSelection([{ minimum: 3, maximum: 3 }]), false);
  assert.equal(usableValueSelection([{ minimum: 3, maximum: Number.NaN }]), false);
  assert.equal(usableValueSelection([{ minimum: 1, maximum: 2 }, { minimum: 0, maximum: 1 }]), true);
  assert.equal(usableValueSelection([{ minimum: 1, maximum: 2 }, { minimum: 1, maximum: 1 }]), false);
});

test('edge values have as many decimals as one pixel of the axis tells apart', () => {
  assert.equal(valueEdgeLabel(18.2727, 11), '18.27');
  assert.equal(valueEdgeLabel(24.31234, .6), '24.312');
  assert.equal(valueEdgeLabel(1534.6, 4000), '1535');
  assert.equal(valueEdgeLabel(0.000123456, 0.0002), '0.000123');
  assert.equal(valueEdgeLabel(-0.0001, 10), '0.00');
  assert.equal(valueEdgeLabel(Number.NaN, 10), '—');
  // A flat or broken span still gives a number.
  assert.equal(valueEdgeLabel(7.4, 0), '7');
  assert.equal(valueEdgeLabel(7.4, Number.POSITIVE_INFINITY), '7');
});
