/** One visual and interaction contract for time-series, trajectory, and comparison legends. */
export const SIGNAL_LEGEND_STYLES = `
.chart-legend-group,.trajectory-legend,.legend-group{display:flex;align-items:center;min-width:0;padding:var(--sm-space-sm) var(--sm-space-md);background:var(--vscode-editor-background);border-bottom:1px solid color-mix(in srgb,var(--vscode-panel-border) 55%,transparent);font-size:var(--sm-font-small);line-height:18px}
.chart-legend-items,.trajectory-legend,.legend-items{flex-wrap:wrap;gap:var(--sm-space-xs) var(--sm-space-md)}
.chart-legend-entry,.trajectory-legend-entry,.legend-entry{display:inline-flex;flex:0 0 auto;align-items:center;gap:var(--sm-space-xs);min-width:0;max-width:100%;margin:0;padding:var(--sm-space-2xs) var(--sm-space-xs);border:0;border-radius:var(--sm-radius-md);background:transparent;color:inherit;font:inherit;font-weight:var(--sm-weight-regular);line-height:18px;text-align:left;white-space:nowrap;cursor:default;outline-offset:1px}
.chart-legend-entry:hover,.trajectory-legend-entry:hover,.legend-entry:hover{background:transparent}
.chart-legend-entry i,.trajectory-legend-entry i,.legend-entry i{width:14px;height:3px;flex:0 0 auto}
.chart-legend-entry>span,.trajectory-legend-entry>span,.legend-entry>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
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
