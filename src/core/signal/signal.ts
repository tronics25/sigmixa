import type { Timestamp } from '../frame/canFrame';

export type SignalSource =
  | { readonly type: 'manual-can'; readonly frameDefinitionId: string }
  | { readonly type: 'plugin'; readonly pluginId: string; readonly bindingId: string }
  | { readonly type: 'calculated'; readonly calculationId: string }
  | { readonly type: 'external-csv'; readonly sourceId: string; readonly column: string };

export interface SignalDefinition {
  readonly id: string;
  readonly name: string;
  readonly unit?: string;
  readonly group?: string;
  readonly source: SignalSource;
  readonly frameRef?: { readonly canId: number; readonly extended: boolean };
}

export interface SignalSample {
  readonly timestamp: Timestamp;
  readonly value: number;
  readonly quality?: 'valid' | 'invalid' | 'missing';
  readonly originalTimestamp?: { readonly value: number; readonly unit: 'seconds' | 'milliseconds' | 'microseconds' };
}

export interface SignalEvent {
  readonly timestamp: Timestamp;
  readonly endTimestamp?: Timestamp;
  readonly kind: string;
  readonly severity?: 'info' | 'warning' | 'error';
  readonly label?: string;
}

export interface SignalSeries {
  readonly definition: SignalDefinition;
  readonly samples: readonly SignalSample[];
  readonly events?: readonly SignalEvent[];
}

export function validateSignalDefinition(definition: SignalDefinition): string[] {
  const errors: string[] = [];
  if (!definition.id.trim()) errors.push('Signal ID is required.');
  if (!definition.name.trim()) errors.push('Signal name is required.');
  if (definition.frameRef) {
    const maxId = definition.frameRef.extended ? 0x1fffffff : 0x7ff;
    if (!Number.isInteger(definition.frameRef.canId) || definition.frameRef.canId < 0 || definition.frameRef.canId > maxId) {
      errors.push('Signal frame reference has an invalid CAN ID.');
    }
  }
  return errors;
}
