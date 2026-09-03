import test from 'node:test';
import assert from 'node:assert/strict';
import type { ManualFrameDefinition } from '../src/core/manual/manualDefinition';
import { buildManualSignalTree, selectionState, toggleGroup } from '../src/core/signal/signalTree';
import { SIGNAL_COLOR_PRESETS } from '../src/webview/shared/signalSelector';

const frame: ManualFrameDefinition = { id: 'f', canId: 0x123, extended: false, name: 'Frame', frameLength: 8, signals: [
  { id: 'a', name: 'A', unit: '', byteOffset: 0, bitOffset: 0, lengthBits: 8, signedness: 'unsigned', byteOrder: 'little', conversion: { type: 'scale-offset', lsb: 1, lsbText: '1', offset: 0 } },
  { id: 'b', name: 'B', unit: '', byteOffset: 1, bitOffset: 0, lengthBits: 8, signedness: 'unsigned', byteOrder: 'little', conversion: { type: 'scale-offset', lsb: 1, lsbText: '1', offset: 0 } },
] };

test('Signal Selector foundation exposes hierarchy, tri-state, and visible-only parent toggles', () => {
  const group = buildManualSignalTree([frame])[0]; assert.equal(group.children.length, 2); assert.equal(selectionState(group, new Set()), 'none'); assert.equal(selectionState(group, new Set(['a'])), 'some');
  const selected = toggleGroup(group, new Set<string>(), new Set(['b'])); assert.deepEqual([...selected], ['b']); assert.equal(selectionState(group, new Set(['a','b'])), 'all');
});

test('Signal color picker exposes the curated 16-color palette', () => {
  assert.equal(SIGNAL_COLOR_PRESETS.length, 16);
  assert.equal(new Set(SIGNAL_COLOR_PRESETS).size, 16);
  assert.ok(SIGNAL_COLOR_PRESETS.every((color) => /^#[0-9a-f]{6}$/.test(color)));
});
