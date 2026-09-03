import type { ManualDerivedSignalDefinition, ManualFrameDefinition, ManualSignalDefinition } from '../manual/manualDefinition';
import { formatCanId, parseCanId } from '../frame/canId';

export const CURRENT_PROJECT_SCHEMA_VERSION = 2 as const;

export type FrameDefinitionStub = ManualFrameDefinition;

export interface PluginRegistration {
  readonly id: string;
  readonly version: string;
  readonly source: string;
  readonly enabled: boolean;
  readonly config?: unknown;
  readonly configSchemaVersion?: string;
}

export type PluginRegistrationStub = PluginRegistration;

export interface PluginBinding {
  readonly id: string;
  readonly pluginId: string;
  readonly frameId: string;
  readonly enabled: boolean;
  readonly automatic: boolean;
}

export interface ExternalCsvValueColumn {
  readonly column: string;
  readonly name: string;
  readonly unit?: string;
}

export interface ExternalCsvSourceDefinition {
  readonly id: string;
  readonly path: string;
  readonly fileName: string;
  readonly timestampColumn: string;
  readonly timestampUnit: 'seconds' | 'milliseconds' | 'microseconds';
  readonly valueColumns: readonly ExternalCsvValueColumn[];
}

export interface LookupTableDefinition {
  readonly id: string;
  readonly name: string;
  readonly points: readonly { readonly input: number; readonly output: number }[];
  readonly outOfRange: 'clamp' | 'error';
}

export type CalculationOperation =
  | { readonly type: 'expression'; readonly expression: string }
  | { readonly type: 'lookup'; readonly tableId: string; readonly input: string };

export interface CalculationDefinition {
  readonly id: string;
  readonly name: string;
  readonly unit?: string;
  readonly enabled: boolean;
  readonly inputs: Readonly<Record<string, string>>;
  readonly timestampSignalId: string;
  readonly interpolation: 'exact' | 'linear';
  readonly operation: CalculationOperation;
}

export interface SigMixaProjectV1 {
  readonly schemaVersion: typeof CURRENT_PROJECT_SCHEMA_VERSION;
  readonly frames: readonly ManualFrameDefinition[];
  readonly plugins: readonly PluginRegistration[];
  readonly pluginBindings: readonly PluginBinding[];
  readonly externalCsvSources: readonly ExternalCsvSourceDefinition[];
  readonly lookupTables: readonly LookupTableDefinition[];
  readonly calculations: readonly CalculationDefinition[];
  readonly viewStates: Readonly<Record<string, unknown>>;
}

export type SigMixaProject = SigMixaProjectV1;

export function emptyProject(): SigMixaProject {
  return { schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION, frames: [], plugins: [], pluginBindings: [], externalCsvSources: [], lookupTables: [], calculations: [], viewStates: {} };
}

/** Converts the runtime model into the source-neutral on-disk representation. */
export function serializeProject(project: SigMixaProject): unknown {
  return {
    ...project,
    schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION,
    frames: project.frames.map(({ canId, extended, ...frame }) => ({ ...frame, canId: formatCanId(canId, extended) })),
  };
}

/** Unregisters an External CSV source without touching its file or unrelated project definitions. */
export function removeExternalCsvSource(project: SigMixaProject, sourceId: string): SigMixaProject {
  return { ...project, externalCsvSources: project.externalCsvSources.filter((source) => source.id !== sourceId) };
}

/** Removes one imported value Signal. The source registration disappears when its last value column is removed. */
export function removeExternalCsvSignal(project: SigMixaProject, sourceId: string, column: string): SigMixaProject {
  return {
    ...project,
    externalCsvSources: project.externalCsvSources.flatMap((source) => {
      if (source.id !== sourceId) return [source];
      const valueColumns = source.valueColumns.filter((value) => value.column !== column);
      return valueColumns.length ? [{ ...source, valueColumns }] : [];
    }),
  };
}

export function upsertCalculation(project: SigMixaProject, calculation: CalculationDefinition): SigMixaProject {
  return { ...project, calculations: [...project.calculations.filter((item) => item.id !== calculation.id), calculation] };
}

export function removeCalculation(project: SigMixaProject, calculationId: string): SigMixaProject {
  return { ...project, calculations: project.calculations.filter((item) => item.id !== calculationId) };
}

export function migrateProject(value: unknown): SigMixaProject {
  if (!value || typeof value !== 'object') throw new Error('Project file must contain a JSON object.');
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== 1 && candidate.schemaVersion !== CURRENT_PROJECT_SCHEMA_VERSION) {
    throw new Error(`Unsupported project schema version: ${String(candidate.schemaVersion)}`);
  }
  const frames = Array.isArray(candidate.frames) ? candidate.frames.map(coerceFrame) : [];
  return {
    schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION,
    frames,
    plugins: Array.isArray(candidate.plugins) ? candidate.plugins.map(coercePlugin) : [],
    pluginBindings: Array.isArray(candidate.pluginBindings) ? candidate.pluginBindings.map(coerceBinding) : [],
    externalCsvSources: Array.isArray(candidate.externalCsvSources) ? candidate.externalCsvSources.map(coerceExternalSource) : [],
    lookupTables: Array.isArray(candidate.lookupTables) ? candidate.lookupTables.map(coerceLookupTable) : [],
    calculations: Array.isArray(candidate.calculations) ? candidate.calculations.map(coerceCalculation) : [],
    viewStates: candidate.viewStates && typeof candidate.viewStates === 'object' ? candidate.viewStates as Readonly<Record<string, unknown>> : {},
  };
}

/** Parses persisted JSON separately so callers can preserve corrupt source bytes before recovery. */
export function parseProjectJson(text: string): SigMixaProject {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch (error) { throw new Error(`Project JSON is invalid: ${(error as Error).message}`); }
  return migrateProject(value);
}

function coerceExternalSource(value: unknown): ExternalCsvSourceDefinition {
  const source = record(value);
  return {
    id: String(source.id ?? ''), path: String(source.path ?? ''), fileName: String(source.fileName ?? ''),
    timestampColumn: String(source.timestampColumn ?? ''),
    timestampUnit: source.timestampUnit === 'milliseconds' || source.timestampUnit === 'microseconds' ? source.timestampUnit : 'seconds',
    valueColumns: Array.isArray(source.valueColumns) ? source.valueColumns.map((item) => {
      const column = record(item); return { column: String(column.column ?? ''), name: String(column.name ?? column.column ?? ''), unit: column.unit === undefined ? undefined : String(column.unit) };
    }) : [],
  };
}

function coerceLookupTable(value: unknown): LookupTableDefinition {
  const table = record(value);
  return {
    id: String(table.id ?? ''), name: String(table.name ?? ''), outOfRange: table.outOfRange === 'error' ? 'error' : 'clamp',
    points: Array.isArray(table.points) ? table.points.map((item) => { const point = record(item); return { input: Number(point.input), output: Number(point.output) }; }) : [],
  };
}

function coerceCalculation(value: unknown): CalculationDefinition {
  const calculation = record(value); const operationValue = record(calculation.operation);
  const operation: CalculationOperation = operationValue.type === 'lookup'
    ? { type: 'lookup', tableId: String(operationValue.tableId ?? ''), input: String(operationValue.input ?? '') }
    : { type: 'expression', expression: String(operationValue.expression ?? '') };
  const inputsValue = record(calculation.inputs);
  return {
    id: String(calculation.id ?? ''), name: String(calculation.name ?? ''), unit: calculation.unit === undefined ? undefined : String(calculation.unit),
    enabled: calculation.enabled !== false,
    inputs: Object.fromEntries(Object.entries(inputsValue).map(([key, input]) => [key, String(input)])),
    timestampSignalId: String(calculation.timestampSignalId ?? ''),
    interpolation: calculation.interpolation === 'linear' ? 'linear' : 'exact',
    operation,
  };
}

function coercePlugin(value: unknown): PluginRegistration {
  const plugin = record(value);
  return { id: String(plugin.id ?? ''), version: String(plugin.version ?? ''), source: String(plugin.source ?? ''), enabled: plugin.enabled !== false, config: plugin.config, configSchemaVersion: plugin.configSchemaVersion === undefined ? undefined : String(plugin.configSchemaVersion) };
}

function coerceBinding(value: unknown): PluginBinding {
  const binding = record(value);
  return { id: String(binding.id ?? ''), pluginId: String(binding.pluginId ?? ''), frameId: String(binding.frameId ?? ''), enabled: binding.enabled !== false, automatic: binding.automatic === true };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function coerceSignal(value: unknown): ManualSignalDefinition {
  const signal = record(value);
  const conversionValue = record(signal.conversion);
  const isScaleOffset = conversionValue.type === 'scale-offset';
  const conversion = isScaleOffset
    ? { type: 'scale-offset' as const, lsb: Number(conversionValue.lsb), lsbText: String(conversionValue.lsbText ?? conversionValue.lsb ?? ''), offset: Number(conversionValue.offset ?? 0) }
    : { type: 'scale-offset' as const, lsb: 1, lsbText: '1', offset: 0 };
  return {
    id: String(signal.id ?? ''),
    name: String(signal.name ?? ''),
    unit: String(signal.unit ?? ''),
    byteOffset: Number(signal.byteOffset ?? 0),
    bitOffset: Number(signal.bitOffset ?? 0),
    lengthBits: Number(signal.lengthBits ?? 8),
    signedness: signal.signedness === 'signed' ? 'signed' : 'unsigned',
    byteOrder: signal.byteOrder === 'big' ? 'big' : 'little',
    conversion,
  };
}

function coerceDerivedSignal(value: unknown): ManualDerivedSignalDefinition {
  const signal = record(value);
  const operationValue = record(signal.operation);
  let operation: ManualDerivedSignalDefinition['operation'];
  if (operationValue.type === 'lookup') {
    operation = {
      type: 'lookup', input: String(operationValue.input ?? ''), outOfRange: operationValue.outOfRange === 'error' ? 'error' : 'clamp',
      points: Array.isArray(operationValue.points) ? operationValue.points.map((item) => { const point = record(item); return { input: Number(point.input), output: Number(point.output) }; }) : [],
    };
  } else if (operationValue.type === 'filter') {
    operation = { type: 'filter', input: String(operationValue.input ?? ''), filter: operationValue.filter === 'moving-average' ? 'moving-average' : 'low-pass', timeSeconds: Number(operationValue.timeSeconds ?? 1) };
  } else {
    operation = { type: 'expression', expression: String(operationValue.expression ?? signal.expression ?? '') };
  }
  return { id: String(signal.id ?? ''), name: String(signal.name ?? ''), unit: String(signal.unit ?? ''), operation };
}

function coerceFrame(value: unknown): ManualFrameDefinition {
  const frame = record(value);
  const parsedCanId = typeof frame.canId === 'string' ? parseCanId(frame.canId) : undefined;
  const originValue = record(frame.origin);
  const origin = originValue.type === 'plugin'
    ? { type: 'plugin' as const, pluginId: String(originValue.pluginId ?? '') }
    : { type: 'manual' as const };
  return {
    id: String(frame.id ?? ''),
    canId: parsedCanId?.canId ?? Number(frame.canId),
    extended: parsedCanId?.extended ?? frame.extended === true,
    name: String(frame.name ?? ''),
    frameLength: Number(frame.frameLength ?? 8),
    signals: Array.isArray(frame.signals) ? frame.signals.map(coerceSignal) : [],
    derivedSignals: Array.isArray(frame.derivedSignals) ? frame.derivedSignals.map(coerceDerivedSignal) : [],
    origin,
  };
}
