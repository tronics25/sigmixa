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
  if (signedness === 'unsigned') return raw;
  const signBit = 1n << BigInt(lengthBits - 1);
  return raw & signBit ? raw - (1n << BigInt(lengthBits)) : raw;
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
