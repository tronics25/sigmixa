import { promises as fs } from 'fs';
import * as zlib from 'zlib';
import type { Diagnostic } from '../../core/diagnostics/diagnostic';
import type { CanFrame } from '../../core/frame/canFrame';

const LOG_CONTAINER = 10;
const CAN_MESSAGE = 1;
const CAN_MESSAGE_2 = 86;
const CAN_FD_MESSAGE = 100;
const CAN_FD_MESSAGE_64 = 101;
const TEN_MICROSECONDS = 0x1;
const NANOSECONDS = 0x2;
const EXTENDED_ID = 0x80000000;
const TX_FLAG = 0x1;

interface BaseObjectHeader {
  readonly offset: number;
  readonly headerSize: number;
  readonly objectSize: number;
  readonly objectType: number;
}

interface ObjectHeader extends BaseObjectHeader {
  readonly flags: number;
  readonly timestamp: bigint;
}

export interface BlfParseProgress {
  readonly framesParsed: number;
  readonly bytesRead: number;
  readonly totalBytes: number;
}

export interface BlfParseSummary {
  readonly bytesRead: number;
  readonly totalBytes: number;
  readonly linesRead: 0;
  readonly framesParsed: number;
  readonly diagnostics: number;
  readonly cancelled: boolean;
  readonly experimental: true;
}

export interface BlfParseOptions {
  readonly sourceId: string;
  readonly signal?: AbortSignal;
  onFrames(frame: readonly CanFrame[]): void;
  onDiagnostics(diagnostics: readonly Diagnostic[]): void;
  onProgress?(progress: BlfParseProgress): void;
}

/**
 * Experimental Vector BLF reader based on the public object layouts used by
 * interoperable OSS readers. Compatibility tests include python-can fixtures;
 * validation against a broader set of production files remains ongoing.
 */
export function parseBlfBuffer(buffer: Buffer, options: BlfParseOptions): BlfParseSummary {
  let framesParsed = 0;
  let diagnosticCount = 0;
  let sequence = 0;
  let bytesRead = 0;
  let containerTail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  const startTimestamp = fileStartTimestamp(buffer);
  const pendingFrames: CanFrame[] = [];
  const flushFrames = () => { if (pendingFrames.length) options.onFrames(pendingFrames.splice(0)); };
  const report = (code: string, severity: Diagnostic['severity'], message: string, offset?: number, details?: Diagnostic['details']) => {
    diagnosticCount++;
    options.onDiagnostics([{
      id: `${options.sourceId}:blf:${code}:${offset ?? diagnosticCount}`,
      source: 'parser', code, severity, message, location: { sourceId: options.sourceId },
      details: { ...(offset === undefined ? {} : { byteOffset: offset }), ...details },
    }]);
  };

  report('BLF_EXPERIMENTAL', 'info', 'BLF support is validated with python-can compatibility fixtures; verification against a broader set of CANoe/CANalyzer files is still ongoing.');

  if (buffer.length < 8 || buffer.toString('ascii', 0, 4) !== 'LOGG') {
    report('BLF_SIGNATURE', 'error', 'The file does not contain a Vector BLF LOGG signature.', 0);
    return summary(buffer.length, bytesRead, framesParsed, diagnosticCount, false);
  }
  const fileHeaderSize = buffer.readUInt32LE(4);
  if (fileHeaderSize < 8 || fileHeaderSize > buffer.length) {
    report('BLF_FILE_HEADER', 'error', 'The BLF file header size is invalid.', 4, { fileHeaderSize });
    return summary(buffer.length, bytesRead, framesParsed, diagnosticCount, false);
  }

  let offset = findObjectOffset(buffer, fileHeaderSize) ?? fileHeaderSize;
  while (offset + 16 <= buffer.length && !options.signal?.aborted) {
    const header = readBaseObjectHeader(buffer, offset);
    if (!header) {
      report('BLF_OBJECT_HEADER', 'error', 'A BLF object header is invalid; parsing stopped to avoid misreading later bytes.', offset);
      break;
    }
    if (offset + header.objectSize > buffer.length) {
      report('BLF_OBJECT_TRUNCATED', 'error', 'A BLF object extends beyond the end of the file; parsing stopped.', offset, { objectType: header.objectType });
      break;
    }
    if (header.objectType === LOG_CONTAINER) {
      const containerOffset = offset + header.headerSize;
      if (containerOffset + 16 > offset + header.objectSize) {
        report('BLF_CONTAINER_HEADER', 'error', 'A LogContainer header is truncated.', offset);
      } else {
        const method = buffer.readUInt16LE(containerOffset);
        const expectedSize = buffer.readUInt32LE(containerOffset + 8);
        const compressed = buffer.subarray(containerOffset + 16, offset + header.objectSize);
        try {
          let contents: Buffer;
          if (method === 0) contents = compressed;
          else if (method === 2) contents = zlib.inflateSync(compressed);
          else {
            report('BLF_COMPRESSION_UNSUPPORTED', 'warning', `LogContainer compression method ${method} is not supported.`, offset, { compressionMethod: method });
            contents = Buffer.alloc(0);
          }
          if (expectedSize && contents.length !== expectedSize) {
            report('BLF_CONTAINER_SIZE', 'warning', 'The expanded LogContainer size differs from the declared size.', offset, { expectedSize, actualSize: contents.length });
          }
          const combined = containerTail.length ? Buffer.concat([containerTail, contents]) : contents;
          containerTail = parseObjects(combined, startTimestamp, options, report, (frame) => {
            const normalized = { ...frame, id: `${options.sourceId}:blf:${sequence++}`, sourceId: options.sourceId };
            pendingFrames.push(normalized);
            if (pendingFrames.length >= 1000) flushFrames();
            framesParsed++;
          });
        } catch (error) {
          report('BLF_CONTAINER_DECOMPRESSION', 'error', `LogContainer decompression failed: ${(error as Error).message}`, offset);
        }
      }
    }
    bytesRead = Math.min(buffer.length, offset + header.objectSize);
    options.onProgress?.({ framesParsed, bytesRead, totalBytes: buffer.length });
    const objectEnd = offset + header.objectSize;
    const nextOffset = findObjectOffset(buffer, objectEnd);
    if (nextOffset === undefined) { offset = objectEnd; break; }
    offset = nextOffset;
  }
  if (!options.signal?.aborted && containerTail.some((byte) => byte !== 0)) {
    report('BLF_INNER_OBJECT_TRUNCATED', 'error', 'The final LogContainer ends with an incomplete BLF object.', undefined, { remainingBytes: containerTail.length });
  }
  if (!options.signal?.aborted && offset < buffer.length && buffer.subarray(offset).some((byte) => byte !== 0)) {
    report('BLF_TRAILING_BYTES', 'warning', 'Non-padding bytes remain after the last complete BLF object.', offset);
  }
  flushFrames();
  return summary(buffer.length, bytesRead, framesParsed, diagnosticCount, options.signal?.aborted === true);
}

export async function parseBlfFile(filePath: string, options: BlfParseOptions): Promise<BlfParseSummary> {
  if (options.signal?.aborted) return summary(0, 0, 0, 0, true);
  const buffer = await fs.readFile(filePath);
  return parseBlfBuffer(buffer, options);
}

function parseObjects(
  buffer: Buffer,
  startTimestamp: number,
  options: BlfParseOptions,
  report: (code: string, severity: Diagnostic['severity'], message: string, offset?: number, details?: Diagnostic['details']) => void,
  append: (frame: Omit<CanFrame, 'id' | 'sourceId'>) => void
): Buffer {
  let offset = 0;
  while (!options.signal?.aborted) {
    if (offset + 16 > buffer.length) return buffer.subarray(offset);
    const objectOffset = findObjectOffset(buffer, offset);
    if (objectOffset === undefined) {
      if (buffer.length - offset > 7) report('BLF_INNER_OBJECT_HEADER', 'error', 'An object inside a LogContainer is invalid; this container was stopped.', offset);
      return buffer.subarray(offset);
    }
    offset = objectOffset;
    const base = readBaseObjectHeader(buffer, offset);
    if (!base) {
      report('BLF_INNER_OBJECT_HEADER', 'error', 'An object inside a LogContainer is invalid; this container was stopped.', offset);
      return Buffer.alloc(0);
    }
    if (offset + base.objectSize > buffer.length) {
      return buffer.subarray(offset);
    }
    const header = readObjectHeader(buffer, offset);
    if (!header) {
      report('BLF_INNER_OBJECT_HEADER', 'error', 'An object inside a LogContainer has an unsupported timed header and was skipped.', offset, { objectType: base.objectType });
      offset += base.objectSize;
      continue;
    }
    const frame = header.objectType === CAN_MESSAGE || header.objectType === CAN_MESSAGE_2
      ? classicFrame(buffer, header, startTimestamp)
      : header.objectType === CAN_FD_MESSAGE
        ? fdFrame(buffer, header, startTimestamp)
        : header.objectType === CAN_FD_MESSAGE_64
          ? fd64Frame(buffer, header, startTimestamp)
          : undefined;
    if (frame === null) report('BLF_MESSAGE_TRUNCATED', 'warning', `BLF CAN object ${header.objectType} is shorter than its public layout and was skipped.`, offset, { objectType: header.objectType });
    else if (frame) append(frame);
    offset += header.objectSize;
  }
  return buffer.subarray(offset);
}

function classicFrame(buffer: Buffer, header: ObjectHeader, startTimestamp: number): Omit<CanFrame, 'id' | 'sourceId'> | null {
  const p = header.offset + header.headerSize;
  if (p + 16 > header.offset + header.objectSize) return null;
  const dlcCode = buffer.readUInt8(p + 3);
  const id = decodeCanId(buffer.readUInt32LE(p + 4));
  const dataLength = Math.min(dlcCode, 8);
  return frame(header, startTimestamp, id, buffer.readUInt16LE(p), buffer.readUInt8(p + 2) & TX_FLAG ? 'Tx' : 'Rx', dlcCode, buffer.subarray(p + 8, p + 8 + dataLength));
}

function fdFrame(buffer: Buffer, header: ObjectHeader, startTimestamp: number): Omit<CanFrame, 'id' | 'sourceId'> | null {
  const p = header.offset + header.headerSize;
  if (p + 84 > header.offset + header.objectSize) return null;
  const dlcCode = buffer.readUInt8(p + 3);
  const validDataBytes = Math.min(buffer.readUInt8(p + 14), 64);
  return frame(header, startTimestamp, decodeCanId(buffer.readUInt32LE(p + 4)), buffer.readUInt16LE(p), buffer.readUInt8(p + 2) & TX_FLAG ? 'Tx' : 'Rx', dlcCode, buffer.subarray(p + 20, p + 20 + validDataBytes));
}

// Public CAN_FD_MESSAGE_64 layout: <BBBBLLLLLLLHBBL>, followed by payload.
function fd64Frame(buffer: Buffer, header: ObjectHeader, startTimestamp: number): Omit<CanFrame, 'id' | 'sourceId'> | null {
  const p = header.offset + header.headerSize;
  if (p + 40 > header.offset + header.objectSize) return null;
  const dlcCode = buffer.readUInt8(p + 1);
  const validDataBytes = Math.min(buffer.readUInt8(p + 2), 64);
  const extDataOffset = buffer.readUInt8(p + 35);
  const dataBoundary = header.offset + (extDataOffset || header.objectSize);
  const availableBytes = Math.max(0, Math.min(header.offset + header.objectSize, dataBoundary) - (p + 40));
  const dataLength = Math.min(validDataBytes, availableBytes);
  const data = Buffer.alloc(validDataBytes);
  buffer.copy(data, 0, p + 40, p + 40 + dataLength);
  return frame(header, startTimestamp, decodeCanId(buffer.readUInt32LE(p + 4)), buffer.readUInt8(p), buffer.readUInt8(p + 34) & TX_FLAG ? 'Tx' : 'Rx', dlcCode, data);
}

function frame(header: ObjectHeader, startTimestamp: number, id: { canId: number; extended: boolean }, channel: number, direction: 'Rx' | 'Tx', dlcCode: number, bytes: Uint8Array): Omit<CanFrame, 'id' | 'sourceId'> {
  const data = Uint8Array.from(bytes);
  return { timestamp: startTimestamp + timestampSeconds(header.timestamp, header.flags), ...id, direction, channel, dlcCode: Math.min(dlcCode, 15), dataLength: data.length, data };
}

function readBaseObjectHeader(buffer: Buffer, offset: number): BaseObjectHeader | undefined {
  if (offset + 16 > buffer.length || buffer.toString('ascii', offset, offset + 4) !== 'LOBJ') return undefined;
  const headerSize = buffer.readUInt16LE(offset + 4);
  const objectSize = buffer.readUInt32LE(offset + 8);
  const objectType = buffer.readUInt32LE(offset + 12);
  if (headerSize < 16 || objectSize < headerSize) return undefined;
  return { offset, headerSize, objectSize, objectType };
}

function readObjectHeader(buffer: Buffer, offset: number): ObjectHeader | undefined {
  const base = readBaseObjectHeader(buffer, offset);
  if (!base) return undefined;
  const version = buffer.readUInt16LE(offset + 6);
  const minimum = version === 1 ? 32 : version === 2 ? 40 : Number.MAX_SAFE_INTEGER;
  if (base.headerSize < minimum) return undefined;
  const flags = buffer.readUInt32LE(offset + 16);
  const timestamp = buffer.readBigUInt64LE(offset + 24);
  return { ...base, flags, timestamp };
}

function timestampSeconds(value: bigint, flags: number): number {
  if (flags & TEN_MICROSECONDS) return Number(value) * 1e-5;
  if (flags & NANOSECONDS) return Number(value) * 1e-9;
  return Number(value) * 1e-9;
}

function decodeCanId(raw: number): { canId: number; extended: boolean } {
  return { canId: raw & 0x1fffffff, extended: (raw & EXTENDED_ID) !== 0 };
}

function findObjectOffset(buffer: Buffer, offset: number): number | undefined {
  const found = buffer.indexOf('LOBJ', offset, 'ascii');
  return found >= offset && found < Math.min(buffer.length, offset + 8) ? found : undefined;
}

function fileStartTimestamp(buffer: Buffer): number {
  if (buffer.length < 72 || buffer.readUInt32LE(4) < 72) return 0;
  const year = buffer.readUInt16LE(40); const month = buffer.readUInt16LE(42); const day = buffer.readUInt16LE(46);
  const hour = buffer.readUInt16LE(48); const minute = buffer.readUInt16LE(50); const second = buffer.readUInt16LE(52); const milliseconds = buffer.readUInt16LE(54);
  if (!year || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59 || milliseconds > 999) return 0;
  const value = Date.UTC(year, month - 1, day, hour, minute, second, milliseconds) / 1000;
  return Number.isFinite(value) ? value : 0;
}

function summary(totalBytes: number, bytesRead: number, framesParsed: number, diagnostics: number, cancelled: boolean): BlfParseSummary {
  return { totalBytes, bytesRead, linesRead: 0, framesParsed, diagnostics, cancelled, experimental: true };
}
