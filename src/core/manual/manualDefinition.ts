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
  readonly minimum?: number;
  readonly maximum?: number;
  readonly multiplexing?: { readonly type: 'multiplexer' } | { readonly type: 'conditional'; readonly ranges: readonly MultiplexerRange[] };
}

export interface MultiplexerRange { readonly from: number; readonly to: number }

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
  readonly multiplexing?: boolean;
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

export function formatMultiplexerActivation(signal: ManualSignalDefinition): string {
  if (signal.multiplexing?.type === 'multiplexer') return 'Multiplexer';
  if (signal.multiplexing?.type !== 'conditional') return 'Always';
  return signal.multiplexing.ranges.map((range) => range.from === range.to ? String(range.from) : `${range.from}-${range.to}`).join(', ');
}

export function parseMultiplexerActivation(text: string): ManualSignalDefinition['multiplexing'] | undefined {
  const value = text.trim();
  if (!value || /^always$/i.test(value)) return undefined;
  if (/^(multiplexer|mux)$/i.test(value)) return { type: 'multiplexer' };
  const ranges: MultiplexerRange[] = [];
  for (const part of value.split(',')) {
    const match = /^\s*(\d+)\s*(?:[-–]\s*(\d+)\s*)?$/.exec(part);
    if (!match) return undefined;
    const from = Number(match[1]); const to = Number(match[2] ?? match[1]);
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from > to) return undefined;
    ranges.push({ from, to });
  }
  return ranges.length ? { type: 'conditional', ranges } : undefined;
}

export function isSignalActive(signal: ManualSignalDefinition, multiplexerValue: number | undefined): boolean {
  if (signal.multiplexing?.type !== 'conditional') return true;
  return multiplexerValue !== undefined && signal.multiplexing.ranges.some((range) => multiplexerValue >= range.from && multiplexerValue <= range.to);
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

export function orderSignalsByDataPosition(signals: readonly ManualSignalDefinition[]): ManualSignalDefinition[] {
  return signals
    .map((signal, index) => ({ signal, index }))
    .sort((left, right) => {
      const byteDifference = sortablePosition(left.signal.byteOffset) - sortablePosition(right.signal.byteOffset);
      if (byteDifference !== 0) return byteDifference;
      const bitDifference = sortablePosition(left.signal.bitOffset) - sortablePosition(right.signal.bitOffset);
      return bitDifference !== 0 ? bitDifference : left.index - right.index;
    })
    .map(({ signal }) => signal);
}

function sortablePosition(value: number): number { return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER; }

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
  const bits = new Map<number, ManualSignalDefinition[]>();
  const overlapPairs = new Set<string>();
  const multiplexers = frame.signals.filter((signal) => signal.multiplexing?.type === 'multiplexer');
  if (frame.multiplexing && multiplexers.length !== 1) add('FRAME_MULTIPLEXER_REQUIRED', 'A multiplexed Frame must have exactly one Multiplexer Signal.');
  if (!frame.multiplexing && frame.signals.some((signal) => signal.multiplexing)) add('FRAME_MULTIPLEXING_DISABLED', 'Signal multiplexing requires Multiplexing to be enabled for the Frame.');
  const multiplexerMaximum = multiplexers.length === 1 && multiplexers[0].lengthBits <= 32 ? 2 ** multiplexers[0].lengthBits - 1 : undefined;
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
    if (signal.multiplexing?.type === 'multiplexer' && (signal.signedness !== 'unsigned' || signal.lengthBits > 32)) add('SIGNAL_MULTIPLEXER_FORMAT', `${signal.name || signal.id}: Multiplexer must be an unsigned Signal of 1 to 32 bits.`, detail);
    if (signal.multiplexing?.type === 'conditional') {
      if (!signal.multiplexing.ranges.length) add('SIGNAL_MULTIPLEXER_RANGE_REQUIRED', `${signal.name || signal.id}: ACTIVE WHEN requires at least one value.`, detail);
      for (const range of signal.multiplexing.ranges) if (range.from < 0 || range.to < range.from || !Number.isSafeInteger(range.from) || !Number.isSafeInteger(range.to) || (multiplexerMaximum !== undefined && range.to > multiplexerMaximum)) add('SIGNAL_MULTIPLEXER_RANGE_INVALID', `${signal.name || signal.id}: ACTIVE WHEN range is outside the Multiplexer value range.`, detail);
    }
    for (const bit of occupied) {
      const previousSignals = bits.get(bit) ?? [];
      for (const previous of previousSignals) if (!multiplexingIsDisjoint(previous, signal)) {
        const pair = [previous.id, signal.id].sort().join(':');
        if (!overlapPairs.has(pair)) { overlapPairs.add(pair); add('SIGNAL_OVERLAP', `${signal.name || signal.id} overlaps another signal at byte ${Math.floor(bit / 8)}, bit ${bit % 8}.`, detail); }
      }
      previousSignals.push(signal); bits.set(bit, previousSignals);
    }
    if (!Number.isFinite(signal.conversion.lsb) || signal.conversion.lsb <= 0) add('SIGNAL_LSB_INVALID', `${signal.name || signal.id}: Scale must be a positive finite number.`, detail);
    const parsed = parseResolution(signal.conversion.lsbText);
    if (!parsed.valid) add('SIGNAL_LSB_TEXT_INVALID', `${signal.name || signal.id}: ${parsed.error}`, detail);
    else if (Math.abs(parsed.resolution.value - signal.conversion.lsb) > Math.max(1e-15, Math.abs(signal.conversion.lsb) * 1e-12)) add('SIGNAL_LSB_MISMATCH', `${signal.name || signal.id}: stored Scale value does not match its display text.`, detail);
    if (!Number.isFinite(signal.conversion.offset)) add('SIGNAL_OFFSET_INVALID', `${signal.name || signal.id}: offset must be finite.`, detail);
    if (signal.minimum !== undefined && !Number.isFinite(signal.minimum)) add('SIGNAL_MINIMUM_INVALID', `${signal.name || signal.id}: minimum must be finite or blank.`, detail);
    if (signal.maximum !== undefined && !Number.isFinite(signal.maximum)) add('SIGNAL_MAXIMUM_INVALID', `${signal.name || signal.id}: maximum must be finite or blank.`, detail);
    if (signal.minimum !== undefined && signal.maximum !== undefined && signal.minimum > signal.maximum) add('SIGNAL_RANGE_INVALID', `${signal.name || signal.id}: minimum cannot exceed maximum.`, detail);
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

function multiplexingIsDisjoint(left: ManualSignalDefinition, right: ManualSignalDefinition): boolean {
  if (left.multiplexing?.type !== 'conditional' || right.multiplexing?.type !== 'conditional') return false;
  return !left.multiplexing.ranges.some((a) => right.multiplexing?.type === 'conditional' && right.multiplexing.ranges.some((b) => a.from <= b.to && b.from <= a.to));
}
