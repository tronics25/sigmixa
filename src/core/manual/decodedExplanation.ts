import { compileExpression } from '../calculation/expression';
import type { ManualFrameDefinition } from './manualDefinition';
import type { ManualDecodedSignal } from './manualDecoder';
import { formatDecodedSignal } from './manualDecoder';
import type { SignalSample } from '../signal/signal';

/** Uses exact Frame identity; equal timestamps on other channels never supply inputs. */
export function decodedExplanation(item: ManualDecodedSignal, frame: ManualFrameDefinition, samples: ReadonlyMap<string, SignalSample>) {
  const sample = samples.get(item.signal.id) ?? item.sample;
  const tag = formatDecodedSignal({ ...item, sample });
  if ('byteOffset' in item.signal) return { tag, raw: item.raw?.toString(), byteOffset: item.signal.byteOffset, bitOffset: item.signal.bitOffset,
    lengthBits: item.signal.lengthBits, byteOrder: item.signal.byteOrder,
    calculation: `${item.raw} × ${item.signal.conversion.lsb} + ${item.signal.conversion.offset} = ${sample.value}${item.signal.unit ? ` ${item.signal.unit}` : ''}` };
  const operation = item.signal.operation;
  const names = operation.type === 'expression' ? [...compileExpression(operation.expression).variables] : [operation.input];
  const definitions = [...frame.signals, ...(frame.derivedSignals ?? [])];
  const inputs = names.map(name => { const signal = definitions.find(candidate => candidate.name === name); return { name, value: signal ? samples.get(signal.id)?.value : undefined, unit: signal?.unit }; });
  const input = inputs[0]?.value;
  const points = operation.type === 'lookup' ? [...operation.points].sort((a, b) => a.input - b.input) : [];
  let bounds: typeof points = [];
  if (input !== undefined && points.length) {
    const upper = points.findIndex(point => point.input >= input);
    bounds = upper <= 0 ? [points[upper < 0 ? points.length - 1 : 0]] : [points[upper - 1], points[upper]];
  }
  return { tag, derived: { operation, inputs, result: sample.value, unit: item.signal.unit, bounds, filterEvidence: sample.filterEvidence } };
}
export type DecodedExplanation = ReturnType<typeof decodedExplanation>;
