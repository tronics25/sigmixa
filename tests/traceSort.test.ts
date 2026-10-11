import test from 'node:test';
import assert from 'node:assert/strict';
import { compareTraceRows } from '../src/webview/raw/traceSort';
import type { LastFrameDto, TraceSort } from '../src/extension/editors/rawLogProtocol';
const row = (id: number, name: string, count: number, extra: Partial<LastFrameDto> = {}): LastFrameDto => ({ key: `s:${id}:1:Rx`, count, signals: [], row: { id: String(id), canId: id.toString(16), canIdValue: id, extended: false, name, channel: 1, direction: 'Rx', time: count, dlc: 0, length: 0, rawContent: '', decodedContent: '', decoded: false, diagnostics: [] }, ...extra });
const sorted = (items: LastFrameDto[], sort: TraceSort, descending = false, pins: string[] = []) => items.slice().sort((a, b) => compareTraceRows(a, b, sort, descending, new Set(pins), (item) => item.row.rawContent));

test('trace sorts CAN IDs and counts numerically and frame names independently', () => {
  const items = [row(0x20, 'Alpha', 2), row(0x3, 'Zulu', 10)];
  assert.deepEqual(sorted(items, 'canId').map(x => x.row.canIdValue), [3, 32]);
  assert.deepEqual(sorted(items, 'canId', true).map(x => x.row.canIdValue), [32, 3]);
  assert.deepEqual(sorted(items, 'name').map(x => x.row.name), ['Alpha', 'Zulu']);
  assert.deepEqual(sorted(items, 'name', true).map(x => x.row.name), ['Zulu', 'Alpha']);
  assert.deepEqual(sorted(items, 'count').map(x => x.count), [2, 10]);
  assert.deepEqual(sorted(items, 'count', true).map(x => x.count), [10, 2]);
});
test('pins keep every MUX branch above unpinned rows, regardless of direction', () => {
  const items = [row(1, 'A', 100), row(2, 'B', 1, { multiplexer: { name: 'mode', value: 0 } }), row(2, 'B', 2, { multiplexer: { name: 'mode', value: 1 } })];
  for (const descending of [false, true]) assert.deepEqual(sorted(items, 'count', descending, ['s:2']).map(x => x.row.canIdValue), [2, 2, 1]);
});
test('unreceived/unavailable values stay last and deviations sort by their unrounded value', () => {
  const items = [row(1, 'A', 1, { deviationMs: .0002 }), row(2, 'B', 1, { deviationMs: -.0002 }), row(3, 'C', 0)];
  assert.deepEqual(sorted(items, 'deviation').map(x => x.row.canIdValue), [2, 1, 3]);
  assert.deepEqual(sorted(items, 'deviation', true).map(x => x.row.canIdValue), [1, 2, 3]);
  assert.equal(sorted(items, 'receivedAt', true).at(-1)?.count, 0);
});
