import type { Diagnostic } from '../../core/diagnostics/diagnostic';

export interface PluginFrameDisplay { readonly tags: readonly string[]; readonly diagnostics: readonly Diagnostic[] }

/**
 * What a Plugin showed for each frame (`name=value unit` tags and diagnostics), kept as numbers so every frame of a large
 * log can keep its tags. Tags are spelled when a frame is shown, exactly as the Plugin gave them, repeats included.
 */
export class PluginFrameTags {
  private ordinals = new Float64Array(1024); private starts = new Uint32Array(1024); private frames = 0;
  private names = new Uint32Array(1024); private values = new Float64Array(1024); private items = 0;
  private readonly nameTexts: (readonly [string, string])[] = []; private readonly nameCells: (number | undefined)[] = []; private readonly nameNumbers = new Map<string, number>();
  private readonly diagnostics = new Map<number, readonly Diagnostic[]>();
  /** Frames given out of order or without an ordinal (none from a store); kept as they are. */
  private readonly other = new Map<number | string, PluginFrameDisplay>();

  get size(): number { return this.frames + this.other.size; }

  set(frame: number | string, decoded: readonly { readonly name: string; readonly unit?: string; readonly value: number }[], diagnostics: readonly Diagnostic[]): void {
    if (!decoded.length && !diagnostics.length) return;
    if (typeof frame !== 'number' || (this.frames && frame <= this.ordinals[this.frames - 1])) {
      this.other.set(frame, { tags: decoded.map(tagText), diagnostics }); return;
    }
    if (this.frames === this.ordinals.length) { this.ordinals = grow(this.ordinals); this.starts = grow(this.starts); }
    this.ordinals[this.frames] = frame; this.starts[this.frames] = this.items; this.frames++;
    for (const item of decoded) {
      if (this.items === this.names.length) { this.names = grow(this.names); this.values = grow(this.values); }
      const key = `${item.name}\u0000${item.unit ?? ''}`;
      let number = this.nameNumbers.get(key);
      if (number === undefined) { number = this.nameTexts.length; this.nameTexts.push([`${item.name}=`, item.unit ? ` ${item.unit}` : '']); this.nameNumbers.set(key, number); }
      this.names[this.items] = number; this.values[this.items] = item.value; this.items++;
    }
    if (diagnostics.length) this.diagnostics.set(frame, diagnostics);
  }

  /** The width of a frame's tags: the sum over its tags of `cells(tag) + extra`. */
  cells(frame: number | string, cells: (text: string) => number, extra: number): number {
    const other = this.other.get(frame); if (other || typeof frame !== 'number') return other?.tags.reduce((sum, tag) => sum + cells(tag) + extra, 0) ?? 0;
    const index = this.indexOf(frame); if (index < 0) return 0;
    const end = index + 1 < this.frames ? this.starts[index + 1] : this.items; let total = 0;
    for (let item = this.starts[index]; item < end; item++) {
      const name = this.names[item]; let fixed = this.nameCells[name];
      if (fixed === undefined) { const [prefix, suffix] = this.nameTexts[name]; fixed = this.nameCells[name] = cells(prefix) + cells(suffix); }
      total += fixed + cells(String(this.values[item])) + extra;
    }
    return total;
  }

  private indexOf(frame: number): number {
    let low = 0; let high = this.frames;
    while (low < high) { const middle = (low + high) >>> 1; if (this.ordinals[middle] < frame) low = middle + 1; else high = middle; }
    return low < this.frames && this.ordinals[low] === frame ? low : -1;
  }

  get(frame: number | string): PluginFrameDisplay | undefined {
    const other = this.other.get(frame); if (other || typeof frame !== 'number') return other;
    const low = this.indexOf(frame); if (low < 0) return undefined;
    const end = low + 1 < this.frames ? this.starts[low + 1] : this.items; const tags: string[] = [];
    for (let item = this.starts[low]; item < end; item++) { const [prefix, suffix] = this.nameTexts[this.names[item]]; tags.push(`${prefix}${this.values[item]}${suffix}`); }
    return { tags, diagnostics: this.diagnostics.get(frame) ?? [] };
  }
}


function tagText(item: { readonly name: string; readonly unit?: string; readonly value: number }): string { return `${item.name}=${item.value}${item.unit ? ` ${item.unit}` : ''}`; }

function grow<A extends Float64Array | Uint32Array>(array: A): A {
  const next = new (array.constructor as new (size: number) => A)(array.length * 2); next.set(array); return next;
}
