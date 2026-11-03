import type { CanFrame } from '../../core/frame/canFrame';
import { createManualDecodeContext, decodeManualDerived, decodeManualFrame, decodeManualSignals, derivedBeforeFilter } from '../../core/manual/manualDecoder';
import type { ManualFrameDefinition } from '../../core/manual/manualDefinition';
import { unpackFrame, type PackedFrames, type PackedSignals } from './packedFrames';

/**
 * What a worker decodes: the Frame definitions (one per CAN key), the Signals it may hand back (by number), and the CAN
 * keys (`e:`/`s:` + CAN ID) of frames a Plugin may process, which the main thread finishes.
 */
export interface DecodeSpec {
  readonly definitions: readonly ManualFrameDefinition[];
  readonly signalIds: readonly string[];
  readonly pluginKeys: readonly string[];
}

/** How far a worker decoded a row's frame (`PackedSignals.rowKinds`). */
export const ROW_DONE = 0;
/** Its own Signals and the derived ones before the first filter (`derivedBeforeFilter`): the rest (which may keep state from frame to frame) and Plugins are left. */
export const ROW_SIGNALS = 1;
/** Every Signal of its definition: Plugins are left. */
export const ROW_MANUAL = 2;

/** Frame definitions a worker may decode on its own: their values follow from each frame alone. */
export function decodesAlone(definition: ManualFrameDefinition): boolean {
  return !(definition.derivedSignals ?? []).some((signal) => signal.operation.type === 'filter');
}

export class ChunkDecoder {
  private readonly definitions = new Map<number, ManualFrameDefinition>();
  private readonly pluginKeys = new Set<number>();
  private readonly alone = new Map<ManualFrameDefinition, boolean>();
  private readonly signalNumbers = new Map<string, number>();
  // Filters are never decoded here (`decodesAlone`), so no state is kept between frames.
  private readonly context = createManualDecodeContext();

  constructor(spec: DecodeSpec) {
    for (const definition of spec.definitions) { this.definitions.set(key(definition.canId, definition.extended), definition); this.alone.set(definition, decodesAlone(definition)); }
    for (const text of spec.pluginKeys) this.pluginKeys.add(key(Number(text.slice(2)), text.startsWith('e')));
    spec.signalIds.forEach((id, index) => this.signalNumbers.set(id, index));
  }

  private decodeBeforeFilter(frame: CanFrame, definition: ManualFrameDefinition) {
    const signals = decodeManualSignals(frame, definition);
    if (signals.diagnostics.length) return signals;
    const derived = decodeManualDerived(frame, definition, this.context, signals.values, 0, derivedBeforeFilter(definition));
    return { decoded: [...signals.decoded, ...derived.decoded], diagnostics: derived.diagnostics };
  }

  decode(packed: PackedFrames): PackedSignals {
    const rowFrames: number[] = []; const rowStarts: number[] = [0]; const rowKinds: number[] = []; const mainFrames: number[] = [];
    let signals = new Uint32Array(Math.max(16, packed.count * 4)); let values = new Float64Array(signals.length); let labels = new Uint32Array(signals.length);
    const labelTexts: string[] = []; const labelNumbers = new Map<string, number>();
    let used = 0;
    for (let index = 0; index < packed.count; index++) {
      const frameKey = key(packed.canIds[index], (packed.flags[index] & 1) !== 0);
      const plugin = this.pluginKeys.has(frameKey); const definition = this.definitions.get(frameKey);
      if (!definition && !plugin) continue;
      const alone = !definition || this.alone.get(definition)!;
      const frame = unpackFrame(packed, index) as CanFrame;
      const result = !definition ? undefined : alone ? decodeManualFrame(frame, definition, this.context) : this.decodeBeforeFilter(frame, definition);
      // A diagnostic names the frame by its ID, which only the main thread knows: such a frame is decoded there.
      if (result?.diagnostics.length) { mainFrames.push(index); continue; }
      const kind = !alone ? ROW_SIGNALS : plugin ? ROW_MANUAL : ROW_DONE;
      const decoded = result?.decoded ?? [];
      if (!decoded.length && kind === ROW_DONE) continue;
      if (used + decoded.length > signals.length) {
        const size = Math.max(signals.length * 2, used + decoded.length);
        const grow = <T extends Uint32Array | Float64Array>(array: T): T => { const next = new (array.constructor as new (length: number) => T)(size); next.set(array); return next; };
        signals = grow(signals); values = grow(values); labels = grow(labels);
      }
      let complete = true; const start = used;
      for (const item of decoded) {
        const number = this.signalNumbers.get(item.definition.id);
        if (number === undefined || item.sample.quality !== 'valid' || !Object.is(item.sample.timestamp, frame.timestamp) || item.sample.filterEvidence !== undefined || item.sample.originalTimestamp !== undefined) { complete = false; break; }
        signals[used] = number; values[used] = item.sample.value;
        const label = item.sample.valueLabel;
        if (label === undefined) labels[used] = 0;
        else { let text = labelNumbers.get(label); if (text === undefined) { text = labelTexts.length; labelTexts.push(label); labelNumbers.set(label, text); } labels[used] = text + 1; }
        used++;
      }
      if (!complete) { used = start; mainFrames.push(index); continue; }
      rowFrames.push(index); rowStarts.push(used); rowKinds.push(kind);
    }
    return {
      rows: rowFrames.length, rowFrames: Uint32Array.from(rowFrames), rowStarts: Uint32Array.from(rowStarts), rowKinds: Uint8Array.from(rowKinds),
      signals: signals.slice(0, used), values: values.slice(0, used), labels: labels.slice(0, used), labelTexts, mainFrames: Uint32Array.from(mainFrames),
    };
  }
}

function key(canId: number, extended: boolean): number { return canId * 2 + (extended ? 1 : 0); }
