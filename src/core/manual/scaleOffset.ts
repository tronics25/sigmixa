import type { ManualConversion } from './manualDefinition';

interface Rational { readonly numerator: bigint; readonly denominator: bigint }
interface CompiledConversion { readonly source: string; readonly offset: number; readonly lsb: number; readonly multiplier: bigint; readonly addend: bigint; readonly denominator: bigint; readonly binaryShift?: bigint; readonly offsetRatio: Rational }
const cache = new WeakMap<ManualConversion, CompiledConversion>();

/** Scale selects integer shifts or exact rational conversion; Offset is applied afterward. */
export function convertScaleOffset(raw: bigint, conversion: ManualConversion): number {
  let compiled = cache.get(conversion);
  if (!compiled || compiled.source !== conversion.lsbText || compiled.offset !== conversion.offset || compiled.lsb !== conversion.lsb) {
    const scale = parseRational(conversion.lsbText) ?? parseRational(String(conversion.lsb));
    const offset = parseRational(String(conversion.offset));
    if (!scale || !offset) return Number.NaN;
    const multiplier = scale.numerator * offset.denominator;
    const addend = offset.numerator * scale.denominator;
    const denominator = scale.denominator * offset.denominator;
    const divisor = gcd(gcd(multiplier, addend), denominator);
    const reduced = denominator / divisor;
    compiled = { source: conversion.lsbText, lsb: conversion.lsb, offset: conversion.offset, multiplier: multiplier / divisor, addend: addend / divisor, denominator: reduced,
      binaryShift: binaryScaleShift(scale), offsetRatio: offset };
    cache.set(conversion, compiled);
  }
  if (compiled.binaryShift !== undefined) {
    // Shift RAW first, then add Offset. BigInt preserves wide integers and arithmetic signed shifts.
    const shifted = compiled.binaryShift >= 0n ? raw << compiled.binaryShift : raw >> -compiled.binaryShift;
    const scaled = compiled.multiplier < 0n ? -shifted : shifted;
    if (!Number.isSafeInteger(Number(scaled))) return Number.NaN;
    const numerator = scaled * compiled.offsetRatio.denominator + compiled.offsetRatio.numerator;
    return rationalToNumber(numerator, compiled.offsetRatio.denominator);
  }
  return rationalToNumber(raw * compiled.multiplier + compiled.addend, compiled.denominator);
}

function binaryScaleShift(scale: Rational): bigint | undefined {
  const divisor = gcd(scale.numerator, scale.denominator);
  const numerator = (scale.numerator < 0n ? -scale.numerator : scale.numerator) / divisor; const denominator = scale.denominator / divisor;
  const powerOfTwo = (value: bigint) => value > 0n && (value & (value - 1n)) === 0n;
  if (denominator === 1n && powerOfTwo(numerator)) return BigInt(numerator.toString(2).length - 1);
  if (numerator === 1n && powerOfTwo(denominator)) return -BigInt(denominator.toString(2).length - 1);
  return undefined;
}

function parseRational(text: string): Rational | undefined {
  const source = text.trim(); if (source.length > 512) return undefined;
  const fraction = /^([+-]?\d+)\s*\/\s*([+-]?\d+)$/.exec(source);
  if (fraction) {
    const numerator = BigInt(fraction[1]); const denominator = BigInt(fraction[2]);
    if (denominator === 0n) return undefined;
    return denominator < 0n ? { numerator: -numerator, denominator: -denominator } : { numerator, denominator };
  }
  const decimal = /^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(source);
  if (!decimal || !`${decimal[2]}${decimal[3] ?? ''}`) return undefined;
  const exponent = Number(decimal[4] ?? 0) - (decimal[3]?.length ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 512) return undefined;
  const numerator = BigInt(`${decimal[1]}${decimal[2] || '0'}${decimal[3] ?? ''}`);
  return exponent >= 0 ? { numerator: numerator * 10n ** BigInt(exponent), denominator: 1n } : { numerator, denominator: 10n ** BigInt(-exponent) };
}

/** Correctly round the rational to binary64, including subnormals, using round-to-nearest/even. */
function rationalToNumber(numerator: bigint, denominator: bigint): number {
  if (numerator === 0n) return 0;
  const negative = numerator < 0n; const magnitude = negative ? -numerator : numerator;
  let exponent = magnitude.toString(2).length - denominator.toString(2).length;
  if (exponent >= 0 ? magnitude < (denominator << BigInt(exponent)) : (magnitude << BigInt(-exponent)) < denominator) exponent--;
  if (exponent > 1023) return negative ? -Infinity : Infinity;
  if (exponent < -1075) return 0;
  const shift = exponent < -1022 ? 1074 : 52 - exponent;
  const scaledNumerator = shift >= 0 ? magnitude << BigInt(shift) : magnitude;
  const scaledDenominator = shift >= 0 ? denominator : denominator << BigInt(-shift);
  let quotient = scaledNumerator / scaledDenominator;
  const remainder = scaledNumerator % scaledDenominator;
  if (remainder * 2n > scaledDenominator || (remainder * 2n === scaledDenominator && (quotient & 1n) !== 0n)) quotient++;
  if (quotient === 0n) return 0;
  const value = Number(quotient) * 2 ** -shift;
  return negative ? -value : value;
}

function gcd(a: bigint, b: bigint): bigint {
  let left = a < 0n ? -a : a; let right = b < 0n ? -b : b;
  while (right !== 0n) [left, right] = [right, left % right];
  return left || 1n;
}
