import test from 'node:test';
import assert from 'node:assert/strict';
import { calculatedSignalId, evaluateCalculations, lookupLinear, sampleAt } from '../src/core/calculation/calculationEngine';
import { compileExpression } from '../src/core/calculation/expression';
import type { CalculationDefinition, LookupTableDefinition } from '../src/core/project/schema';
import type { SignalDefinition, SignalSample } from '../src/core/signal/signal';

const actual: SignalDefinition = { id: 'actual', name: 'Actual', source: { type: 'manual-can', frameDefinitionId: 'frame' } };
const reference: SignalDefinition = { id: 'reference', name: 'Reference', source: { type: 'external-csv', sourceId: 'csv', column: 'Reference' } };
const series = (definition: SignalDefinition, samples: Array<[number, number]>) => ({ definition, samples: samples.map(([timestamp, value]) => ({ timestamp, value } as SignalSample)) });

test('Expression supports arithmetic and explicit clamp without evaluating arbitrary JavaScript', () => {
  const expression = compileExpression('clamp(actual - reference * 2, -10, 10)');
  assert.deepEqual([...expression.variables].sort(), ['actual', 'reference']);
  assert.equal(expression.evaluate({ actual: 50, reference: 15 }), 10);
  assert.throws(() => compileExpression('globalThis.process.exit()'), /Unsupported|Unexpected|Invalid/);
});

test('Expression supports bracketed Signal names with spaces and non-ASCII characters', () => {
  const expression = compileExpression('[車速] * [Battery Voltage] / 12');
  assert.deepEqual([...expression.variables], ['車速', 'Battery Voltage']);
  assert.equal(expression.evaluate({ 車速: 60, 'Battery Voltage': 12 }), 60);
});

test('Calculated Signal uses explicit linear interpolation at the Timestamp source without forward fill', () => {
  const calculation: CalculationDefinition = {
    id: 'error', name: 'Error', unit: 'km/h', enabled: true,
    inputs: { actual: actual.id, reference: reference.id }, timestampSignalId: reference.id, interpolation: 'linear',
    operation: { type: 'expression', expression: 'actual - reference' },
  };
  const result = evaluateCalculations([series(actual, [[5, 10], [6, 30]]), series(reference, [[5.25, 12], [5.75, 18]])], [calculation], []);
  assert.equal(result.diagnostics.length, 0);
  assert.deepEqual(result.series[0].samples, [{ timestamp: 5.25, value: 3, quality: 'valid', originalTimestamp: undefined }, { timestamp: 5.75, value: 7, quality: 'valid', originalTimestamp: undefined }]);
  assert.equal(result.series[0].definition.id, calculatedSignalId('error'));
  assert.equal(sampleAt(series(actual, [[5, 10], [6, 30]]).samples, 5.5, 'exact'), undefined);
});

test('calculation cycle and invalid Expression produce Diagnostics', () => {
  const a: CalculationDefinition = { id: 'a', name: 'A', enabled: true, inputs: { b: calculatedSignalId('b') }, timestampSignalId: actual.id, interpolation: 'exact', operation: { type: 'expression', expression: 'b + 1' } };
  const b: CalculationDefinition = { id: 'b', name: 'B', enabled: true, inputs: { a: calculatedSignalId('a') }, timestampSignalId: actual.id, interpolation: 'exact', operation: { type: 'expression', expression: 'a + 1' } };
  const invalid: CalculationDefinition = { id: 'invalid', name: 'Invalid', enabled: true, inputs: { actual: actual.id }, timestampSignalId: actual.id, interpolation: 'exact', operation: { type: 'expression', expression: 'actual +' } };
  const result = evaluateCalculations([series(actual, [[1, 2]])], [a, b, invalid], []);
  assert.ok(result.diagnostics.some((item) => item.code === 'CALCULATION_CYCLE'));
  assert.ok(result.diagnostics.some((item) => item.code === 'CALCULATION_EXPRESSION_INVALID'));
});

test('Lookup Table linearly interpolates, clamps explicitly, and diagnoses out-of-range errors', () => {
  const clamped: LookupTableDefinition = { id: 'clamp', name: 'Clamp', outOfRange: 'clamp', points: [{ input: 0, output: 0 }, { input: 10, output: 100 }] };
  assert.equal(lookupLinear(clamped, 2.5), 25); assert.equal(lookupLinear(clamped, 20), 100);
  const strict = { ...clamped, id: 'strict', outOfRange: 'error' as const }; const diagnostics: any[] = [];
  assert.equal(lookupLinear(strict, -1, 'lookup', diagnostics), undefined); assert.equal(diagnostics[0].code, 'LOOKUP_OUT_OF_RANGE');
});
