import type { Diagnostic } from '../diagnostics/diagnostic';
import { createDiagnostic } from '../diagnostics/diagnostic';
import type { CanFrame } from '../frame/canFrame';
import type { SignalDefinition, SignalSample } from '../signal/signal';
import { extractBits } from './bits';
import type { ManualFrameDefinition, ManualSignalDefinition } from './manualDefinition';
import { signalDefinitionFor } from './manualDefinition';
import type { ManualDerivedSignalDefinition } from './manualDefinition';
import { compileExpression, type CompiledExpression } from '../calculation/expression';

const derivedExpressionCache = new WeakMap<ManualDerivedSignalDefinition, { readonly source: string; readonly compiled: CompiledExpression }>();

interface FilterRuntime { lastTimestamp?: number; value?: number; samples: Array<{ timestamp: number; value: number }>; sum: number }
export interface ManualDecodeContext { readonly filters: Map<string, FilterRuntime> }
export function createManualDecodeContext(): ManualDecodeContext { return { filters: new Map() }; }

export interface ManualDecodedSignal {
  readonly signal: ManualSignalDefinition | ManualDerivedSignalDefinition;
  readonly definition: SignalDefinition;
  readonly sample: SignalSample;
  readonly raw?: bigint;
}

export interface ManualDecodeResult {
  readonly decoded: readonly ManualDecodedSignal[];
  readonly diagnostics: readonly Diagnostic[];
}

export function frameMatchesDefinition(frame: CanFrame, definition: ManualFrameDefinition): boolean {
  return frame.canId === definition.canId && frame.extended === definition.extended;
}

export function decodeManualFrame(frame: CanFrame, definition: ManualFrameDefinition, context: ManualDecodeContext = createManualDecodeContext()): ManualDecodeResult {
  const decoded: ManualDecodedSignal[] = [];
  const diagnostics: Diagnostic[] = [];
  const values: Record<string, number> = {};
  if (!frameMatchesDefinition(frame, definition)) return { decoded, diagnostics };
  for (const signal of definition.signals) {
    const location = { sourceId: frame.sourceId, frameId: frame.id };
    let raw: bigint;
    try {
      raw = extractBits(frame.data, signal.byteOffset, signal.bitOffset, signal.lengthBits, signal.byteOrder, signal.signedness);
    } catch (error) {
      diagnostics.push(createDiagnostic({
        source: 'definition', code: 'FRAME_TOO_SHORT', severity: 'warning',
        message: `${signal.name}: ${(error as Error).message}`, location,
        details: { signalId: signal.id, definitionId: definition.id },
      }));
      continue;
    }
    const rawNumber = Number(raw);
    if (!Number.isSafeInteger(rawNumber)) {
      diagnostics.push(createDiagnostic({
        source: 'definition', code: 'SIGNAL_INTEGER_UNSAFE', severity: 'warning',
        message: `${signal.name}: decoded integer cannot be represented exactly as a JavaScript number.`, location,
        details: { signalId: signal.id, definitionId: definition.id },
      }));
      continue;
    }
    const value = rawNumber * signal.conversion.lsb + signal.conversion.offset;
    if (!Number.isFinite(value)) {
      diagnostics.push(createDiagnostic({
        source: 'definition', code: 'SIGNAL_VALUE_NONFINITE', severity: 'warning',
        message: `${signal.name}: converted value is not finite.`, location,
        details: { signalId: signal.id, definitionId: definition.id },
      }));
      continue;
    }
    decoded.push({
      signal,
      definition: signalDefinitionFor(definition, signal),
      sample: { timestamp: frame.timestamp, value, quality: 'valid' },
      raw,
    });
    values[signal.name] = value;
  }
  for (const signal of definition.derivedSignals ?? []) {
    const location = { sourceId: frame.sourceId, frameId: frame.id };
    try {
      const value = evaluateDerived(signal, values, frame.timestamp, definition.id, context);
      decoded.push({ signal, definition: signalDefinitionFor(definition, signal), sample: { timestamp: frame.timestamp, value, quality: 'valid' } });
      values[signal.name] = value;
    } catch (error) {
      diagnostics.push(createDiagnostic({ source: 'definition', code: 'DERIVED_SIGNAL_EVALUATION_ERROR', severity: 'warning', message: `${signal.name}: ${(error as Error).message}`, location, details: { signalId: signal.id, definitionId: definition.id } }));
    }
  }
  return { decoded, diagnostics };
}

function compiledDerivedExpression(signal: ManualDerivedSignalDefinition): CompiledExpression {
  if (signal.operation.type !== 'expression') throw new Error('Derived Signal is not an Expression.');
  const cached = derivedExpressionCache.get(signal);
  if (cached?.source === signal.operation.expression) return cached.compiled;
  const compiled = compileExpression(signal.operation.expression);
  derivedExpressionCache.set(signal, { source: signal.operation.expression, compiled });
  return compiled;
}

function evaluateDerived(signal: ManualDerivedSignalDefinition, values: Readonly<Record<string, number>>, timestamp: number, definitionId: string, context: ManualDecodeContext): number {
  if (signal.operation.type === 'expression') return compiledDerivedExpression(signal).evaluate(values);
  const input = values[signal.operation.input];
  if (!Number.isFinite(input)) throw new Error(`Input Signal “${signal.operation.input}” is missing or invalid.`);
  if (signal.operation.type === 'lookup') return lookup(signal.operation.points, input, signal.operation.outOfRange);
  const key = `${definitionId}:${signal.id}`; let state = context.filters.get(key);
  if (!state) { state = { samples: [], sum: 0 }; context.filters.set(key, state); }
  if (state.lastTimestamp !== undefined && timestamp <= state.lastTimestamp) { state.samples = []; state.sum = 0; state.value = undefined; }
  if (signal.operation.filter === 'low-pass') {
    const previous = state.value; const delta = state.lastTimestamp === undefined ? 0 : timestamp - state.lastTimestamp;
    state.value = previous === undefined || !(delta > 0) ? input : previous + (1 - Math.exp(-delta / signal.operation.timeSeconds)) * (input - previous);
  } else {
    state.samples.push({ timestamp, value: input }); state.sum += input;
    const cutoff = timestamp - signal.operation.timeSeconds;
    while (state.samples.length && state.samples[0].timestamp < cutoff) state.sum -= state.samples.shift()!.value;
    state.value = state.sum / state.samples.length;
  }
  state.lastTimestamp = timestamp; return state.value;
}

function lookup(pointsValue: readonly { readonly input: number; readonly output: number }[], input: number, outOfRange: 'clamp' | 'error'): number {
  const points = [...pointsValue].sort((left, right) => left.input - right.input);
  if (points.length < 2) throw new Error('Lookup Table requires at least two points.');
  if (input < points[0].input || input > points[points.length - 1].input) {
    if (outOfRange === 'error') throw new Error(`Input ${input} is outside the Lookup Table range.`);
    return input < points[0].input ? points[0].output : points[points.length - 1].output;
  }
  for (let index = 1; index < points.length; index++) {
    const left = points[index - 1]; const right = points[index];
    if (input <= right.input) return left.output + (right.output - left.output) * ((input - left.input) / (right.input - left.input));
  }
  return points[points.length - 1].output;
}

export function formatDecodedSignal(decoded: ManualDecodedSignal): string {
  const value = Number.isInteger(decoded.sample.value) ? String(decoded.sample.value) : Number(decoded.sample.value.toPrecision(12)).toString();
  return `${decoded.definition.name}=${value}${decoded.definition.unit ? ` ${decoded.definition.unit}` : ''}`;
}
