import test from 'node:test';
import assert from 'node:assert/strict';
import * as zlib from 'zlib';
import { readFileSync } from 'fs';
import type { CanFrame } from '../src/core/frame/canFrame';
import type { Diagnostic } from '../src/core/diagnostics/diagnostic';
import { parseBlfBuffer } from '../src/parsers/blf/parseBlf';
import { parseAscFile } from '../src/parsers/asc/parseAscStream';

const NS = 0x2;

test('synthetic BLF golden fixture imports Classic, CAN FD, FD64, direction, channel and absolute object timestamps', () => {
  const inner = Buffer.concat([
    object(1, classic(2, 0, 0x123, [1, 2, 3]), 12_500_000_000n),
    object(100, fd(3, 1, 0x80000000 | 0x18ff50e5, 9, range(12)), 12_750_000_000n),
    object(101, fd64(4, 0, 0x456, 15, range(64)), 13_000_000_000n),
  ]);
  const buffer = blf(inner, true);
  const frames: CanFrame[] = []; const diagnostics: Diagnostic[] = [];
  const result = parseBlfBuffer(buffer, { sourceId: 'golden.blf', onFrames: (items) => frames.push(...items), onDiagnostics: (items) => diagnostics.push(...items) });
  assert.equal(result.framesParsed, 3); assert.equal(result.cancelled, false); assert.deepEqual(diagnostics.map((item) => item.code), ['BLF_EXPERIMENTAL']);
  assert.deepEqual(frames.map((frame) => [frame.timestamp, frame.channel, frame.direction, frame.canId, frame.extended, frame.dlcCode, frame.dataLength]), [
    [12.5, 2, 'Rx', 0x123, false, 3, 3],
    [12.75, 3, 'Tx', 0x18ff50e5, true, 9, 12],
    [13, 4, 'Rx', 0x456, false, 15, 64],
  ]);
  assert.equal(frames[2].data[63], 63);
});

test('uncompressed LogContainer and ten-microsecond timestamp flag are supported', () => {
  const inner = object(86, classic(1, 1, 0x321, [0xaa]), 123_456n, 0x1);
  const frames: CanFrame[] = [];
  const result = parseBlfBuffer(blf(inner, false), { sourceId: 'plain.blf', onFrames: (items) => frames.push(...items), onDiagnostics: () => undefined });
  assert.equal(result.framesParsed, 1); assert.ok(Math.abs(frames[0].timestamp - 1.23456) < 1e-12); assert.equal(frames[0].direction, 'Tx');
});

test('truncated object is diagnosed and never interpreted as a frame', () => {
  const valid = object(1, classic(1, 0, 0x100, [1]), 1n);
  const broken = Buffer.from(valid); broken.writeUInt32LE(valid.length + 200, 8);
  const diagnostics: Diagnostic[] = []; const frames: CanFrame[] = [];
  parseBlfBuffer(blf(broken, false), { sourceId: 'broken.blf', onFrames: (items) => frames.push(...items), onDiagnostics: (items) => diagnostics.push(...items) });
  assert.equal(frames.length, 0); assert.equal(diagnostics.at(-1)?.code, 'BLF_INNER_OBJECT_TRUNCATED');
});

test('synthetic BLF performance smoke parses 20,000 Classic frames', { timeout: 10_000 }, () => {
  const objects = Array.from({ length: 20_000 }, (_, index) => object(1, classic(1, index & 1, 0x500 + index % 32, range(8)), BigInt(index) * 1_000_000n));
  let frames = 0; const started = performance.now();
  const result = parseBlfBuffer(blf(Buffer.concat(objects), true), { sourceId: 'large.blf', onFrames: (items) => { frames += items.length; }, onDiagnostics: () => undefined });
  assert.equal(result.framesParsed, 20_000); assert.equal(frames, 20_000); assert.ok(performance.now() - started < 8_000);
});

test('bundled BLF showcase mirrors every supported ASC frame', async () => {
  const frames: CanFrame[] = []; const diagnostics: Diagnostic[] = [];
  const result = parseBlfBuffer(readFileSync('sample/sigmixa-showcase.blf'), { sourceId: 'sample/sigmixa-showcase.blf', onFrames: (items) => { frames.push(...items); }, onDiagnostics: (items) => diagnostics.push(...items) });
  const ascFrames: CanFrame[] = [];
  await parseAscFile('sample/sigmixa-showcase.asc', { sourceId: 'sample/sigmixa-showcase.asc', onFrames: (items) => ascFrames.push(...items) });
  const supportedAscFrames = ascFrames.filter((frame) => !(frame.canId === 0x400 && frame.dataLength === 0));
  const comparable = (frame: CanFrame) => ({
    timestampNs: Math.round(frame.timestamp * 1_000_000_000), channel: frame.channel, direction: frame.direction,
    canId: frame.canId, extended: frame.extended, dlcCode: frame.dlcCode,
    dataLength: frame.dataLength, data: [...frame.data],
  });
  assert.equal(result.framesParsed, 3038); assert.equal(frames.length, result.framesParsed);
  assert.deepEqual(frames.map(comparable), supportedAscFrames.map(comparable));
  assert.deepEqual(diagnostics.map((item) => item.code), ['BLF_EXPERIMENTAL']);
});

function blf(contents: Buffer, compressed: boolean): Buffer {
  const fileHeader = Buffer.alloc(144); fileHeader.write('LOGG'); fileHeader.writeUInt32LE(fileHeader.length, 4);
  const payload = compressed ? zlib.deflateSync(contents) : contents;
  const container = Buffer.alloc(16 + payload.length); container.writeUInt16LE(compressed ? 2 : 0, 0); container.writeUInt32LE(contents.length, 8); payload.copy(container, 16);
  return Buffer.concat([fileHeader, object(10, container, 0n)]);
}

function object(type: number, payload: Buffer, timestamp: bigint, flags = NS): Buffer {
  const size = 32 + payload.length; const padded = Buffer.alloc(align4(size));
  padded.write('LOBJ'); padded.writeUInt16LE(32, 4); padded.writeUInt16LE(1, 6); padded.writeUInt32LE(size, 8); padded.writeUInt32LE(type, 12);
  padded.writeUInt32LE(flags, 16); padded.writeBigUInt64LE(timestamp, 24); payload.copy(padded, 32); return padded;
}

function classic(channel: number, tx: number, id: number, data: number[]): Buffer {
  const payload = Buffer.alloc(16); payload.writeUInt16LE(channel, 0); payload.writeUInt8(tx, 2); payload.writeUInt8(data.length, 3); payload.writeUInt32LE(id >>> 0, 4); Buffer.from(data).copy(payload, 8); return payload;
}

function fd(channel: number, tx: number, id: number, dlc: number, data: number[]): Buffer {
  const payload = Buffer.alloc(84); payload.writeUInt16LE(channel, 0); payload.writeUInt8(tx, 2); payload.writeUInt8(dlc, 3); payload.writeUInt32LE(id >>> 0, 4); payload.writeUInt8(data.length, 14); Buffer.from(data).copy(payload, 20); return payload;
}

function fd64(channel: number, direction: number, id: number, dlc: number, data: number[]): Buffer {
  const payload = Buffer.alloc(40 + data.length); payload.writeUInt8(channel, 0); payload.writeUInt8(dlc, 1); payload.writeUInt8(data.length, 2); payload.writeUInt32LE(id >>> 0, 4); payload.writeUInt8(direction, 34); Buffer.from(data).copy(payload, 40); return payload;
}

function range(length: number): number[] { return Array.from({ length }, (_, index) => index); }
function align4(value: number): number { return Math.ceil(value / 4) * 4; }
