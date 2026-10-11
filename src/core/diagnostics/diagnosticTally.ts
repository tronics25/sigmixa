import type { Diagnostic } from './diagnostic';

/** Where occurrences are located: a timestamp in seconds, or a source line. */
export type DiagnosticPositionKind = 'time' | 'line';

export interface DiagnosticGroup {
  readonly key: string;
  readonly source: Diagnostic['source'];
  readonly code: string;
  readonly severity: Diagnostic['severity'];
  readonly message: string;
  readonly definitionId?: string;
  /** Plugin (and binding) that reported it, for Plugin findings. */
  readonly owner?: string;
  /** Display label of the Frame the finding belongs to; filled in by the host. */
  readonly subject?: string;
  readonly count: number;
  readonly positionKind: DiagnosticPositionKind;
  /** First and last occurrence; undefined when the findings carry no position. */
  readonly firstPosition?: number;
  readonly lastPosition?: number;
}

const MAX_GROUPS = 5000;
export const OVERFLOW_MESSAGE = 'Further findings with the same code (messages grouped)';

/**
 * Counts diagnostics for a whole log. Identical findings (same source, code, owner, definition,
 * Signal and message) collapse into one group so a large log stays bounded in memory.
 */
export class DiagnosticTally {
  private readonly groups = new Map<string, { -readonly [K in keyof DiagnosticGroup]: DiagnosticGroup[K] }>();
  private totalCount = 0;

  constructor(readonly positionKind: DiagnosticPositionKind = 'time') {}

  get total(): number { return this.totalCount; }
  get size(): number { return this.groups.size; }

  add(position: number | undefined, diagnostics: readonly Diagnostic[]): void {
    const located = position !== undefined && Number.isFinite(position) ? position : undefined;
    for (const item of diagnostics) {
      const definitionId = typeof item.details?.definitionId === 'string' ? item.details.definitionId : undefined;
      const signalId = typeof item.details?.signalId === 'string' ? item.details.signalId : '';
      const owner = [item.details?.pluginId, item.details?.bindingId].filter((value) => value !== undefined).join('/');
      let key = [item.source, item.code, owner, definitionId ?? '', signalId, item.message].join('\u0000');
      let message = item.message;
      // Messages that embed per-frame values would otherwise create a group per frame.
      if (!this.groups.has(key) && this.groups.size >= MAX_GROUPS) { key = [item.source, item.code, owner, definitionId ?? '', '*'].join('\u0000'); message = OVERFLOW_MESSAGE; }
      const group = this.groups.get(key);
      if (group) {
        group.count++;
        if (located !== undefined) {
          group.firstPosition = group.firstPosition === undefined ? located : Math.min(group.firstPosition, located);
          group.lastPosition = group.lastPosition === undefined ? located : Math.max(group.lastPosition, located);
        }
      } else {
        this.groups.set(key, { key, source: item.source, code: item.code, severity: item.severity, message, definitionId, owner: owner || undefined, count: 1, positionKind: this.positionKind, firstPosition: located, lastPosition: located });
      }
      this.totalCount++;
    }
  }

  /** Drops the findings of re-analysed definitions before their replacement is merged in. */
  replaceDefinitions(definitionIds: ReadonlySet<string>, replacement: DiagnosticTally): void {
    for (const [key, group] of this.groups) {
      // Only manual decode findings are re-analysed by a definition delta; Plugin findings stay.
      if (group.source !== 'definition' || group.definitionId === undefined || !definitionIds.has(group.definitionId)) continue;
      this.groups.delete(key); this.totalCount -= group.count;
    }
    for (const group of replacement.snapshot()) {
      this.groups.set(group.key, { ...group }); this.totalCount += group.count;
    }
  }

  snapshot(): DiagnosticGroup[] {
    const position = (group: DiagnosticGroup) => group.firstPosition ?? Number.POSITIVE_INFINITY;
    return [...this.groups.values()].map((group) => ({ ...group })).sort((a, b) => position(a) - position(b) || a.key.localeCompare(b.key));
  }
}
