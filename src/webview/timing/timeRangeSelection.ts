import type { ToExtensionMessage, ToWebviewMessage } from '../../extension/editors/rawLogProtocol';
import { isTextEditing } from '../shared/keyboard';
import type { TimelineController } from '../shared/timelineController';

/** A press becomes a drag once the pointer has moved this far, as on a graph. */
const DRAG_THRESHOLD = 6;

/**
 * Selecting a time range on a view with a time axis, as on a graph: drag to select, click to clear, Escape to clear. The
 * range belongs to the whole log (the timeline), so every view shows it; when the drag ends it is moved onto CAN
 * Timestamps, as a graph's is.
 */
export class TimeRangeSelection {
  private anchor?: { time: number; clientX: number };
  private dragged = false;
  private counter = 0;
  private request = 0;
  /** True from a drag's end until the click that follows it. */
  private clickFollowsDrag = false;

  /** `timeAt` gives the time at a pointer position: undefined outside the plot, or, with `clamp`, the nearest time of the plot. */
  constructor(canvas: HTMLCanvasElement, private readonly timeline: TimelineController, private readonly source: string, private readonly timeAt: (clientX: number, clamp: boolean) => number | undefined, private readonly post: (message: ToExtensionMessage) => void, private readonly active: () => boolean, signal: AbortSignal) {
    canvas.addEventListener('mousedown', (event) => { if (event.button !== 0) return; const time = this.timeAt(event.clientX, false); if (time === undefined) return; this.anchor = { time, clientX: event.clientX }; this.dragged = false; event.preventDefault(); }, { signal });
    window.addEventListener('mousemove', (event) => {
      if (!this.anchor) return; if (!this.dragged && Math.abs(event.clientX - this.anchor.clientX) <= DRAG_THRESHOLD) return;
      const time = this.timeAt(event.clientX, true); if (time === undefined) return; this.dragged = true; this.request = 0;
      this.timeline.setRange({ start: Math.min(this.anchor.time, time), end: Math.max(this.anchor.time, time) }, this.source); this.timeline.set(time, this.source);
    }, { signal });
    window.addEventListener('mouseup', () => {
      const anchor = this.anchor; if (!anchor) return; this.anchor = undefined; const range = this.timeline.range;
      if (this.dragged) { this.clickFollowsDrag = true; if (range && range.end > range.start) { this.request = ++this.counter; this.post({ type: 'snapTimeRangeRequest', requestId: this.request, startTimestamp: range.start, endTimestamp: range.end }); } }
    }, { signal });
    // A click on the plot clears the selected range; the click that ends a drag does not.
    canvas.addEventListener('click', (event) => { if (this.clickFollowsDrag) { this.clickFollowsDrag = false; return; } if (this.timeline.range && this.timeAt(event.clientX, false) !== undefined) this.timeline.setRange(undefined, this.source); }, { signal });
    window.addEventListener('keydown', (event) => { if (event.key !== 'Escape' || event.defaultPrevented || !this.active() || !this.timeline.range || isTextEditing(event.target)) return; this.anchor = undefined; this.timeline.setRange(undefined, this.source); }, { signal });
  }

  get dragging(): boolean { return !!this.anchor && this.dragged; }

  /** Takes the answer to the request made when a drag ended; true when the message was that answer. */
  handle(message: ToWebviewMessage): boolean {
    if (message.type !== 'timeRangeAdjusted') return false; if (message.requestId !== this.request) return true;
    this.request = 0; this.timeline.setRange({ start: message.startTimestamp, end: message.endTimestamp }, this.source); return true;
  }
}
