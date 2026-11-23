import type { SendMode } from '../timing/sendingPattern';
import { createDiagnostic, type Diagnostic } from '../diagnostics/diagnostic';
import { normalizeFrameDefinition, parseValueLabelRaw, validateFrameDefinition, type ManualFrameDefinition, type ManualSignalDefinition } from '../manual/manualDefinition';

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
const CYCLE_TIME = new RegExp(`^\\s*BA_\\s+"GenMsgCycleTime"\\s+BO_\\s+(0x[0-9a-f]+|\\d+)\\s+(${NUMBER})\\s*;`, 'i');
const CYCLE_TIME_DEFAULT = new RegExp(`^\\s*BA_DEF_DEF_\\s+"GenMsgCycleTime"\\s+(${NUMBER})\\s*;`, 'i');
const SEND_TYPE_DEFINITION = /^\s*BA_DEF_\s+BO_\s+"GenMsgSendType"\s+ENUM\s+([^;]*);/im;
const SEND_TYPE_DEFAULT = /^\s*BA_DEF_DEF_\s+"GenMsgSendType"\s+("[^"]*"|\d+)\s*;/i;
const SEND_TYPE = /^\s*BA_\s+"GenMsgSendType"\s+BO_\s+(0x[0-9a-f]+|\d+)\s+("[^"]*"|\d+)\s*;/i;
/** The GenMsgSendType values written on export, in this order. */
const SEND_TYPES = ['Cyclic', 'Spontaneous', 'CyclicAndSpontaneous', 'NoMsgSendType'] as const;
/** A GenMsgSendType value as a send mode: the many tool-specific names come down to cyclic, spontaneous (events) or both. */
export function sendModeOfDbc(name: string): SendMode | undefined {
  const value = name.toLowerCase(); const cyclic = value.includes('cyclic') || value.includes('periodic'); const events = value.includes('spontan') || value.includes('event') || value === 'ifactive';
  return cyclic && events ? 'mixed' : cyclic ? 'periodic' : events ? 'event' : undefined;
}
// Vector's VFrameFormat values: 0 StandardCAN, 1 ExtendedCAN, 14 StandardCAN_FD, 15 ExtendedCAN_FD.
const FRAME_FORMATS = ['StandardCAN', 'ExtendedCAN', 'reserved', 'J1939PG', 'reserved', 'reserved', 'reserved', 'reserved', 'reserved', 'reserved', 'reserved', 'reserved', 'reserved', 'reserved', 'StandardCAN_FD', 'ExtendedCAN_FD'];
const EXTENDED_MULTIPLEXING = /^\s*SG_MUL_VAL_\s+(0x[0-9a-f]+|\d+)\s+([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s+([^;]+);/i;

/**
 * DBC files have no encoding declaration: tools on Japanese Windows write Shift_JIS, others UTF-8 or Windows-1252.
 * Valid UTF-8 is read as UTF-8. Otherwise the text is read as Shift_JIS only when it reads as Japanese; most
 * Windows-1252 text (such as "°C" or "Länge") is also valid Shift_JIS, but turns into stray half-width katakana or lone rare kanji.
 */
export function decodeDbcBytes(bytes: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { /* not UTF-8 */ }
  let japanese: string | undefined;
  try { japanese = new TextDecoder('shift_jis', { fatal: true }).decode(bytes); } catch { /* not Shift_JIS */ }
  return japanese !== undefined && (readsAsJapanese(japanese) || hasCommonKanji(bytes)) ? japanese : new TextDecoder('windows-1252').decode(bytes);
}

/**
 * A common (JIS level 1) kanji, such as a unit written as "秒" alone: its lead byte 0x88-0x9F is, in Windows-1252, a
 * rarely used punctuation mark (the "•" of "•b"), while Windows-1252 letters such as "ä" fall on other lead bytes.
 */
function hasCommonKanji(bytes: Uint8Array): boolean {
  for (let index = 0; index < bytes.length; index++) {
    const byte = bytes[index];
    if (byte < 0x81 || (byte >= 0xa0 && byte < 0xe0)) continue;
    if (byte >= 0x88 && byte <= 0x9f) return true;
    index++; // skip the trail byte of any other double-byte character
  }
  return false;
}

/** Kana, Japanese punctuation and full-width forms, two or more kanji in a row, or three or more half-width katakana in a row. */
function readsAsJapanese(text: string): boolean {
  return /[\u3000-\u30ff\uff01-\uff5e\u2103]|[\u4e00-\u9fff]{2}|[\uff61-\uff9f]{3}/.test(text);
}

export function importDbc(source: string, sourceId = 'database.dbc'): DbcImportResult {
  const frames: ManualFrameDefinition[] = []; const diagnostics: Diagnostic[] = [];
  // Line breaks may be LF, CR LF or CR alone; line numbers below count the normalized text.
  const text = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  // Signals marked both multiplexed and multiplexer (m1M): the selectors of nested multiplexing.
  const nestedSelectors = new Set<string>();
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
    if (scale === 0 || ![scale, offset, minimum, maximum].every(Number.isFinite)) { diagnostics.push(diagnostic(sourceId, lineNumber, 'DBC_SIGNAL_CONVERSION', `Signal ${signal[1]} has an invalid conversion. Scale must be non-zero and all values finite.`)); return; }
    const position = dbcStartToManual(startBit, byteOrder);
    const idBase = `dbc-${current.frame.extended ? 'e' : 's'}-${current.frame.canId.toString(16)}-${slug(signal[1])}`;
    const usedIds = new Set(current.frame.signals.map((item) => item.id)); let id = idBase; let suffix = 2; while (usedIds.has(id)) id = `${idBase}-${suffix++}`;
    const definition: ManualSignalDefinition = {
      id, name: signal[1], unit: unescapeDbc(signal[11]), ...position, lengthBits,
      signedness: signal[6] === '-' ? 'signed' : 'unsigned', byteOrder,
      conversion: { type: 'scale-offset', lsb: scale, lsbText: signal[7], offset }, minimum, maximum,
      multiplexing: marker === 'M' ? { type: 'multiplexer' } : marker?.startsWith('m') ? { type: 'conditional', ranges: [{ from: Number(/^m(\d+)/.exec(marker)?.[1]), to: Number(/^m(\d+)/.exec(marker)?.[1]) }] } : undefined,
    };
    if (marker && /^m\d+M$/.test(marker)) nestedSelectors.add(id);
    current.frame = { ...current.frame, multiplexing: current.frame.multiplexing || Boolean(marker), signals: [...current.frame.signals, definition] };
  });
  finish();
  // SIG_VALTYPE_ <message> <signal> : 1 (float, 32 bits) | 2 (double, 64 bits); a Signal without one is an integer.
  lines.forEach((line, index) => {
    const match = /^\s*SIG_VALTYPE_\s+(0x[0-9a-f]+|\d+)\s+([A-Za-z_][A-Za-z0-9_]*)\s*:?\s*(\d+)\s*;/i.exec(line); if (!match) return;
    const decoded = decodeDbcMessageId(Number(match[1])); const frameIndex = decoded ? frames.findIndex((frame) => frame.canId === decoded.canId && frame.extended === decoded.extended) : -1;
    const target = frames[frameIndex]?.signals.find((signal) => signal.name === match[2]);
    if (!target) { diagnostics.push(diagnostic(sourceId, index + 1, 'DBC_VALUE_TYPE_REFERENCE', `SIG_VALTYPE_ references an unknown Signal ${match[2]}.`, 'warning')); return; }
    const type = Number(match[3]); if (type === 0) return;
    if ((type !== 1 && type !== 2) || target.lengthBits !== (type === 1 ? 32 : 64)) { diagnostics.push(diagnostic(sourceId, index + 1, 'DBC_VALUE_TYPE_INVALID', `${target.name}: SIG_VALTYPE_ ${type} does not match its ${target.lengthBits}-bit length.`)); return; }
    frames[frameIndex] = { ...frames[frameIndex], signals: frames[frameIndex].signals.map((signal) => signal.id === target.id ? { ...signal, signedness: 'float' as const } : signal) };
  });
  // VAL_ records may span lines; a semicolon inside a quoted label is not a terminator.
  const valueRecords = /^[ \t]*VAL_[ \t]+(\d+|0x[0-9a-f]+)[ \t]+([A-Za-z_][A-Za-z0-9_]*)\s+((?:"(?:\\.|[^"\\])*"|[^";])*);/gmi;
  const records = [...text.matchAll(valueRecords)];
  let recordIndex = 0;
  for (const start of text.matchAll(/^[ \t]*VAL_[ \t]+(?=\d)/gm)) {
    while (recordIndex < records.length && records[recordIndex].index! + records[recordIndex][0].length <= start.index!) recordIndex++;
    const record = records[recordIndex];
    if (!record || start.index! < record.index!) diagnostics.push(diagnostic(sourceId, text.slice(0, start.index).split('\n').length, 'DBC_VALUE_LABEL_SYNTAX', 'Invalid or unterminated VAL_ record.'));
  }
  for (const match of records) {
    const line = text.slice(0, match.index).split('\n').length;
    const decoded = decodeDbcMessageId(Number(match[1]));
    const frameIndex = decoded ? frames.findIndex((frame) => frame.canId === decoded.canId && frame.extended === decoded.extended) : -1;
    const target = frames[frameIndex]?.signals.find((signal) => signal.name === match[2]);
    if (!target) { diagnostics.push(diagnostic(sourceId, line, 'DBC_VALUE_LABEL_REFERENCE', `Value labels reference an unknown Signal ${match[2]}.`, 'warning')); continue; }
    const values: Record<string, string> = { ...target.valueLabels }; let rest = match[3].trim(); let valid = true;
    while (rest) {
      const pair = /^([+-]?\d+)\s+"((?:\\.|[^"\\])*)"\s*/.exec(rest);
      if (!pair) { valid = false; break; }
      const key = BigInt(pair[1]).toString();
      if (Object.prototype.hasOwnProperty.call(values, key)) { valid = false; break; }
      values[key] = unescapeDbc(pair[2]); rest = rest.slice(pair[0].length);
    }
    if (!valid) { diagnostics.push(diagnostic(sourceId, line, 'DBC_VALUE_LABEL_SYNTAX', `${target.name}: invalid or duplicate RAW value in VAL_.`)); continue; }
    frames[frameIndex] = { ...frames[frameIndex], signals: frames[frameIndex].signals.map((signal) => signal.id === target.id ? { ...signal, valueLabels: values } : signal) };
  }
  // SG_MUL_VAL_ ties a Signal to its Multiplexer. A Frame has one Multiplexer here, so a Signal selected by a nested
  // Multiplexer (m<n>M), or by a Signal that is itself left out, would be decoded with the wrong selector: such Signals are
  // left out, however deep the nesting, and reported; the rest of the Frame is kept.
  const selections = new Map<number, Array<{ readonly line: number; readonly target: ManualSignalDefinition; readonly selector: ManualSignalDefinition; readonly ranges: readonly { from: number; to: number }[] }>>();
  lines.forEach((line, index) => {
    const match = EXTENDED_MULTIPLEXING.exec(line); if (!match) return;
    const decoded = decodeDbcMessageId(Number(match[1])); const frameIndex = decoded ? frames.findIndex((frame) => frame.canId === decoded.canId && frame.extended === decoded.extended) : -1;
    if (frameIndex < 0) { diagnostics.push(diagnostic(sourceId, index + 1, 'DBC_MULTIPLEXING_FRAME', 'Extended multiplexing references an unknown Frame.', 'warning')); return; }
    const frame = frames[frameIndex]; const target = frame.signals.find((signal) => signal.name === match[2]); const selector = frame.signals.find((signal) => signal.name === match[3]); const ranges = parseDbcMuxRanges(match[4]);
    if (!target || !selector || !ranges) { diagnostics.push(diagnostic(sourceId, index + 1, 'DBC_MULTIPLEXING_REFERENCE', 'Extended multiplexing contains an invalid Signal reference or value range.', 'warning')); return; }
    selections.set(frameIndex, [...(selections.get(frameIndex) ?? []), { line: index + 1, target, selector, ranges }]);
  });
  for (const [frameIndex, entries] of selections) {
    const leftOut = new Set<string>();
    for (let changed = true; changed;) {
      changed = false;
      for (const entry of entries) {
        if (leftOut.has(entry.target.id) || !(nestedSelectors.has(entry.selector.id) || leftOut.has(entry.selector.id))) continue;
        leftOut.add(entry.target.id); changed = true;
        diagnostics.push(diagnostic(sourceId, entry.line, 'DBC_NESTED_MULTIPLEXING', `${frames[frameIndex].name}: Signal ${entry.target.name} is selected by the nested Multiplexer ${entry.selector.name} and was not imported. Nested multiplexing is not supported.`, 'warning'));
      }
    }
    let frame = { ...frames[frameIndex], signals: frames[frameIndex].signals.filter((signal) => !leftOut.has(signal.id)) };
    for (const { target, selector, ranges } of entries) {
      if (leftOut.has(target.id)) continue;
      frame = { ...frame, multiplexing: true, signals: frame.signals.map((signal) => signal.id === selector.id ? { ...signal, multiplexing: { type: 'multiplexer' } } : signal.id === target.id ? { ...signal, multiplexing: { type: 'conditional', ranges } } : signal) };
    }
    frames[frameIndex] = frame;
  }
  // GenMsgCycleTime (ms) is the Frame's expected period; the attribute's default applies to Frames without their own value.
  let defaultPeriod: number | undefined; const periods = new Map<number, number>();
  for (const line of lines) {
    const fallback = CYCLE_TIME_DEFAULT.exec(line); if (fallback) { defaultPeriod = Number(fallback[1]); continue; }
    const match = CYCLE_TIME.exec(line); if (!match) continue;
    const decoded = decodeDbcMessageId(Number(match[1])); const frameIndex = decoded ? frames.findIndex((frame) => frame.canId === decoded.canId && frame.extended === decoded.extended) : -1;
    if (frameIndex >= 0) periods.set(frameIndex, Number(match[2]));
  }
  frames.forEach((frame, index) => {
    const period = periods.get(index) ?? defaultPeriod;
    if (period !== undefined && Number.isFinite(period) && period > 0) frames[index] = { ...frame, expectedPeriodMs: period };
  });
  // GenMsgSendType is the Frame's send mode. Its values are indexes into the attribute's ENUM (or, by some tools, the names).
  let sendTypeNames: string[] = []; let defaultSendType: string | undefined; const sendTypes = new Map<number, string>();
  const sendTypeName = (value: string) => value.startsWith('"') ? value.slice(1, -1) : sendTypeNames[Number(value)];
  // The ENUM's values may continue on the following lines, up to its semicolon.
  const definition = SEND_TYPE_DEFINITION.exec(lines.join('\n')); if (definition) sendTypeNames = [...definition[1].matchAll(/"([^"]*)"/g)].map((item) => item[1]);
  for (const line of lines) {
    const fallback = SEND_TYPE_DEFAULT.exec(line); if (fallback) { defaultSendType = sendTypeName(fallback[1]); continue; }
    const match = SEND_TYPE.exec(line); if (!match) continue;
    const decoded = decodeDbcMessageId(Number(match[1])); const frameIndex = decoded ? frames.findIndex((frame) => frame.canId === decoded.canId && frame.extended === decoded.extended) : -1;
    const name = sendTypeName(match[2]); if (frameIndex >= 0 && name !== undefined) sendTypes.set(frameIndex, name);
  }
  frames.forEach((frame, index) => { const name = sendTypes.get(index) ?? defaultSendType; const mode = name === undefined ? undefined : sendModeOfDbc(name); if (mode) frames[index] = { ...frames[index], sendMode: mode }; });
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
  const usedMessageNames = new Set<string>(); const valueTypeLines: string[] = [];
  const exported: Array<{ readonly dbcId: number; readonly frame: ManualFrameDefinition }> = [];
  for (const frame of frames) {
    const validation = validateFrameDefinition(frame);
    if (!validation.valid) { diagnostics.push(...validation.diagnostics); continue; }
    const messageName = uniqueDbcName(frame.name, usedMessageNames, `Frame_${frame.canId.toString(16).toUpperCase()}`);
    const dbcId = frame.extended ? frame.canId + 0x80000000 : frame.canId;
    lines.push(`BO_ ${dbcId} ${messageName}: ${frame.frameLength} Vector__XXX`); exported.push({ dbcId, frame });
    const usedSignalNames = new Set<string>();
    const signalNames = new Map<string, string>(); const extendedMuxLines: string[] = [];
    const selector = frame.signals.find((signal) => signal.multiplexing?.type === 'multiplexer');
    for (const signal of frame.signals) {
      const signalName = uniqueDbcName(signal.name, usedSignalNames, 'Signal');
      signalNames.set(signal.id, signalName);
      if (signalName !== signal.name) diagnostics.push(diagnostic('export.dbc', undefined, 'DBC_NAME_NORMALIZED', `“${signal.name}” was exported as DBC identifier “${signalName}”.`, 'warning'));
      const start = manualStartToDbc(signal.byteOffset, signal.bitOffset, signal.byteOrder);
      const byteOrder = signal.byteOrder === 'little' ? '1' : '0'; const sign = signal.signedness === 'unsigned' ? '+' : '-';
      if (signal.signedness === 'float') valueTypeLines.push(`SIG_VALTYPE_ ${dbcId} ${signalName} : ${signal.lengthBits === 64 ? 2 : 1};`);
      const [minimum, maximum] = physicalRange(signal);
      const marker = signal.multiplexing?.type === 'multiplexer' ? ' M' : signal.multiplexing?.type === 'conditional' ? ` m${signal.multiplexing.ranges[0]?.from ?? 0}` : '';
      lines.push(` SG_ ${signalName}${marker} : ${start}|${signal.lengthBits}@${byteOrder}${sign} (${numberText(signal.conversion.lsb)},${numberText(signal.conversion.offset)}) [${numberText(minimum)}|${numberText(maximum)}] "${escapeDbc(signal.unit)}" Vector__XXX`);
      if (signal.multiplexing?.type === 'conditional' && selector && (signal.multiplexing.ranges.length !== 1 || signal.multiplexing.ranges[0].from !== signal.multiplexing.ranges[0].to)) extendedMuxLines.push(`${signalName}\t${signal.multiplexing.ranges.map((range) => `${range.from}-${range.to}`).join(', ')}`);
    }
    const selectorName = selector ? signalNames.get(selector.id) : undefined;
    for (const signal of frame.signals) {
      const values = Object.entries(signal.valueLabels ?? {});
      if (values.length) lines.push(`VAL_ ${dbcId} ${signalNames.get(signal.id)} ${values.map(([raw, label]) => `${parseValueLabelRaw(raw) ?? raw} "${escapeDbc(label)}"`).join(' ')};`);
    }
    if (selectorName) for (const entry of extendedMuxLines) { const [signalName, ranges] = entry.split('\t'); lines.push(`SG_MUL_VAL_ ${dbcId} ${signalName} ${selectorName} ${ranges};`); }
    if (frame.derivedSignals?.length) diagnostics.push(diagnostic('export.dbc', undefined, 'DBC_DERIVED_SIGNALS_SKIPPED', `${frame.name}: ${frame.derivedSignals.length} Derived Signal definition(s) were not exported because standard DBC SG_ entries cannot preserve their operations.`, 'warning'));
    lines.push('');
  }
  // Attributes: the expected period as GenMsgCycleTime, the send mode as GenMsgSendType, and CAN FD (a Frame longer than
  // 8 bytes) as BusType and VFrameFormat.
  const periodic = exported.filter(({ frame }) => frame.expectedPeriodMs !== undefined);
  const sent = exported.filter(({ frame }) => frame.sendMode !== undefined);
  const fd = exported.some(({ frame }) => frame.frameLength > 8);
  if (periodic.length || sent.length || fd) {
    const definitions: string[] = []; const defaults: string[] = []; const values: string[] = [];
    if (fd) { definitions.push('BA_DEF_  "BusType" STRING ;', `BA_DEF_ BO_  "VFrameFormat" ENUM  ${FRAME_FORMATS.map((name) => `"${name}"`).join(',')};`); defaults.push('BA_DEF_DEF_  "BusType" "CAN";', 'BA_DEF_DEF_  "VFrameFormat" "StandardCAN";'); values.push('BA_ "BusType" "CAN FD";'); }
    if (periodic.length) {
      const integers = periodic.every(({ frame }) => Number.isInteger(frame.expectedPeriodMs));
      definitions.push(integers ? 'BA_DEF_ BO_  "GenMsgCycleTime" INT 0 2147483647;' : 'BA_DEF_ BO_  "GenMsgCycleTime" FLOAT 0 2147483647;'); defaults.push('BA_DEF_DEF_  "GenMsgCycleTime" 0;');
    }
    if (fd) for (const { dbcId, frame } of exported) values.push(`BA_ "VFrameFormat" BO_ ${dbcId} ${(frame.frameLength > 8 ? 14 : 0) + (frame.extended ? 1 : 0)};`);
    for (const { dbcId, frame } of periodic) values.push(`BA_ "GenMsgCycleTime" BO_ ${dbcId} ${numberText(frame.expectedPeriodMs!)};`);
    if (sent.length) {
      definitions.push(`BA_DEF_ BO_  "GenMsgSendType" ENUM  ${SEND_TYPES.map((name) => `"${name}"`).join(',')};`); defaults.push('BA_DEF_DEF_  "GenMsgSendType" "NoMsgSendType";');
      for (const { dbcId, frame } of sent) values.push(`BA_ "GenMsgSendType" BO_ ${dbcId} ${frame.sendMode === 'periodic' ? 0 : frame.sendMode === 'event' ? 1 : 2};`);
    }
    lines.push(...definitions, ...defaults, ...values, '');
  }
  // SIG_VALTYPE_ records follow the messages, as DBC writers place them.
  if (valueTypeLines.length) lines.push(...valueTypeLines, '');
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
  // A Float Signal has no integer range; [0|0] is DBC's "not given".
  if (signal.signedness === 'float') return [signal.minimum ?? 0, signal.maximum ?? 0];
  const signed = signal.signedness === 'signed'; const rawMinimum = signed ? -(2 ** (signal.lengthBits - 1)) : 0; const rawMaximum = signed ? 2 ** (signal.lengthBits - 1) - 1 : 2 ** signal.lengthBits - 1;
  const first = rawMinimum * signal.conversion.lsb + signal.conversion.offset; const last = rawMaximum * signal.conversion.lsb + signal.conversion.offset;
  return [signal.minimum ?? Math.min(first, last), signal.maximum ?? Math.max(first, last)];
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
