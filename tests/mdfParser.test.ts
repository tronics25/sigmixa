import test from 'node:test';
import assert from 'node:assert/strict';
import * as zlib from 'zlib';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import type { CanFrame } from '../src/core/frame/canFrame';
import type { Diagnostic } from '../src/core/diagnostics/diagnostic';
import type { TimeReference } from '../src/core/time/timeFormat';
import { algebraic, parseMdfFile, readNumber, seriesLabel, type MdfSignalSeries } from '../src/parsers/mdf/parseMdf';
import { mdfSignalDefinitions } from '../src/extension/editors/rawLogDocument';
import { signalCatalogGroups } from '../src/extension/editors/signalCatalogGroups';
import { parseAscFile } from '../src/parsers/asc/parseAscStream';
import * as vscode from 'vscode';
import { RawLogDocument } from '../src/extension/editors/rawLogDocument';
import { PluginRegistry } from '../src/core/plugin/pluginHost';
import { emptyProject } from '../src/core/project/schema';
import { assertMatchesAsammdf, type AsammdfEntry } from './support/asammdfReference';

// ---- a small MDF 4.11 writer: blocks refer to each other by Ref and are laid out in the order they are added ----

interface Ref { readonly index: number }
type Link = Ref | 0;
class Mdf {
  private readonly blocks: { type: string; links: Link[]; body: Buffer }[] = [];
  add(type: string, links: Link[], body: Buffer): Ref { this.blocks.push({ type, links, body }); return { index: this.blocks.length - 1 }; }
  /** Fills a link after the blocks it names exist (lists that point forward). */
  link(ref: Ref, at: number, target: Link): void { this.blocks[ref.index].links[at] = target; }
  text(value: string): Ref { return this.add('##TX', [], Buffer.from(`${value}\0`, 'utf8')); }
  /** A block's body, to change a field after it is made. */
  blockBody(ref: Ref): Buffer { return this.blocks[ref.index].body; }
  build(unfinished = false, trailing = Buffer.alloc(0)): Buffer {
    const addresses: number[] = []; let at = 64;
    for (const block of this.blocks) { addresses.push(at); at += align(24 + 8 * block.links.length + block.body.length); }
    const id = Buffer.alloc(64); id.write(unfinished ? 'UnFinMF ' : 'MDF     ', 0, 'ascii'); id.write('4.11    ', 8, 'ascii'); id.writeUInt16LE(411, 28);
    if (unfinished) id.writeUInt16LE(0x25, 60);
    const parts = [id];
    for (const block of this.blocks) {
      const header = Buffer.alloc(24 + 8 * block.links.length);
      header.write(block.type, 0, 'ascii'); header.writeBigUInt64LE(BigInt(24 + 8 * block.links.length + block.body.length), 8); header.writeBigUInt64LE(BigInt(block.links.length), 16);
      block.links.forEach((link, i) => header.writeBigUInt64LE(BigInt(link ? addresses[link.index] : 0), 24 + 8 * i));
      const whole = Buffer.concat([header, block.body]);
      parts.push(whole, Buffer.alloc(align(whole.length) - whole.length));
    }
    return Buffer.concat([...parts, trailing]);
  }
}
const align = (size: number) => Math.ceil(size / 8) * 8;

function hd(mdf: Mdf, startNs: bigint, tzMinutes = 0, dstMinutes = 0, flags = 0x2): Ref {
  const body = Buffer.alloc(32); body.writeBigUInt64LE(startNs, 0); body.writeInt16LE(tzMinutes, 8); body.writeInt16LE(dstMinutes, 10); body[12] = flags;
  return mdf.add('##HD', [0, 0, 0, 0, 0, 0], body);
}
function dg(mdf: Mdf, idSize: number, firstCg: Link, data: Link): Ref { const body = Buffer.alloc(8); body[0] = idSize; return mdf.add('##DG', [0, firstCg, data, 0], body); }
function cg(mdf: Mdf, recordId: number, dataBytes: number, firstCn: Link, name = '', flags = 0x6): Ref {
  const body = Buffer.alloc(32); body.writeBigUInt64LE(BigInt(recordId), 0); body.writeUInt16LE(flags, 16); body.writeUInt16LE(46, 18); body.writeUInt32LE(dataBytes, 24);
  return mdf.add('##CG', [0, firstCn, name ? mdf.text(name) : 0, 0, 0, 0], body);
}
interface CnOptions { type?: number; sync?: number; dataType?: number; bitOffset?: number; byteOffset?: number; bits?: number; flags?: number; invalidBit?: number; conversion?: Link; data?: Link; composition?: Link; next?: Link }
function cn(mdf: Mdf, name: string, options: CnOptions = {}): Ref {
  const body = Buffer.alloc(72);
  body[0] = options.type ?? 0; body[1] = options.sync ?? 0; body[2] = options.dataType ?? 0; body[3] = options.bitOffset ?? 0;
  body.writeUInt32LE(options.byteOffset ?? 0, 4); body.writeUInt32LE(options.bits ?? 0, 8); body.writeUInt32LE(options.flags ?? 0, 12); body.writeUInt32LE(options.invalidBit ?? 0, 16);
  return mdf.add('##CN', [options.next ?? 0, options.composition ?? 0, mdf.text(name), 0, options.conversion ?? 0, options.data ?? 0, 0, 0], body);
}
function cc(mdf: Mdf, type: number, values: readonly number[]): Ref {
  const body = Buffer.alloc(24 + 8 * values.length); body[0] = type; body.writeUInt16LE(values.length, 6);
  values.forEach((value, i) => body.writeDoubleLE(value, 24 + 8 * i));
  return mdf.add('##CC', [0, 0, 0, 0], body);
}
const constant = (mdf: Mdf, value: number) => cc(mdf, 1, [value, 0]);
const fdLengths = (mdf: Mdf) => cc(mdf, 5, [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 12, 10, 16, 11, 20, 12, 24, 13, 32, 14, 48, 15, 64]);

/** Builds a channel list from the last to the first, so each `next` exists before the one that names it. */
function chain(make: ((next: Link) => Ref)[]): Ref { let next: Link = 0; for (const item of [...make].reverse()) next = item(next); return next as Ref; }

type Parsed = { frames: CanFrame[]; diagnostics: Diagnostic[]; reference?: TimeReference; framesParsed: number; signals: MdfSignalSeries[] };
async function parse(buffer: Buffer): Promise<Parsed> {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'sigmixa-mdf-')), 'log.mf4'); writeFileSync(file, buffer);
  return parseFile(file);
}
async function parseFile(file: string): Promise<Parsed> {
  const frames: CanFrame[] = []; const diagnostics: Diagnostic[] = []; let reference: TimeReference | undefined; let signals: MdfSignalSeries[] = [];
  const result = await parseMdfFile(file, { sourceId: 'log.mf4', onFrames: (items) => frames.push(...items), onDiagnostics: (items) => diagnostics.push(...items), onTimeReference: (value) => { reference = value; }, onSignals: (items) => { signals = [...items]; } });
  return { frames, diagnostics, reference, framesParsed: result.framesParsed, signals };
}
const codes = (diagnostics: readonly Diagnostic[]) => diagnostics.map((diagnostic) => `${diagnostic.code}:${diagnostic.severity}`);
const row = (frame: CanFrame) => [+frame.timestamp.toFixed(6), frame.channel, frame.direction, frame.canId, frame.extended, frame.dlcCode, frame.dataLength, Array.from(frame.data).join(' ')];

// ---- CANedge-style unsorted data group: one channel group per bus and frame kind, constants as virtual channels ----

/** A CAN_DataFrame group: 6-byte µs time, 11/29-bit ID at 6, DLC in the next byte, DataBytes inline after it. */
function canedgeDataGroup(mdf: Mdf, recordId: number, bus: number, tx: boolean, extended: boolean, fd: boolean): Ref {
  const idBytes = extended ? 4 : 2; const dlcAt = 6 + idBytes;
  const members = chain([
    (next) => cn(mdf, 'CAN_DataFrame.BusChannel', { type: 6, conversion: constant(mdf, bus), next }),
    (next) => cn(mdf, 'CAN_DataFrame.ID', { byteOffset: 6, bits: extended ? 29 : 11, next }),
    (next) => cn(mdf, 'CAN_DataFrame.IDE', { type: 6, conversion: constant(mdf, extended ? 1 : 0), next }),
    (next) => cn(mdf, 'CAN_DataFrame.DLC', { byteOffset: dlcAt, bits: 4, next }),
    (next) => cn(mdf, 'CAN_DataFrame.DataLength', { byteOffset: dlcAt, bits: 4, conversion: fdLengths(mdf), next }),
    (next) => cn(mdf, 'CAN_DataFrame.DataBytes', { dataType: 10, byteOffset: dlcAt + 1, bits: (fd ? 64 : 8) * 8, next }),
    (next) => cn(mdf, 'CAN_DataFrame.Dir', { type: 6, conversion: constant(mdf, tx ? 1 : 0), next }),
    ...(fd ? [(next: Link) => cn(mdf, 'CAN_DataFrame.EDL', { type: 6, conversion: constant(mdf, 1), next })] : []),
  ]);
  const frame = cn(mdf, 'CAN_DataFrame', { dataType: 10, byteOffset: 6, composition: members });
  const time = cn(mdf, 'Timestamp', { type: 2, sync: 1, bits: 48, conversion: cc(mdf, 1, [0, 1e-6]), next: frame });
  return cg(mdf, recordId, dlcAt + 1 + (fd ? 64 : 8), time, `CAN${bus}`);
}
function canedgeRecord(recordId: number, extended: boolean, fd: boolean, us: number, id: number, dlc: number, data: readonly number[]): Buffer {
  const idBytes = extended ? 4 : 2; const record = Buffer.alloc(1 + 6 + idBytes + 1 + (fd ? 64 : 8));
  record[0] = recordId; record.writeUIntLE(us, 1, 6);
  if (extended) record.writeUInt32LE(id, 7); else record.writeUInt16LE(id, 7);
  record[7 + idBytes] = dlc; Buffer.from(data).copy(record, 8 + idBytes);
  return record;
}

function canedgeSample(): Buffer {
  const mdf = new Mdf();
  const header = hd(mdf, 1_700_000_000_000_000_000n, 540, 0);
  const groups = [canedgeDataGroup(mdf, 1, 1, false, false, false), canedgeDataGroup(mdf, 2, 2, true, true, false), canedgeDataGroup(mdf, 3, 1, false, false, true)];
  mdf.link(groups[0], 0, groups[1]); mdf.link(groups[1], 0, groups[2]);
  // Bus 2 is written after bus 1 although its frames are earlier, as CANedge does.
  const records = Buffer.concat([
    canedgeRecord(1, false, false, 1_000, 0x123, 3, [1, 2, 3]),
    canedgeRecord(1, false, false, 3_000, 0x124, 8, [8, 7, 6, 5, 4, 3, 2, 1]),
    canedgeRecord(2, true, false, 500, 0x18ff50e5, 2, [0xaa, 0xbb]),
    canedgeRecord(2, true, false, 2_000, 0x18ff50e6, 0, []),
    canedgeRecord(3, false, true, 2_500, 0x200, 9, Array.from({ length: 12 }, (_, i) => i + 1)),
  ]);
  const data = mdf.add('##DT', [], records);
  mdf.link(header, 0, dg(mdf, 1, groups[0], data));
  return mdf.build();
}

test('CANedge-style MF4: inline payloads, virtual constants, FD lengths, time zone, and channel groups merged in time order', async () => {
  const { frames, diagnostics, reference } = await parse(canedgeSample());
  assert.deepEqual(codes(diagnostics), []);
  assert.deepEqual(frames.map(row), [
    [0.0005, 2, 'Tx', 0x18ff50e5, true, 2, 2, '170 187'],
    [0.001, 1, 'Rx', 0x123, false, 3, 3, '1 2 3'],
    [0.002, 2, 'Tx', 0x18ff50e6, true, 0, 0, ''],
    [0.0025, 1, 'Rx', 0x200, false, 9, 12, '1 2 3 4 5 6 7 8 9 10 11 12'],
    [0.003, 1, 'Rx', 0x124, false, 8, 8, '8 7 6 5 4 3 2 1'],
  ]);
  assert.deepEqual(reference, { start: 1_700_000_000 + 540 * 60, offset: 1_700_000_000 + 540 * 60, utcOffsetMinutes: 540 });
  assert.equal(new Set(frames.map((frame) => frame.id)).size, frames.length);
});

// ---- older CANedge layout: 64-bit ns float time, BusChannel/ID/IDE packed in bits, DataBytes in a VLSD channel group written after the frame ----

test('VLSD channel group payloads written after their frame, bit-packed fields, float timestamps, unfinalized file', async () => {
  const mdf = new Mdf();
  const header = hd(mdf, 1_577_716_781_000_000_000n);
  const vlsdGroup = cg(mdf, 2, 0, 0, '', 0x1);
  const members = chain([
    (next) => cn(mdf, 'CAN_DataFrame.BusChannel', { byteOffset: 8, bits: 2, next }),
    (next) => cn(mdf, 'CAN_DataFrame.ID', { byteOffset: 8, bitOffset: 2, bits: 29, next }),
    (next) => cn(mdf, 'CAN_DataFrame.IDE', { byteOffset: 11, bitOffset: 7, bits: 1, next }),
    (next) => cn(mdf, 'CAN_DataFrame.DLC', { byteOffset: 13, bitOffset: 2, bits: 4, next }),
    (next) => cn(mdf, 'CAN_DataFrame.DataLength', { byteOffset: 12, bitOffset: 1, bits: 7, next }),
    (next) => cn(mdf, 'CAN_DataFrame.DataBytes', { type: 1, dataType: 10, byteOffset: 14, bits: 64, data: vlsdGroup, next }),
    (next) => cn(mdf, 'CAN_DataFrame.Dir', { byteOffset: 12, bits: 1, next }),
  ]);
  const frame = cn(mdf, 'CAN_DataFrame', { dataType: 10, byteOffset: 8, composition: members });
  const time = cn(mdf, 'Timestamp', { type: 2, sync: 1, dataType: 4, bits: 64, conversion: cc(mdf, 1, [0, 1e-9]), next: frame });
  const dataGroup = cg(mdf, 1, 22, time, 'CAN_DataFrame');
  mdf.link(dataGroup, 0, vlsdGroup);
  const fixed = (ns: number, bus: number, id: number, extended: boolean, dlc: number, length: number, tx: boolean, offset: number) => {
    const record = Buffer.alloc(23); record[0] = 1; record.writeDoubleLE(ns, 1);
    record.writeUInt32LE(((bus & 3) | (id << 2) | (extended ? 0x80000000 : 0)) >>> 0, 9);
    record[13] = (length << 1) | (tx ? 1 : 0); record[14] = dlc << 2; record.writeBigUInt64LE(BigInt(offset), 15);
    return record;
  };
  const payload = (bytes: readonly number[]) => { const record = Buffer.alloc(5 + bytes.length); record[0] = 2; record.writeUInt32LE(bytes.length, 1); Buffer.from(bytes).copy(record, 5); return record; };
  const records = Buffer.concat([
    fixed(1e9, 1, 0x0cf00400, true, 8, 8, false, 0), payload([1, 2, 3, 4, 5, 6, 7, 8]),
    fixed(2e9, 2, 0x7df, false, 2, 2, true, 12), payload([0x02, 0x01]),
    // Later frames may refer to the same payload, or go back to an earlier one.
    fixed(3e9, 2, 0x7df, false, 2, 2, true, 12),
    fixed(4e9, 1, 0x0cf00400, true, 8, 8, false, 0),
  ]);
  // An unfinalized CANedge file: the last DT block, at the end of the file, keeps its header length; reserved space follows.
  const group = dg(mdf, 1, dataGroup, 0);
  mdf.link(header, 0, group); mdf.link(group, 2, mdf.add('##DT', [], records));
  const built = mdf.build(true, Buffer.alloc(40));
  const dtAt = built.indexOf('##DT'); built.writeBigUInt64LE(24n, dtAt + 8);
  const { frames, diagnostics } = await parse(built);
  assert.deepEqual(codes(diagnostics), ['MDF_UNFINALIZED:info']);
  assert.deepEqual(frames.map(row), [
    [1, 1, 'Rx', 0x0cf00400, true, 8, 8, '1 2 3 4 5 6 7 8'],
    [2, 2, 'Tx', 0x7df, false, 2, 2, '2 1'],
    [3, 2, 'Tx', 0x7df, false, 2, 2, '2 1'],
    [4, 1, 'Rx', 0x0cf00400, true, 8, 8, '1 2 3 4 5 6 7 8'],
  ]);
});

// ---- finalized, sorted file: one channel group per data group, payloads in compressed signal data, bus logging next to measured signals ----

test('sorted data groups are merged by time; SD payloads, DZ blocks and data lists are read; other groups and error frames are reported', async () => {
  const mdf = new Mdf();
  const header = hd(mdf, 1_600_000_000_000_000_000n, 60, 60);
  const sdRecords = (items: readonly (readonly number[])[]) => Buffer.concat(items.map((bytes) => { const record = Buffer.alloc(4 + bytes.length); record.writeUInt32LE(bytes.length, 0); Buffer.from(bytes).copy(record, 4); return record; }));
  const dz = (original: Buffer, transposeColumns = 0) => {
    let source = original;
    if (transposeColumns) { const rows = Math.floor(original.length / transposeColumns); source = Buffer.from(original); for (let c = 0; c < transposeColumns; c++) for (let r = 0; r < rows; r++) source[c * rows + r] = original[r * transposeColumns + c]; }
    const packed = zlib.deflateSync(source); const body = Buffer.alloc(24 + packed.length);
    body.write('DT', 0, 'ascii'); body[2] = transposeColumns ? 1 : 0; body.writeUInt32LE(transposeColumns, 4); body.writeBigUInt64LE(BigInt(original.length), 8); body.writeBigUInt64LE(BigInt(packed.length), 16); packed.copy(body, 24);
    return body;
  };
  // A sorted CAN group: 8-byte double seconds, then a 32-bit ID with the IDE flag in bit 31, DLC, Dir, and an SD offset.
  const group = (bus: number, sd: Ref) => {
    const members = chain([
      (next) => cn(mdf, 'CAN_DataFrame.BusChannel', { type: 6, conversion: constant(mdf, bus), next }),
      (next) => cn(mdf, 'CAN_DataFrame.ID', { byteOffset: 8, bits: 32, next }),
      (next) => cn(mdf, 'CAN_DataFrame.DLC', { byteOffset: 12, bits: 4, next }),
      (next) => cn(mdf, 'CAN_DataFrame.Dir', { byteOffset: 12, bitOffset: 7, bits: 1, next }),
      (next) => cn(mdf, 'CAN_DataFrame.DataBytes', { type: 1, dataType: 10, byteOffset: 13, bits: 64, data: sd, next }),
    ]);
    const frame = cn(mdf, 'CAN_DataFrame', { dataType: 10, byteOffset: 8, composition: members });
    return cg(mdf, 0, 21, cn(mdf, 'time', { type: 2, sync: 1, dataType: 4, bits: 64, next: frame }), `CAN${bus}`);
  };
  const record = (seconds: number, id: number, dlc: number, tx: boolean, offset: number) => { const r = Buffer.alloc(21); r.writeDoubleLE(seconds, 0); r.writeUInt32LE(id >>> 0, 8); r[12] = dlc | (tx ? 0x80 : 0); r.writeBigUInt64LE(BigInt(offset), 13); return r; };
  const sd1 = mdf.add('##DZ', [], dz(sdRecords([[1, 1], [3, 3, 3]])));
  const sd2Parts = [mdf.add('##SD', [], sdRecords([[2]])), mdf.add('##SD', [], sdRecords([[4, 4, 4, 4]]))];
  const sdBody = Buffer.alloc(8); sdBody.writeUInt32LE(2, 4);
  const sd2 = mdf.add('##DL', [0, ...sd2Parts], sdBody);
  const can1 = group(1, sd1); const can2 = group(2, sd2);
  const dt1 = mdf.add('##DZ', [], dz(Buffer.concat([record(0.1, 0x100, 2, false, 0), record(0.3, 0x80000000 | 0x1abcdef, 3, true, 6)]), 21));
  const dt2 = mdf.add('##DT', [], Buffer.concat([record(0.2, 0x200, 1, false, 0), record(0.4, 0x201, 4, false, 5)]));
  // A CAN error frame group and a measured-signal group sit beside the bus logging.
  const errorMembers = cn(mdf, 'CAN_ErrorFrame.ErrorType', { byteOffset: 8, bits: 8 });
  const errors = cg(mdf, 0, 9, cn(mdf, 't', { type: 2, sync: 1, dataType: 4, bits: 64, next: cn(mdf, 'CAN_ErrorFrame', { dataType: 10, byteOffset: 8, composition: errorMembers }) }), 'CAN1_Errors');
  const errorRecord = Buffer.alloc(9); errorRecord.writeDoubleLE(0.25, 0); errorRecord[8] = 1;
  const dtErrors = mdf.add('##DT', [], errorRecord);
  const speed = cg(mdf, 0, 16, cn(mdf, 't', { type: 2, sync: 1, dataType: 4, bits: 64, next: cn(mdf, 'Speed', { dataType: 4, byteOffset: 8, bits: 64 }) }), 'Engine', 0);
  const dtSpeed = mdf.add('##DT', [], Buffer.alloc(32));
  // LIN bus logging is not read.
  const lin = cg(mdf, 0, 9, cn(mdf, 't', { type: 2, sync: 1, dataType: 4, bits: 64, next: cn(mdf, 'LIN_Frame', { dataType: 10, byteOffset: 8, bits: 8 }) }), 'LIN1');
  const dtLin = mdf.add('##DT', [], Buffer.alloc(9));
  const groups = [dg(mdf, 0, can1, dt1), dg(mdf, 0, can2, dt2), dg(mdf, 0, errors, dtErrors), dg(mdf, 0, speed, dtSpeed), dg(mdf, 0, lin, dtLin)];
  for (let i = 0; i + 1 < groups.length; i++) mdf.link(groups[i], 0, groups[i + 1]);
  mdf.link(header, 0, groups[0]);
  const { frames, diagnostics, reference } = await parse(mdf.build());
  assert.deepEqual(codes(diagnostics), ['MDF_ERROR_FRAME:warning', 'MDF_GROUP_UNSUPPORTED:info']);
  assert.match(diagnostics[1].message, /LIN1/);
  assert.deepEqual(frames.map(row), [
    [0.1, 1, 'Rx', 0x100, false, 2, 2, '1 1'],
    [0.2, 2, 'Rx', 0x200, false, 1, 1, '2'],
    [0.3, 1, 'Tx', 0x1abcdef, true, 3, 3, '3 3 3'],
    [0.4, 2, 'Rx', 0x201, false, 4, 4, '4 4 4 4'],
  ]);
  assert.equal(reference?.utcOffsetMinutes, 120);
});

test('an .mf4 log opens in the RAW log with its frames, decoded Signals and recorded time zone', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sigmixa-mdf-doc-'));
  (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file(root) }];
  (vscode.workspace as any).getWorkspaceFolder = () => vscode.workspace.workspaceFolders![0];
  const file = path.join(root, 'canedge.MF4'); writeFileSync(file, canedgeSample());
  const project = { ...emptyProject(), frames: [{ id: 'def', name: 'Status', canId: 0x123, extended: false, frameLength: 3, signals: [{ id: 's', name: 'First', unit: '', byteOffset: 0, bitOffset: 0, lengthBits: 8, signedness: 'unsigned', byteOrder: 'little', conversion: { type: 'scale-offset', lsb: 1, lsbText: '1', offset: 0 } }] }] } as never;
  const doc = new RawLogDocument(vscode.Uri.file(file), file, project, 1, new PluginRegistry());
  try {
    const summary = await doc.whenReady();
    assert.equal(summary.framesParsed, 5); assert.equal(doc.readError, undefined);
    assert.equal(doc.timeReference?.utcOffsetMinutes, 540);
    const rows = doc.query({ offset: 0, limit: 10 }, project, 1).rows;
    assert.deepEqual(rows.map((row) => [row.canIdValue, row.channel, row.direction, row.length]), [[0x18ff50e5, 2, 'Tx', 2], [0x123, 1, 'Rx', 3], [0x18ff50e6, 2, 'Tx', 0], [0x200, 1, 'Rx', 12], [0x124, 1, 'Rx', 8]]);
    assert.equal(rows[1].decoded, true); assert.match(rows[1].decodedContent, /First=1/);
    assert.deepEqual(doc.channelValues, [1, 2]);
  } finally { doc.dispose(); rmSync(root, { recursive: true, force: true }); }
});

/** A sorted CAN group: double seconds, 16-bit ID, DLC, 8 data bytes (19-byte records). */
function sortedCanGroup(mdf: Mdf, recordBytes = 19, extra: ((next: Link) => Ref)[] = []): Ref {
  const members = chain([
    ...extra,
    (next) => cn(mdf, 'CAN_DataFrame.ID', { byteOffset: 8, bits: 11, next }),
    (next) => cn(mdf, 'CAN_DataFrame.DLC', { byteOffset: 10, bits: 4, next }),
    (next) => cn(mdf, 'CAN_DataFrame.DataBytes', { dataType: 10, byteOffset: 11, bits: 64, next }),
  ]);
  return cg(mdf, 0, recordBytes, cn(mdf, 't', { type: 2, sync: 1, dataType: 4, bits: 64, next: cn(mdf, 'CAN_DataFrame', { dataType: 10, byteOffset: 8, composition: members }) }), 'CAN');
}
const sortedRecord = (seconds: number, id: number, byte: number) => { const r = Buffer.alloc(19); r.writeDoubleLE(seconds, 0); r.writeUInt16LE(id, 8); r[10] = 1; r[11] = byte; return r; };

test('a long chain of data lists is read to its end', async () => {
  const mdf = new Mdf();
  const header = hd(mdf, 0n);
  const group = dg(mdf, 0, sortedCanGroup(mdf), 0);
  mdf.link(header, 0, group);
  const body = Buffer.alloc(8); body.writeUInt32LE(1, 4);
  let next: Link = 0;
  for (let i = 99; i >= 0; i--) next = mdf.add('##DL', [next, mdf.add('##DT', [], sortedRecord(i / 100, 0x100, i))], body);
  mdf.link(group, 2, next);
  const { frames, diagnostics } = await parse(mdf.build());
  assert.deepEqual(codes(diagnostics), []);
  assert.equal(frames.length, 100); assert.equal(frames[99].data[0], 99);
});

test('a value-range conversion (CC type 6) gives the payload length', async () => {
  const mdf = new Mdf();
  const header = hd(mdf, 0n);
  // DLC 1 → 3 bytes by range [0, 1], anything else → the default 8.
  const lengths = cc(mdf, 6, [0, 1, 3, 2, 4, 5, 8]);
  const group = sortedCanGroup(mdf, 19, [(next) => cn(mdf, 'CAN_DataFrame.DataLength', { byteOffset: 10, bits: 4, conversion: lengths, next })]);
  mdf.link(header, 0, dg(mdf, 0, group, mdf.add('##DT', [], sortedRecord(0.5, 0x10, 7))));
  const { frames } = await parse(mdf.build());
  assert.deepEqual(frames.map(row), [[0.5, 1, 'Rx', 0x10, false, 1, 3, '7 0 0']]);
});

test('algebraic conversions (CC type 3) are evaluated; formulas with anything else are refused', () => {
  assert.equal(algebraic('X*0.000001')!(1_000_000), 1);
  assert.equal(algebraic('(x + 2) * -3 ^ 2 / 9')!(1), -3);
  assert.equal(algebraic('2^3^2')!(0), 512);
  assert.equal(algebraic('1.5e3 - X')!(500), 1000);
  assert.equal(algebraic('sin(X)'), undefined);
  assert.equal(algebraic('X +'), undefined);
});

test('a time master with a formula conversion, and a float range table that excludes its upper bound', async () => {
  const mdf = new Mdf();
  const header = hd(mdf, 0n);
  const formula = mdf.add('##CC', [0, 0, 0, 0, mdf.text('X/1000')], (() => { const body = Buffer.alloc(24); body[0] = 3; body.writeUInt16LE(1, 4); return body; })());
  const members = chain([
    (next) => cn(mdf, 'CAN_DataFrame.ID', { byteOffset: 4, bits: 11, next }),
    (next) => cn(mdf, 'CAN_DataFrame.DLC', { byteOffset: 6, bits: 4, next }),
    // A float channel: 1.0 is at the upper bound of [0, 1) and takes the default 2.
    (next) => cn(mdf, 'CAN_DataFrame.DataLength', { dataType: 4, byteOffset: 7, bits: 32, conversion: cc(mdf, 6, [0, 1, 1, 2]), next }),
    (next) => cn(mdf, 'CAN_DataFrame.DataBytes', { dataType: 10, byteOffset: 11, bits: 64, next }),
  ]);
  const group = cg(mdf, 0, 19, cn(mdf, 't', { type: 2, sync: 1, bits: 32, conversion: formula, next: cn(mdf, 'CAN_DataFrame', { dataType: 10, byteOffset: 4, composition: members }) }), 'CAN');
  const record = Buffer.alloc(19); record.writeUInt32LE(2500, 0); record.writeUInt16LE(0x55, 4); record[6] = 2; record.writeFloatLE(1, 7); record[11] = 9; record[12] = 8;
  mdf.link(header, 0, dg(mdf, 0, group, mdf.add('##DT', [], record)));
  const { frames, diagnostics } = await parse(mdf.build());
  assert.deepEqual(codes(diagnostics), []);
  assert.deepEqual(frames.map(row), [[2.5, 1, 'Rx', 0x55, false, 2, 2, '9 8']]);
});

test('records of 0 bytes in a sorted group are an error, not an endless read', async () => {
  const mdf = new Mdf();
  const header = hd(mdf, 0n);
  mdf.link(header, 0, dg(mdf, 0, sortedCanGroup(mdf, 0), mdf.add('##DT', [], Buffer.alloc(16))));
  await assert.rejects(parse(mdf.build()), /0 bytes/);
});

test('measured signals: numeric channels with units and value labels; other channels are reported; a file with signals only opens', async () => {
  const mdf = new Mdf();
  const header = hd(mdf, 0n);
  const unit = mdf.text('km/h');
  const gearText = cc(mdf, 7, [0, 1, 2]);
  // Value-to-text: 0 → P, 1 → D, 2 → R, anything else → ?
  const texts = [mdf.text('P'), mdf.text('D'), mdf.text('R'), mdf.text('?')];
  texts.forEach((text, i) => mdf.link(gearText, 4 + i, text));
  const channelList = chain([
    (next) => cn(mdf, 't', { type: 2, sync: 1, dataType: 4, bits: 64, next }),
    (next) => { const speed = cn(mdf, 'Speed', { dataType: 4, byteOffset: 8, bits: 32, conversion: cc(mdf, 1, [0, 3.6]), next }); mdf.link(speed, 6, unit); return speed; },
    (next) => cn(mdf, 'Gear', { byteOffset: 12, bits: 8, conversion: gearText, next }),
    (next) => cn(mdf, 'VIN', { dataType: 6, byteOffset: 13, bits: 24, next }),
  ]);
  const group = cg(mdf, 0, 16, channelList, 'Powertrain', 0);
  const records = Buffer.alloc(32);
  for (const [i, [seconds, metres, gear]] of [[0.5, 10, 0], [1.5, 20, 1]].entries()) { records.writeDoubleLE(seconds, 16 * i); records.writeFloatLE(metres, 16 * i + 8); records[16 * i + 12] = gear; }
  mdf.link(header, 0, dg(mdf, 0, group, mdf.add('##DT', [], records)));
  const { frames, diagnostics, signals } = await parse(mdf.build());
  assert.equal(frames.length, 0);
  assert.deepEqual(codes(diagnostics), ['MDF_CHANNEL_UNSUPPORTED:info']);
  assert.match(diagnostics[0].message, /VIN/);
  assert.deepEqual(signals.map((item) => [item.group, item.channel, item.unit, Array.from(item.times), Array.from(item.values)]), [
    ['Powertrain', 'Speed', 'km/h', [0.5, 1.5], [36, 72]],
    ['Powertrain', 'Gear', undefined, [0.5, 1.5], [0, 1]],
  ]);
  const definitions = mdfSignalDefinitions(signals);
  assert.deepEqual(definitions.map((item) => item.definition.id), ['mdf:Powertrain:Speed', 'mdf:Powertrain:Gear']);
  assert.deepEqual(definitions[1].samples().map((sample) => sample.valueLabel), ['P', 'D']);
  assert.equal(seriesLabel(signals[1], 1), 'D');
});

test('measured signals of an MF4 log are in its Signal catalog, grouped by channel group, in the Table as rows of their own times, and as trajectory axes', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sigmixa-mdf-signals-'));
  (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file(root) }];
  (vscode.workspace as any).getWorkspaceFolder = () => vscode.workspace.workspaceFolders![0];
  const file = path.join(root, 'basic.mf4'); writeFileSync(file, readFileSync('sample/basic/sigmixa-basic.mf4'));
  const project = emptyProject();
  const doc = new RawLogDocument(vscode.Uri.file(file), file, project, 1, new PluginRegistry());
  try {
    const summary = await doc.whenReady();
    assert.equal(summary.framesParsed, 3730);
    const catalog = doc.signalCatalog().filter((item) => item.source.type === 'mdf-channel');
    assert.deepEqual(catalog.slice(0, 2).map((item) => [item.id, item.name, item.unit]), [['mdf:Reference:Vehicle%20Speed', 'Vehicle Speed', 'm/s'], ['mdf:Reference:Coolant%20Temperature', 'Coolant Temperature', '°C']]);
    assert.deepEqual(catalog[6].parent, { id: 'Chassis:Position', label: 'Position', member: 'X' });
    const groups = signalCatalogGroups(doc.signalCatalog(), project, true);
    assert.deepEqual(groups.map((group) => [group.label, group.signalIds.length]), [['MF4 · Reference', 2], ['MF4 · Chassis', 6]]);
    assert.deepEqual(signalCatalogGroups(doc.signalCatalog(), project, false), []);
    const table = doc.signalTablePage(['mdf:Reference:Vehicle%20Speed'], 0, 3);
    assert.equal(table.total, 601);
    assert.deepEqual(table.rows.map((row) => [row.timestamp, row.values.get('mdf:Reference:Vehicle%20Speed')?.value]), [[0.001, 0], [0.101, 0.277777777777778], [0.201, 0.555555555555556]]);
    // Two signals of one group pair up as trajectory axes: the same times on both.
    const axes = doc.signalSeries(['mdf:Reference:Vehicle%20Speed', 'mdf:Reference:Coolant%20Temperature'], undefined, 4000, true).series;
    assert.equal(axes.length, 2); assert.equal(axes[0].samples.length, 601);
    assert.deepEqual(axes[0].samples.map((sample) => sample.timestamp), axes[1].samples.map((sample) => sample.timestamp));
  } finally { doc.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test('structure members and array elements are Signals of their own; a group may take its time from another (MDF 4.2)', async () => {
  const mdf = new Mdf();
  const header = hd(mdf, 0n);
  // Master group (record ID 1): time only. Slave group (record ID 2): a structure {X, Y} and a 2 x 2 array of int8, no time.
  const master = cg(mdf, 1, 8, cn(mdf, 't', { type: 2, sync: 1, dataType: 4, bits: 64 }), 'Clock', 0);
  const members = chain([(next) => cn(mdf, 'Pos.X', { dataType: 2, byteOffset: 0, bits: 16, next }), (next) => cn(mdf, 'Pos.Y', { dataType: 2, byteOffset: 2, bits: 16, next })]);
  const ca = (() => { const body = Buffer.alloc(32); body[0] = 0; body[1] = 0; body.writeUInt16LE(2, 2); body.writeInt32LE(1, 8); body.writeBigUInt64LE(2n, 16); body.writeBigUInt64LE(2n, 24); return mdf.add('##CA', [0], body); })();
  const slaveChannels = chain([
    (next) => cn(mdf, 'Pos', { dataType: 10, byteOffset: 0, bits: 32, composition: members, next }),
    (next) => cn(mdf, 'Map', { dataType: 2, byteOffset: 4, bits: 8, composition: ca, next }),
  ]);
  const slave = cg(mdf, 2, 8, slaveChannels, 'Sensor', 0);
  mdf.link(master, 0, slave); mdf.link(slave, 6, master);
  const record = (id: number, body: Buffer) => Buffer.concat([Buffer.from([id]), body]);
  const time = (seconds: number) => { const body = Buffer.alloc(8); body.writeDoubleLE(seconds, 0); return body; };
  const sensor = (x: number, y: number, map: number[]) => { const body = Buffer.alloc(8); body.writeInt16LE(x, 0); body.writeInt16LE(y, 2); Buffer.from(Int8Array.from(map).buffer).copy(body, 4); return body; };
  // The slave's first record comes before the master's: times are matched by record number, not by order.
  const data = Buffer.concat([record(2, sensor(1, -1, [1, 2, 3, -4])), record(1, time(0.5)), record(1, time(1.5)), record(2, sensor(2, -2, [5, 6, 7, 8]))]);
  mdf.link(header, 0, dg(mdf, 1, master, mdf.add('##DT', [], data)));
  const { diagnostics, signals } = await parse(mdf.build());
  assert.deepEqual(codes(diagnostics), []);
  assert.deepEqual(signals.map((item) => [item.group, item.channel, Array.from(item.times), Array.from(item.values)]), [
    ['Sensor', 'Pos.X', [0.5, 1.5], [1, 2]],
    ['Sensor', 'Pos.Y', [0.5, 1.5], [-1, -2]],
    ['Sensor', 'Map[0][0]', [0.5, 1.5], [1, 5]],
    ['Sensor', 'Map[0][1]', [0.5, 1.5], [2, 6]],
    ['Sensor', 'Map[1][0]', [0.5, 1.5], [3, 7]],
    ['Sensor', 'Map[1][1]', [0.5, 1.5], [-4, 8]],
  ]);
  // Listed under their structure or array, by their own part of the name.
  assert.deepEqual(signals.map((item) => item.parent && [item.parent.label, item.parent.member]), [['Pos', 'X'], ['Pos', 'Y'], ['Map [2×2]', '[0][0]'], ['Map [2×2]', '[0][1]'], ['Map [2×2]', '[1][0]'], ['Map [2×2]', '[1][1]']]);
});

test('an array of dynamic size gives values only for the elements each record holds', async () => {
  const mdf = new Mdf();
  const header = hd(mdf, 0n);
  const ca = (() => { const body = Buffer.alloc(24); body.writeUInt16LE(1, 2); body.writeUInt32LE(1, 4); body.writeInt32LE(1, 8); body.writeBigUInt64LE(3n, 16); return mdf.add('##CA', [0, 0, 0, 0], body); })();
  const size = cn(mdf, 'Count', { byteOffset: 8, bits: 8 });
  const channels = chain([
    (next) => cn(mdf, 't', { type: 2, sync: 1, dataType: 4, bits: 64, next }),
    (next) => { mdf.link(size, 0, next); return size; },
    (next) => cn(mdf, 'Cells', { byteOffset: 9, bits: 8, composition: ca, next }),
  ]);
  const group = cg(mdf, 0, 12, channels, 'Battery', 0);
  mdf.link(ca, 2, group); mdf.link(ca, 3, size);
  const record = (seconds: number, values: number[]) => { const body = Buffer.alloc(12); body.writeDoubleLE(seconds, 0); body[8] = values.length; Buffer.from(values).copy(body, 9); return body; };
  mdf.link(header, 0, dg(mdf, 0, group, mdf.add('##DT', [], Buffer.concat([record(1, [10, 11]), record(2, [20, 21, 22])]))));
  const { diagnostics, signals } = await parse(mdf.build());
  assert.deepEqual(codes(diagnostics), []);
  assert.deepEqual(signals.map((item) => [item.channel, Array.from(item.values)]), [['Count', [2, 3]], ['Cells[0]', [10, 20]], ['Cells[1]', [11, 21]], ['Cells[2]', [Number.NaN, 22]]]);
});

test('a column-major array (inverse layout) names its elements by their indexes, and a remote master may sit in another data group', async () => {
  const mdf = new Mdf();
  const header = hd(mdf, 0n);
  // Data group 1: the master's times, one of them invalid (NaN). Data group 2: a 2 x 2 array stored column by column.
  const master = cg(mdf, 0, 8, cn(mdf, 't', { type: 2, sync: 1, dataType: 4, bits: 64 }), 'Clock', 0);
  const times = Buffer.alloc(24); times.writeDoubleLE(0.5, 0); times.writeDoubleLE(Number.NaN, 8); times.writeDoubleLE(2.5, 16);
  const ca = (() => { const body = Buffer.alloc(32); body.writeUInt16LE(2, 2); body.writeUInt32LE(0x40, 4); body.writeInt32LE(1, 8); body.writeBigUInt64LE(2n, 16); body.writeBigUInt64LE(2n, 24); return mdf.add('##CA', [0], body); })();
  const slave = cg(mdf, 0, 4, cn(mdf, 'M', { dataType: 0, byteOffset: 0, bits: 8, composition: ca }), 'Grid', 0);
  mdf.link(slave, 6, master);
  const grid = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  const first = dg(mdf, 0, master, mdf.add('##DT', [], times)); const second = dg(mdf, 0, slave, mdf.add('##DT', [], grid));
  mdf.link(first, 0, second); mdf.link(header, 0, first);
  const { diagnostics, signals } = await parse(mdf.build());
  assert.deepEqual(codes(diagnostics), []);
  // Column by column: the bytes run [0][0], [1][0], [0][1], [1][1]. Record 1 has no master time.
  assert.deepEqual(signals.map((item) => [item.channel, Array.from(item.times), Array.from(item.values)]), [
    ['M[0][0]', [0.5, Number.NaN, 2.5], [1, 5, 9]],
    ['M[1][0]', [0.5, Number.NaN, 2.5], [2, 6, 10]],
    ['M[0][1]', [0.5, Number.NaN, 2.5], [3, 7, 11]],
    ['M[1][1]', [0.5, Number.NaN, 2.5], [4, 8, 12]],
  ]);
});

test('an array whose CA block names another (chained) has every element of both', async () => {
  const mdf = new Mdf();
  const header = hd(mdf, 0n);
  const caBody = (size: number, step: number) => { const body = Buffer.alloc(24); body.writeUInt16LE(1, 2); body.writeInt32LE(step, 8); body.writeBigUInt64LE(BigInt(size), 16); return body; };
  const inner = mdf.add('##CA', [0], caBody(3, 1)); const outer = mdf.add('##CA', [inner], caBody(2, 3));
  const channels = chain([(next) => cn(mdf, 't', { type: 2, sync: 1, dataType: 4, bits: 64, next }), (next) => cn(mdf, 'M', { byteOffset: 8, bits: 8, composition: outer, next })]);
  const group = cg(mdf, 0, 14, channels, 'Grid', 0);
  const record = Buffer.alloc(14); record.writeDoubleLE(1, 0); Buffer.from([1, 2, 3, 4, 5, 6]).copy(record, 8);
  mdf.link(header, 0, dg(mdf, 0, group, mdf.add('##DT', [], record)));
  const { diagnostics, signals } = await parse(mdf.build());
  assert.deepEqual(codes(diagnostics), []);
  assert.deepEqual(signals.map((item) => [item.channel, item.values[0]]), [['M[0][0]', 1], ['M[0][1]', 2], ['M[0][2]', 3], ['M[1][0]', 4], ['M[1][1]', 5], ['M[1][2]', 6]]);
});

test('a value inside structures nested five deep is read', async () => {
  const mdf = new Mdf();
  const header = hd(mdf, 0n);
  let inner: Ref = cn(mdf, 'V', { byteOffset: 8, bits: 8 });
  for (let level = 4; level >= 0; level--) inner = cn(mdf, `S${level}`, { dataType: 10, byteOffset: 8, bits: 8, composition: inner });
  const group = cg(mdf, 0, 9, cn(mdf, 't', { type: 2, sync: 1, dataType: 4, bits: 64, next: inner }), 'Deep', 0);
  const record = Buffer.alloc(9); record.writeDoubleLE(0.5, 0); record[8] = 42;
  mdf.link(header, 0, dg(mdf, 0, group, mdf.add('##DT', [], record)));
  const { diagnostics, signals } = await parse(mdf.build());
  assert.deepEqual(codes(diagnostics), []);
  assert.deepEqual(signals.map((item) => [item.channel, item.values[0]]), [['V', 42]]);
});

test('a value-to-text table whose entries name numeric conversions converts those values, as asammdf does', async () => {
  const mdf = new Mdf();
  const header = hd(mdf, 0n);
  // 0 → "Off" (text); anything else → X * 0.1 (a CC block as the default).
  const table = cc(mdf, 7, [0]); mdf.link(table, 4, mdf.text('Off')); mdf.link(table, 5, cc(mdf, 1, [0, 0.1]));
  const channels = chain([(next) => cn(mdf, 't', { type: 2, sync: 1, dataType: 4, bits: 64, next }), (next) => cn(mdf, 'Level', { byteOffset: 8, bits: 8, conversion: table, next })]);
  const group = cg(mdf, 0, 9, channels, 'G', 0);
  const records = Buffer.alloc(18); records.writeDoubleLE(1, 0); records[8] = 0; records.writeDoubleLE(2, 9); records[17] = 10;
  mdf.link(header, 0, dg(mdf, 0, group, mdf.add('##DT', [], records)));
  const { signals } = await parse(mdf.build());
  assert.deepEqual(Array.from(signals[0].values), [0, 1]);
  // The label follows the raw value: 10 (converted to 1) has none.
  assert.equal(seriesLabel(signals[0], 0), 'Off'); assert.equal(seriesLabel(signals[0], 1), undefined);
});

/** A sorted group of one float time master and one float value, with its records. */
function measuredGroup(mdf: Mdf, conversion: Link, samples: readonly [number, number][]): { group: Ref; data: Ref } {
  const channels = chain([(next) => cn(mdf, 't', { type: 2, sync: 1, dataType: 4, bits: 64, next }), (next) => cn(mdf, 'Value', { dataType: 4, byteOffset: 8, bits: 64, conversion, next })]);
  const group = cg(mdf, 0, 16, channels, 'G', 0);
  const records = Buffer.alloc(16 * samples.length); samples.forEach(([time, value], i) => { records.writeDoubleLE(time, 16 * i); records.writeDoubleLE(value, 16 * i + 8); });
  return { group, data: mdf.add('##DT', [], records) };
}

test('a value range to text (CC type 8) range [1, 1) holds nothing: raw 1.0 takes the default, as asammdf does', async () => {
  const mdf = new Mdf();
  const header = hd(mdf, 0n);
  const table = cc(mdf, 8, [1, 1, 2, 3]); mdf.link(table, 4, mdf.text('Empty')); mdf.link(table, 5, mdf.text('Two')); mdf.link(table, 6, mdf.text('Other'));
  const { group, data } = measuredGroup(mdf, table, [[0, 1], [1, 2.5]]);
  mdf.link(header, 0, dg(mdf, 0, group, data));
  const { signals } = await parse(mdf.build());
  assert.equal(seriesLabel(signals[0], 0), 'Other');
  assert.equal(seriesLabel(signals[0], 1), 'Two');
});

test('a value-to-text entry with a NaN key never names a NaN sample: it takes the default, as asammdf does', async () => {
  const mdf = new Mdf();
  const header = hd(mdf, 0n);
  const table = cc(mdf, 7, [Number.NaN, 1]); mdf.link(table, 4, mdf.text('Not a number')); mdf.link(table, 5, mdf.text('One')); mdf.link(table, 6, mdf.text('Other'));
  const { group, data } = measuredGroup(mdf, table, [[0, Number.NaN], [1, 1]]);
  mdf.link(header, 0, dg(mdf, 0, group, data));
  const { signals } = await parse(mdf.build());
  assert.notEqual(seriesLabel(signals[0], 0), 'Not a number');
  assert.equal(seriesLabel(signals[0], 1), 'One');
});

test('a record whose time master is invalid (NaN) is left out without moving the times of the records after it', async () => {
  const mdf = new Mdf();
  const header = hd(mdf, 0n);
  const { group, data } = measuredGroup(mdf, 0, [[0, 10], [Number.NaN, 20], [2, 30]]);
  mdf.link(header, 0, dg(mdf, 0, group, data));
  const { signals } = await parse(mdf.build());
  const pairs = Array.from(signals[0].times).map((time, i) => [time, signals[0].values[i]]).filter(([time]) => Number.isFinite(time));
  assert.deepEqual(pairs, [[0, 10], [2, 30]]);
});

test('frames of sorted groups come out in time order, also when one group holds more frames than the merge keeps waiting', async () => {
  const mdf = new Mdf();
  const header = hd(mdf, 0n);
  const many = 70_000;
  const records = Buffer.concat(Array.from({ length: many }, (_, i) => sortedRecord(0.001 + i * 0.001, 0x100, i & 0xff)));
  const late = dg(mdf, 0, sortedCanGroup(mdf), mdf.add('##DT', [], sortedRecord(0.0005, 0x200, 1)));
  const first = dg(mdf, 0, sortedCanGroup(mdf), mdf.add('##DT', [], records));
  mdf.link(first, 0, late); mdf.link(header, 0, first);
  const { frames } = await parse(mdf.build());
  assert.equal(frames.length, many + 1);
  for (let i = 1; i < frames.length; i++) if (frames[i].timestamp < frames[i - 1].timestamp) assert.fail(`frame ${i} at ${frames[i].timestamp} s comes after ${frames[i - 1].timestamp} s`);
  assert.equal(frames[0].canId, 0x200);
});

test('record IDs above 2^53 are never taken for one another: read apart, or refused', async () => {
  const mdf = new Mdf();
  const header = hd(mdf, 0n);
  const a = sortedCanGroup(mdf); const b = sortedCanGroup(mdf);
  // 8-byte record IDs 2^53 and 2^53 + 1, which are one number once they become a JavaScript number.
  mdf.blockBody(a).writeBigUInt64LE(2n ** 53n, 0); mdf.blockBody(b).writeBigUInt64LE(2n ** 53n + 1n, 0);
  mdf.link(a, 0, b);
  const record = (id: bigint, seconds: number, canId: number) => { const r = Buffer.alloc(8 + 19); r.writeBigUInt64LE(id, 0); sortedRecord(seconds, canId, 1).copy(r, 8); return r; };
  const data = Buffer.concat([record(2n ** 53n, 0.1, 0x111), record(2n ** 53n + 1n, 0.2, 0x222)]);
  // Different record lengths would hide the mix-up: both groups use the same layout, so only the ID tells them apart.
  mdf.link(header, 0, dg(mdf, 8, a, mdf.add('##DT', [], data)));
  // Read apart, or refused as too large: never read with another group's channels.
  const result = await parse(mdf.build()).catch((error: Error) => error);
  if (result instanceof Error) assert.match(result.message, /record ID.*too large/);
  else assert.deepEqual(result.frames.map((frame) => [frame.timestamp, frame.canId]), [[0.1, 0x111], [0.2, 0x222]]);
});

test('an MF4 file with neither CAN frames nor readable signals is an error', async () => {
  const mdf = new Mdf();
  const header = hd(mdf, 0n);
  const text = cg(mdf, 0, 16, cn(mdf, 't', { type: 2, sync: 1, dataType: 4, bits: 64, next: cn(mdf, 'Comment', { dataType: 6, byteOffset: 8, bits: 64 }) }), 'Notes', 0);
  mdf.link(header, 0, dg(mdf, 0, text, mdf.add('##DT', [], Buffer.alloc(16))));
  const { frames, diagnostics, reference } = await parse(mdf.build());
  assert.equal(frames.length, 0); assert.equal(reference, undefined);
  assert.deepEqual(codes(diagnostics), ['MDF_CHANNEL_UNSUPPORTED:info', 'MDF_NOTHING_TO_IMPORT:error']);
});

test('readNumber reads bit fields in both byte orders, signed values and 64-bit integers', () => {
  const record = Buffer.from([0b1011_0100, 0x12, 0x34, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f]);
  assert.equal(readNumber(record, { dataType: 0, byteOffset: 0, bitOffset: 2, bitCount: 4 }), 0b1101);
  assert.equal(readNumber(record, { dataType: 0, byteOffset: 1, bitOffset: 0, bitCount: 16 }), 0x3412);
  assert.equal(readNumber(record, { dataType: 1, byteOffset: 1, bitOffset: 0, bitCount: 16 }), 0x1234);
  assert.equal(readNumber(record, { dataType: 2, byteOffset: 3, bitOffset: 0, bitCount: 16 }), -1);
  assert.equal(readNumber(record, { dataType: 0, byteOffset: 3, bitOffset: 0, bitCount: 64 }), 0x7fffffffffffffff);
  assert.ok(Number.isNaN(readNumber(record, { dataType: 0, byteOffset: 10, bitOffset: 0, bitCount: 16 })));
});

test('bundled basic MF4 log mirrors every ASC frame, remote frames included, with the ASC start time, and holds the reference signals', async () => {
  const { frames, diagnostics, reference, signals } = await parseFile(path.resolve('sample/basic/sigmixa-basic.mf4'));
  const ascFrames: CanFrame[] = []; let ascReference: TimeReference | undefined;
  await parseAscFile('sample/basic/sigmixa-basic.asc', { sourceId: 'sample/basic/sigmixa-basic.asc', onFrames: (items) => ascFrames.push(...items), onTimeReference: (value) => { ascReference = value; } });
  const comparable = (frame: CanFrame) => ({
    timestampNs: Math.round(frame.timestamp * 1_000_000_000), channel: frame.channel, direction: frame.direction,
    canId: frame.canId, extended: frame.extended, dlcCode: frame.dlcCode, dataLength: frame.dataLength, data: [...frame.data],
  });
  assert.deepEqual(diagnostics, []);
  assert.equal(frames.length, ascFrames.length);
  assert.deepEqual(frames.map(comparable), ascFrames.map(comparable));
  assert.deepEqual(reference, ascReference);
  // Its measured signals are the reference CSV's columns, on the same time base.
  const csv = readFileSync('sample/basic/sigmixa-basic-decoded.csv', 'utf8').trim().split(/\r?\n/).slice(1).map((line) => line.split(',').map(Number));
  assert.deepEqual(signals.map((item) => [item.group, item.channel, item.unit, item.parent?.label]), [
    ['Reference', 'Vehicle Speed', 'm/s', undefined], ['Reference', 'Coolant Temperature', '°C', undefined],
    ...[0, 1, 2, 3].map((wheel) => ['Chassis', `WheelSpeed[${wheel}]`, 'm/s', 'WheelSpeed [4]']), ['Chassis', 'Position.X', 'm', 'Position'], ['Chassis', 'Position.Y', 'm', 'Position'],
  ]);
  assert.deepEqual(Array.from(signals[0].times), csv.map(([milliseconds]) => milliseconds / 1000));
  assert.deepEqual(Array.from(signals[0].values), csv.map(([, speed]) => speed));
  assert.deepEqual(Array.from(signals[1].values), csv.map(([, , temperature]) => temperature));
});

// ---- the downloaded sample corpus (work/, not in Git): checked against asammdf when it is present ----

const corpus = path.resolve('work/mdf4-samples');
test('MF4 sample corpus matches the asammdf reference (frame counts, sampled IDs, times and payloads, measured signals)', { skip: !existsSync(path.join(corpus, 'reference.json')) }, async () => {
  const reference = JSON.parse(readFileSync(path.join(corpus, 'reference.json'), 'utf8')) as AsammdfEntry[];
  for (const entry of reference) {
    const { frames, signals } = await parseFile(path.join(corpus, entry.file));
    assertMatchesAsammdf(entry, frames, signals);
    if (entry.file.startsWith('asammdf/')) assert.equal(signals.length, 37);
  }
});

test('a CAN frame whose time the logger marked invalid is reported and not imported', async () => {
  const mdf = new Mdf();
  const header = hd(mdf, 0n);
  const members = chain([
    (next) => cn(mdf, 'CAN_DataFrame.ID', { byteOffset: 8, bits: 11, next }),
    (next) => cn(mdf, 'CAN_DataFrame.DLC', { byteOffset: 10, bits: 4, next }),
    (next) => cn(mdf, 'CAN_DataFrame.DataBytes', { dataType: 10, byteOffset: 11, bits: 64, next }),
  ]);
  // 19 data bytes and one invalidation byte; bit 0 marks the time invalid.
  const group = cg(mdf, 0, 19, cn(mdf, 't', { type: 2, sync: 1, dataType: 4, bits: 64, flags: 0x2, invalidBit: 0, next: cn(mdf, 'CAN_DataFrame', { dataType: 10, byteOffset: 8, composition: members }) }), 'CAN');
  mdf.blockBody(group).writeUInt32LE(1, 28);
  const record = (seconds: number, byte: number, invalid: boolean) => Buffer.concat([sortedRecord(seconds, 0x100, byte), Buffer.from([invalid ? 1 : 0])]);
  const data = mdf.add('##DT', [], Buffer.concat([record(0.1, 1, false), record(0.2, 2, true), record(0.3, 3, false)]));
  mdf.link(header, 0, dg(mdf, 0, group, data));
  const { frames, diagnostics } = await parse(mdf.build());
  assert.deepEqual(frames.map((frame) => frame.data[0]), [1, 3]);
  assert.deepEqual(codes(diagnostics), ['MDF_TIME_INVALID:warning']);
});

test('an array that steps backwards out of the record is not read, and the rest of the log still is', async () => {
  const mdf = new Mdf();
  const header = hd(mdf, 0n);
  // Two uint16 elements from byte offset 8 of the record, 2 bytes apart backwards then forwards again: the second backwards one lands before the record.
  const ca = (() => { const body = Buffer.alloc(24); body.writeUInt16LE(1, 2); body.writeInt32LE(-10, 8); body.writeBigUInt64LE(2n, 16); return mdf.add('##CA', [0], body); })();
  const channels = chain([
    (next) => cn(mdf, 't', { type: 2, sync: 1, dataType: 4, bits: 64, next }),
    (next) => cn(mdf, 'Speed', { byteOffset: 8, bits: 16, next }),
    (next) => cn(mdf, 'Back', { byteOffset: 8, bits: 16, composition: ca, next }),
  ]);
  const group = cg(mdf, 0, 10, channels, 'Body', 0);
  const record = (seconds: number, value: number) => { const body = Buffer.alloc(10); body.writeDoubleLE(seconds, 0); body.writeUInt16LE(value, 8); return body; };
  mdf.link(header, 0, dg(mdf, 0, group, mdf.add('##DT', [], Buffer.concat([record(1, 5), record(2, 6)]))));
  const { signals } = await parse(mdf.build());
  assert.deepEqual(Array.from(signals.find((item) => item.channel === 'Speed')!.values), [5, 6]);
  assert.ok(!signals.some((item) => item.channel === 'Back[1]'), 'an element before the record is not read');
});
