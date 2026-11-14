import type { Diagnostic } from '../../core/diagnostics/diagnostic';
import { memoCells, tagTextCells, TAG_SPACING, textCells } from '../../core/frame/widestText';

export interface PluginFrameDisplay { readonly tags: readonly string[]; readonly diagnostics: readonly Diagnostic[] }

/** A Plugin value of a frame, with the name and unit it came with. */
export interface PluginFrameValue { readonly definition: { readonly name: string; readonly unit?: string }; readonly value: number }

/**
 * What a Plugin showed for each frame: `name=value unit` tags, spelled when a frame is shown from the values the Signal
 * store keeps for the frame (`stored`: each with the name and unit it came with, in the order the Plugins gave them,
 * repeats included), and the Plugins' diagnostics, kept here.
 */
export class PluginFrameTags {
  private readonly diagnostics = new Map<number, readonly Diagnostic[]>();
  /** Frames named by text rather than by their place in the frame store (small stores, such as in tests): kept as they are. */
  private readonly other = new Map<string, PluginFrameDisplay>();

  constructor(private readonly stored: (frame: number) => readonly PluginFrameValue[]) {}

  set(frame: number | string, decoded: readonly { readonly name: string; readonly unit?: string; readonly value: number }[], diagnostics: readonly Diagnostic[]): void {
    if (!decoded.length && !diagnostics.length) return;
    if (typeof frame !== 'number') { this.other.set(frame, { tags: decoded.map(tagText), diagnostics }); return; }
    if (diagnostics.length) this.diagnostics.set(frame, diagnostics);
  }

  /** The width of a frame's tags in cells, each with the spacing the RAW log puts around it (see `tagTextCells`). */
  cells(frame: number | string): number {
    if (typeof frame !== 'number') return this.other.get(frame)?.tags.reduce((sum, tag) => sum + textCells(tag) + TAG_SPACING, 0) ?? 0;
    let total = 0;
    for (const item of this.stored(frame)) { const name = nameCells(item.definition); total += tagTextCells(name.name, name.unit, valueCells(item.value)) + TAG_SPACING; }
    return total;
  }

  get(frame: number | string): PluginFrameDisplay | undefined {
    if (typeof frame !== 'number') return this.other.get(frame);
    const tags = this.stored(frame).map((item) => tagText({ name: item.definition.name, unit: item.definition.unit, value: item.value }));
    const diagnostics = this.diagnostics.get(frame);
    return tags.length || diagnostics ? { tags, diagnostics: diagnostics ?? [] } : undefined;
  }
}

const valueCells = memoCells(String);
const names = new WeakMap<PluginFrameValue['definition'], { readonly name: number; readonly unit?: number }>();
/** The cells of a Plugin Signal's name and unit, counted once per definition. */
function nameCells(definition: PluginFrameValue['definition']): { readonly name: number; readonly unit?: number } {
  let cells = names.get(definition);
  if (!cells) { cells = { name: textCells(definition.name), ...(definition.unit ? { unit: textCells(definition.unit) } : {}) }; names.set(definition, cells); }
  return cells;
}

function tagText(item: { readonly name: string; readonly unit?: string; readonly value: number }): string { return `${item.name}=${item.value}${item.unit ? ` ${item.unit}` : ''}`; }
