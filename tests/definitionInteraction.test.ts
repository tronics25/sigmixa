import test from 'node:test';
import assert from 'node:assert/strict';
import { definitionControlKey, definitionSignalColor, signalBitEndpoints } from '../src/webview/frame-editor/definitionInteraction';
import { filterStepPreview, lookupPreviewPoints } from '../src/webview/frame-editor/definitionPreview';
import { createManualSignal, orderSignalsByDataPosition } from '../src/core/manual/manualDefinition';
import { definitionGraph } from '../src/core/manual/definitionGraph';

test('editor colors and focus keys follow Signal identity across insertion and reorder', () => {
  const signals = [createManualSignal('dbc-e-speed'), { ...createManualSignal('second'), byteOffset: 2 }];
  const before = new Map(signals.map((signal) => [signal.id, definitionSignalColor(signal.id)]));
  const reordered = orderSignalsByDataPosition([{ ...signals[1], byteOffset: 0 }, { ...signals[0], byteOffset: 5 }, createManualSignal('inserted')]);
  for (const signal of reordered.filter((signal) => before.has(signal.id))) assert.equal(definitionSignalColor(signal.id), before.get(signal.id));
  assert.notEqual(definitionControlKey('speed', 'byte', 0), definitionControlKey('speed', 'length', 0));
  assert.notEqual(definitionControlKey('speed', 'byte', 0), definitionControlKey('another', 'byte', 0));
});

test('Bit endpoints identify physical MSB/LSB for LITTLE and BIG across bytes', () => {
  const signal = { ...createManualSignal('s'), byteOffset: 2, bitOffset: 3, lengthBits: 12 };
  assert.deepEqual(signalBitEndpoints(signal), { start: 19, lsb: 19, msb: 30 });
  assert.deepEqual(signalBitEndpoints({ ...signal, byteOrder: 'big' }), { start: 20, msb: 20, lsb: 25 });
  assert.deepEqual(signalBitEndpoints({ ...signal, lengthBits: Infinity }), {});
});

test('Lookup preview sorts the curve without reordering editable points and rejects ambiguous inputs', () => {
  const points = [{ input: 10, output: -5 }, { input: -10, output: 20 }, { input: 0, output: 0 }];
  assert.deepEqual(lookupPreviewPoints(points).map((point) => point.index), [1, 2, 0]);
  assert.equal(points[0].input, 10);
  assert.deepEqual(lookupPreviewPoints([{ input: 0, output: 1 }, { input: 0, output: 2 }]), []);
  assert.deepEqual(lookupPreviewPoints([{ input: NaN, output: 1 }, { input: 0, output: 2 }]), []);
});

test('filter preview illustrates time constant and moving-average window on the time axis', () => {
  const operation = { type: 'filter' as const, input: 'Value', filter: 'low-pass' as const, timeSeconds: 2 };
  const output = filterStepPreview(operation)[1].points;
  assert.ok(Math.abs(output.find((point) => point.input === 2)!.output - (1 - Math.exp(-1))) < 1e-12);
  const average = filterStepPreview({ ...operation, filter: 'moving-average' })[1].points;
  assert.equal(average.find((point) => point.input === 1)!.output, .5);
  assert.equal(average.find((point) => point.input === 2)!.output, 1);
  assert.deepEqual(filterStepPreview({ ...operation, timeSeconds: 0 }), []);
});

test('dependency diagram resolves ancestors and marks unavailable forward references', () => {
  const raw = { ...createManualSignal('raw'), name: 'Speed' };
  const graph = definitionGraph({ id: 'f', name: 'Frame', canId: 256, extended: false, frameLength: 8, signals: [raw], derivedSignals: [
    { id: 'converted', name: 'Converted', unit: '', operation: { type: 'expression', expression: '[Speed] * 2' } },
    { id: 'filtered', name: 'Filtered', unit: '', operation: { type: 'filter', input: 'Converted', filter: 'low-pass', timeSeconds: 1 } },
    { id: 'out', name: 'Output', unit: '', operation: { type: 'expression', expression: '[Filtered] + [Missing]' } },
  ] }, 'out');
  assert.equal(graph.nodes.find((node) => node.id === 'out')?.level, 3);
  assert.deepEqual(graph.edges.filter((edge) => edge.to === 'filtered'), [{ from: 'converted', to: 'filtered' }]);
  assert.ok(graph.nodes.some((node) => node.kind === 'missing' && node.name === 'Missing'));
});
