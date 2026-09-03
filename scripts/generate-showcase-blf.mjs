import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const input = path.resolve('sample/sigmixa-showcase.asc');
const output = path.resolve('sample/sigmixa-showcase.blf');
const objects = [];

for (const line of readFileSync(input, 'utf8').split(/\r?\n/)) {
  const fields = line.trim().split(/\s+/);
  if (!fields[0] || !Number.isFinite(Number(fields[0]))) continue;

  if (fields[1] === 'CANFD') {
    const parsed = parseFd(fields);
    if (!parsed) continue;
    const payload = parsed.data.length === 64
      ? fd64(parsed.channel, parsed.direction === 'Tx', parsed.canId, parsed.extended, parsed.dlc, parsed.data)
      : fd(parsed.channel, parsed.direction === 'Tx', parsed.canId, parsed.extended, parsed.dlc, parsed.data);
    objects.push(object(parsed.data.length === 64 ? 101 : 100, payload, timestamp(fields[0])));
    continue;
  }

  const parsed = parseClassic(fields);
  if (!parsed) continue;
  objects.push(object(1, classic(parsed.channel, parsed.direction === 'Tx', parsed.canId, parsed.extended, parsed.data), timestamp(fields[0])));
}

const contents = Buffer.concat(objects);
const compressed = zlib.deflateSync(contents);
const container = Buffer.alloc(16 + compressed.length);
container.writeUInt16LE(2, 0);
container.writeUInt32LE(contents.length, 8);
compressed.copy(container, 16);
const fileHeader = Buffer.alloc(144);
fileHeader.write('LOGG');
fileHeader.writeUInt32LE(fileHeader.length, 4);
writeFileSync(output, Buffer.concat([fileHeader, object(10, container, 0n)]));
console.log(`Generated ${output}: ${objects.length} frames matching the ASC showcase`);

function parseClassic(fields) {
  if (fields.length < 6 || fields[4] !== 'd') return undefined;
  const dataLength = Number(fields[5]);
  if (!Number.isInteger(dataLength) || fields.length < 6 + dataLength) return undefined;
  const id = parseCanId(fields[2]);
  if (!id) return undefined;
  return {
    channel: Number(fields[1]), canId: id.canId, extended: id.extended,
    direction: fields[3], data: fields.slice(6, 6 + dataLength).map(hexByte),
  };
}

function parseFd(fields) {
  if (fields.length < 10) return undefined;
  let lengthIndex = -1;
  for (let index = 5; index < fields.length; index++) {
    const candidate = Number(fields[index]);
    if (Number.isInteger(candidate) && candidate >= 0 && fields.length - index - 1 === candidate) {
      lengthIndex = index;
      break;
    }
  }
  if (lengthIndex < 1) return undefined;
  const id = parseCanId(fields[4]);
  if (!id) return undefined;
  return {
    channel: Number(fields[2]), canId: id.canId, extended: id.extended,
    direction: fields[3], dlc: Number.parseInt(fields[lengthIndex - 1], 16),
    data: fields.slice(lengthIndex + 1).map(hexByte),
  };
}

function parseCanId(text) {
  const extended = text.toLowerCase().endsWith('x') || text.replace(/x$/i, '').length > 3;
  const canId = Number.parseInt(text.replace(/x$/i, ''), 16);
  return Number.isInteger(canId) ? { canId, extended } : undefined;
}

function timestamp(text) { return BigInt(Math.round(Number(text) * 1_000_000_000)); }
function hexByte(text) { return Number.parseInt(text, 16); }
function align4(value) { return Math.ceil(value / 4) * 4; }
function encodedId(canId, extended) { return extended ? (canId | 0x80000000) >>> 0 : canId >>> 0; }

function object(type, payload, time) {
  const size = 32 + payload.length;
  const result = Buffer.alloc(align4(size));
  result.write('LOBJ'); result.writeUInt16LE(32, 4); result.writeUInt16LE(1, 6);
  result.writeUInt32LE(size, 8); result.writeUInt32LE(type, 12);
  result.writeUInt32LE(0x2, 16); result.writeBigUInt64LE(time, 24);
  payload.copy(result, 32);
  return result;
}

function classic(channel, tx, canId, extended, data) {
  const payload = Buffer.alloc(16);
  payload.writeUInt16LE(channel, 0); payload.writeUInt8(tx ? 1 : 0, 2);
  payload.writeUInt8(data.length, 3); payload.writeUInt32LE(encodedId(canId, extended), 4);
  Buffer.from(data).copy(payload, 8);
  return payload;
}

function fd(channel, tx, canId, extended, dlc, data) {
  const payload = Buffer.alloc(84);
  payload.writeUInt16LE(channel, 0); payload.writeUInt8(tx ? 1 : 0, 2);
  payload.writeUInt8(dlc, 3); payload.writeUInt32LE(encodedId(canId, extended), 4);
  payload.writeUInt8(data.length, 14); Buffer.from(data).copy(payload, 20);
  return payload;
}

function fd64(channel, tx, canId, extended, dlc, data) {
  const payload = Buffer.alloc(40 + data.length);
  payload.writeUInt8(channel, 0); payload.writeUInt8(dlc, 1); payload.writeUInt8(data.length, 2);
  payload.writeUInt32LE(encodedId(canId, extended), 4); payload.writeUInt8(tx ? 1 : 0, 34);
  Buffer.from(data).copy(payload, 40);
  return payload;
}
