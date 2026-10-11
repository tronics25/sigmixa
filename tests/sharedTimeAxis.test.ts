import test from 'node:test';
import assert from 'node:assert/strict';
import { SharedTimeAxis } from '../src/core/timeline/sharedTimeAxis';

test('the axis spans every graph, and all of it is shown until someone zooms', () => {
  const axis = new SharedTimeAxis(); axis.report('a', { start: 2, end: 10 });
  assert.deepEqual(axis.view, { start: 2, end: 10 });
  axis.report('b', { start: 0, end: 6 });
  assert.deepEqual(axis.full, { start: 0, end: 10 }); assert.deepEqual(axis.view, { start: 0, end: 10 }); assert.equal(axis.zoomed, false);
});

test('zooming one graph is what every graph shows, and a new graph does not undo it', () => {
  const axis = new SharedTimeAxis(); axis.report('a', { start: 0, end: 10 });
  let told = 0; axis.subscribe(() => told++);
  axis.setView({ start: 4, end: 6 });
  assert.deepEqual(axis.view, { start: 4, end: 6 }); assert.equal(axis.zoomed, true); assert.equal(told, 1);
  axis.report('b', { start: 0, end: 20 });
  assert.deepEqual(axis.full, { start: 0, end: 20 }); assert.deepEqual(axis.view, { start: 4, end: 6 });
  axis.reset(); assert.deepEqual(axis.view, { start: 0, end: 20 });
});

test('zoom keeps the pivot in place and stays inside the axis; pan stops at the ends', () => {
  const axis = new SharedTimeAxis(); axis.report('a', { start: 0, end: 10 });
  axis.zoom(0.5, 2); assert.deepEqual(axis.view, { start: 1, end: 6 });
  axis.zoom(100); assert.deepEqual(axis.view, { start: 0, end: 10 });
  axis.zoom(0.5); axis.pan(-1); axis.pan(-1); axis.pan(-1); axis.pan(-1); assert.deepEqual(axis.view, { start: 0, end: 5 });
  for (let i = 0; i < 40; i++) axis.zoom(0.5); assert.equal(axis.canZoomIn, false); assert.ok(Math.abs((axis.view!.end - axis.view!.start) - 0.05) < 1e-9);
});

test('a graph that loses its data leaves the axis; with none left there is no axis', () => {
  const axis = new SharedTimeAxis(); axis.report('a', { start: 0, end: 10 }); axis.report('b', { start: 5, end: 30 });
  axis.setView({ start: 20, end: 25 }); axis.report('b', undefined);
  assert.deepEqual(axis.full, { start: 0, end: 10 }); assert.deepEqual(axis.view, { start: 0, end: 10 }, 'what was shown is gone, so everything is shown');
  axis.report('a', undefined); assert.equal(axis.full, undefined); assert.equal(axis.view, undefined);
});

test('reporting the same span again tells nobody', () => {
  const axis = new SharedTimeAxis(); axis.report('a', { start: 0, end: 10 }); let told = 0; axis.subscribe(() => told++);
  axis.report('a', { start: 0, end: 10 }); axis.report('missing', undefined); assert.equal(told, 0);
});
