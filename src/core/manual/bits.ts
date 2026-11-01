import type { ByteOrder, SignalSignedness } from './manualDefinition';

export function extractUnsignedBits(
  data: Uint8Array,
  byteOffset: number,
  bitOffset: number,
  lengthBits: number,
  byteOrder: ByteOrder
): bigint {
  if (!Number.isInteger(byteOffset) || byteOffset < 0) throw new Error('byteOffset must be a non-negative integer.');
  if (!Number.isInteger(bitOffset) || bitOffset < 0 || bitOffset > 7) throw new Error('bitOffset must be between 0 and 7.');
  if (!Number.isInteger(lengthBits) || lengthBits < 1 || lengthBits > 64) throw new Error('lengthBits must be between 1 and 64.');
  if (byteOffset + Math.ceil((bitOffset + lengthBits) / 8) > data.length) throw new Error('Signal bit range exceeds the available payload.');
  if (byteOrder === 'little') {
    const byteCount = Math.ceil((bitOffset + lengthBits) / 8);
    let scratch = 0n;
    for (let index = byteCount - 1; index >= 0; index--) scratch = (scratch << 8n) | BigInt(data[byteOffset + index]);
    return (scratch >> BigInt(bitOffset)) & ((1n << BigInt(lengthBits)) - 1n);
  }
  let value = 0n;
  for (let index = 0; index < lengthBits; index++) {
    const sequential = bitOffset + index;
    const byte = data[byteOffset + Math.floor(sequential / 8)];
    const bit = 7 - (sequential % 8);
    value = (value << 1n) | BigInt((byte >> bit) & 1);
  }
  return value;
}

export function applySignedness(raw: bigint, lengthBits: number, signedness: SignalSignedness): bigint {
  // A Float Signal's bits are read as they are; `floatFromBits` turns them into its value.
  if (signedness !== 'signed') return raw;
  const signBit = 1n << BigInt(lengthBits - 1);
  return raw & signBit ? raw - (1n << BigInt(lengthBits)) : raw;
}

/** The value of an IEEE 754 Float Signal from its 32 or 64 bits. */
export function floatFromBits(bits: bigint, lengthBits: number): number {
  const view = new DataView(new ArrayBuffer(8));
  if (lengthBits === 32) { view.setUint32(0, Number(bits & 0xffffffffn)); return view.getFloat32(0); }
  view.setBigUint64(0, BigInt.asUintN(64, bits)); return view.getFloat64(0);
}

export function extractBits(
  data: Uint8Array,
  byteOffset: number,
  bitOffset: number,
  lengthBits: number,
  byteOrder: ByteOrder,
  signedness: SignalSignedness
): bigint {
  return applySignedness(extractUnsignedBits(data, byteOffset, bitOffset, lengthBits, byteOrder), lengthBits, signedness);
}

/**
 * `extractBits` as a plain number when the field and its bit offset fit in six bytes (almost every CAN Signal), which
 * avoids BigInt work for each frame; wider fields come back as a bigint. Float Signals use `extractBits`.
 */
export function extractRaw(
  data: Uint8Array,
  byteOffset: number,
  bitOffset: number,
  lengthBits: number,
  byteOrder: ByteOrder,
  signedness: SignalSignedness
): bigint | number {
  const span = bitOffset + lengthBits;
  if (signedness === 'float' || span > 48 || !Number.isInteger(byteOffset) || byteOffset < 0 || !Number.isInteger(bitOffset) || bitOffset < 0 || bitOffset > 7 || !Number.isInteger(lengthBits) || lengthBits < 1
    || byteOffset + Math.ceil(span / 8) > data.length) return extractBits(data, byteOffset, bitOffset, lengthBits, byteOrder, signedness);
  const byteCount = Math.ceil(span / 8); let bytes = 0;
  // Up to 48 bits: exact in a double.
  if (byteOrder === 'little') for (let index = byteCount - 1; index >= 0; index--) bytes = bytes * 256 + data[byteOffset + index];
  else for (let index = 0; index < byteCount; index++) bytes = bytes * 256 + data[byteOffset + index];
  const below = byteOrder === 'little' ? bitOffset : byteCount * 8 - span;
  const value = Math.floor(bytes / 2 ** below) % 2 ** lengthBits;
  return signedness === 'signed' && value >= 2 ** (lengthBits - 1) ? value - 2 ** lengthBits : value;
}
