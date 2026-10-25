/** Readable tick step for a raw interval: mantissa 1/2/5/10 times a power of ten, kept as integers so ticks can be built decimal-exact. */
export interface TickStep { readonly mantissa: number; readonly exponent: number; readonly size: number }

export function tickStep(raw: number, limits: readonly [number, number, number]): TickStep | undefined {
  const exponent = Math.floor(Math.log10(raw));
  if (!Number.isFinite(exponent)) return undefined;
  const fraction = raw / 10 ** exponent;
  const mantissa = fraction <= limits[0] ? 1 : fraction <= limits[1] ? 2 : fraction <= limits[2] ? 5 : 10;
  return { mantissa, exponent, size: tickValue(1, { mantissa, exponent }) };
}

/** multiple × step without float accumulation: 3 × 0.2 is 0.6, not 0.6000000000000001. */
export function tickValue(multiple: number, step: Pick<TickStep, 'mantissa' | 'exponent'>): number {
  const product = multiple * step.mantissa;
  // Parsing "<integer>e<exponent>" rounds once, exactly like a decimal literal, for every exponent; BigInt keeps the integer exact past 2^53.
  const digits = Number.isSafeInteger(product) ? String(product) : Number.isInteger(multiple) ? (BigInt(multiple) * BigInt(step.mantissa)).toString() : undefined;
  const value = digits === undefined ? product * 10 ** step.exponent : Number(`${digits}e${step.exponent}`);
  return value === 0 ? 0 : value;
}
