export interface PressRepeatOptions {
  readonly delayMs?: number;
  readonly intervalMs?: number;
}

/** One pointer press performs one action; holding repeats it without duplicating the trailing click. */
export function bindPressRepeat(button: HTMLButtonElement, action: () => void, options: PressRepeatOptions = {}): void {
  const delayMs = options.delayMs ?? 360; const intervalMs = options.intervalMs ?? 120;
  let delay: number | undefined; let repeat: number | undefined; let pointerHandled = false;
  const stop = () => { if (delay !== undefined) window.clearTimeout(delay); if (repeat !== undefined) window.clearInterval(repeat); delay = undefined; repeat = undefined; };
  const run = (): boolean => { if (button.disabled) { stop(); return false; } action(); return true; };
  button.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || button.disabled) return; event.preventDefault(); pointerHandled = true; button.setPointerCapture(event.pointerId); run();
    delay = window.setTimeout(() => { if (run()) repeat = window.setInterval(run, intervalMs); }, delayMs);
  });
  button.addEventListener('pointerup', stop); button.addEventListener('pointercancel', stop); button.addEventListener('lostpointercapture', stop);
  button.addEventListener('click', (event) => { if (pointerHandled && event.detail !== 0) { pointerHandled = false; event.preventDefault(); return; } run(); });
}
