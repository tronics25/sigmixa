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

test('python-can Classic CAN and CAN_MESSAGE2 fixtures are compatible', () => {
  for (const name of ['test_CanMessage.blf', 'test_CanMessage2.blf']) {
    const { frames, diagnostics } = parseFixture(name);
    assert.equal(frames.length, 2);
    assert.deepEqual(diagnostics.map((item) => item.code), ['BLF_EXPERIMENTAL']);
    for (const frame of frames) {
      assert.ok(Math.abs(frame.timestamp - 2459565876.494607) < 1e-6);
      assert.deepEqual([frame.channel, frame.direction, frame.canId, frame.extended, frame.dlcCode, frame.dataLength], [0x1111, 'Rx', 0x4444444, false, 15, 8]);
      assert.deepEqual([...frame.data], [0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc]);
    }
  }
});

test('python-can CAN FD and CAN_FD_MESSAGE_64 fixtures are compatible', () => {
  const regular = parseFixture('test_CanFdMessage.blf');
  assert.equal(regular.frames.length, 2);
  assert.deepEqual([regular.frames[0].channel, regular.frames[0].direction, regular.frames[0].canId, regular.frames[0].dlcCode, regular.frames[0].dataLength], [0x1111, 'Rx', 0x4444444, 15, 64]);
  assert.deepEqual([...regular.frames[0].data], range(64));

  const fd64 = parseFixture('test_CanFdMessage64.blf');
  assert.equal(fd64.frames.length, 2);
  assert.deepEqual([fd64.frames[0].channel, fd64.frames[0].direction, fd64.frames[0].canId, fd64.frames[0].dlcCode, fd64.frames[0].dataLength], [0x11, 'Tx', 0x15555555, 15, 64]);
  assert.deepEqual([...fd64.frames[0].data], range(64));
});

test('python-can issue 1905 fixture restores file start time and CANoe-compatible FD64 padding', () => {
  const { frames, diagnostics } = parseFixture('issue_1905.blf');
  assert.equal(frames.length, 22);
  assert.deepEqual(diagnostics.map((item) => item.code), ['BLF_EXPERIMENTAL']);
  assert.ok(Math.abs(frames[0].timestamp - 1735654183.491113) < 1e-6);
  assert.deepEqual([frames[0].channel, frames[0].direction, frames[0].canId, frames[0].extended, frames[0].dlcCode, frames[0].dataLength], [7, 'Rx', 0x6a9, false, 15, 64]);
  assert.deepEqual([...frames[0].data], [...Array(48).fill(0xff), ...Array(16).fill(0)]);
});

test('an inner object split across python-can-style LogContainers is reassembled', () => {
  const inner = object(1, classic(2, 0, 0x123, [1, 2, 3]), 42n);
  const buffer = blfContainers([inner.subarray(0, 21), inner.subarray(21)], true);
  const frames: CanFrame[] = []; const diagnostics: Diagnostic[] = [];
  const result = parseBlfBuffer(buffer, { sourceId: 'split.blf', onFrames: (items) => frames.push(...items), onDiagnostics: (items) => diagnostics.push(...items) });
  assert.equal(result.framesParsed, 1);
  assert.deepEqual([...frames[0].data], [1, 2, 3]);
  assert.deepEqual(diagnostics.map((item) => item.code), ['BLF_EXPERIMENTAL']);
});

function blf(contents: Buffer, compressed: boolean): Buffer {
  return blfContainers([contents], compressed);
}

function blfContainers(contents: readonly Buffer[], compressed: boolean): Buffer {
  const fileHeader = Buffer.alloc(144); fileHeader.write('LOGG'); fileHeader.writeUInt32LE(fileHeader.length, 4);
  return Buffer.concat([fileHeader, ...contents.map((content) => {
    const payload = compressed ? zlib.deflateSync(content) : content;
    const container = Buffer.alloc(16 + payload.length); container.writeUInt16LE(compressed ? 2 : 0, 0); container.writeUInt32LE(content.length, 8); payload.copy(container, 16);
    const size = 16 + container.length; const result = Buffer.alloc(size + size % 4);
    result.write('LOBJ'); result.writeUInt16LE(16, 4); result.writeUInt16LE(1, 6); result.writeUInt32LE(size, 8); result.writeUInt32LE(10, 12); container.copy(result, 16);
    return result;
  })]);
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

function parseFixture(name: string): { readonly frames: CanFrame[]; readonly diagnostics: Diagnostic[] } {
  const frames: CanFrame[] = []; const diagnostics: Diagnostic[] = [];
  parseBlfBuffer(readFileSync(`tests/fixtures/python-can/${name}`), { sourceId: name, onFrames: (items) => frames.push(...items), onDiagnostics: (items) => diagnostics.push(...items) });
  return { frames, diagnostics };
}
