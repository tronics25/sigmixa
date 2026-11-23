import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemorySignalStore } from '../src/core/signal/signalStore';
import type { SignalDefinition } from '../src/core/signal/signal';
import { dropoutLimit, dropouts, estimateSendMode } from '../src/core/timing/sendingPattern';

const signal: SignalDefinition = { id: 'frame-a:value', name: 'Value', source: { type: 'manual-can', frameDefinitionId: 'frame-a' } };
/** Deterministic noise in [-1, 1). */
const noise = (index: number) => ((index * 7919 + 13) % 1000) / 500 - 1;
const list = (times: readonly number[]) => ({ length: times.length, at: (index: number) => times[index] });
const sorted = (times: number[]) => times.sort((a, b) => a - b);
/** Every `cycle` s for `count` cycles, each time moved by up to `jitter` s, leaving out the cycles `skip` names. */
const periodic = (cycle: number, count: number, jitter = 0, skip?: (index: number) => boolean) => Array.from({ length: count }, (_, index) => index).filter((index) => !skip?.(index)).map((index) => index * cycle + jitter * noise(index));
/** Events at irregular times over `span` s (intervals of every length), each sent `repeat` times 10 ms apart. */
const events = (count: number, span: number, repeat = 1) => {
  const intervals = Array.from({ length: count }, (_, index) => 1.04 ** ((index * 37) % 120)); const scale = span / intervals.reduce((sum, value) => sum + value, 0);
  let time = 0; return intervals.flatMap((interval) => { time += interval * scale; return Array.from({ length: repeat }, (_, at) => time + at * 0.01); });
};
const gapsOf = (times: readonly number[], frameBreaks?: ConstructorParameters<typeof InMemorySignalStore>[0]) => {
  const store = new InMemorySignalStore(frameBreaks); store.registerDefinitions([signal]);
  store.appendSeries(signal, times.map((timestamp, index) => ({ timestamp, value: index % 7, quality: 'valid' as const })));
  return store.seriesSlice([signal.id], undefined, 50_000_000)[0].gaps;
};

test('the send mode is estimated from the receive times: periodic, periodic + events, or on events', () => {
  const plain = estimateSendMode(list(periodic(0.1, 600, 0.02)));
  assert.equal(plain?.mode, 'periodic', 'jitter of ±20 ms on 100 ms'); assert.ok(Math.abs(plain!.cycle! - 0.1) < 0.01);
  const mixed = estimateSendMode(list(sorted([...periodic(0.1, 600, 0.005), ...events(60, 60)])));
  assert.equal(mixed?.mode, 'mixed', 'events between the cycle frames'); assert.ok(Math.abs(mixed!.cycle! - 0.1) < 0.01);
  assert.equal(estimateSendMode(list(events(300, 600)))?.mode, 'event');
  assert.equal(estimateSendMode(list(events(100, 600, 3)))?.mode, 'event', 'an event sent three times in quick succession');
  assert.equal(estimateSendMode(list(periodic(0.01, 20_000, 0.001)))?.mode, 'periodic', 'many frames: only runs of them are read');
  assert.equal(estimateSendMode(list([0, 0.1, 0.2])), undefined, 'too few frames to tell');
  assert.equal(dropoutLimit('event', 0.1), Infinity); assert.ok(Math.abs(dropoutLimit('periodic', 0.1) - 0.16) < 1e-12);
  assert.deepEqual([...dropouts(list([0, 0.1, 0.2, 0.5, 0.6]), 0.16).starts], [0.2]);
});

test('a line breaks where a cycle is missing, never between events, and not at events between cycle frames', () => {
  assert.equal(gapsOf(periodic(0.01, 2000, 0, (index) => index === 1000)).length, 1, 'one lost frame of a periodic Signal');
  assert.deepEqual(gapsOf(events(300, 600)), [], 'a Signal sent on events is one line, however long it waits');
  const withEvents = sorted([...periodic(0.1, 600, 0.005, (index) => index >= 300 && index < 310), ...events(60, 60)].filter((time) => time < 30 || time > 31));
  const gaps = gapsOf(withEvents);
  assert.equal(gaps.length, 1, 'periodic + events: only the second without its cycle frames'); assert.ok(gaps[0].startTimestamp < 30 && gaps[0].endTimestamp > 31);
  // The rate changes during the log (10 ms, then 100 ms): neither part is cut.
  assert.deepEqual(gapsOf([...periodic(0.01, 1000), ...periodic(0.1, 1000).map((time) => time + 10)]), []);
});

test('a Signal of a frame breaks where its frame was not received: a multiplexed Signal, in every 8th frame, too', () => {
  // The frame every 10 ms, not received from 5 s to 6 s; the Signal is in every 8th frame (multiplexer value 0).
  const frame = periodic(0.01, 1000).filter((time) => time < 5 || time > 6);
  const multiplexed = frame.filter((_, index) => index % 8 === 0);
  const frameBreaks = () => ({ limit: Infinity, ...dropouts(list(frame), 0.016) });
  const gaps = gapsOf(multiplexed, { frameBreaks });
  assert.equal(gaps.length, 1); assert.ok(gaps[0].startTimestamp < 5 && gaps[0].endTimestamp > 6);
  assert.equal(gapsOf(multiplexed.filter((time) => time < 5 || time > 6), { frameBreaks: () => ({ limit: Infinity }) }).length, 0, 'a frame sent on events gives no breaks');
});

test('a cycle with an event right after each cycle frame is still found, and its dropouts with it', () => {
  // A frame every 100 ms and an event 30 ms after each: the times between neighbours are 30 and 70 ms, never 100 ms.
  const times = sorted([...periodic(0.1, 600), ...periodic(0.1, 600).map((time) => time + 0.03)]);
  const estimate = estimateSendMode(list(times)); assert.equal(estimate?.mode, 'mixed'); assert.ok(Math.abs(estimate!.cycle! - 0.1) < 0.005);
  assert.equal(gapsOf(times.filter((time) => time < 20 || time > 21)).length, 1, 'a second without frames');
});

test('frames sent in bursts at irregular times are sent on events; a cycle with a regular extra send is periodic + events', () => {
  // Bursts of 12 frames 10 ms apart, one at an irregular time every few seconds.
  const bursts = events(40, 200).flatMap((start) => Array.from({ length: 12 }, (_, index) => start + index * 0.01));
  assert.equal(estimateSendMode(list(bursts))?.mode, 'event'); assert.deepEqual(gapsOf(bursts), []);
  // A frame every 100 ms and an extra one 20 ms after each.
  const extra = sorted([...periodic(0.1, 600), ...periodic(0.1, 600).map((time) => time + 0.02)]);
  assert.equal(estimateSendMode(list(extra))?.mode, 'mixed'); assert.equal(gapsOf(extra.filter((time) => time < 20 || time > 21)).length, 1);
});
