import test from 'node:test';
import assert from 'node:assert/strict';
import { ChunkedFrameStore } from '../src/core/frame/frameStore';
import type { CanFrame } from '../src/core/frame/canFrame';

function frame(index: number, canId = index % 4): CanFrame {
  const length = index % 16;
  return { id: `s:${index}`, sourceId: 's', timestamp: 100 + index / 10, canId, extended: false, direction: index % 2 ? 'Tx' : 'Rx', channel: 1, dlcCode: Math.min(length, 15), dataLength: length, data: new Uint8Array(length).fill(index & 0xff) };
}

test('chunked store pages and filters without exposing its backing collection', () => {
  const store = new ChunkedFrameStore(3); store.append(Array.from({ length: 20 }, (_, index) => frame(index)));
  const page = store.query({ offset: 2, limit: 3, filter: { canIds: [1] } });
  assert.equal(page.total, 5); assert.deepEqual(page.rows.map((item) => item.id), ['s:9', 's:13', 's:17']);
});

test('active filtered query cache incorporates frames appended during parsing', () => {
  const store = new ChunkedFrameStore(); store.append([frame(0, 1), frame(1, 2)]);
  assert.equal(store.query({ offset: 0, limit: 20, filter: { canIds: [1] } }).total, 1);
  store.append([frame(2, 1), frame(3, 3)]);
  assert.equal(store.query({ offset: 0, limit: 20, filter: { canIds: [1] } }).total, 2);
});

test('CAN ID reference filter distinguishes a short standard ID from its extended form', () => {
  const store = new ChunkedFrameStore();
  store.append([
    { ...frame(0, 0x123), id: 'standard' },
    { ...frame(1, 0x123), id: 'extended', extended: true },
  ]);
  assert.deepEqual(store.query({ offset: 0, limit: 10, filter: { canIdRefs: [{ canId: 0x123, extended: true }] } }).rows.map((item) => item.id), ['extended']);
});

test('query context extends search and decoded/raw filtering without adding definition knowledge to the store', () => {
  const store = new ChunkedFrameStore(); store.append([frame(0, 1), frame(1, 2)]);
  const context = { cacheKey: 'definitions:1', additionalSearchText: (item: CanFrame) => item.canId === 1 ? 'Vehicle Speed' : '', isDecoded: (item: CanFrame) => item.canId === 1 };
  assert.equal(store.query({ offset: 0, limit: 10, filter: { search: 'speed' } }, context).total, 1);
  assert.equal(store.query({ offset: 0, limit: 10, filter: { decoded: false } }, context).rows[0].canId, 2);
});

test('representative width sample is bounded, spans time, and includes longest payload per CAN ID', () => {
  const store = new ChunkedFrameStore(); store.append(Array.from({ length: 1000 }, (_, index) => frame(index, index % 3)));
  const sample = store.representativeSample(undefined, 20);
  assert.ok(sample.length <= 20); assert.ok(sample.some((item) => item.id === 's:999'));
  for (const id of [0, 1, 2]) assert.equal(Math.max(...sample.filter((item) => item.canId === id).map((item) => item.dataLength)), 15);
});
