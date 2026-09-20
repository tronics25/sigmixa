import test from 'node:test';
import assert from 'node:assert/strict';
import { ChunkedFrameStore } from '../src/core/frame/frameStore';
import { InMemorySignalStore } from '../src/core/signal/signalStore';
import { createManualDecodeContext, decodeManualFrame } from '../src/core/manual/manualDecoder';
import { signalDefinitionFor, type ManualFrameDefinition } from '../src/core/manual/manualDefinition';
import type { CanFrame } from '../src/core/frame/canFrame';

function definition(id: string, canId: number, scale: number): ManualFrameDefinition {
  return { id, canId, extended: false, name: id, frameLength: 2, signals: [{
    id: `${id}-value`, name: 'Value', unit: '', byteOffset: 0, bitOffset: 0, lengthBits: 16,
    signedness: 'unsigned', byteOrder: 'little', conversion: { type: 'scale-offset', lsb: scale, lsbText: String(scale), offset: 0 },
  }], derivedSignals: [] };
}

function decode(store: InMemorySignalStore, frames: readonly CanFrame[], definitions: readonly ManualFrameDefinition[]): void {
  const byId = new Map(definitions.map((item) => [item.canId, item])); const contexts = new Map<string, ReturnType<typeof createManualDecodeContext>>();
  store.registerDefinitions(definitions.flatMap((frame) => frame.signals.map((signal) => signalDefinitionFor(frame, signal))));
  for (const frame of frames) {
    const target = byId.get(frame.canId); if (!target) continue;
    let context = contexts.get(target.id); if (!context) { context = createManualDecodeContext(); contexts.set(target.id, context); }
    store.appendFrame(frame.id, frame.timestamp, decodeManualFrame(frame, target, context).decoded);
  }
  store.finalize();
}

test('indexed differential decoding matches a full rebuild while touching only the changed CAN ID', () => {
  const frameStore = new ChunkedFrameStore(); const frames: CanFrame[] = [];
  for (let index = 0; index < 20_000; index++) {
    const canId = index % 20 === 0 ? 0x123 : 0x456;
    frames.push({ id: `f:${index}`, sourceId: 'f', timestamp: index / 1000, canId, extended: false, direction: 'Rx', channel: 1, dlcCode: 2, dataLength: 2, data: Uint8Array.of(index & 0xff, index >>> 8 & 0xff) });
  }
  frameStore.append(frames);
  const beforeA = definition('a', 0x123, 1); const afterA = definition('a', 0x123, 0.5); const stableB = definition('b', 0x456, 2);
  const incremental = new InMemorySignalStore(); decode(incremental, frames, [beforeA, stableB]);
  const affected = frameStore.queryByCanRefs([{ canId: 0x123, extended: false }], 0, frameStore.size);
  assert.equal(affected.length, 1000);
  const replacement = new InMemorySignalStore(); decode(replacement, affected, [afterA]);
  incremental.replaceDefinitions((item) => item.source.type === 'manual-can' && item.source.frameDefinitionId === 'a', replacement);
  const rebuilt = new InMemorySignalStore(); decode(rebuilt, frames, [afterA, stableB]);
  for (const id of ['a-value', 'b-value']) {
    assert.deepEqual(incremental.seriesSlice([id], undefined, 50_000), rebuilt.seriesSlice([id], undefined, 50_000));
  }
  assert.equal(incremental.tablePage(['a-value', 'b-value'], 0, 50_000).total, rebuilt.tablePage(['a-value', 'b-value'], 0, 50_000).total);
});
