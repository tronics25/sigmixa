/**
 * Scroll bars drawn by SigMixa, matching VS Code's own (checked against VS Code 1.144 ScrollableElement):
 * - an area's scroll bar shows as soon as the pointer enters the area (0.1 s fade in), or when the area scrolls;
 * - it fades out over 0.8 s when the pointer leaves, or 0.5 s after a scroll when the pointer is not over the area;
 * - it stays while its slider is dragged; it lies over the content and takes no room; it looks the same on every OS;
 * - 14 px vertical / 12 px horizontal on editor-like grids (`data-scrollbar="editor"`), 10 px elsewhere;
 * - clicking the track moves the slider's centre there and keeps dragging; the wheel over a scroll bar scrolls its area.
 * The browser's own scroll bars are hidden. Scrolling itself is unchanged: the bars only read and set scrollTop/scrollLeft.
 *
 * `installOverlayScrollbars` is self-contained apart from the two geometry helpers below, so a page without a bundle
 * (the group definitions editor) can embed it with `overlayScrollbarScript()`.
 */

export interface SliderGeometry { readonly visible: boolean; readonly size: number; readonly position: number }

/** Slider size and offset along a track; hidden when the content fits. Like VS Code, the slider is at least 20 px. */
export function overlaySliderGeometry(trackSize: number, clientSize: number, scrollSize: number, scrollPosition: number): SliderGeometry {
  if (!(trackSize > 0) || !(scrollSize > clientSize + 0.5)) return { visible: false, size: 0, position: 0 };
  const size = Math.max(Math.min(20, trackSize), Math.floor(trackSize * clientSize / scrollSize));
  const room = trackSize - size; const maxScroll = scrollSize - clientSize;
  const position = room > 0 ? Math.round(Math.min(1, Math.max(0, scrollPosition / maxScroll)) * room) : 0;
  return { visible: true, size, position };
}

/** Scroll position that puts the slider's start at `sliderPosition` along the track. */
export function overlayScrollForSlider(trackSize: number, clientSize: number, scrollSize: number, sliderSize: number, sliderPosition: number): number {
  const room = trackSize - sliderSize; const maxScroll = Math.max(0, scrollSize - clientSize);
  return room > 0 ? Math.min(1, Math.max(0, sliderPosition / room)) * maxScroll : 0;
}

export function installOverlayScrollbars(doc: Document): void {
  const win = doc.defaultView as (Window & { __sigmixaOverlayScrollbars?: boolean }) | null;
  if (!win || win.__sigmixaOverlayScrollbars) return;
  win.__sigmixaOverlayScrollbars = true;
  if (!doc.body) { doc.addEventListener('DOMContentLoaded', () => { win.__sigmixaOverlayScrollbars = false; installOverlayScrollbars(doc); }, { once: true }); return; }

  const HIDE_DELAY = 500; const FADE_OUT = 800;
  const style = doc.createElement('style');
  style.textContent = ':root,:root *{scrollbar-width:none}:root::-webkit-scrollbar,:root ::-webkit-scrollbar{display:none}'
    + '.sm-scrollbar{position:fixed;z-index:15;box-sizing:border-box;touch-action:none;opacity:0;pointer-events:none;background:var(--vscode-scrollbar-background,transparent)}'
    + '.sm-scrollbar.visible{opacity:1;pointer-events:auto;transition:opacity .1s linear}.sm-scrollbar.invisible.fade{transition:opacity .8s linear}'
    + '.sm-scrollbar[hidden]{display:none}.sm-scrollbar>.sm-slider{position:absolute;background:var(--vscode-scrollbarSlider-background)}'
    + '.sm-scrollbar>.sm-slider:hover{background:var(--vscode-scrollbarSlider-hoverBackground)}.sm-scrollbar>.sm-slider.active{background:var(--vscode-scrollbarSlider-activeBackground)}';
  doc.head.appendChild(style);
  const layer = doc.createElement('div'); layer.className = 'sm-scrollbars'; layer.setAttribute('aria-hidden', 'true'); doc.body.appendChild(layer);

  type Axis = 'vertical' | 'horizontal';
  interface Bar { readonly axis: Axis; readonly track: HTMLDivElement; readonly slider: HTMLDivElement; trackSize: number; sliderSize: number; sliderPosition: number; needed: boolean }
  interface Area { readonly el: Element; readonly bars: Record<Axis, Bar>; over: boolean; dragging: boolean; shown: boolean; fadeUntil: number; hideTimer: number | undefined }
  const areas = new Map<Element, Area>(); const barOwner = new WeakMap<Element, Area>();
  let frame: number | undefined;

  const root = (): Element => doc.scrollingElement ?? doc.documentElement;
  const scrolls = (el: Element): boolean => {
    if (el === root()) return true;
    const css = win.getComputedStyle(el);
    return /(auto|scroll)/.test(css.overflowY) || /(auto|scroll)/.test(css.overflowX);
  };
  /** Scrolling areas the element is in, itself included, innermost first. */
  const areasAround = (start: Element | null): Element[] => {
    const found: Element[] = [];
    for (let el = start; el; el = el.parentElement) {
      const owner = barOwner.get(el);
      if (owner) return [...found, ...areasAround(owner.el)];
      if (el !== layer && scrolls(el)) found.push(el);
    }
    if (!found.includes(root())) found.push(root());
    return found;
  };

  const makeBar = (area: () => Area, axis: Axis, host: Element): Bar => {
    const track = doc.createElement('div'); track.className = `sm-scrollbar ${axis} invisible`; track.hidden = true;
    const slider = doc.createElement('div'); slider.className = 'sm-slider'; track.appendChild(slider); host.appendChild(track);
    const bar: Bar = { axis, track, slider, trackSize: 0, sliderSize: 0, sliderPosition: 0, needed: false };
    track.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || area().dragging) return; event.preventDefault(); event.stopPropagation();
      const owner = area(); const pointer = event.pointerId; const vertical = axis === 'vertical';
      const trackBox = track.getBoundingClientRect(); const along = (e: PointerEvent) => vertical ? e.clientY - trackBox.top : e.clientX - trackBox.left;
      // A click on the track moves the slider's centre to the pointer, then drags from there.
      let grab = along(event) - bar.sliderPosition;
      if (event.target !== slider) { grab = bar.sliderSize / 2; scrollTo(owner, bar, along(event) - grab); }
      track.setPointerCapture(event.pointerId); owner.dragging = true; slider.classList.add('active'); reveal(owner);
      // Only the pointer that began the drag moves or ends it.
      const move = (e: PointerEvent) => { if (e.pointerId === pointer) scrollTo(owner, bar, along(e) - grab); };
      const end = (e: PointerEvent) => {
        if (e.pointerId !== pointer) return;
        win.removeEventListener('pointermove', move, true); win.removeEventListener('pointerup', end, true); win.removeEventListener('pointercancel', end, true);
        owner.dragging = false; slider.classList.remove('active');
        // While captured, the pointer counted as over the scroll bar wherever it went: look again at what is under it.
        pointerAt(doc.elementFromPoint(e.clientX, e.clientY)); if (!owner.over) hide(owner);
      };
      // Listened for on the window, so the drag ends wherever the button is let go.
      win.addEventListener('pointermove', move, true); win.addEventListener('pointerup', end, true); win.addEventListener('pointercancel', end, true);
    });
    track.addEventListener('wheel', (event) => {
      const el = area().el; const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? (axis === 'vertical' ? el.clientHeight : el.clientWidth) : 1;
      event.preventDefault(); el.scrollBy({ left: event.deltaX * unit, top: event.deltaY * unit });
    }, { passive: false });
    return bar;
  };

  const scrollTo = (area: Area, bar: Bar, sliderPosition: number) => {
    const el = area.el;
    if (bar.axis === 'vertical') el.scrollTop = overlayScrollForSlider(bar.trackSize, el.clientHeight, el.scrollHeight, bar.sliderSize, sliderPosition);
    else el.scrollLeft = overlayScrollForSlider(bar.trackSize, el.clientWidth, el.scrollWidth, bar.sliderSize, sliderPosition);
  };

  const areaFor = (el: Element): Area => {
    let area = areas.get(el); if (area) return area;
    const self = () => area!;
    // A modal dialog sits above everything else and makes the rest inert, so bars of an area in a dialog go inside it.
    const host = el.closest('dialog') ?? layer;
    area = { el, bars: { vertical: makeBar(self, 'vertical', host), horizontal: makeBar(self, 'horizontal', host) }, over: false, dragging: false, shown: false, fadeUntil: 0, hideTimer: undefined };
    barOwner.set(area.bars.vertical.track, area); barOwner.set(area.bars.horizontal.track, area); areas.set(el, area);
    return area;
  };
  const drop = (area: Area) => { area.bars.vertical.track.remove(); area.bars.horizontal.track.remove(); if (area.hideTimer !== undefined) win.clearTimeout(area.hideTimer); areas.delete(area.el); };

  /** The visible part of an area: its inner box, cut by every clipping area around it. */
  const visibleBox = (el: Element) => {
    if (el === root()) return { left: 0, top: 0, right: doc.documentElement.clientWidth, bottom: doc.documentElement.clientHeight, box: { left: 0, top: 0, width: doc.documentElement.clientWidth, height: doc.documentElement.clientHeight } };
    const rect = el.getBoundingClientRect(); const box = { left: rect.left + el.clientLeft, top: rect.top + el.clientTop, width: el.clientWidth, height: el.clientHeight };
    let left = box.left, top = box.top, right = box.left + box.width, bottom = box.top + box.height;
    for (let parent = el.parentElement; parent && parent !== doc.documentElement; parent = parent.parentElement) {
      const css = win.getComputedStyle(parent);
      if (css.overflowX === 'visible' && css.overflowY === 'visible') continue;
      const clip = parent.getBoundingClientRect();
      left = Math.max(left, clip.left); top = Math.max(top, clip.top); right = Math.min(right, clip.right); bottom = Math.min(bottom, clip.bottom);
    }
    return { left, top, right, bottom, box };
  };

  const render = (area: Area) => {
    const el = area.el;
    if (!el.isConnected) { drop(area); return; }
    const shape = el.getClientRects().length > 0 || el === root() ? visibleBox(el) : undefined;
    const editor = el instanceof HTMLElement && el.dataset.scrollbar === 'editor';
    const vSize = editor ? 14 : 10; const hSize = editor ? 12 : 10;
    const css = el === root() ? undefined : win.getComputedStyle(el);
    const vNeeded = !!shape && css?.overflowY !== 'hidden' && el.scrollHeight > el.clientHeight + 0.5;
    const hNeeded = !!shape && css?.overflowX !== 'hidden' && el.scrollWidth > el.clientWidth + 0.5;
    const place = (bar: Bar, needed: boolean, left: number, top: number, width: number, height: number) => {
      bar.needed = needed && width > 0 && height > 0;
      bar.track.hidden = !bar.needed; if (!bar.needed || !shape) return;
      const vertical = bar.axis === 'vertical'; bar.trackSize = vertical ? height : width;
      const geometry = vertical ? overlaySliderGeometry(height, el.clientHeight, el.scrollHeight, el.scrollTop) : overlaySliderGeometry(width, el.clientWidth, el.scrollWidth, el.scrollLeft);
      bar.sliderSize = geometry.size; bar.sliderPosition = geometry.position;
      const s = bar.track.style; s.left = `${left}px`; s.top = `${top}px`; s.width = `${width}px`; s.height = `${height}px`;
      s.clipPath = `inset(${Math.max(0, shape.top - top)}px ${Math.max(0, left + width - shape.right)}px ${Math.max(0, top + height - shape.bottom)}px ${Math.max(0, shape.left - left)}px)`;
      const k = bar.slider.style;
      if (vertical) { k.left = '0'; k.width = '100%'; k.top = `${geometry.position}px`; k.height = `${geometry.size}px`; }
      else { k.top = '0'; k.height = '100%'; k.left = `${geometry.position}px`; k.width = `${geometry.size}px`; }
    };
    if (!shape) { place(area.bars.vertical, false, 0, 0, 0, 0); place(area.bars.horizontal, false, 0, 0, 0, 0); return; }
    const { box } = shape;
    place(area.bars.vertical, vNeeded, box.left + box.width - vSize, box.top, vSize, box.height - (hNeeded ? hSize : 0));
    place(area.bars.horizontal, hNeeded, box.left, box.top + box.height - hSize, box.width - (vNeeded ? vSize : 0), hSize);
  };

  const tick = () => {
    frame = undefined; const now = win.performance.now(); let active = false;
    for (const area of [...areas.values()]) if (area.shown || area.fadeUntil > now) { render(area); active = true; }
    if (active) frame = win.requestAnimationFrame(tick);
  };
  const run = () => { if (frame === undefined) frame = win.requestAnimationFrame(tick); };

  const setClass = (area: Area, visible: boolean, fade: boolean) => {
    for (const bar of [area.bars.vertical, area.bars.horizontal]) bar.track.className = `sm-scrollbar ${bar.axis} ${visible ? 'visible' : `invisible${fade ? ' fade' : ''}`}`;
  };
  const reveal = (area: Area) => {
    if (area.hideTimer !== undefined) { win.clearTimeout(area.hideTimer); area.hideTimer = undefined; }
    render(area); if (!area.shown) { area.shown = true; setClass(area, true, false); }
    run(); scheduleHide(area);
  };
  const hide = (area: Area) => {
    if (area.over || area.dragging || !area.shown) return;
    area.shown = false; area.fadeUntil = win.performance.now() + FADE_OUT; setClass(area, false, true); run();
  };
  const scheduleHide = (area: Area) => {
    if (area.over || area.dragging) return;
    if (area.hideTimer !== undefined) win.clearTimeout(area.hideTimer);
    area.hideTimer = win.setTimeout(() => { area.hideTimer = undefined; hide(area); }, HIDE_DELAY);
  };

  let hovered = new Set<Element>();
  function pointerAt(target: Element | null): void {
    for (const area of [...areas.values()]) if (!area.el.isConnected) drop(area); // areas whose element was replaced
    const next = new Set(target ? areasAround(target) : []);
    for (const el of hovered) if (!next.has(el)) { const area = areas.get(el); if (area) { area.over = false; hide(area); } }
    for (const el of next) if (!hovered.has(el)) { const area = areaFor(el); area.over = true; reveal(area); }
    hovered = next;
  }
  doc.addEventListener('mouseover', (event) => pointerAt(event.target instanceof Element ? event.target : null), true);
  doc.documentElement.addEventListener('mouseleave', () => pointerAt(null));
  doc.addEventListener('scroll', (event) => {
    const el = event.target === doc ? root() : event.target instanceof Element ? event.target : undefined;
    if (!el) return; const area = areaFor(el); reveal(area);
    // Areas that move with the page or a parent area follow along.
    for (const other of areas.values()) if (other !== area && (other.shown || other.fadeUntil > win.performance.now())) render(other);
  }, { capture: true, passive: true });
  win.addEventListener('resize', () => { for (const area of areas.values()) if (area.shown) render(area); });
}

/** Script text for a page without a bundle: `<script nonce=…>${overlayScrollbarScript()}</script>`. */
export function overlayScrollbarScript(): string {
  return `${overlaySliderGeometry.toString()}\n${overlayScrollForSlider.toString()}\n(${installOverlayScrollbars.toString()})(document);`;
}
