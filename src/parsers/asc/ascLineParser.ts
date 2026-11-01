import type { CanFrame } from '../../core/frame/canFrame';
import { assertCanFrame } from '../../core/frame/canFrame';
import type { Diagnostic } from '../../core/diagnostics/diagnostic';
import { createDiagnostic } from '../../core/diagnostics/diagnostic';
import { parseCanId } from '../../core/frame/canId';
import { parseAscDate } from '../../core/time/timeFormat';

export type AscNumericBase = 'hex' | 'dec';

export interface AscParseContext {
  readonly sourceId: string;
  readonly line: number;
  readonly sequence: number;
  readonly base: AscNumericBase;
}

export type AscLineResult =
  | { readonly type: 'frame'; readonly frame: CanFrame }
  | { readonly type: 'base'; readonly base: AscNumericBase }
  /** The measurement start written on the `date` line, in clock seconds. */
  | { readonly type: 'date'; readonly start: number }
  | { readonly type: 'ignored' }
  | { readonly type: 'diagnostic'; readonly diagnostic: Diagnostic };

const CLASSIC_RE = /^\s*([+\-]?\d+(?:\.\d+)?)\s+(\d+)\s+([0-9A-Fa-f]+x?)\s+(Rx|Tx)\s+([dr])\s+(\d+)\s*(.*)$/;
const FD_RE = /^\s*([+\-]?\d+(?:\.\d+)?)\s+CANFD\s+(.+)$/i;

function parseId(value: string, base: AscNumericBase): { canId: number; extended: boolean } | undefined {
  return parseCanId(value, base);
}

function diagnostic(context: AscParseContext, code: string, message: string): AscLineResult {
  return {
    type: 'diagnostic',
    diagnostic: createDiagnostic({
      source: 'parser', code, severity: 'warning', message,
      location: { sourceId: context.sourceId, line: context.line },
    }),
  };
}

function frameId(context: AscParseContext): string {
  return `${context.sourceId}:${context.sequence}`;
}

function bytes(tokens: readonly string[], length: number): Uint8Array | undefined {
  if (tokens.length < length) return undefined;
  const data = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    if (!/^[0-9A-Fa-f]{1,2}$/.test(tokens[i])) return undefined;
    data[i] = Number.parseInt(tokens[i], 16);
  }
  return data;
}

function parseFd(timestampText: string, rest: string, context: AscParseContext): AscLineResult {
  const tokens = rest.trim().split(/\s+/);
  const channel = Number.parseInt(tokens[0] ?? '', 10);
  const direction = tokens[1];
  const id = parseId(tokens[2] ?? '', context.base);
  if (!Number.isInteger(channel) || (direction !== 'Rx' && direction !== 'Tx') || !id) {
    return diagnostic(context, 'ASC_FD_HEADER', 'Unsupported or malformed CAN FD row.');
  }
  let index = 3;
  if (tokens[index] && !/^\d+$/.test(tokens[index])) index++;
  const brs = tokens[index++];
  const esi = tokens[index++];
  const dlcText = tokens[index++];
  const lengthText = tokens[index++];
  if (!/^\d+$/.test(brs ?? '') || !/^\d+$/.test(esi ?? '')) {
    return diagnostic(context, 'ASC_FD_FLAGS', 'CAN FD BRS/ESI flags are malformed.');
  }
  const dlcCode = Number.parseInt(dlcText ?? '', context.base === 'hex' ? 16 : 10);
  const dataLength = Number.parseInt(lengthText ?? '', 10);
  if (!Number.isInteger(dlcCode) || dlcCode < 0 || dlcCode > 15 || !Number.isInteger(dataLength) || dataLength < 0 || dataLength > 64) {
    return diagnostic(context, 'ASC_FD_LENGTH', 'CAN FD DLC or payload length is invalid.');
  }
  const data = bytes(tokens.slice(index), dataLength);
  if (!data) return diagnostic(context, 'ASC_FD_PAYLOAD', 'CAN FD payload is shorter than its declared length or contains invalid bytes.');
  const frame: CanFrame = {
    id: frameId(context), sourceId: context.sourceId, timestamp: Number(timestampText),
    canId: id.canId, extended: id.extended, direction, channel,
    dlcCode, dataLength, data,
  };
  try { assertCanFrame(frame); } catch (error) { return diagnostic(context, 'ASC_FD_RANGE', (error as Error).message); }
  return { type: 'frame', frame };
}

export function parseAscLine(line: string, context: AscParseContext): AscLineResult {
  const trimmed = line.trim();
  if (!trimmed) return { type: 'ignored' };
  if (/^base\s+/i.test(trimmed)) return { type: 'base', base: /\bdec\b/i.test(trimmed) ? 'dec' : 'hex' };
  if (/^date\s/i.test(trimmed)) { const start = parseAscDate(trimmed); return start === undefined ? { type: 'ignored' } : { type: 'date', start }; }
  if (/^(\/\/|internal events|timestamps)/i.test(trimmed)) return { type: 'ignored' };
  const fd = FD_RE.exec(line);
  if (fd) return parseFd(fd[1], fd[2], context);
  const classic = CLASSIC_RE.exec(line);
  if (!classic) return diagnostic(context, 'ASC_UNSUPPORTED_ROW', 'Unsupported ASC row was not imported.');
  const [, timestampText, channelText, idText, direction, frameType, dlcText, payloadText] = classic;
  const id = parseId(idText, context.base);
  const channel = Number.parseInt(channelText, 10);
  const dlcCode = Number.parseInt(dlcText, 10);
  if (!id || !Number.isInteger(channel) || !Number.isInteger(dlcCode) || dlcCode < 0 || dlcCode > 8) {
    return diagnostic(context, 'ASC_CLASSIC_HEADER', 'Classic CAN header is malformed.');
  }
  const dataLength = frameType === 'r' ? 0 : dlcCode;
  const data = bytes(payloadText.trim() ? payloadText.trim().split(/\s+/) : [], dataLength);
  if (!data) return diagnostic(context, 'ASC_CLASSIC_PAYLOAD', 'Classic CAN payload is shorter than its DLC or contains invalid bytes.');
  const frame: CanFrame = {
    id: frameId(context), sourceId: context.sourceId, timestamp: Number(timestampText),
    canId: id.canId, extended: id.extended, direction: direction as 'Rx' | 'Tx', channel,
    dlcCode, dataLength, data,
  };
  try { assertCanFrame(frame); } catch (error) { return diagnostic(context, 'ASC_CLASSIC_RANGE', (error as Error).message); }
  return { type: 'frame', frame };
}

const HEX = new Int8Array(128).fill(-1);
for (let code = 0; code < 128; code++) { const char = String.fromCharCode(code); if (/[0-9A-Fa-f]/.test(char)) HEX[code] = Number.parseInt(char, 16); }

/** Word positions of the line being read (reused: reading is synchronous). */
const HEADER_WORDS = 12;
const wordStart = new Int32Array(HEADER_WORDS); const wordEnd = new Int32Array(HEADER_WORDS);

/**
 * The common frame rows, read straight from the file's bytes `[start, end)` (one line without its line break): plain
 * ASCII, words separated by spaces or tabs, every field well formed. No string is made per word. Anything else returns
 * undefined, and the line then goes through `parseAscLine`, which gives the same frame for every row this accepts.
 */
export function parseAscFrameBytes(bytes: Buffer, start: number, end: number, context: AscParseContext): CanFrame | undefined {
  if (context.base !== 'hex') return undefined;
  // Words of the header (at most HEADER_WORDS); the payload after them is read in place below.
  let words = 0; let wordAt = -1; let scanned = start;
  for (; scanned < end && words < HEADER_WORDS; scanned++) {
    const code = bytes[scanned];
    if (code === 32 || code === 9) { if (wordAt >= 0) { wordStart[words] = wordAt; wordEnd[words++] = scanned; wordAt = -1; } }
    else if (code < 33 || code > 126) return undefined;
    else if (wordAt < 0) wordAt = scanned;
  }
  if (wordAt >= 0 && scanned === end) { wordStart[words] = wordAt; wordEnd[words++] = end; wordAt = -1; }
  // Words beyond the header start where the scan stopped (inside a word when it stopped there).
  const restStart = wordAt >= 0 ? wordAt : scanned;
  if (words < 6) return undefined;
  const timestamp = timestampOf(bytes, wordStart[0], wordEnd[0]); if (timestamp === undefined) return undefined;
  const fd = wordEnd[1] - wordStart[1] === 5 && upper(bytes, wordStart[1]) === 67 && upper(bytes, wordStart[1] + 1) === 65 && upper(bytes, wordStart[1] + 2) === 78 && upper(bytes, wordStart[1] + 3) === 70 && upper(bytes, wordStart[1] + 4) === 68;
  let channel: number; let direction: 'Rx' | 'Tx'; let idWord: number; let dlcCode: number; let dataLength: number; let at: number;
  if (fd) {
    channel = smallNumber(bytes, 2, words); if (channel < 0) return undefined;
    const found = directionOf(bytes, 3); if (!found) return undefined; direction = found;
    idWord = 4; at = 5; if (at < words && !digits(bytes, at, words)) at++;
    const brs = at++; const esi = at++; const dlcWord = at++; const lengthWord = at++;
    if (!digits(bytes, brs, words) || !digits(bytes, esi, words) || dlcWord >= words || lengthWord >= words || wordEnd[dlcWord] - wordStart[dlcWord] > 2) return undefined;
    dlcCode = 0; for (let index = wordStart[dlcWord]; index < wordEnd[dlcWord]; index++) { const value = HEX[bytes[index]]; if (value < 0) return undefined; dlcCode = dlcCode * 16 + value; }
    dataLength = smallNumber(bytes, lengthWord, words);
    if (dlcCode > 15 || dataLength < 0 || dataLength > 64) return undefined;
  } else {
    channel = smallNumber(bytes, 1, words); if (channel < 0) return undefined;
    idWord = 2;
    const found = directionOf(bytes, 3); if (!found) return undefined; direction = found;
    const remote = is1(bytes, 4, 114); if (!remote && !is1(bytes, 4, 100)) return undefined;
    dlcCode = smallNumber(bytes, 5, words); if (dlcCode < 0 || dlcCode > 8) return undefined;
    dataLength = remote ? 0 : dlcCode; at = 6;
  }
  // Hex CAN ID, optionally ending in x (extended; for CAN FD rows also X); a 0x prefix is left to the full rules.
  let idEnd = wordEnd[idWord]; const last = bytes[idEnd - 1];
  const extendedMark = last === 120 || (last === 88 && fd); if (extendedMark) idEnd--;
  const idDigits = idEnd - wordStart[idWord];
  if (idDigits < 1 || idDigits > 8) return undefined;
  let canId = 0;
  for (let index = wordStart[idWord]; index < idEnd; index++) { const value = HEX[bytes[index]]; if (value < 0) return undefined; canId = canId * 16 + value; }
  if (canId > 0x1fffffff) return undefined;
  // Payload: `dataLength` words of one or two hex digits from word `at` on; whatever follows is not read, but must still be
  // plain words for the full rules to see the same words.
  const data = new Uint8Array(dataLength);
  let position = at < words ? wordStart[at] : restStart;
  for (let index = 0; index < dataLength; index++) {
    while (position < end && (bytes[position] === 32 || bytes[position] === 9)) position++;
    if (position >= end) return undefined;
    const high = HEX[bytes[position]]; if (high === undefined || high < 0) return undefined;
    const second = position + 1 < end ? bytes[position + 1] : 32;
    if (second === 32 || second === 9) { data[index] = high; position += 1; continue; }
    const low = HEX[second]; if (low === undefined || low < 0) return undefined;
    const third = position + 2 < end ? bytes[position + 2] : 32;
    if (third !== 32 && third !== 9) return undefined;
    data[index] = high * 16 + low; position += 2;
  }
  for (; position < end; position++) { const code = bytes[position]; if ((code < 32 && code !== 9) || code > 126) return undefined; }
  const frame: CanFrame = { id: frameId(context), sourceId: context.sourceId, timestamp, canId, extended: extendedMark || canId > 0x7ff, direction, channel, dlcCode, dataLength, data };
  try { assertCanFrame(frame); } catch { return undefined; }
  return frame;
}

function digits(bytes: Buffer, word: number, words: number): boolean {
  if (word >= words) return false;
  for (let index = wordStart[word]; index < wordEnd[word]; index++) { const code = bytes[index]; if (code < 48 || code > 57) return false; }
  return true;
}
/** A word of 1 to 9 digits as a number, or -1. */
function smallNumber(bytes: Buffer, word: number, words: number): number {
  if (!digits(bytes, word, words) || wordEnd[word] - wordStart[word] > 9) return -1;
  let value = 0; for (let index = wordStart[word]; index < wordEnd[word]; index++) value = value * 10 + bytes[index] - 48;
  return value;
}
function is1(bytes: Buffer, word: number, code: number): boolean { return wordEnd[word] - wordStart[word] === 1 && bytes[wordStart[word]] === code; }
function directionOf(bytes: Buffer, word: number): 'Rx' | 'Tx' | undefined {
  if (wordEnd[word] - wordStart[word] !== 2 || bytes[wordStart[word] + 1] !== 120) return undefined;
  const first = bytes[wordStart[word]]; return first === 82 ? 'Rx' : first === 84 ? 'Tx' : undefined;
}
function upper(bytes: Buffer, index: number): number { return bytes[index] >= 97 && bytes[index] <= 122 ? bytes[index] - 32 : bytes[index]; }

/**
 * `Number()` of a timestamp word `[+-]digits[.digits]`, or undefined when it is not one. With up to 15 digits it is the
 * digits divided by a power of ten: both are exact doubles, so the quotient is the same correctly rounded value.
 */
function timestampOf(bytes: Buffer, start: number, end: number): number | undefined {
  let index = start; const sign = bytes[index];
  if (sign === 43 || sign === 45) index++;
  let integer = 0; let mantissa = 0; let count = 0;
  while (index < end && bytes[index] >= 48 && bytes[index] <= 57) { mantissa = mantissa * 10 + bytes[index] - 48; index++; integer++; }
  if (!integer) return undefined;
  let fraction = 0;
  if (index < end) {
    if (bytes[index] !== 46) return undefined; index++;
    while (index < end && bytes[index] >= 48 && bytes[index] <= 57) { mantissa = mantissa * 10 + bytes[index] - 48; index++; fraction++; }
    if (!fraction || index < end) return undefined;
  }
  count = integer + fraction;
  if (count > 15) return Number(bytes.toString('latin1', start, end));
  const value = fraction ? mantissa / POWERS_OF_TEN[fraction] : mantissa;
  return sign === 45 ? -value : value;
}
const POWERS_OF_TEN = Array.from({ length: 16 }, (_, power) => 10 ** power);
