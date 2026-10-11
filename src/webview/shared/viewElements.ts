/** A view owns both its canvas and its controls, even when controls live in a shared inspector. */
export class ViewElements {
  constructor(private readonly canvasHost: HTMLElement, private readonly optionsHost?: HTMLElement, private readonly actionsHost?: HTMLElement) {}

  querySelector<K extends keyof HTMLElementTagNameMap>(selector: K): HTMLElementTagNameMap[K] | null;
  querySelector<E extends Element = Element>(selector: string): E | null;
  querySelector<E extends Element = Element>(selector: string): E | null {
    return this.canvasHost.querySelector<E>(selector) ?? this.optionsHost?.querySelector<E>(selector) ?? this.actionsHost?.querySelector<E>(selector) ?? null;
  }

  querySelectorAll<E extends Element = Element>(selector: string): E[] {
    return [...Array.from(this.canvasHost.querySelectorAll<E>(selector)), ...Array.from(this.optionsHost?.querySelectorAll<E>(selector) ?? []), ...Array.from(this.actionsHost?.querySelectorAll<E>(selector) ?? [])];
  }
}
