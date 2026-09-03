import type { Diagnostic } from '../diagnostics/diagnostic';
import type { CalculationDefinition, LookupTableDefinition } from '../project/schema';
import type { SignalDefinition, SignalSample } from '../signal/signal';
import { compileExpression, type CompiledExpression } from './expression';

export interface CalculationSeries {
  readonly definition: SignalDefinition;
  readonly samples: readonly SignalSample[];
}

export interface CalculationResult {
  readonly series: readonly CalculationSeries[];
  readonly diagnostics: readonly Diagnostic[];
}

export function calculatedSignalId(calculationId: string): string { return `calculated:${encodeURIComponent(calculationId)}`; }

export function evaluateCalculations(
  sources: readonly CalculationSeries[],
  definitions: readonly CalculationDefinition[],
  tables: readonly LookupTableDefinition[]
): CalculationResult {
  const available = new Map(sources.map((series) => [series.definition.id, series]));
  const calculations = new Map(definitions.filter((item) => item.enabled).map((item) => [item.id, item]));
  const diagnostics: Diagnostic[] = []; const output: CalculationSeries[] = [];
  const order = calculationOrder(calculations, diagnostics);
  const tableMap = new Map(tables.map((table) => [table.id, table]));
  for (const id of order) {
    const calculation = calculations.get(id)!;
    const result = evaluateOne(calculation, available, tableMap, diagnostics);
    if (result) { available.set(result.definition.id, result); output.push(result); }
  }
  return { series: output, diagnostics };
}

function calculationOrder(calculations: ReadonlyMap<string, CalculationDefinition>, diagnostics: Diagnostic[]): string[] {
  const output: string[] = []; const visiting = new Set<string>(); const visited = new Set<string>(); const cyclic = new Set<string>();
  const bySignal = new Map([...calculations.keys()].map((id) => [calculatedSignalId(id), id]));
  const visit = (id: string, trail: string[]) => {
    if (visited.has(id) || cyclic.has(id)) return;
    if (visiting.has(id)) {
      const start = trail.indexOf(id); const cycle = [...trail.slice(start), id]; cycle.forEach((item) => cyclic.add(item));
      diagnostics.push(diagnostic(id, 'CALCULATION_CYCLE', `Calculation cycle detected: ${cycle.join(' → ')}.`, 'error')); return;
    }
    visiting.add(id); const calculation = calculations.get(id)!;
    for (const signalId of Object.values(calculation.inputs)) { const dependency = bySignal.get(signalId); if (dependency) visit(dependency, [...trail, id]); }
    visiting.delete(id); visited.add(id); if (!cyclic.has(id)) output.push(id);
  };
  calculations.forEach((_, id) => visit(id, [])); return output.filter((id) => !cyclic.has(id));
}

function evaluateOne(
  calculation: CalculationDefinition,
  available: ReadonlyMap<string, CalculationSeries>,
  tables: ReadonlyMap<string, LookupTableDefinition>,
  diagnostics: Diagnostic[]
): CalculationSeries | undefined {
  const axis = available.get(calculation.timestampSignalId);
  if (!axis) { diagnostics.push(diagnostic(calculation.id, 'CALCULATION_TIMESTAMP_SOURCE_MISSING', 'Calculation Timestamp source was not found.', 'error')); return undefined; }
  const inputs = new Map<string, CalculationSeries>();
  for (const [name, signalId] of Object.entries(calculation.inputs)) {
    const series = available.get(signalId); if (!series) diagnostics.push(diagnostic(calculation.id, 'CALCULATION_INPUT_MISSING', `Input “${name}” was not found.`, 'error'));
    else inputs.set(name, series);
  }
  if (inputs.size !== Object.keys(calculation.inputs).length) return undefined;

  let expression: CompiledExpression | undefined; let table: LookupTableDefinition | undefined;
  if (calculation.operation.type === 'expression') {
    try {
      expression = compileExpression(calculation.operation.expression);
      for (const variable of expression.variables) if (!inputs.has(variable)) diagnostics.push(diagnostic(calculation.id, 'CALCULATION_VARIABLE_MISSING', `Expression variable “${variable}” is not mapped to a Signal.`, 'error'));
      if ([...expression.variables].some((variable) => !inputs.has(variable))) return undefined;
    } catch (error) { diagnostics.push(diagnostic(calculation.id, 'CALCULATION_EXPRESSION_INVALID', (error as Error).message, 'error')); return undefined; }
  } else {
    table = tables.get(calculation.operation.tableId);
    if (!table) { diagnostics.push(diagnostic(calculation.id, 'CALCULATION_LOOKUP_MISSING', `Lookup Table “${calculation.operation.tableId}” was not found.`, 'error')); return undefined; }
    if (!inputs.has(calculation.operation.input)) { diagnostics.push(diagnostic(calculation.id, 'CALCULATION_VARIABLE_MISSING', `Lookup input “${calculation.operation.input}” is not mapped.`, 'error')); return undefined; }
  }

  const samples: SignalSample[] = []; const reported = new Set<string>();
  for (const timestampSample of axis.samples) {
    const values: Record<string, number> = {}; let missing = false;
    for (const [name, series] of inputs) {
      const sample = sampleAt(series.samples, timestampSample.timestamp, calculation.interpolation);
      if (!sample) {
        missing = true; const key = `range:${name}`;
        if (!reported.has(key)) { reported.add(key); diagnostics.push(diagnostic(calculation.id, 'CALCULATION_INPUT_OUT_OF_RANGE', `Input “${name}” has no ${calculation.interpolation === 'linear' ? 'bracketing' : 'exact'} sample at part of the calculation range.`, 'warning')); }
      } else values[name] = sample.value;
    }
    if (missing) continue;
    try {
      const value = expression ? expression.evaluate(values) : lookupLinear(table!, values[calculation.operation.type === 'lookup' ? calculation.operation.input : ''], calculation.id, diagnostics, reported);
      if (value !== undefined && Number.isFinite(value)) samples.push({ timestamp: timestampSample.timestamp, value, quality: 'valid', originalTimestamp: timestampSample.originalTimestamp });
    } catch (error) {
      const key = `evaluation:${(error as Error).message}`;
      if (!reported.has(key)) { reported.add(key); diagnostics.push(diagnostic(calculation.id, 'CALCULATION_EVALUATION_ERROR', (error as Error).message, 'warning')); }
    }
  }
  return { definition: { id: calculatedSignalId(calculation.id), name: calculation.name.trim() || calculation.id, unit: calculation.unit?.trim() || undefined, source: { type: 'calculated', calculationId: calculation.id } }, samples };
}

export function sampleAt(samples: readonly SignalSample[], timestamp: number, mode: 'exact' | 'linear'): SignalSample | undefined {
  let low = 0; let high = samples.length - 1;
  while (low <= high) { const middle = Math.floor((low + high) / 2); const sample = samples[middle]; if (sample.timestamp === timestamp) return sample; if (sample.timestamp < timestamp) low = middle + 1; else high = middle - 1; }
  if (mode === 'exact' || high < 0 || low >= samples.length) return undefined;
  const left = samples[high]; const right = samples[low]; const span = right.timestamp - left.timestamp;
  if (!(span > 0)) return undefined;
  const fraction = (timestamp - left.timestamp) / span;
  return { timestamp, value: left.value + (right.value - left.value) * fraction, quality: left.quality === 'invalid' || right.quality === 'invalid' ? 'invalid' : 'valid' };
}

export function lookupLinear(
  table: LookupTableDefinition,
  input: number,
  calculationId = table.id,
  diagnostics: Diagnostic[] = [],
  reported: Set<string> = new Set()
): number | undefined {
  const points = [...table.points].filter((point) => Number.isFinite(point.input) && Number.isFinite(point.output)).sort((left, right) => left.input - right.input);
  if (!points.length) { if (!reported.has('lookup-empty')) diagnostics.push(diagnostic(calculationId, 'LOOKUP_TABLE_EMPTY', `Lookup Table “${table.name || table.id}” has no valid points.`, 'error')); reported.add('lookup-empty'); return undefined; }
  if (input < points[0].input || input > points[points.length - 1].input) {
    if (table.outOfRange === 'clamp') return input < points[0].input ? points[0].output : points[points.length - 1].output;
    if (!reported.has('lookup-range')) diagnostics.push(diagnostic(calculationId, 'LOOKUP_OUT_OF_RANGE', `Value ${input} is outside Lookup Table “${table.name || table.id}”.`, 'warning'));
    reported.add('lookup-range'); return undefined;
  }
  for (let index = 1; index < points.length; index++) {
    const right = points[index]; const left = points[index - 1];
    if (input <= right.input) {
      if (right.input === left.input) return right.output;
      const fraction = (input - left.input) / (right.input - left.input); return left.output + (right.output - left.output) * fraction;
    }
  }
  return points[points.length - 1].output;
}

function diagnostic(calculationId: string, code: string, message: string, severity: Diagnostic['severity']): Diagnostic {
  return { id: `calculation:${calculationId}:${code}`, source: 'calculation', code, severity, message, details: { calculationId } };
}
