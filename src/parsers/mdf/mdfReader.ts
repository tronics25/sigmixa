import { closeSync, fstatSync, openSync, readSync } from 'fs';
import { createInflate, inflateSync } from 'zlib';
import { ReadBudget } from '../readBudget';

/** Metadata and bounded data reads. Addresses and sizes must fit both JS integers and this file. */
export interface MdfBlock { readonly address: number; readonly type: string; readonly size: number; readonly links: readonly number[]; readonly data: number }
/** A transposed block must be expanded whole to be put back in order. */
const MAX_TRANSPOSED = 64 * 1024 * 1024;
/** How much of a data block is read (or expanded) at a time. */
const PIECE = 256 * 1024;
/**
 * The fixed part of each block's data that the readers read (MDF 4.x): a block that is shorter is damaged, and is reported
 * as such before any field of it is read. Variable parts after it (conversion values, array dimensions, list offsets)
 * are checked where they are read.
 */
const FIXED_DATA: Readonly<Record<string, number>> = {
  '##HD': 32, '##DG': 8, '##CG': 32, '##CN': 72, '##CC': 24, '##CA': 16, '##DL': 8, '##DZ': 24, '##HL': 8, '##SI': 8,
};
export class MdfReader {
  readonly fd: number;
  readonly size: number;
  readonly unfinished: boolean;
  readonly version: number;
  private readonly cache = new Map<number, MdfBlock>();
  /** Bytes of data blocks read from the file so far (compressed ones as stored): how far reading has come. */
  dataRead = 0;
  /** What reading this file may take; transposed blocks expanded and still being read are held in it, as several data groups are read side by side. */
  constructor(filePath: string, readonly budget = new ReadBudget()) {
    this.fd = openSync(filePath, 'r');
    try {
      this.size = fstatSync(this.fd).size;
      const id = this.read(0, 64);
      this.unfinished = id.toString('ascii', 0, 8) === 'UnFinMF ';
      if (!this.unfinished && id.toString('ascii', 0, 8) !== 'MDF     ') throw new Error('Missing MDF identification block.');
      this.version = id.readUInt16LE(28);
      if (this.version < 400 || this.version > 420) throw new Error(`MDF version ${this.version} is not supported (4.00–4.20 only).`);
    } catch (error) { closeSync(this.fd); throw error; }
  }
  close(): void { closeSync(this.fd); }
  read(address: number, size: number): Buffer {
    if (!Number.isSafeInteger(address) || !Number.isSafeInteger(size) || address < 0 || !this.budget.fitsPiece(size) || address + size > this.size) throw new Error(`MDF read outside the file or size limit at ${address} (${size} bytes).`);
    const b = Buffer.allocUnsafe(size); let offset = 0;
    while (offset < size) { const n = readSync(this.fd, b, offset, size - offset, address + offset); if (!n) throw new Error(`Truncated MDF data at ${address + offset}.`); offset += n; }
    return b;
  }
  integer(b: Buffer, at: number): number {
    const value = Number(b.readBigUInt64LE(at));
    if (!Number.isSafeInteger(value)) throw new Error('MDF address or size exceeds the safe integer range.');
    return value;
  }
  block(address: number, expected?: string): MdfBlock {
    let block = this.cache.get(address);
    if (!block) {
      const h = this.read(address, 24); const type = h.toString('ascii', 0, 4);
      const size = this.integer(h, 8); const count = this.integer(h, 16);
      if (!type.startsWith('##') || count > 100_000 || size < 24 + 8 * count + (FIXED_DATA[type] ?? 0) || address + size > this.size) throw new Error(`Invalid MDF block at ${address}.`);
      const links = this.read(address + 24, count * 8);
      block = { address, type, size, links: Array.from({ length: count }, (_, i) => this.integer(links, i * 8)), data: address + 24 + count * 8 };
      if (this.cache.size >= 100_000) throw new Error('Too many MDF metadata blocks.');
      this.cache.set(address, block);
    }
    if (expected && block.type !== expected) throw new Error(`Expected ${expected} at ${address}, found ${block.type}.`);
    return block;
  }
  body(block: MdfBlock): Buffer { return this.read(block.data, block.address + block.size - block.data); }
  text(address: number): string {
    if (!address) return '';
    const block = this.block(address);
    if (block.type !== '##TX' && block.type !== '##MD') throw new Error(`Expected MDF text at ${address}.`);
    return this.body(block).toString('utf8').replace(/\0.*$/s, '').trim();
  }
  /**
   * Data lists are concatenated logically; records can span their block boundaries. Each block is read once:
   * `visited` holds every block of this stream, so a list that names a block twice (or itself) is an error.
   */
  async *data(address: number, visited = new Set<number>(), depth = 0): AsyncGenerator<Buffer> {
    const budget = this.budget;
    if (!address || budget.cancelled) return;
    if (visited.has(address)) throw new Error('An MDF data block is listed more than once.');
    if (depth > 64) throw new Error('Excessively nested MDF data list.');
    visited.add(address);
    const block = this.block(address);
    if (block.type === '##DT' || block.type === '##SD') {
      // CANedge unfinished logs leave the last DT length at its header size.
      const end = this.unfinished && block.type === '##DT' && block.size === 24 ? this.size : block.address + block.size;
      for (let at = block.data; at < end && !budget.cancelled; at += PIECE) {
        const piece = this.read(at, Math.min(PIECE, end - at)); this.dataRead += piece.length;
        yield piece;
        await budget.pause();
      }
    } else if (block.type === '##DZ') {
      const h = this.read(block.data, 24); const method = h[2]; const columns = h.readUInt32LE(4);
      const original = this.integer(h, 8); const packed = this.integer(h, 16);
      if (!budget.fitsPiece(original) || packed !== block.address + block.size - block.data - 24 || method > 1) throw new Error('Unsupported or oversized MDF compressed block.');
      if (method === 0) {
        // Expanded as it is read, a piece at a time, so a large block is never held whole.
        yield* this.inflated(block.data + 24, packed, original);
        return;
      }
      if (!columns) throw new Error('Invalid MDF transpose width.');
      if (original > MAX_TRANSPOSED) throw new Error('MDF transposed compressed block is too large.');
      if (!budget.hold(2 * original)) throw new Error('Too many large transposed MDF blocks are read at once.');
      try {
        const compressed = this.read(block.data + 24, packed); let expanded: Buffer;
        // Data that expands beyond the size the block gives, or is not zlib data, is damaged (zlib stops it at that size).
        try { expanded = inflateSync(compressed, { maxOutputLength: Math.max(1, original) }); } catch { throw new Error('MDF compressed data could not be expanded to its stated size.'); }
        this.dataRead += packed;
        if (expanded.length !== original) throw new Error('MDF decompressed size mismatch.');
        const out = Buffer.allocUnsafe(original); const rows = Math.floor(original / columns); const count = rows * columns;
        // Fewer bytes than one row: nothing is transposed.
        if (rows) for (let c = 0; c < columns; c++) for (let r = 0; r < rows; r++) out[r * columns + c] = expanded[c * rows + r];
        expanded.copy(out, count, count);
        for (let at = 0; at < out.length && !budget.cancelled; at += PIECE) {
          yield out.subarray(at, Math.min(out.length, at + PIECE));
          await budget.pause();
        }
      } finally { budget.release(2 * original); }
    } else if (block.type === '##HL') {
      yield* this.data(block.links[0], visited, depth + 1);
    } else if (block.type === '##DL') {
      // A chain of lists is followed in a loop: long chains are normal, only nesting is limited.
      for (let list = block; !budget.cancelled; ) {
        const count = this.body(list).readUInt32LE(4);
        if (count > list.links.length - 1) throw new Error('Invalid MDF data list count.');
        for (let i = 1; i <= count && !budget.cancelled; i++) yield* this.data(list.links[i], visited, depth + 1);
        if (!list.links[0]) break;
        if (visited.has(list.links[0])) throw new Error('An MDF data block is listed more than once.');
        visited.add(list.links[0]);
        list = this.block(list.links[0], '##DL');
      }
    } else throw new Error(`Unsupported MDF data block ${block.type}.`);
  }
  private async *inflated(address: number, packed: number, original: number): AsyncGenerator<Buffer> {
    const inflate = createInflate();
    const feed = (async () => {
      try {
        for (let at = 0; at < packed && !this.budget.cancelled; at += PIECE) {
          if (inflate.destroyed) return;
          // Waits for room, or for the reader to stop (the stream is then closed and never drains).
          const piece = this.read(address + at, Math.min(PIECE, packed - at)); this.dataRead += piece.length;
          if (!inflate.write(piece)) await new Promise<void>((resolve) => { inflate.once('drain', resolve); inflate.once('close', resolve); });
        }
        inflate.end();
      } catch (error) { inflate.destroy(error as Error); }
    })();
    let total = 0; let pending: Buffer[] = []; let size = 0;
    try {
      for await (const piece of inflate as AsyncIterable<Buffer>) {
        total += piece.length;
        if (total > original) throw new Error('MDF decompressed size mismatch.');
        pending.push(piece); size += piece.length;
        if (size >= PIECE) { yield Buffer.concat(pending); pending = []; size = 0; }
        if (this.budget.cancelled) return;
      }
      if (total !== original) throw new Error('MDF decompressed size mismatch.');
      if (size) yield Buffer.concat(pending);
    } finally { inflate.destroy(); await feed; }
  }
}
