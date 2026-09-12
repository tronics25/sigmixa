import { createDiagnostic, type Diagnostic } from '../diagnostics/diagnostic';
import { normalizeFrameDefinition, validateFrameDefinition, type ManualFrameDefinition, type ManualSignalDefinition } from '../manual/manualDefinition';

export interface DbcImportResult {
  readonly frames: readonly ManualFrameDefinition[];
  readonly diagnostics: readonly Diagnostic[];
}

export interface DbcExportResult {
  readonly text: string;
  readonly diagnostics: readonly Diagnostic[];
}

const NUMBER = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?';
const SIGNAL = new RegExp(`^\\s*SG_\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*(M|m\\d+(?:M)?)?\\s*:\\s*(\\d+)\\|(\\d+)@([01])([+-])\\s*\\(\\s*(${NUMBER})\\s*,\\s*(${NUMBER})\\s*\\)\\s*\\[\\s*(${NUMBER})\\s*\\|\\s*(${NUMBER})\\s*\\]\\s*"((?:[^"\\\\]|\\\\.)*)"`);
const MESSAGE = /^\s*BO_\s+(0x[0-9a-f]+|\d+)\s+([A-Za-z_][A-Za-z0-9_]*):\s*(\d+)\s+\S+/i;
const EXTENDED_MULTIPLEXING = /^\s*SG_MUL_VAL_\s+(0x[0-9a-f]+|\d+)\s+([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s+([^;]+);/i;

export function importDbc(text: string, sourceId = 'database.dbc'): DbcImportResult {
  const frames: ManualFrameDefinition[] = []; const diagnostics: Diagnostic[] = [];
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  let current: { frame: ManualFrameDefinition; line: number } | undefined;
  const finish = () => {
    if (!current) return;
    frames.push(normalizeFrameDefinition(current.frame));
    current = undefined;
  };
  lines.forEach((line, index) => {
    const lineNumber = index + 1; const message = MESSAGE.exec(line);
    if (message) {
      finish();
      const rawId = Number(message[1]); const decoded = decodeDbcMessageId(rawId);
      if (!decoded) { diagnostics.push(diagnostic(sourceId, lineNumber, 'DBC_MESSAGE_ID', `Message ${message[2]} has an invalid DBC CAN ID.`)); return; }
      if (rawId > 0x7ff && rawId < 0x80000000) diagnostics.push(diagnostic(sourceId, lineNumber, 'DBC_EXTENDED_ID_INFERRED', `Message ${message[2]} omits the DBC extended-ID flag; it was inferred from its CAN ID.`, 'warning'));
      const frameLength = Number(message[3]);
      current = { line: lineNumber, frame: { id: frameId(decoded.canId, decoded.extended), canId: decoded.canId, extended: decoded.extended, name: message[2], frameLength, signals: [], derivedSignals: [], origin: { type: 'manual' } } };
      return;
    }
    if (!/^\s*SG_\s+/.test(line)) return;
    if (!current) { diagnostics.push(diagnostic(sourceId, lineNumber, 'DBC_SIGNAL_WITHOUT_MESSAGE', 'Signal definition appears before a message definition.')); return; }
    const signal = SIGNAL.exec(line);
    if (!signal) { diagnostics.push(diagnostic(sourceId, lineNumber, 'DBC_SIGNAL_SYNTAX', 'Unsupported or invalid DBC Signal definition.')); return; }
    const marker = signal[2];
    const startBit = Number(signal[3]); const lengthBits = Number(signal[4]); const byteOrder = signal[5] === '1' ? 'little' : 'big';
    const scale = Number(signal[7]); const offset = Number(signal[8]); const minimum = Number(signal[9]); const maximum = Number(signal[10]);
    if (!(scale > 0) || ![offset, minimum, maximum].every(Number.isFinite)) { diagnostics.push(diagnostic(sourceId, lineNumber, 'DBC_SIGNAL_CONVERSION', `Signal ${signal[1]} has a conversion unsupported by SigMixa. Scale must be positive and all values finite.`)); return; }
    const position = dbcStartToManual(startBit, byteOrder);
    const idBase = `dbc-${current.frame.extended ? 'e' : 's'}-${current.frame.canId.toString(16)}-${slug(signal[1])}`;
    const usedIds = new Set(current.frame.signals.map((item) => item.id)); let id = idBase; let suffix = 2; while (usedIds.has(id)) id = `${idBase}-${suffix++}`;
    const definition: ManualSignalDefinition = {
      id, name: signal[1], unit: unescapeDbc(signal[11]), ...position, lengthBits,
      signedness: signal[6] === '-' ? 'signed' : 'unsigned', byteOrder,
      conversion: { type: 'scale-offset', lsb: scale, lsbText: signal[7], offset }, minimum, maximum,
      multiplexing: marker === 'M' ? { type: 'multiplexer' } : marker?.startsWith('m') ? { type: 'conditional', ranges: [{ from: Number(/^m(\d+)/.exec(marker)?.[1]), to: Number(/^m(\d+)/.exec(marker)?.[1]) }] } : undefined,
    };
    current.frame = { ...current.frame, multiplexing: current.frame.multiplexing || Boolean(marker), signals: [...current.frame.signals, definition] };
  });
  finish();
  lines.forEach((line, index) => {
    const match = EXTENDED_MULTIPLEXING.exec(line); if (!match) return;
    const decoded = decodeDbcMessageId(Number(match[1])); const frameIndex = decoded ? frames.findIndex((frame) => frame.canId === decoded.canId && frame.extended === decoded.extended) : -1;
    if (frameIndex < 0) { diagnostics.push(diagnostic(sourceId, index + 1, 'DBC_MULTIPLEXING_FRAME', 'Extended multiplexing references an unknown Frame.', 'warning')); return; }
    const frame = frames[frameIndex]; const target = frame.signals.find((signal) => signal.name === match[2]); const selector = frame.signals.find((signal) => signal.name === match[3]); const ranges = parseDbcMuxRanges(match[4]);
    if (!target || !selector || !ranges) { diagnostics.push(diagnostic(sourceId, index + 1, 'DBC_MULTIPLEXING_REFERENCE', 'Extended multiplexing contains an invalid Signal reference or value range.', 'warning')); return; }
    frames[frameIndex] = { ...frame, multiplexing: true, signals: frame.signals.map((signal) => signal.id === selector.id ? { ...signal, multiplexing: { type: 'multiplexer' } } : signal.id === target.id ? { ...signal, multiplexing: { type: 'conditional', ranges } } : signal) };
  });
  const validFrames = frames.filter((frame) => {
    const validation = validateFrameDefinition(frame);
    if (validation.valid) return true;
    diagnostics.push(...validation.diagnostics.map((item, index) => ({ ...item, id: `dbc:${frame.id}:${item.code}:${index}`, location: { sourceId } })));
    return false;
  });
  return { frames: validFrames, diagnostics };
}

export function exportDbc(frames: readonly ManualFrameDefinition[]): DbcExportResult {
  const diagnostics: Diagnostic[] = []; const lines = [
    'VERSION ""', '', 'NS_ :', '', 'BS_:', '', 'BU_: Vector__XXX', '',
  ];
  const usedMessageNames = new Set<string>();
  for (const frame of frames) {
    const validation = validateFrameDefinition(frame);
    if (!validation.valid) { diagnostics.push(...validation.diagnostics); continue; }
    const messageName = uniqueDbcName(frame.name, usedMessageNames, `Frame_${frame.canId.toString(16).toUpperCase()}`);
    const dbcId = frame.extended ? frame.canId + 0x80000000 : frame.canId;
    lines.push(`BO_ ${dbcId} ${messageName}: ${frame.frameLength} Vector__XXX`);
    const usedSignalNames = new Set<string>();
    const signalNames = new Map<string, string>(); const extendedMuxLines: string[] = [];
    const selector = frame.signals.find((signal) => signal.multiplexing?.type === 'multiplexer');
    for (const signal of frame.signals) {
      const signalName = uniqueDbcName(signal.name, usedSignalNames, 'Signal');
      signalNames.set(signal.id, signalName);
      if (signalName !== signal.name) diagnostics.push(diagnostic('export.dbc', undefined, 'DBC_NAME_NORMALIZED', `“${signal.name}” was exported as DBC identifier “${signalName}”.`, 'warning'));
      const start = manualStartToDbc(signal.byteOffset, signal.bitOffset, signal.byteOrder);
      const byteOrder = signal.byteOrder === 'little' ? '1' : '0'; const sign = signal.signedness === 'signed' ? '-' : '+';
      const [minimum, maximum] = physicalRange(signal);
      const marker = signal.multiplexing?.type === 'multiplexer' ? ' M' : signal.multiplexing?.type === 'conditional' ? ` m${signal.multiplexing.ranges[0]?.from ?? 0}` : '';
      lines.push(` SG_ ${signalName}${marker} : ${start}|${signal.lengthBits}@${byteOrder}${sign} (${numberText(signal.conversion.lsb)},${numberText(signal.conversion.offset)}) [${numberText(minimum)}|${numberText(maximum)}] "${escapeDbc(signal.unit)}" Vector__XXX`);
      if (signal.multiplexing?.type === 'conditional' && selector && (signal.multiplexing.ranges.length !== 1 || signal.multiplexing.ranges[0].from !== signal.multiplexing.ranges[0].to)) extendedMuxLines.push(`${signalName}\t${signal.multiplexing.ranges.map((range) => `${range.from}-${range.to}`).join(', ')}`);
    }
    const selectorName = selector ? signalNames.get(selector.id) : undefined;
    if (selectorName) for (const entry of extendedMuxLines) { const [signalName, ranges] = entry.split('\t'); lines.push(`SG_MUL_VAL_ ${dbcId} ${signalName} ${selectorName} ${ranges};`); }
    if (frame.derivedSignals?.length) diagnostics.push(diagnostic('export.dbc', undefined, 'DBC_DERIVED_SIGNALS_SKIPPED', `${frame.name}: ${frame.derivedSignals.length} Derived Signal definition(s) were not exported because standard DBC SG_ entries cannot preserve their operations.`, 'warning'));
    lines.push('');
  }
  return { text: `${lines.join('\n').trimEnd()}\n`, diagnostics };
}

function parseDbcMuxRanges(text: string): readonly { from: number; to: number }[] | undefined {
  const ranges: Array<{ from: number; to: number }> = [];
  for (const part of text.split(',')) { const match = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(part); if (!match) return undefined; const from = Number(match[1]); const to = Number(match[2] ?? match[1]); if (from > to) return undefined; ranges.push({ from, to }); }
  return ranges.length ? ranges : undefined;
}

export function dbcStartToManual(startBit: number, byteOrder: 'little' | 'big'): Pick<ManualSignalDefinition, 'byteOffset' | 'bitOffset'> {
  return { byteOffset: Math.floor(startBit / 8), bitOffset: byteOrder === 'little' ? startBit % 8 : 7 - (startBit % 8) };
}

export function manualStartToDbc(byteOffset: number, bitOffset: number, byteOrder: 'little' | 'big'): number {
  return byteOffset * 8 + (byteOrder === 'little' ? bitOffset : 7 - bitOffset);
}

function decodeDbcMessageId(rawId: number): { canId: number; extended: boolean } | undefined {
  if (!Number.isInteger(rawId) || rawId < 0 || rawId > 0xffffffff) return undefined;
  const flagged = rawId >= 0x80000000; const canId = flagged ? rawId - 0x80000000 : rawId;
  if (canId > 0x1fffffff) return undefined;
  return { canId, extended: flagged || canId > 0x7ff };
}

function physicalRange(signal: ManualSignalDefinition): readonly [number, number] {
  if (signal.minimum !== undefined && signal.maximum !== undefined) return [signal.minimum, signal.maximum];
  const signed = signal.signedness === 'signed'; const rawMinimum = signed ? -(2 ** (signal.lengthBits - 1)) : 0; const rawMaximum = signed ? 2 ** (signal.lengthBits - 1) - 1 : 2 ** signal.lengthBits - 1;
  return [signal.minimum ?? rawMinimum * signal.conversion.lsb + signal.conversion.offset, signal.maximum ?? rawMaximum * signal.conversion.lsb + signal.conversion.offset];
}

function frameId(canId: number, extended: boolean): string { return `dbc-${extended ? 'e' : 's'}-${canId.toString(16)}`; }
function slug(value: string): string { return value.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'signal'; }
function numberText(value: number): string { return Object.is(value, -0) ? '0' : String(value); }
function unescapeDbc(value: string): string { return value.replace(/\\(["\\])/g, '$1'); }
function escapeDbc(value: string): string { return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }
function uniqueDbcName(value: string, used: Set<string>, fallback: string): string {
  const base = value.trim().replace(/[^A-Za-z0-9_]/g, '_').replace(/^[^A-Za-z_]+/, '') || fallback; let result = base; let suffix = 2;
  while (used.has(result)) result = `${base}_${suffix++}`; used.add(result); return result;
}
function diagnostic(sourceId: string, line: number | undefined, code: string, message: string, severity: 'warning' | 'error' = 'error'): Diagnostic {
  return createDiagnostic({ source: 'definition', code, severity, message, location: { sourceId, ...(line === undefined ? {} : { line }) } });
}
