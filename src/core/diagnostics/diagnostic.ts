export type DiagnosticSeverity = 'info' | 'warning' | 'error';

export interface DiagnosticLocation {
  readonly sourceId: string;
  readonly line?: number;
  readonly frameId?: string;
}

export interface Diagnostic {
  readonly id: string;
  readonly source: 'parser' | 'plugin' | 'definition' | 'calculation' | 'csv' | 'storage';
  readonly code: string;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly location?: DiagnosticLocation;
  readonly details?: Readonly<Record<string, string | number | boolean>>;
}

export function createDiagnostic(input: Omit<Diagnostic, 'id'> & { readonly id?: string }): Diagnostic {
  return { ...input, id: input.id ?? `${input.source}:${input.code}:${input.location?.line ?? 'global'}` };
}
