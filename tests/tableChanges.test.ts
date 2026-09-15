import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemorySignalStore } from '../src/core/signal/signalStore';
import type { SignalDefinition, SignalSample } from '../src/core/signal/signal';
import { signalCellChange } from '../src/core/signal/tableChanges';

const speed: SignalDefinition = { id: 'speed', name: 'Speed', unit: 'km/h', hasValueLabels: true, source: { type: 'manual-can', frameDefinitionId: 'motion' } };
const other: SignalDefinition = { ...speed, id: 'other', name: 'Other' };
function append(store: InMemorySignalStore, timestamp: number, value: number, extra: Partial<SignalSample> = {}, definition = speed): void {
  store.appendFrame(`${definition.id}:${timestamp}`, timestamp, [{ definition, sample: { timestamp, value, ...extra } }]);
}

test('Table changes compare per-Signal predecessors across pages and unrelated event rows', () => {
  const store = new InMemorySignalStore();
  append(store, 0, 0); append(store, 0.5, 70, {}, other);
  append(store, 1, 1); append(store, 2, 21); append(store, 3, 21);
  const all = store.tableDisplayPage([speed.id, other.id], 0, 100);
  assert.equal(all.rows[0].changes?.speed, undefined);
  assert.equal(all.rows[1].changes?.speed, undefined);
  assert.equal(all.rows[4].changes?.speed, undefined);
  const small = all.rows[2].changes!.speed;
  const large = all.rows[3].changes!.speed;
  assert.equal(small.kind, 'numeric'); assert.equal(large.kind, 'numeric');
  if (small.kind === 'numeric' && large.kind === 'numeric') {
    assert.ok(small.magnitude < large.magnitude);
    assert.equal(small.delta, 1); assert.equal(large.delta, 20);
  }
  assert.deepEqual(store.tableDisplayPage([speed.id, other.id], 3, 1).rows[0].changes, all.rows[3].changes);
  assert.deepEqual(store.tableDisplayPage([speed.id], 2, 1).rows[0].changes, all.rows[3].changes);
  assert.equal(store.tablePage([speed.id], 0, 10).rows[0].changes, undefined);
});

test('Clip first sample is uncolored, later pages still compare within the Clip', () => {
  const store = new InMemorySignalStore();
  append(store, 0, 0); append(store, 1, 10); append(store, 2, 20);
  const range = { start: 0.5, end: 2 };
  assert.equal(store.tableDisplayPage([speed.id], 0, 1, range).rows[0].changes?.speed, undefined);
  assert.equal(store.tableDisplayPage([speed.id], 1, 1, range).rows[0].changes?.speed.kind, 'numeric');
});

test('Labels mark discrete transitions but unlabeled measurements remain numeric', () => {
  const store = new InMemorySignalStore();
  append(store, 0, 0, { valueLabel: 'OFF' }); append(store, 1, 0, { valueLabel: 'ON' });
  append(store, 2, 0, { valueLabel: 'ON' }); append(store, 3, 10); append(store, 4, 20);
  const rows = store.tableDisplayPage([speed.id], 0, 100).rows;
  assert.deepEqual(rows[1].changes?.speed, { kind: 'state', previousLabel: 'OFF' });
  assert.equal(rows[2].changes?.speed, undefined);
  assert.equal(rows[3].changes?.speed.kind, 'state');
  assert.equal(rows[4].changes?.speed.kind, 'numeric');
});

test('Invalid values and long cadence gaps recover without exaggerated numeric coloring', () => {
  const store = new InMemorySignalStore();
  append(store, 0, 0); append(store, 1, 65535, { quality: 'invalid' }); append(store, 2, 10);
  append(store, 3, Number.NaN, { quality: 'missing' }); append(store, 4, 20);
  append(store, 5, 21); append(store, 20, 40); append(store, 21, 41); append(store, 22, 42);
  const rows = store.tableDisplayPage([speed.id], 0, 100).rows;
  for (const index of [2, 4, 6]) assert.deepEqual(rows[index].changes?.speed, { kind: 'recovery' });
  for (const index of [1, 3]) assert.equal(rows[index].changes?.speed, undefined);
  assert.equal(rows[5].changes?.speed.kind, 'numeric');
  assert.equal(rows[7].changes?.speed.kind, 'numeric');
});

test('Finalized out-of-order samples and equal timestamps retain exact predecessor identity', () => {
  const store = new InMemorySignalStore();
  append(store, 2, 20); append(store, 0, 0); append(store, 1, 1); append(store, 1, 3);
  store.finalize();
  const rows = store.tableDisplayPage([speed.id], 0, 100).rows;
  assert.deepEqual(rows.map((row) => row.timestamp), [0, 1, 1, 2]);
  const change = store.tableDisplayPage([speed.id], 2, 1).rows[0].changes!.speed;
  assert.equal(change.kind, 'numeric');
  if (change.kind === 'numeric') assert.equal(change.delta, 2);
  assert.deepEqual(change, rows[2].changes!.speed);
});

test('Numeric strength is normalized by each Signal range, with finite constant/extreme behavior', () => {
  const current = { timestamp: 1, value: 2 }; const previous = { timestamp: 0, value: 1 };
  const normal = signalCellChange(current, previous, 0, 10, Infinity);
  const scaled = signalCellChange({ ...current, value: 2000 }, { ...previous, value: 1000 }, 0, 10000, Infinity);
  assert.equal(normal?.kind, 'numeric'); assert.equal(scaled?.kind, 'numeric');
  if (normal?.kind === 'numeric' && scaled?.kind === 'numeric') assert.equal(normal.magnitude, scaled.magnitude);
  assert.equal(signalCellChange(previous, previous, 1, 1, Infinity), undefined);
  const wide = signalCellChange(current, previous, -Number.MAX_VALUE, Number.MAX_VALUE, Infinity);
  assert.equal(wide?.kind, 'numeric');
  if (wide?.kind === 'numeric') assert.ok(Number.isFinite(wide.magnitude) && wide.magnitude >= 0 && wide.magnitude <= 1);
});

test('Large-log Table presentation remains bounded and never annotates stored event rows', () => {
  const store = new InMemorySignalStore();
  for (let index = 0; index < 100_000; index++) append(store, index * 0.01, index % 100);
  const page = store.tableDisplayPage([speed.id], 90_000, 480);
  assert.equal(page.rows.length, 480);
  assert.equal(page.rows[0].changes?.speed.kind, 'numeric');
  assert.ok(JSON.stringify(page.rows.map((row) => row.changes)).length < 60_000);
  assert.equal(store.tablePage([speed.id], 90_000, 1).rows[0].changes, undefined);
});
