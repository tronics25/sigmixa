import { strict as assert } from 'node:assert';
import type { CanFrame } from '../../src/core/frame/canFrame';
import type { MdfSignalSeries } from '../../src/parsers/mdf/parseMdf';

type Point = readonly [number, number, number | number[] | null];

/** What scripts/asammdf-reference.py writes for one file: each channel's sample count and a few samples (index, time, value). */
export interface AsammdfEntry {
  readonly file: string;
  readonly error?: string;
  readonly groups?: readonly { readonly channels: readonly { readonly name: string; readonly count?: number; readonly unit?: string; readonly error?: string; readonly master?: boolean; readonly points?: readonly Point[] }[] }[];
}

/** Bus logging channels and each group's time are no measured signals. */
const notSignal = (channel: { readonly name: string; readonly master?: boolean }) => channel.master === true || channel.name.startsWith('CAN_');

/**
 * Checks what SigMixa read from a file against what asammdf read: every measured signal asammdf gives (count, sampled
 * times and values), and the CAN frames (how many, and each sampled ID and payload at its time), in time order.
 */
export function assertMatchesAsammdf(entry: AsammdfEntry, frames: readonly CanFrame[], signals: readonly MdfSignalSeries[], label = entry.file): void {
  const byName = new Map<string, MdfSignalSeries[]>();
  for (const item of signals) byName.set(item.channel, [...byName.get(item.channel) ?? [], item]);
  const at = new Map<string, CanFrame>();
  for (const frame of frames) at.set(`${Math.round(frame.timestamp * 1e6)}:${frame.canId}`, frame);
  let expected = 0;
  for (const group of entry.groups ?? []) for (const channel of group.channels) {
    if (channel.error || channel.count === undefined) continue;
    if (channel.name === 'CAN_DataFrame' || channel.name === 'CAN_RemoteFrame') { expected += channel.count; continue; }
    const bus = /^CAN_(DataFrame|RemoteFrame)\.ID$/.exec(channel.name);
    if (bus) {
      for (const [index, time, id] of channel.points ?? []) {
        const frame = at.get(`${Math.round(time * 1e6)}:${id}`);
        assert.ok(frame, `${label}: CAN ID ${id} at ${time}`);
        // The payload asammdf gives at the same index, as many bytes as the frame holds.
        const bytes = group.channels.find((item) => item.name === `CAN_${bus[1]}.DataBytes`)?.points?.find(([other]) => other === index)?.[2];
        if (Array.isArray(bytes)) assert.deepEqual(Array.from(frame!.data), bytes.slice(0, frame!.data.length), `${label}: payload of ${id} at ${time}`);
      }
      continue;
    }
    if (notSignal(channel)) continue;
    // A signal of that name with as many samples (names repeat across channel groups).
    const series = (byName.get(channel.name) ?? []).find((item) => item.times.length === channel.count);
    if (!series) continue;
    for (const [index, time, value] of channel.points ?? []) {
      assert.ok(Math.abs(series.times[index] - time) < 1e-9, `${label}: ${channel.name} time at ${index}: ${series.times[index]} vs ${time}`);
      if (typeof value === 'number') assert.ok(Math.abs(series.values[index] - value) <= 1e-6 * Math.max(1, Math.abs(value)), `${label}: ${channel.name} value at ${index}: ${series.values[index]} vs ${value}`);
    }
  }
  assert.equal(frames.length, expected, `${label}: CAN frames`);
  for (let i = 1; i < frames.length; i++) assert.ok(frames[i].timestamp >= frames[i - 1].timestamp, `${label}: time order at ${i}`);
}

/** The measured signals asammdf gives that SigMixa did not read (by name and sample count). */
export function missingSignals(entry: AsammdfEntry, signals: readonly MdfSignalSeries[]): string[] {
  const missing: string[] = [];
  for (const group of entry.groups ?? []) for (const channel of group.channels) {
    if (channel.error || channel.count === undefined || notSignal(channel)) continue;
    // A structure or array is read as its members, each a signal of its own.
    if (signals.some((item) => (item.parent?.label === channel.name || item.channel.startsWith(`${channel.name}[`)) && item.times.length === channel.count)) continue;
    if (!signals.some((item) => item.channel === channel.name && item.times.length === channel.count)) missing.push(`${channel.name} (${channel.count})`);
  }
  return missing;
}
