import type { CanFrame } from '../../core/frame/canFrame';
import { assertCanFrame } from '../../core/frame/canFrame';
import type { Diagnostic } from '../../core/diagnostics/diagnostic';
import { createDiagnostic } from '../../core/diagnostics/diagnostic';
import { parseCanId } from '../../core/frame/canId';

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
  if (/^(date\s|\/\/|internal events|timestamps)/i.test(trimmed)) return { type: 'ignored' };
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
