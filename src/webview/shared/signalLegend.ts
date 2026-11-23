import { t } from './i18n';

/** One visual and interaction contract for time-series, trajectory, and comparison legends. */
export const SIGNAL_LEGEND_STYLES = `
.chart-legend-group,.trajectory-legend,.legend-group{display:flex;align-items:center;min-width:0;padding:var(--sm-space-sm) var(--sm-space-md);background:var(--vscode-editor-background);border-bottom:1px solid color-mix(in srgb,var(--vscode-panel-border) 55%,transparent);font-size:var(--sm-font-small);line-height:18px}
.chart-legend-items,.trajectory-legend,.legend-items{flex-wrap:wrap;gap:var(--sm-space-xs) var(--sm-space-md)}
.chart-legend-entry,.trajectory-legend-entry,.legend-entry{display:inline-flex;flex:0 0 auto;align-items:center;gap:var(--sm-space-xs);min-width:0;max-width:100%;margin:0;padding:var(--sm-space-2xs) var(--sm-space-xs);border:0;border-radius:var(--sm-radius-md);background:transparent;color:inherit;font:inherit;font-weight:var(--sm-weight-regular);line-height:18px;text-align:left;white-space:nowrap;cursor:default;outline-offset:1px}
.chart-legend-entry:hover,.trajectory-legend-entry:hover,.legend-entry:hover{background:transparent}
.chart-legend-entry i,.trajectory-legend-entry i,.legend-entry i{width:14px;height:3px;flex:0 0 auto}
.chart-legend-entry>span,.trajectory-legend-entry>span,.legend-entry>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.signal-warning{flex:0 0 auto;color:var(--vscode-editorWarning-foreground);cursor:default}
.chart-legend-entry:focus-visible,.trajectory-legend-entry:focus-visible,.legend-entry:focus-visible{outline:1px solid var(--vscode-focusBorder)}
`;

export function createLegendEntry(label: string, color: string, highlight: (active: boolean) => void): HTMLButtonElement {
  const entry = document.createElement('button'); entry.type = 'button';
  const swatch = document.createElement('i'); swatch.style.backgroundColor = color; swatch.setAttribute('aria-hidden', 'true');
  const name = document.createElement('span'); name.textContent = label; entry.append(swatch, name);
  entry.addEventListener('mouseenter', () => highlight(true));
  entry.addEventListener('mouseleave', () => highlight(entry.matches(':focus-visible')));
  entry.addEventListener('focus', () => { if (entry.matches(':focus-visible')) highlight(true); });
  entry.addEventListener('blur', () => { if (!entry.matches(':hover')) highlight(false); });
  return entry;
}

/** The warning icon shown next to a Signal that has no data here; hovering it tells why. */
export function signalWarningIcon(reason: string = t('Not in this log', 'このログにはありません')): HTMLSpanElement {
  const icon = document.createElement('span'); icon.className = 'codicon codicon-warning signal-warning';
  icon.title = reason; icon.setAttribute('role', 'img'); icon.setAttribute('aria-label', reason);
  return icon;
}

/** Adds or removes the warning icon of a legend entry or Signal row. */
export function markUnmeasured(entry: HTMLElement, unmeasured: boolean, reason?: string): void {
  entry.querySelector(':scope>.signal-warning')?.remove();
  if (unmeasured) entry.appendChild(signalWarningIcon(reason));
}
