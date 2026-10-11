import type { CanFrame } from './canFrame';

export interface LastFrameValue { readonly frame: CanFrame; readonly count: number; readonly age: number; readonly intervalMs?: number; }

/** Indexed past-only lookup, separated by source, CAN format, channel and direction. */
export class LastFrameIndex {
  private readonly groups = new Map<string, CanFrame[]>();
  constructor(frames: Iterable<CanFrame>) {
    for (const frame of frames) {
      const key = `${frame.sourceId}:${frame.extended}:${frame.canId}:${frame.channel}:${frame.direction}`;
      const values = this.groups.get(key) ?? []; values.push(frame); this.groups.set(key, values);
    }
    for (const values of this.groups.values()) values.sort((a, b) => a.timestamp - b.timestamp);
  }
  at(timestamp: number, start = -Infinity, end = Infinity): LastFrameValue[] {
    if (!Number.isFinite(timestamp)) return [];
    const output: LastFrameValue[] = [];
    for (const frames of this.groups.values()) {
      const first = lowerBound(frames, start);
      const last = upperBound(frames, Math.min(timestamp, end)) - 1;
      if (last < first) continue;
      const frame = frames[last];
      output.push({ frame, count: last - first + 1, age: timestamp - frame.timestamp, intervalMs: last > first ? (frame.timestamp - frames[last - 1].timestamp) * 1000 : undefined });
    }
    return output;
  }
}
function lowerBound(frames: readonly CanFrame[], time: number): number { let low = 0, high = frames.length; while (low < high) { const mid = (low + high) >>> 1; if (frames[mid].timestamp < time) low = mid + 1; else high = mid; } return low; }
function upperBound(frames: readonly CanFrame[], time: number): number { let low = 0, high = frames.length; while (low < high) { const mid = (low + high) >>> 1; if (frames[mid].timestamp <= time) low = mid + 1; else high = mid; } return low; }
