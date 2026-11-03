import type { Diagnostic } from '../diagnostics/diagnostic';
import { createDiagnostic } from '../diagnostics/diagnostic';
import type { CanFrame } from '../frame/canFrame';
import type { SignalDefinition, SignalSample } from '../signal/signal';
import { extractBits, extractRaw, floatFromBits } from './bits';
import type { ManualFrameDefinition, ManualSignalDefinition } from './manualDefinition';
import { isSignalActive, signalDefinitionFor, valueLabelFor } from './manualDefinition';
import type { ManualDerivedSignalDefinition } from './manualDefinition';
import { compileExpression, type CompiledExpression } from '../calculation/expression';
import { convertScaleOffset } from './scaleOffset';

const derivedExpressionCache = new WeakMap<ManualDerivedSignalDefinition, { readonly source: string; readonly compiled: CompiledExpression }>();

interface FilterRuntime { lastTimestamp?: number; value?: number; samples: Array<{ timestamp: number; value: number }>; sum: number }
export interface ManualDecodeContext { readonly filters: Map<string, FilterRuntime> }
export function createManualDecodeContext(): ManualDecodeContext { return { filters: new Map() }; }

export interface ManualDecodedSignal {
  readonly signal: ManualSignalDefinition | ManualDerivedSignalDefinition;
  readonly definition: SignalDefinition;
  readonly sample: SignalSample;
  /** The RAW integer; for a Float Signal, its IEEE 754 value. */
  readonly raw?: bigint | number;
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
  decodeSignalsInto(frame, definition, decoded, diagnostics, values);
  decodeDerivedInto(frame, definition, context, decoded, diagnostics, values);
  return { decoded, diagnostics };
}

/** The first part of `decodeManualFrame`: the frame's own Signals (not the derived ones), and their values by name. */
export function decodeManualSignals(frame: CanFrame, definition: ManualFrameDefinition): ManualDecodeResult & { readonly values: Record<string, number> } {
  const decoded: ManualDecodedSignal[] = []; const diagnostics: Diagnostic[] = []; const values: Record<string, number> = {};
  if (frameMatchesDefinition(frame, definition)) decodeSignalsInto(frame, definition, decoded, diagnostics, values);
  return { decoded, diagnostics, values };
}

/**
 * The rest of `decodeManualFrame`: its derived Signals, from `values` (by name) that `decodeManualSignals` gave for the
 * same frame. Only these depend on `context`.
 */
export function decodeManualDerived(frame: CanFrame, definition: ManualFrameDefinition, context: ManualDecodeContext, values: Record<string, number>, from = 0, to?: number): ManualDecodeResult {
  const decoded: ManualDecodedSignal[] = []; const diagnostics: Diagnostic[] = [];
  if (frameMatchesDefinition(frame, definition)) decodeDerivedInto(frame, definition, context, decoded, diagnostics, values, from, to);
  return { decoded, diagnostics };
}

/** How many derived Signals of a definition come before its first filter: they depend on nothing but their frame. */
export function derivedBeforeFilter(definition: ManualFrameDefinition): number {
  const derived = definition.derivedSignals ?? []; const index = derived.findIndex((signal) => signal.operation.type === 'filter');
  return index < 0 ? derived.length : index;
}

function decodeSignalsInto(frame: CanFrame, definition: ManualFrameDefinition, decoded: ManualDecodedSignal[], diagnostics: Diagnostic[], values: Record<string, number>): void {
  const multiplexer = definition.multiplexing ? multiplexerOf(definition) : undefined;
  let multiplexerValue: number | undefined;
  if (multiplexer) {
    try { multiplexerValue = Number(extractBits(frame.data, multiplexer.byteOffset, multiplexer.bitOffset, multiplexer.lengthBits, multiplexer.byteOrder, 'unsigned')); }
    catch { /* The normal Signal pass reports the short-frame diagnostic. */ }
  }
  for (const signal of definition.signals) {
    if (!isSignalActive(signal, multiplexerValue)) continue;
    let raw: bigint | number;
    try {
      raw = extractRaw(frame.data, signal.byteOffset, signal.bitOffset, signal.lengthBits, signal.byteOrder, signal.signedness);
    } catch (error) {
      diagnostics.push(createDiagnostic({
        source: 'definition', code: 'FRAME_TOO_SHORT', severity: 'warning',
        message: `${signal.name}: ${(error as Error).message}`, location: { sourceId: frame.sourceId, frameId: frame.id },
        details: { signalId: signal.id, definitionId: definition.id },
      }));
      continue;
    }
    if (signal.signedness === 'float') {
      // An IEEE 754 Signal: its bits are the value, then scaled like any Signal. NaN and infinities are not values.
      const rawFloat = floatFromBits(BigInt(raw), signal.lengthBits); const value = rawFloat * signal.conversion.lsb + signal.conversion.offset;
      if (!Number.isFinite(value)) {
        diagnostics.push(createDiagnostic({ source: 'definition', code: 'SIGNAL_VALUE_NONFINITE', severity: 'warning', message: `${signal.name}: converted value is not finite.`, location: { sourceId: frame.sourceId, frameId: frame.id }, details: { signalId: signal.id, definitionId: definition.id } }));
        continue;
      }
      decoded.push({ signal, definition: signalDefinitionFor(definition, signal), sample: { timestamp: frame.timestamp, value, quality: 'valid' }, raw: rawFloat });
      values[signal.name] = value;
      continue;
    }
    const rawNumber = Number(raw);
    if (!Number.isSafeInteger(rawNumber)) {
      diagnostics.push(createDiagnostic({
        source: 'definition', code: 'SIGNAL_INTEGER_UNSAFE', severity: 'warning',
        message: `${signal.name}: decoded integer cannot be represented exactly as a JavaScript number.`, location: { sourceId: frame.sourceId, frameId: frame.id },
        details: { signalId: signal.id, definitionId: definition.id },
      }));
      continue;
    }
    const value = convertScaleOffset(raw, signal.conversion);
    if (!Number.isFinite(value)) {
      diagnostics.push(createDiagnostic({
        source: 'definition', code: 'SIGNAL_VALUE_NONFINITE', severity: 'warning',
        message: `${signal.name}: converted value is not finite.`, location: { sourceId: frame.sourceId, frameId: frame.id },
        details: { signalId: signal.id, definitionId: definition.id },
      }));
      continue;
    }
    const valueLabel = valueLabelFor(signal.valueLabels, raw);
    decoded.push({
      signal,
      definition: signalDefinitionFor(definition, signal),
      sample: valueLabel !== undefined ? { timestamp: frame.timestamp, value, quality: 'valid', valueLabel } : { timestamp: frame.timestamp, value, quality: 'valid' },
      raw,
    });
    values[signal.name] = value;
  }
}

/** Derived Signals `from..to-1` (all by default). */
function decodeDerivedInto(frame: CanFrame, definition: ManualFrameDefinition, context: ManualDecodeContext, decoded: ManualDecodedSignal[], diagnostics: Diagnostic[], values: Record<string, number>, from = 0, to?: number): void {
  const derived = definition.derivedSignals ?? [];
  for (let index = from; index < (to ?? derived.length); index++) {
    const signal = derived[index];
    try {
      // Only filters keep state (and evidence of it).
      if (signal.operation.type !== 'filter') {
        const value = evaluateDerived(signal, values, frame.timestamp, definition.id, context);
        decoded.push({ signal, definition: signalDefinitionFor(definition, signal), sample: { timestamp: frame.timestamp, value, quality: 'valid' } });
        values[signal.name] = value;
        continue;
      }
      const key = filterKey(definition.id, signal);
      const previous = context.filters.get(key);
      const previousValue = previous?.value;
      const deltaSeconds = previous?.lastTimestamp === undefined ? 0 : frame.timestamp - previous.lastTimestamp;
      const value = evaluateDerived(signal, values, frame.timestamp, definition.id, context);
      const state = context.filters.get(key);
      const filterEvidence = signal.operation.filter === 'moving-average'
        ? { previousValue: deltaSeconds > 0 ? previousValue : undefined, deltaSeconds, sampleCount: state?.samples.length, sum: state?.sum }
        : { previousValue: deltaSeconds > 0 ? previousValue : undefined, deltaSeconds };
      decoded.push({ signal, definition: signalDefinitionFor(definition, signal), sample: { timestamp: frame.timestamp, value, quality: 'valid', filterEvidence } });
      values[signal.name] = value;
    } catch (error) {
      diagnostics.push(createDiagnostic({ source: 'definition', code: 'DERIVED_SIGNAL_EVALUATION_ERROR', severity: 'warning', message: `${signal.name}: ${(error as Error).message}`, location: { sourceId: frame.sourceId, frameId: frame.id }, details: { signalId: signal.id, definitionId: definition.id } }));
    }
  }
}

function compiledDerivedExpression(signal: ManualDerivedSignalDefinition): CompiledExpression {
  if (signal.operation.type !== 'expression') throw new Error('Derived Signal is not an Expression.');
  const cached = derivedExpressionCache.get(signal);
  if (cached?.source === signal.operation.expression) return cached.compiled;
  const compiled = compileExpression(signal.operation.expression);
  derivedExpressionCache.set(signal, { source: signal.operation.expression, compiled });
  return compiled;
}

const filterKeys = new WeakMap<ManualDerivedSignalDefinition, { readonly definitionId: string; readonly signalId: string; readonly key: string }>();
/** Where a filter keeps its state in a decode context (`<definition ID>:<Signal ID>`), made once per Signal. */
function filterKey(definitionId: string, signal: ManualDerivedSignalDefinition): string {
  const cached = filterKeys.get(signal); if (cached?.definitionId === definitionId && cached.signalId === signal.id) return cached.key;
  const key = `${definitionId}:${signal.id}`; filterKeys.set(signal, { definitionId, signalId: signal.id, key }); return key;
}

function evaluateDerived(signal: ManualDerivedSignalDefinition, values: Readonly<Record<string, number>>, timestamp: number, definitionId: string, context: ManualDecodeContext): number {
  if (signal.operation.type === 'expression') return compiledDerivedExpression(signal).evaluate(values);
  const input = values[signal.operation.input];
  if (!Number.isFinite(input)) throw new Error(`Input Signal “${signal.operation.input}” is missing or invalid.`);
  if (signal.operation.type === 'lookup') return lookup(signal.operation.points, input, signal.operation.outOfRange);
  const key = filterKey(definitionId, signal); let state = context.filters.get(key);
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

const multiplexers = new WeakMap<ManualFrameDefinition, { readonly signals: readonly ManualSignalDefinition[]; readonly multiplexer: ManualSignalDefinition | undefined }>();
function multiplexerOf(definition: ManualFrameDefinition): ManualSignalDefinition | undefined {
  const cached = multiplexers.get(definition); if (cached?.signals === definition.signals) return cached.multiplexer;
  const multiplexer = definition.signals.find((signal) => signal.multiplexing?.type === 'multiplexer'); multiplexers.set(definition, { signals: definition.signals, multiplexer }); return multiplexer;
}

type LookupPoints = readonly { readonly input: number; readonly output: number }[];
const sortedLookups = new WeakMap<LookupPoints, LookupPoints>();
function lookup(pointsValue: LookupPoints, input: number, outOfRange: 'clamp' | 'error'): number {
  let points = sortedLookups.get(pointsValue);
  if (!points) { points = [...pointsValue].sort((left, right) => left.input - right.input); sortedLookups.set(pointsValue, points); }
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
  return `${decoded.definition.name}=${value}${decoded.definition.unit ? ` ${decoded.definition.unit}` : ''}${decoded.sample.valueLabel ? ` (${decoded.sample.valueLabel})` : ''}`;
}
