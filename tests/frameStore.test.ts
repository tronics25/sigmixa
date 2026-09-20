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
  const changed = { cacheKey: 'definitions:2', isDecoded: (item: CanFrame) => item.canId === 2 };
  assert.equal(store.query({ offset: 0, limit: 10, filter: { decoded: false } }, changed).rows[0].canId, 1);
});

test('unified keyword filtering supports VS Code-style regular expressions across individual fields', () => {
  const store = new ChunkedFrameStore(); store.append([{ ...frame(0, 0x123), data: Uint8Array.from([0xaa, 0x55]) }, frame(1, 0x1234)]);
  const context = { cacheKey: 'names:1', additionalSearchText: (item: CanFrame) => item.canId === 0x123 ? 'Vehicle Speed' : 'Engine' };
  assert.equal(store.query({ offset: 0, limit: 10, filter: { search: 'speed' } }, context).total, 1);
  assert.deepEqual(store.query({ offset: 0, limit: 10, filter: { search: '^123$', searchRegex: true } }, context).rows.map((item) => item.canId), [0x123]);
  assert.equal(store.query({ offset: 0, limit: 10, filter: { search: 'AA\\s+55', searchRegex: true } }, context).total, 1);
  assert.equal(store.query({ offset: 0, limit: 10, filter: { search: '[', searchRegex: true } }, context).total, 0);
});

test('keyword payload matching follows the visible RAW or Decoded content mode', () => {
  const store = new ChunkedFrameStore(); store.append([
    { ...frame(0, 0x123), data: Uint8Array.from([0xaa, 0x55]) },
    { ...frame(1, 0x124), data: Uint8Array.from([0xaa, 0x55]) },
  ]);
  const decodedContext = { cacheKey: 'decoded-content', additionalSearchText: (item: CanFrame) => item.canId === 0x123 ? 'Vehicle Speed' : '', isDecoded: (item: CanFrame) => item.canId === 0x123 };
  assert.deepEqual(store.query({ offset: 0, limit: 10, filter: { search: 'AA', searchContent: 'decoded' } }, decodedContext).rows.map((item) => item.canId), [0x124]);
  assert.deepEqual(store.query({ offset: 0, limit: 10, filter: { search: 'AA', searchContent: 'raw' } }, { ...decodedContext, cacheKey: 'raw-content', additionalSearchText: () => '' }).rows.map((item) => item.canId), [0x123, 0x124]);
  assert.deepEqual(store.query({ offset: 0, limit: 10, filter: { search: 'speed', searchContent: 'decoded' } }, decodedContext).rows.map((item) => item.canId), [0x123]);
});

test('representative width sample is bounded, spans time, and includes longest payload per CAN ID', () => {
  const store = new ChunkedFrameStore(); store.append(Array.from({ length: 1000 }, (_, index) => frame(index, index % 3)));
  const sample = store.representativeSample(undefined, 20);
  assert.ok(sample.length <= 20); assert.ok(sample.some((item) => item.id === 's:999'));
  for (const id of [0, 1, 2]) assert.equal(Math.max(...sample.filter((item) => item.canId === id).map((item) => item.dataLength)), 15);
});

test('adjacent Timestamp navigation snaps within the Clip range', () => {
  const store = new ChunkedFrameStore(); store.append(Array.from({ length: 8 }, (_, index) => frame(index)));
  assert.equal(store.adjacentTimestamp(100.35, -1, { start: 100.2, end: 100.6 }), 100.3);
  assert.equal(store.adjacentTimestamp(100.35, 1, { start: 100.2, end: 100.6 }), 100.4);
  assert.equal(store.adjacentTimestamp(100.2, -1, { start: 100.2, end: 100.6 }), undefined);
  assert.equal(store.adjacentTimestamp(99, 1, { start: 100.2, end: 100.6 }), 100.2);
  assert.equal(store.adjacentTimestamp(101, -1, { start: 100.2, end: 100.6 }), 100.6);
});

test('nearest Timestamp snapping keeps exact matches and respects the Clip range', () => {
  const store = new ChunkedFrameStore(); store.append(Array.from({ length: 8 }, (_, index) => frame(index)));
  assert.equal(store.nearestTimestamp(100.36), 100.4);
  assert.equal(store.nearestTimestamp(100.3), 100.3);
  assert.equal(store.nearestTimestamp(99, { start: 100.2, end: 100.6 }), 100.2);
  assert.equal(store.nearestTimestamp(101, { start: 100.2, end: 100.6 }), 100.6);
});

test('adjacent Timestamp cache stays correct after unsorted appends', () => {
  const store = new ChunkedFrameStore();
  store.append([{ ...frame(5), timestamp: 5 }, { ...frame(1), timestamp: 1 }, { ...frame(3), timestamp: 3 }]);
  assert.equal(store.adjacentTimestamp(2, 1), 3);
  store.append([{ ...frame(2), timestamp: 2 }]);
  assert.equal(store.adjacentTimestamp(1, 1), 2);
});

test('CAN-reference index pages sparse matches in original order', () => {
  const store = new ChunkedFrameStore(3);
  store.append(Array.from({ length: 50 }, (_, index) => ({ ...frame(index, index % 10), extended: index % 7 === 0 })));
  const refs = [{ canId: 3, extended: false }, { canId: 0, extended: true }];
  const expected = store.query({ offset: 0, limit: 2000, filter: { canIdRefs: refs } }).rows;
  assert.equal(store.countByCanRefs(refs), expected.length);
  assert.deepEqual(store.queryByCanRefs(refs, 1, 3).map((item) => item.id), expected.slice(1, 4).map((item) => item.id));
});
