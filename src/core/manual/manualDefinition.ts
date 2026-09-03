import type { Diagnostic } from '../diagnostics/diagnostic';
import { createDiagnostic } from '../diagnostics/diagnostic';
import type { SignalDefinition } from '../signal/signal';
import { parseResolution } from './resolution';
import { compileExpression } from '../calculation/expression';

export type ByteOrder = 'little' | 'big';
export type SignalSignedness = 'unsigned' | 'signed';

export interface ManualConversion {
  readonly type: 'scale-offset';
  readonly lsb: number;
  readonly lsbText: string;
  readonly offset: number;
}

export interface ManualSignalDefinition {
  readonly id: string;
  readonly name: string;
  readonly unit: string;
  readonly byteOffset: number;
  readonly bitOffset: number;
  readonly lengthBits: number;
  readonly signedness: SignalSignedness;
  readonly byteOrder: ByteOrder;
  readonly conversion: ManualConversion;
}

export interface ManualDerivedSignalDefinition {
  readonly id: string;
  readonly name: string;
  readonly unit: string;
  readonly operation: ManualDerivedOperation;
}

export interface ManualLookupPoint { readonly input: number; readonly output: number }
export type ManualDerivedOperation =
  | { readonly type: 'expression'; readonly expression: string }
  | { readonly type: 'lookup'; readonly input: string; readonly outOfRange: 'clamp' | 'error'; readonly points: readonly ManualLookupPoint[] }
  | { readonly type: 'filter'; readonly input: string; readonly filter: 'low-pass' | 'moving-average'; readonly timeSeconds: number };

export interface ManualFrameDefinition {
  readonly id: string;
  readonly canId: number;
  readonly extended: boolean;
  readonly name: string;
  readonly frameLength: number;
  readonly signals: readonly ManualSignalDefinition[];
  readonly derivedSignals?: readonly ManualDerivedSignalDefinition[];
  readonly origin?: { readonly type: 'manual' } | { readonly type: 'plugin'; readonly pluginId: string };
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly diagnostics: readonly Diagnostic[];
}

export const VALID_FRAME_LENGTHS = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32, 48, 64]);

export function signalDefinitionFor(frame: ManualFrameDefinition, signal: ManualSignalDefinition | ManualDerivedSignalDefinition): SignalDefinition {
  return {
    id: signal.id,
    name: signal.name,
    unit: signal.unit || undefined,
    source: { type: 'manual-can', frameDefinitionId: frame.id },
    frameRef: { canId: frame.canId, extended: frame.extended },
  };
}

export function occupiedBits(signal: Pick<ManualSignalDefinition, 'byteOffset' | 'bitOffset' | 'lengthBits' | 'byteOrder'>): number[] {
  const result: number[] = [];
  for (let index = 0; index < signal.lengthBits; index++) {
    const sequential = signal.bitOffset + index;
    const byte = signal.byteOffset + Math.floor(sequential / 8);
    const bit = signal.byteOrder === 'big' ? 7 - (sequential % 8) : sequential % 8;
    result.push(byte * 8 + bit);
  }
  return result;
}

export function normalizeFrameDefinition(frame: ManualFrameDefinition): ManualFrameDefinition {
  return {
    ...frame,
    name: frame.name.trim(),
    origin: frame.origin ?? { type: 'manual' },
    signals: frame.signals.map((signal) => ({
      ...signal,
      name: signal.name.trim(),
      unit: signal.unit.trim(),
      conversion: { ...signal.conversion, lsbText: signal.conversion.lsbText.trim() },
    })),
    derivedSignals: (frame.derivedSignals ?? []).map((signal) => ({
      ...signal, name: signal.name.trim(), unit: signal.unit.trim(),
      operation: signal.operation.type === 'expression' ? { ...signal.operation, expression: signal.operation.expression.trim() }
        : { ...signal.operation, input: signal.operation.input.trim() },
    })),
  };
}

export function createManualSignal(
  id: string,
  previous?: ManualSignalDefinition,
  frameLength = 8
): ManualSignalDefinition {
  const previousEnd = previous ? previous.byteOffset * 8 + previous.bitOffset + previous.lengthBits : 0;
  return {
    id,
    name: 'New Signal',
    unit: '',
    byteOffset: Math.min(Math.max(0, frameLength - 1), Math.floor(previousEnd / 8)),
    bitOffset: previousEnd % 8,
    lengthBits: previous?.lengthBits ?? 8,
    signedness: 'unsigned',
    byteOrder: previous?.byteOrder ?? 'little',
    conversion: { type: 'scale-offset', lsb: 1, lsbText: '1', offset: 0 },
  };
}

export function createManualDerivedSignal(id: string): ManualDerivedSignalDefinition {
  return { id, name: 'New Derived Signal', unit: '', operation: { type: 'expression', expression: '' } };
}

export function validateFrameDefinition(frame: ManualFrameDefinition): ValidationResult {
  const diagnostics: Diagnostic[] = [];
  let diagnosticSequence = 0;
  const add = (code: string, message: string, details?: Record<string, string | number | boolean>) => diagnostics.push(createDiagnostic({
    id: `definition:${code}:${String(details?.signalId ?? 'frame')}:${diagnosticSequence++}`,
    source: 'definition', code, severity: 'error', message, details,
  }));
  const maxCanId = frame.extended ? 0x1fffffff : 0x7ff;
  if (!frame.id.trim()) add('FRAME_ID_REQUIRED', 'Frame ID is required.');
  if (!frame.name.trim()) add('FRAME_NAME_REQUIRED', 'Frame name is required.');
  if (!Number.isInteger(frame.canId) || frame.canId < 0 || frame.canId > maxCanId) add('FRAME_CAN_ID_RANGE', `CAN ID must fit the ${frame.extended ? '29' : '11'}-bit range.`);
  if (!Number.isInteger(frame.frameLength) || !VALID_FRAME_LENGTHS.has(frame.frameLength)) add('FRAME_LENGTH_RANGE', 'Frame length must be a valid Classic CAN or CAN FD payload length.');

  const ids = new Set<string>(); const names = new Set<string>();
  const bits = new Map<number, string>();
  const overlapPairs = new Set<string>();
  for (const signal of frame.signals) {
    const detail = { signalId: signal.id };
    if (!signal.id.trim()) add('SIGNAL_ID_REQUIRED', 'Signal ID is required.', detail);
    else if (ids.has(signal.id)) add('SIGNAL_ID_DUPLICATE', `Signal ID “${signal.id}” is duplicated.`, detail);
    ids.add(signal.id);
    if (!signal.name.trim()) add('SIGNAL_NAME_REQUIRED', 'Signal name is required.', detail);
    else if (names.has(signal.name.trim())) add('SIGNAL_NAME_DUPLICATE', `Signal name “${signal.name.trim()}” is duplicated in this Frame.`, detail);
    names.add(signal.name.trim());
    if (!Number.isInteger(signal.byteOffset) || signal.byteOffset < 0) add('SIGNAL_BYTE_RANGE', `${signal.name || signal.id}: byte position must be a non-negative integer.`, detail);
    if (!Number.isInteger(signal.bitOffset) || signal.bitOffset < 0 || signal.bitOffset > 7) add('SIGNAL_BIT_RANGE', `${signal.name || signal.id}: bit position must be between 0 and 7.`, detail);
    if (!Number.isInteger(signal.lengthBits) || signal.lengthBits < 1 || signal.lengthBits > 64) add('SIGNAL_LENGTH_RANGE', `${signal.name || signal.id}: length must be between 1 and 64 bits.`, detail);
    const occupied = occupiedBits(signal);
    if (occupied.some((bit) => bit < 0 || bit >= frame.frameLength * 8)) add('SIGNAL_OUTSIDE_FRAME', `${signal.name || signal.id}: bit range exceeds the frame length.`, detail);
    for (const bit of occupied) {
      const previous = bits.get(bit);
      if (previous && previous !== signal.id) {
        const pair = [previous, signal.id].sort().join(':');
        if (!overlapPairs.has(pair)) {
          overlapPairs.add(pair);
          add('SIGNAL_OVERLAP', `${signal.name || signal.id} overlaps another signal at byte ${Math.floor(bit / 8)}, bit ${bit % 8}.`, detail);
        }
      }
      else bits.set(bit, signal.id);
    }
    if (!Number.isFinite(signal.conversion.lsb) || signal.conversion.lsb <= 0) add('SIGNAL_LSB_INVALID', `${signal.name || signal.id}: Scale must be a positive finite number.`, detail);
    const parsed = parseResolution(signal.conversion.lsbText);
    if (!parsed.valid) add('SIGNAL_LSB_TEXT_INVALID', `${signal.name || signal.id}: ${parsed.error}`, detail);
    else if (Math.abs(parsed.resolution.value - signal.conversion.lsb) > Math.max(1e-15, Math.abs(signal.conversion.lsb) * 1e-12)) add('SIGNAL_LSB_MISMATCH', `${signal.name || signal.id}: stored Scale value does not match its display text.`, detail);
    if (!Number.isFinite(signal.conversion.offset)) add('SIGNAL_OFFSET_INVALID', `${signal.name || signal.id}: offset must be finite.`, detail);
  }
  const availableNames = new Set(frame.signals.map((signal) => signal.name.trim()).filter(Boolean));
  for (const signal of frame.derivedSignals ?? []) {
    const detail = { signalId: signal.id };
    if (!signal.id.trim()) add('DERIVED_SIGNAL_ID_REQUIRED', 'Derived Signal ID is required.', detail);
    else if (ids.has(signal.id)) add('SIGNAL_ID_DUPLICATE', `Signal ID “${signal.id}” is duplicated.`, detail);
    ids.add(signal.id);
    const name = signal.name.trim();
    if (!name) add('DERIVED_SIGNAL_NAME_REQUIRED', 'Derived Signal name is required.', detail);
    else if (names.has(name)) add('SIGNAL_NAME_DUPLICATE', `Signal name “${name}” is duplicated in this Frame.`, detail);
    names.add(name);
    if (signal.operation.type === 'expression') {
      if (!signal.operation.expression.trim()) add('DERIVED_EXPRESSION_EMPTY', `${name || signal.id}: expression is empty.`, detail);
      else {
      try {
        const expression = compileExpression(signal.operation.expression);
        if (!expression.variables.size) add('DERIVED_EXPRESSION_INPUT_REQUIRED', `${name || signal.id}: expression must reference at least one earlier Signal.`, detail);
        for (const variable of expression.variables) if (!availableNames.has(variable)) add('DERIVED_SIGNAL_FORWARD_REFERENCE', `${name || signal.id}: “${variable}” is not an earlier Signal or Derived Signal.`, detail);
      } catch (error) { add('DERIVED_EXPRESSION_INVALID', `${name || signal.id}: ${(error as Error).message}`, detail); }
      }
    } else {
      if (!signal.operation.input.trim()) add('DERIVED_INPUT_REQUIRED', `${name || signal.id}: an input Signal is required.`, detail);
      else if (!availableNames.has(signal.operation.input.trim())) add('DERIVED_SIGNAL_FORWARD_REFERENCE', `${name || signal.id}: “${signal.operation.input.trim()}” is not an earlier Signal or Derived Signal.`, detail);
      if (signal.operation.type === 'lookup') {
        if (signal.operation.points.length < 2) add('DERIVED_LOOKUP_POINTS_REQUIRED', `${name || signal.id}: Lookup Table requires at least two points.`, detail);
        const inputs = new Set<number>();
        for (const point of signal.operation.points) {
          if (!Number.isFinite(point.input) || !Number.isFinite(point.output)) add('DERIVED_LOOKUP_POINT_INVALID', `${name || signal.id}: Lookup Table points must be finite numbers.`, detail);
          else if (inputs.has(point.input)) add('DERIVED_LOOKUP_INPUT_DUPLICATE', `${name || signal.id}: Lookup Table INPUT ${point.input} is duplicated.`, detail);
          inputs.add(point.input);
        }
      } else if (!Number.isFinite(signal.operation.timeSeconds) || signal.operation.timeSeconds <= 0) {
        add('DERIVED_FILTER_TIME_INVALID', `${name || signal.id}: Filter time must be a positive finite number of seconds.`, detail);
      }
    }
    if (name) availableNames.add(name);
  }
  return { valid: diagnostics.length === 0, diagnostics };
}
