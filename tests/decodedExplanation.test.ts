import test from 'node:test';
import assert from 'node:assert/strict';
import { createManualDecodeContext, decodeManualFrame } from '../src/core/manual/manualDecoder';
import { decodedExplanation } from '../src/core/manual/decodedExplanation';
import type { ManualFrameDefinition } from '../src/core/manual/manualDefinition';
import { InMemorySignalStore } from '../src/core/signal/signalStore';
import { explanationLines, signalByteMasks } from '../src/webview/raw/decodedInspection';
import type { CanFrame } from '../src/core/frame/canFrame';

const definition: ManualFrameDefinition = { id: 'frame', canId: 1, name: 'Test', extended: false, frameLength: 1,
  signals: [{ id: 'input', name: 'Input', unit: 'V', byteOffset: 0, bitOffset: 0, lengthBits: 8, byteOrder: 'little', signedness: 'unsigned', conversion: { type: 'scale-offset', lsb: 2, lsbText: '2', offset: 1 } }],
  derivedSignals: [
    { id: 'filter', name: 'Filtered', unit: 'V', operation: { type: 'filter', filter: 'low-pass', input: 'Input', timeSeconds: 1 } },
    { id: 'expression', name: 'Twice', unit: 'V', operation: { type: 'expression', expression: 'Filtered * 2' } },
    { id: 'lookup', name: 'Mapped', unit: 'm', operation: { type: 'lookup', input: 'Input', outOfRange: 'clamp', points: [{ input: 0, output: 0 }, { input: 20, output: 100 }] } },
    { id: 'average', name: 'Average', unit: 'V', operation: { type: 'filter', filter: 'moving-average', input: 'Input', timeSeconds: 2 } },
  ] };
const frame = (id: string, timestamp: number, input: number): CanFrame => ({ id, sourceId: 'source', canId: 1, extended: false, channel: 1, direction: 'Rx', dlcCode: 1, dataLength: 1, timestamp, data: Uint8Array.of(input) });

test('RAW derived inspection uses exact Frame results, including filter history and downstream expressions', () => {
  const context = createManualDecodeContext(); const store = new InMemorySignalStore();
  for (const f of [frame('a', 0, 0), frame('b', 1, 5)]) store.appendFrame(f.id, f.timestamp, decodeManualFrame(f, definition, context).decoded);
  // Another channel at the same time must not replace this Frame's inputs/results.
  store.appendFrame('other', 1, decodeManualFrame(frame('other', 1, 200), definition).decoded);
  const samples = new Map(store.samplesForFrame('b').map(item => [item.signalId, item.sample]));
  const decoded = decodeManualFrame(frame('b', 1, 5), definition).decoded;
  const detail = (id: string) => decodedExplanation(decoded.find(item => item.signal.id === id)!, definition, samples);
  assert.equal(detail('input').calculation, '5 × 2 + 1 = 11 V');
  assert.equal(signalByteMasks(detail('input')).get(0), 255);
  const filter = detail('filter').derived!;
  assert.deepEqual(filter.filterEvidence, { previousValue: 1, deltaSeconds: 1 });
  assert.equal(filter.inputs[0].value, 11);
  assert.equal(filter.result, 1 + (1 - Math.exp(-1)) * 10);
  assert.equal(detail('expression').derived?.inputs[0].value, filter.result);
  assert.equal(detail('expression').derived?.result, filter.result * 2);
  assert.ok(explanationLines(detail('filter')).some(line => line.includes('α =')));
  assert.deepEqual(detail('lookup').derived?.bounds, [{ input: 0, output: 0 }, { input: 20, output: 100 }]);
  assert.ok(Math.abs(detail('lookup').derived!.result - 55) < 1e-12);
  assert.deepEqual(detail('average').derived?.filterEvidence, { previousValue: 1, deltaSeconds: 1, sampleCount: 2, sum: 12 });
  assert.ok(explanationLines(detail('average')).some(line => line.includes('12 / 2')));
});

test('filter evidence explains initial values, history reset, and lookup clamping', () => {
  const context = createManualDecodeContext();
  decodeManualFrame(frame('first', 3, 2), definition, context);
  const result = decodeManualFrame(frame('reset', 2, 50), definition, context);
  const samples = new Map(result.decoded.map(item => [item.signal.id, item.sample]));
  const details = result.decoded.map(item => decodedExplanation(item, definition, samples));
  assert.equal(details[1].derived?.filterEvidence?.previousValue, undefined);
  assert.ok(explanationLines(details[1]).some(line => line.includes('Initial/reset')));
  assert.deepEqual(details[3].derived?.bounds, [{ input: 20, output: 100 }]);
  assert.equal(details[3].derived?.result, 100);
});
