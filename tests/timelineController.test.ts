import test from 'node:test';
import assert from 'node:assert/strict';
import { TimelineController, SEEK_STEPS, seekTimestamp } from '../src/webview/shared/timelineController';

test('trace position, hover, and selected range remain independent', () => {
  const timeline = new TimelineController(); timeline.setBounds({ start: 10, end: 20 });
  timeline.setPosition(12, 'trace'); timeline.set(18, 'graph'); timeline.setRange({ start: 13, end: 15 }, 'graph');
  assert.equal(timeline.position, 12); assert.equal(timeline.timestamp, 18);
  timeline.setPosition(14, 'trace'); assert.equal(timeline.timestamp, 18);
  timeline.set(undefined, 'other'); assert.equal(timeline.timestamp, 18);
  timeline.set(undefined, 'graph'); assert.equal(timeline.timestamp, undefined); assert.equal(timeline.position, 14);
  assert.deepEqual(timeline.range, { start: 13, end: 15 });
});

test('seek reaches exact fractional and nonzero endpoints without rounding past the last sample', () => {
  for (const range of [{ start: 12.345678901, end: 89.987654321 }, { start: -10.1, end: -0.000001 }, { start: 1e9 + .1, end: 1e9 + .2 }, { start: 3.7, end: 3.7 }]) {
    assert.equal(seekTimestamp(0, range), range.start);
    assert.equal(seekTimestamp(SEEK_STEPS, range), range.end);
    const middle = seekTimestamp(SEEK_STEPS / 2, range); assert.ok(middle >= range.start && middle <= range.end);
  }
});

test('trace clamps to source bounds, preserves position on append, and handles empty data', () => {
  const timeline = new TimelineController(); const seen: (number | undefined)[] = [];
  timeline.subscribePosition((position) => seen.push(position));
  timeline.setBounds({ start: 10.1, end: 20.2 }); assert.equal(timeline.position, 10.1);
  timeline.setPosition(999, 'trace'); assert.equal(timeline.position, 20.2);
  timeline.setBounds({ start: 10.1, end: 30.3 }); assert.equal(timeline.position, 20.2);
  timeline.setBounds(undefined); assert.equal(timeline.position, undefined);
  assert.deepEqual(seen, [10.1, 20.2, 20.2, undefined]);
});

test('hiding trace markers preserves playback position, hover and range', () => {
  const timeline = new TimelineController(); timeline.setBounds({ start: 0, end: 10 });
  timeline.setPosition(3, 'trace'); timeline.set(7, 'graph'); timeline.setRange({ start: 2, end: 5 }, 'graph');
  let redraws = 0; let positionUpdates = 0;
  const unsubscribe = timeline.subscribePositionVisibility(() => redraws++);
  timeline.subscribePosition(() => positionUpdates++);
  timeline.setPositionVisible(false);
  assert.equal(timeline.positionVisible, false); assert.equal(timeline.position, 3);
  assert.equal(timeline.timestamp, 7); assert.deepEqual(timeline.range, { start: 2, end: 5 });
  assert.equal(positionUpdates, 0);
  timeline.setPosition(4, 'trace'); assert.equal(timeline.position, 4); assert.equal(timeline.positionVisible, false);
  timeline.setPositionVisible(true); timeline.setPositionVisible(true); assert.equal(redraws, 2);
  unsubscribe(); timeline.setPositionVisible(false); assert.equal(redraws, 2);
});

test('every graph shares one visible time span; a change is told to the others once', () => {
  const timeline = new TimelineController(); const seen: Array<[unknown, string]> = [];
  timeline.subscribeViewRange((range, source) => seen.push([range, source]));
  assert.equal(timeline.viewRange, undefined, 'everything is shown at first');
  timeline.setViewRange({ start: 10, end: 20 }, 'graph-a'); timeline.setViewRange({ start: 10, end: 20 }, 'graph-b');
  assert.deepEqual(seen, [[{ start: 10, end: 20 }, 'graph-a']], 'the same span again is not a change');
  timeline.setViewRange({ start: 5, end: 5 }, 'graph-a'); assert.deepEqual(timeline.viewRange, { start: 10, end: 20 }, 'an empty span is ignored');
  timeline.setViewRange(undefined, 'graph-b'); assert.equal(timeline.viewRange, undefined); assert.equal(seen.length, 2);
  // The selected range and the trace position are separate from the visible span.
  timeline.setRange({ start: 1, end: 2 }, 'graph-a'); assert.equal(timeline.viewRange, undefined);
});
