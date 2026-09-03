export interface ParsedCanId {
  readonly canId: number;
  readonly extended: boolean;
}

/** Canonical UI notation: short extended IDs use x; IDs above 7FF imply extended. */
export function formatCanId(canId: number, extended: boolean): string {
  const hex = canId.toString(16).toUpperCase();
  return extended && canId <= 0x7ff ? `${hex}x` : hex;
}

export function parseCanId(text: string, base: 'hex' | 'dec' = 'hex'): ParsedCanId | undefined {
  const trimmed = text.trim();
  const explicitExtended = trimmed.toLowerCase().endsWith('x');
  let numberText = explicitExtended ? trimmed.slice(0, -1) : trimmed;
  if (base === 'hex') numberText = numberText.replace(/^0x/i, '');
  const pattern = base === 'hex' ? /^[0-9a-f]+$/i : /^\d+$/;
  if (!pattern.test(numberText)) return undefined;
  const canId = Number.parseInt(numberText, base === 'hex' ? 16 : 10);
  if (!Number.isInteger(canId) || canId < 0 || canId > 0x1fffffff) return undefined;
  return { canId, extended: explicitExtended || canId > 0x7ff };
}
