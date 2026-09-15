import { occupiedBits, type ManualSignalDefinition } from '../../core/manual/manualDefinition';
import { SIGNAL_COLOR_PRESETS } from '../shared/signalSelector';

/** Identity, not display order, determines the default color. Imported DBC IDs work identically. */
export function definitionSignalColor(id: string): string {
  let hash = 0; for (const char of id) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return SIGNAL_COLOR_PRESETS[Math.abs(hash) % SIGNAL_COLOR_PRESETS.length];
}

export function signalBitEndpoints(signal: ManualSignalDefinition): { start?: number; msb?: number; lsb?: number } {
  if (!Number.isInteger(signal.lengthBits) || signal.lengthBits < 1 || signal.lengthBits > 64 || !Number.isInteger(signal.bitOffset) || signal.bitOffset < 0 || signal.bitOffset > 7 || !Number.isInteger(signal.byteOffset) || signal.byteOffset < 0 || signal.byteOffset > 63) return {};
  const bits = occupiedBits(signal);
  return { start: bits[0], msb: signal.byteOrder === 'big' ? bits[0] : bits.at(-1), lsb: signal.byteOrder === 'little' ? bits[0] : bits.at(-1) };
}

export function definitionControlKey(signalId: string, column: string, control: number): string {
  return JSON.stringify([signalId, column, control]);
}
