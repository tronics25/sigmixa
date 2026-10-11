import test from 'node:test';
import assert from 'node:assert/strict';
import type { CanFrame } from '../src/core/frame/canFrame';
import { LastFrameIndex } from '../src/core/frame/lastFrameIndex';
const frame = (timestamp: number, channel = 1, direction: 'Rx' | 'Tx' = 'Rx'): CanFrame => ({ id: `${timestamp}:${channel}:${direction}`, sourceId: 'source', timestamp, channel, direction, canId: 0x123, extended: false, dlcCode: 1, dataLength: 1, data: new Uint8Array([1]) });
test('last Frame queries never use future values and separate channels and direction', () => {
  const index = new LastFrameIndex([frame(2), frame(1), frame(1.5, 2), frame(1.6, 1, 'Tx'), frame(3)]);
  const values = index.at(2.5); assert.equal(values.length, 3);
  assert.equal(values[0].frame.timestamp, 2); assert.equal(values[0].count, 2); assert.equal(values[0].age, .5); assert.equal(values[0].intervalMs, 1000);
  assert.equal(index.at(.5).length, 0); assert.equal(index.at(1).length, 1);
});
test('Clip boundaries constrain counts and previous receive times', () => {
  const index = new LastFrameIndex([frame(1), frame(2), frame(3)]);
  const values = index.at(2.5, 2, 3); assert.equal(values[0].count, 1); assert.equal(values[0].intervalMs, undefined);
  assert.equal(index.at(3, 2, 3)[0].count, 2);
});
