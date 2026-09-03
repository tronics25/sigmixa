export const MIN_RESOLUTION = 1e-15;
export const MAX_RESOLUTION = 1e15;

export interface ParsedResolution {
  readonly value: number;
  readonly text: string;
  readonly fraction?: { readonly numerator: number; readonly denominator: number };
}

export type ResolutionParseResult =
  | { readonly valid: true; readonly resolution: ParsedResolution }
  | { readonly valid: false; readonly error: string };

function gcd(a: number, b: number): number {
  let left = Math.abs(a); let right = Math.abs(b);
  while (right) [left, right] = [right, left % right];
  return left || 1;
}

export function parseResolution(text: string): ResolutionParseResult {
  const normalized = text.trim();
  if (!normalized) return { valid: false, error: 'Resolution is required.' };
  const fraction = /^([+\-]?\d+)\s*\/\s*([+\-]?\d+)$/.exec(normalized);
  let value: number;
  let ratio: ParsedResolution['fraction'];
  if (fraction) {
    const numerator = Number(fraction[1]);
    const denominator = Number(fraction[2]);
    if (denominator === 0) return { valid: false, error: 'Resolution denominator must not be zero.' };
    value = numerator / denominator;
    ratio = { numerator, denominator };
  } else {
    value = Number(normalized);
  }
  if (!Number.isFinite(value)) return { valid: false, error: 'Resolution must be finite.' };
  if (value <= 0) return { valid: false, error: 'Resolution must be greater than zero.' };
  if (value < MIN_RESOLUTION || value > MAX_RESOLUTION) return { valid: false, error: `Resolution must be between ${MIN_RESOLUTION} and ${MAX_RESOLUTION}.` };
  return { valid: true, resolution: { value, text: normalized, ...(ratio ? { fraction: ratio } : {}) } };
}

export function resolutionStepFactor(text: string): 2 | 10 {
  const parsed = parseResolution(text);
  if (!parsed.valid) return 10;
  const power = Math.log2(parsed.resolution.value);
  return Math.abs(power - Math.round(power)) < 1e-12 ? 2 : 10;
}

export function adjustResolution(text: string, direction: 'increase' | 'decrease'): ResolutionParseResult {
  const parsed = parseResolution(text);
  if (!parsed.valid) return parsed;
  const factor = resolutionStepFactor(text);
  const fraction = parsed.resolution.fraction;
  if (fraction) {
    let numerator = fraction.numerator;
    let denominator = fraction.denominator;
    if (direction === 'increase') numerator *= factor;
    else denominator *= factor;
    const divisor = gcd(numerator, denominator);
    numerator /= divisor; denominator /= divisor;
    return parseResolution(`${numerator}/${denominator}`);
  }
  const value = direction === 'increase' ? parsed.resolution.value * factor : parsed.resolution.value / factor;
  return parseResolution(String(value));
}
