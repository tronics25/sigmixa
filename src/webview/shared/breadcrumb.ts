/**
 * Breadcrumbs: the last step is where you are and is plain text; every step above it is a link that goes there.
 */
export const BREADCRUMB_STYLES = '.crumb-link{display:inline;padding:0;margin:0;border:0;background:none;font:inherit;color:var(--vscode-textLink-foreground);cursor:pointer}.crumb-link:hover{text-decoration:underline;color:var(--vscode-textLink-activeForeground);background:none}.crumb-link:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:2px}';

export interface Crumb { readonly label: string; readonly open?: () => void }

export function crumbLink(label: string, open: () => void): HTMLButtonElement {
  const link = document.createElement('button'); link.type = 'button'; link.className = 'crumb-link'; link.textContent = label;
  link.addEventListener('click', open); return link;
}

/** Fills `host` with the steps joined by ›; a step without `open` stays text. */
export function renderCrumbs(host: HTMLElement, crumbs: readonly Crumb[]): void {
  host.replaceChildren(...crumbs.flatMap((crumb, index) => [...(index ? [' › '] : []), crumb.open ? crumbLink(crumb.label, crumb.open) : crumb.label]));
}
