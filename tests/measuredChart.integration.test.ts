import test from 'node:test';
import assert from 'node:assert/strict';
import { TimeSeriesView } from '../src/webview/timeseries/timeSeriesView';
import { MeasuredSamples } from '../src/webview/shared/measuredSamples';
import { InMemorySignalStore } from '../src/core/signal/signalStore';

test('hover follows the rendered line while fixed and exported markers use original measurements', () => {
  // Exercise the production canvas renderer without a VS Code window or browser.
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const originalStyle = Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle');
  Object.defineProperty(globalThis, 'document', { value: { documentElement: {} }, configurable: true });
  Object.defineProperty(globalThis, 'getComputedStyle', { value: () => ({ getPropertyValue: () => '' }), configurable: true });
  try {
    const store = new InMemorySignalStore();
    store.appendSeries({ id: 'speed', name: 'Speed', unit: 'km/h', source: { type: 'manual-can', frameDefinitionId: 'f' } }, [
      { timestamp: 1, value: 10 }, { timestamp: 1.5, value: 99 }, { timestamp: 2, value: 40 },
    ]);
    // The middle measurement is deliberately absent from the rendered polyline.
    const series = store.seriesSlice(['speed'], undefined, 2);
    let measured: MeasuredSamples;
    measured = new MeasuredSamples((id, query) => measured.receive(id, store.measured(query.signalIds, query.timestamp)), () => {});
    const view = Object.assign(Object.create(TimeSeriesView.prototype), {
      visible: true, series, viewRange: { start: 1, end: 2 }, mode: 'raw', connectGaps: true,
      axisRange: { mode: 'global' }, colors: new Map([['speed', '#dc2626']]),
      markers: new Map([['a', { id: 'a', timestamp: 1.6, signalIds: ['speed'] }]]),
      cursorTimestamp: 1.55, hoverGraphIndex: 0, rangeSignalIds: [], measured,
    });
    const labels: string[] = []; const dots: number[][] = [];
    const context = new Proxy({
      measureText: (text: string) => ({ width: text.length * 7 }),
      fillText: (text: string) => labels.push(text),
      arc: (...args: number[]) => dots.push(args),
    }, { get: (target, name) => name in target ? Reflect.get(target, name) : () => {} }) as unknown as CanvasRenderingContext2D;
    view.updateMeasuredSamples();
    view.paintChart(context, 1000, 500, 16, 34, true, [34]);
    assert.equal(labels.filter((label) => label === '99 km/h').length, 1); // Fixed marker uses the full-resolution peak.
    assert.equal(labels.filter((label) => label === '26.5 km/h').length, 1); // Hover is interpolated on the rendered line.
    assert.equal(labels.filter((label) => label === '1.5 s').length, 1);
    assert.equal(labels.filter((label) => label === '1.55 s').length, 1);
    assert.equal(dots.length, 2);
    const dotXs = dots.map((dot) => dot[0]).sort((a, b) => a - b);
    assert.equal(dotXs[0], 500);
    assert.ok(dotXs[1] > 540 && dotXs[1] < 541);

    labels.length = 0; dots.length = 0;
    view.paintChart(context, 1600, 900, 58, 34, false, [34]);
    assert.equal(labels.filter((label) => label === '99 km/h').length, 1); // Fixed marker exported; hover not exported.
    assert.equal(labels.filter((label) => label === '1.5 s').length, 1);
    assert.equal(dots[0][0], 800);

    labels.length = 0;
    view.mode = 'normalized'; view.connectGaps = false;
    view.paintChart(context, 1000, 500, 16, 34, true, [34]);
    assert.equal(labels.filter((label) => label === '100 %').length, 1);
    assert.ok(labels.some((label) => label.endsWith(' %') && label !== '100 %'));

    // An original peak must remain inspectable even when the plotted Y range misses it.
    labels.length = 0;
    view.mode = 'raw'; view.axisRange = { mode: 'visible' };
    view.paintChart(context, 1000, 500, 16, 34, true, [34]);
    assert.equal(labels.filter((label) => label === '99 km/h').length, 1);
    assert.equal(labels.filter((label) => label === '26.5 km/h').length, 1);

    store.appendSeries({ id: 'phase', name: 'Phase', unit: 'km/h', source: { type: 'manual-can', frameDefinitionId: 'f2' } }, [
      { timestamp: 1, value: 10 }, { timestamp: 1.497, value: 50 }, { timestamp: 2, value: 40 },
    ]);
    labels.length = 0; view.axisRange = { mode: 'global' };
    view.series = store.seriesSlice(['speed', 'phase'], undefined, 2);
    view.updateMeasuredSamples();
    view.paintChart(context, 1000, 500, 16, 34, true, [34]);
    assert.equal(labels.filter((label) => label === '99 km/h').length, 1);
    assert.equal(labels.filter((label) => label === '50 km/h @-3ms').length, 1);
    assert.equal(labels.filter((label) => label === '26.5 km/h').length, 2);
    assert.equal(labels.filter((label) => label === '1.5 s').length, 1);
    assert.equal(labels.filter((label) => label === '1.55 s').length, 1);
  } finally {
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument); else Reflect.deleteProperty(globalThis, 'document');
    if (originalStyle) Object.defineProperty(globalThis, 'getComputedStyle', originalStyle); else Reflect.deleteProperty(globalThis, 'getComputedStyle');
  }
});
