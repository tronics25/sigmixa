import { closeSync, fstatSync, openSync, readSync } from 'fs';
import type { Diagnostic } from '../../core/diagnostics/diagnostic';
import type { TimeReference } from '../../core/time/timeFormat';
import { ReadBudget } from '../readBudget';
import { algebraic, labelIndex, labelTexts, readNumber, type MdfParseOptions, type MdfParseSummary, type MdfSignalSeries, type ValueLabels } from './parseMdf';

/**
 * ASAM MDF 3.x (versions 2.x and 3.x, `.mdf`): measured signals, given as series as MF4's are. MDF 3 has no standard
 * for bus logging, so it holds no CAN frames here. Little- and big-endian files, sorted and unsorted data groups.
 */

interface Block { readonly address: number; readonly data: Buffer }

/** The fixed part of each block that is read (MDF 2.x/3.x, the oldest versions' sizes); later versions' fields are read only when the block holds them. */
const FIXED_SIZE: Readonly<Record<string, number>> = { HD: 164, DG: 24, CG: 26, CN: 218, CC: 46, TX: 4 };

class Mdf3Reader {
  readonly fd: number; readonly size: number; readonly bigEndian: boolean; readonly version: number;
  constructor(filePath: string, readonly budget = new ReadBudget()) {
    this.fd = openSync(filePath, 'r');
    try {
      this.size = fstatSync(this.fd).size;
      const id = this.read(0, 64);
      if (id.toString('ascii', 0, 8) !== 'MDF     ') throw new Error('Missing MDF identification block.');
      // The byte order (0: little endian) is that of channel values without their own; blocks are little endian (as asammdf reads them).
      this.bigEndian = id.readUInt16LE(24) !== 0;
      this.version = id.readUInt16LE(28);
      if (this.version < 200 || this.version >= 400) throw new Error(`MDF version ${this.version} is not MDF 2 or 3.`);
    } catch (error) { closeSync(this.fd); throw error; }
  }
  close(): void { closeSync(this.fd); }
  read(address: number, size: number): Buffer {
    if (address < 0 || size < 0 || address + size > this.size || !this.budget.fitsPiece(size)) throw new Error(`MDF read outside the file at ${address} (${size} bytes).`);
    const buffer = Buffer.allocUnsafe(size); let done = 0;
    while (done < size) { const count = readSync(this.fd, buffer, done, size - done, address + done); if (!count) throw new Error(`Truncated MDF data at ${address + done}.`); done += count; }
    return buffer;
  }
  u16(buffer: Buffer, at: number): number { return buffer.readUInt16LE(at); }
  i16(buffer: Buffer, at: number): number { return buffer.readInt16LE(at); }
  u32(buffer: Buffer, at: number): number { return buffer.readUInt32LE(at); }
  f64(buffer: Buffer, at: number): number { return buffer.readDoubleLE(at); }
  /** A block: its two-letter ID and size, then its body (the whole block is returned). A block shorter than its fixed part is damaged. */
  block(address: number, expected: string): Block {
    const head = this.read(address, 4); const id = head.toString('ascii', 0, 2); const size = this.u16(head, 2);
    if (id !== expected || size < 4) throw new Error(`Expected MDF ${expected} block at ${address}, found ${id}.`);
    const data = this.read(address, Math.min(size, this.size - address));
    if (data.length < (FIXED_SIZE[expected] ?? 4)) throw new Error(`The MDF ${expected} block at ${address} is too short (${data.length} bytes).`);
    return { address, data };
  }
  text(address: number): string {
    if (!address) return '';
    const block = this.block(address, 'TX');
    return block.data.toString('latin1', 4).replace(/\0.*$/s, '').trim();
  }
}

/** A value's place and type in a record, as `readNumber` takes it (MF4 data type codes). */
interface Field { readonly dataType: number; readonly byteOffset: number; readonly bitOffset: number; readonly bitCount: number }

interface Channel { readonly name: string; readonly unit?: string; readonly field: Field; /** A channel of 0 bits is virtual: record n's raw value is n × this sampling rate (as asammdf reads it). */ readonly rate?: number; readonly convert: (raw: number) => number; readonly labels?: ValueLabels; readonly times: number[]; readonly values: number[]; /** Each sample's text (labelIndex of its raw value). */ readonly labelIndexes: number[] }

export async function parseMdf3File(filePath: string, options: MdfParseOptions): Promise<MdfParseSummary> {
  const reader = new Mdf3Reader(filePath, new ReadBudget(options.signal));
  let diagnostics = 0;
  const report = (code: string, severity: Diagnostic['severity'], message: string, offset?: number, details?: Diagnostic['details']) => {
    diagnostics++;
    options.onDiagnostics([{ id: `${options.sourceId}:mdf:${code}:${offset ?? diagnostics}`, source: 'parser', code, severity, message, location: { sourceId: options.sourceId }, details: { ...(offset === undefined ? {} : { byteOffset: offset }), ...details } }]);
  };
  try {
    const header = reader.block(64, 'HD').data;
    const timeReference = readStart(reader, header);
    if (timeReference) options.onTimeReference?.(timeReference);
    const series: MdfSignalSeries[] = []; let bytesRead = 0; let groupNumber = 0;
    const visited = new Set<number>();
    for (let address = reader.u32(header, 4), count = 0; address && !reader.budget.cancelled; count++) {
      if (count > 100_000) throw new Error('Too many MDF data groups.');
      // Lists that run back on themselves would be read again and again.
      if (visited.has(address)) throw new Error('Cyclic MDF data group list.');
      visited.add(address);
      const dg = reader.block(address, 'DG').data;
      const ids = reader.u16(dg, 22);
      if (ids > 2) throw new Error(`MDF record ID count ${ids} is not valid.`);
      const groups: { readonly recordId: number; readonly size: number; readonly records: number; readonly name: string; readonly time?: Channel; readonly channels: Channel[] }[] = [];
      for (let cgAddress = reader.u32(dg, 8), index = 0; cgAddress; index++) {
        if (index > 65_536) throw new Error('Too many MDF channel groups.');
        if (visited.has(cgAddress)) throw new Error('Cyclic MDF channel group list.');
        visited.add(cgAddress);
        const cg = reader.block(cgAddress, 'CG').data;
        // A group without a comment is named by its place in the file.
        groupNumber++;
        const name = reader.text(reader.u32(cg, 12)) || `Group ${groupNumber}`;
        const { time, channels, unsupported } = readChannels(reader, reader.u32(cg, 8));
        if (unsupported.length) report('MDF_CHANNEL_UNSUPPORTED', 'info', `${unsupported.length} channel(s) of ${name} hold text, byte arrays or other values that are not numbers, and were not imported: ${unsupported.slice(0, 5).join(', ')}${unsupported.length > 5 ? ', …' : ''}`, cgAddress, { channelGroup: name, channels: unsupported.length });
        if (!time && channels.length) report('MDF_NO_TIME', 'warning', `Channel group ${name} has no time channel; its signals were not imported.`, cgAddress);
        groups.push({ recordId: reader.u16(cg, 16), size: reader.u16(cg, 20), records: reader.u32(cg, 22), name, ...(time ? { time } : {}), channels: time ? channels : [] });
        cgAddress = reader.u32(cg, 4);
      }
      if (!ids && groups.length > 1) throw new Error('A sorted MDF data group has more than one channel group.');
      // Records follow one another from the data link: without record IDs, each group's count of them; with them, until all counts are met.
      const byId = new Map(groups.map((group) => [group.recordId, group]));
      const left = new Map(groups.map((group) => [group, group.records]));
      let remaining = groups.reduce((total, group) => total + group.records, 0);
      let at = reader.u32(dg, 16); let carry = Buffer.alloc(0);
      while (remaining > 0 && at < reader.size && !reader.budget.cancelled) {
        const chunk = reader.read(at, Math.min(1 << 20, reader.size - at)); at += chunk.length; bytesRead += chunk.length;
        const buffer = carry.length ? Buffer.concat([carry, chunk]) : chunk;
        let offset = 0;
        while (remaining > 0) {
          // A record ID is read only once the record's first byte is here.
          if (ids && offset >= buffer.length) break;
          const id = ids ? buffer[offset] : groups[0]?.recordId;
          const group = id === undefined ? undefined : byId.get(id);
          if (!group) { report('MDF_RECORD_ID', 'error', `Unknown MDF record ID ${id}; the rest of this data group was not read.`, undefined, { recordId: id ?? -1 }); remaining = 0; break; }
          // The record ID before the record, and with two of them, its copy after it.
          const length = (ids ? 1 : 0) + group.size + (ids === 2 ? 1 : 0);
          if (!length) throw new Error(`MDF channel group ${group.name} has records of 0 bytes.`);
          if (offset + length > buffer.length) break;
          const record = buffer.subarray(offset + (ids ? 1 : 0), offset + (ids ? 1 : 0) + group.size);
          const number = group.records - left.get(group)!;
          offset += length; remaining--; left.set(group, left.get(group)! - 1);
          if (group.time) {
            const raw = (channel: Channel) => channel.rate !== undefined ? number * channel.rate : readNumber(record, channel.field);
            const time = group.time.convert(raw(group.time));
            if (Number.isFinite(time)) for (const channel of group.channels) { const value = raw(channel); channel.times.push(time); channel.values.push(channel.convert(value)); if (channel.labels) channel.labelIndexes.push(labelIndex(channel.labels, value)); }
          }
        }
        carry = Buffer.from(buffer.subarray(offset));
        options.onProgress?.({ framesParsed: 0, bytesRead: Math.min(bytesRead, reader.size), totalBytes: reader.size });
        await reader.budget.pause();
      }
      if (remaining > 0 && !reader.budget.cancelled) report('MDF_RECORD_TRUNCATED', 'warning', `The data of an MDF data group ends ${remaining} record(s) early.`, address, { records: remaining });
      for (const group of groups) for (const channel of group.channels) if (channel.times.length) series.push({
        group: group.name, channel: channel.name, ...(channel.unit ? { unit: channel.unit } : {}),
        times: Float64Array.from(channel.times), values: Float64Array.from(channel.values), ...(channel.labels ? { labels: { texts: labelTexts(channel.labels), indexes: Int32Array.from(channel.labelIndexes) } } : {}),
      });
      address = reader.u32(dg, 4);
    }
    const cancelled = reader.budget.cancelled;
    if (!cancelled) {
      if (series.length) options.onSignals?.(series);
      else report('MDF_NOTHING_TO_IMPORT', 'error', 'The MDF file has no measured values SigMixa can read.', 0);
    }
    return { totalBytes: reader.size, bytesRead: cancelled ? Math.min(bytesRead, reader.size) : reader.size, linesRead: 0, framesParsed: 0, diagnostics, cancelled, ...(timeReference ? { timeReference } : {}) };
  } finally { reader.close(); }
}

/** HD start: the nanosecond time stamp and UTC offset (MDF 3.2+), or the date and time text, both the local clock. */
function readStart(reader: Mdf3Reader, header: Buffer): TimeReference | undefined {
  if (reader.version >= 320 && header.length >= 176) {
    const nanoseconds = header.readBigUInt64LE(164);
    // The time stamp is UTC (as asammdf reads it); the offset gives the recording's local clock.
    if (nanoseconds) { const minutes = reader.i16(header, 172) * 60; const start = Number(nanoseconds) / 1e9 + minutes * 60; return { start, offset: start, utcOffsetMinutes: minutes }; }
  }
  const date = /^(\d{2}):(\d{2}):(\d{4})$/.exec(header.toString('latin1', 18, 28)); const time = /^(\d{2}):(\d{2}):(\d{2})$/.exec(header.toString('latin1', 28, 36));
  if (!date || !time) return undefined;
  const milliseconds = Date.UTC(+date[3], +date[2] - 1, +date[1], +time[1], +time[2], +time[3]);
  return Number.isFinite(milliseconds) ? { start: milliseconds / 1000, offset: milliseconds / 1000 } : undefined;
}

/** MDF 3 data types as MF4 codes (0/1 unsigned LE/BE, 2/3 signed, 4/5 float); undefined for text and bytes. */
function fieldType(type: number, bigEndian: boolean, bits: number): number | undefined {
  const order = (little: number, big: number) => bigEndian ? big : little;
  switch (type) {
    case 0: return order(0, 1); case 1: return order(2, 3); case 2: case 3: return bits === 32 || bits === 64 ? order(4, 5) : undefined;
    case 9: return 1; case 10: return 3; case 11: case 12: return bits === 32 || bits === 64 ? 5 : undefined;
    case 13: return 0; case 14: return 2; case 15: case 16: return bits === 32 || bits === 64 ? 4 : undefined;
    default: return undefined;
  }
}

function readChannels(reader: Mdf3Reader, first: number): { time?: Channel; channels: Channel[]; unsupported: string[] } {
  const seen = new Set<number>();
  let time: Channel | undefined; const channels: Channel[] = []; const unsupported: string[] = [];
  for (let address = first, count = 0; address; count++) {
    if (count > 65_536) throw new Error('MDF channel list is too long.');
    if (seen.has(address)) throw new Error('Cyclic MDF channel list.');
    seen.add(address);
    const cn = reader.block(address, 'CN').data;
    address = reader.u32(cn, 4);
    const short = cn.toString('latin1', 26, 58).replace(/\0.*$/s, '').trim();
    const long = cn.length >= 222 ? reader.text(reader.u32(cn, 218)) : '';
    const name = long || short;
    const bits = reader.u16(cn, 188); const type = reader.u16(cn, 190);
    const position = reader.u16(cn, 186) + (cn.length >= 228 ? reader.u16(cn, 226) * 8 : 0);
    const dataType = fieldType(type, reader.bigEndian, bits);
    const conversion = readConversion(reader, reader.u32(cn, 8));
    // As asammdf: a sampling rate of 0 counts records one by one.
    const rate = !bits ? reader.f64(cn, 210) || 1 : undefined;
    if ((dataType === undefined && rate === undefined) || bits > 64 || !conversion) { unsupported.push(name); continue; }
    const channel: Channel = { name, ...(conversion.unit ? { unit: conversion.unit } : {}), ...(rate !== undefined ? { rate } : {}), field: { dataType: dataType ?? 0, byteOffset: position >> 3, bitOffset: position & 7, bitCount: bits }, convert: conversion.convert, ...(conversion.labels ? { labels: conversion.labels } : {}), times: [], values: [], labelIndexes: [] };
    if (reader.u16(cn, 24) === 1) time = channel; else channels.push(channel);
  }
  return { ...(time ? { time } : {}), channels, unsupported };
}

/** A CC block's conversion, unit and value texts; undefined for a conversion SigMixa cannot evaluate. */
function readConversion(reader: Mdf3Reader, address: number): { convert: (raw: number) => number; unit: string; labels?: ValueLabels } | undefined {
  const identity = (raw: number) => raw;
  if (!address) return { convert: identity, unit: '' };
  const cc = reader.block(address, 'CC').data;
  const unit = cc.toString('latin1', 22, 42).replace(/\0.*$/s, '').trim();
  const type = reader.u16(cc, 42); const count = reader.u16(cc, 44);
  const p = (i: number) => reader.f64(cc, 46 + 8 * i);
  const enough = (bytes: number) => 46 + bytes <= cc.length;
  switch (type) {
    case 0: return enough(16) ? { convert: (raw) => raw * p(1) + p(0), unit } : undefined;
    case 1: case 2: {
      if (!enough(16 * count) || !count) return undefined;
      const keys = Array.from({ length: count }, (_, i) => p(2 * i)); const values = Array.from({ length: count }, (_, i) => p(2 * i + 1));
      return { convert: (raw) => {
        if (raw <= keys[0]) return values[0];
        if (raw >= keys[count - 1]) return values[count - 1];
        let i = 1; while (keys[i] < raw) i++;
        if (type === 2) return raw - keys[i - 1] <= keys[i] - raw ? values[i - 1] : values[i];
        return values[i - 1] + (values[i] - values[i - 1]) * (raw - keys[i - 1]) / (keys[i] - keys[i - 1]);
      }, unit };
    }
    case 6: return enough(48) ? { convert: (raw) => (p(1) - p(3) * (raw - p(4) - p(5))) / (p(2) * (raw - p(4) - p(5)) - p(0)), unit } : undefined;
    case 9: return enough(48) ? { convert: (raw) => (p(0) * raw * raw + p(1) * raw + p(2)) / (p(3) * raw * raw + p(4) * raw + p(5)), unit } : undefined;
    case 10: { const formula = algebraic(cc.toString('latin1', 46, 46 + 256).replace(/\0.*$/s, '').trim().replace(/\bX1\b/gi, 'X')); return formula ? { convert: formula, unit } : undefined; }
    case 11: {
      if (!enough(40 * count)) return undefined;
      const ranges = Array.from({ length: count }, (_, i) => { const key = p(5 * i); return [key, key, cc.toString('latin1', 46 + 40 * i + 8, 46 + 40 * i + 40).replace(/\0.*$/s, '').trim()] as const; });
      return { convert: identity, unit, labels: { ranges, floating: false, exact: true } };
    }
    case 12: {
      if (!enough(20 * count) || !count) return undefined;
      // The first entry holds the default text; the others are [low, high] ranges.
      const entry = (i: number) => [reader.f64(cc, 46 + 20 * i), reader.f64(cc, 46 + 20 * i + 8), reader.text(reader.u32(cc, 46 + 20 * i + 16))] as const;
      const fallback = entry(0)[2];
      return { convert: identity, unit, labels: { ranges: Array.from({ length: count - 1 }, (_, i) => entry(i + 1)), floating: false, ...(fallback ? { fallback } : {}) } };
    }
    case 65535: return { convert: identity, unit };
    default: return undefined;
  }
}
