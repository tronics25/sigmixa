/** Stable, human-readable numeric text for exported Signal CSV files. */
export function formatCsvTimestamp(value: number): string {
  if (!Number.isFinite(value)) return '';
  if (Math.abs(value) >= 1e21) return value.toString();
  return trimDecimal(value.toFixed(9));
}

export function formatCsvSignalValue(value: number): string {
  if (!Number.isFinite(value)) return '';
  if (Number.isInteger(value)) return value.toString();
  return Number(value.toPrecision(12)).toString();
}

function trimDecimal(value: string): string {
  const trimmed = value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
  return trimmed === '-0' ? '0' : trimmed;
}
