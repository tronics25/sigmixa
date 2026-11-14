/**
 * What one log file may take while it is read, in one place for every reader (ASC, BLF, MDF, CSV, on the main thread
 * and on worker threads). Numbers read from a file (counts, sizes, offsets, nesting) never decide alone how much is
 * allocated or how long a loop runs: a reader asks its file's budget first.
 *
 * - Limits: one piece read or expanded whole, bytes held at once, and totals for the whole file (never per call, so
 *   recursion and repetition cannot multiply them).
 * - Pauses: a long read lets other work run now and then (`pause`), so the editor stays responsive.
 * - Cancellation: `cancelled` once the file's read was cancelled; readers stop at their next check.
 */

export interface ReadLimits {
  /** Bytes of one piece read or expanded whole: a block, a container, a record or an object that spans containers. */
  readonly pieceBytes: number;
  /** Bytes held at once beyond what is read out (expanded blocks still being read, for the whole file). */
  readonly heldBytes: number;
  /** Characters of the names a file's signals may have together (about 100 MB as JS strings). */
  readonly nameCharacters: number;
}

export const READ_LIMITS: ReadLimits = {
  pieceBytes: 256 * 1024 * 1024,
  heldBytes: 1024 * 1024 * 1024,
  nameCharacters: 48_000_000,
};

/** How long a read may run before it lets other work run. */
const PAUSE_AFTER_MS = 20;

export class ReadBudget {
  private held = 0;
  private names = 0;
  private lastPause = performance.now();
  readonly limits: ReadLimits;
  constructor(readonly signal?: AbortSignal, limits?: Partial<ReadLimits>) { this.limits = { ...READ_LIMITS, ...limits }; }

  get cancelled(): boolean { return this.signal?.aborted === true; }

  /** Whether one piece of `bytes` may be read or expanded whole. */
  fitsPiece(bytes: number): boolean { return Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= this.limits.pieceBytes; }

  /** Holds `bytes` until `release`; false (nothing held) when the file would hold more than its limit at once. */
  hold(bytes: number): boolean {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || this.held + bytes > this.limits.heldBytes) return false;
    this.held += bytes; return true;
  }
  release(bytes: number): void { this.held = Math.max(0, this.held - bytes); }

  /** Takes `characters` of names from the file's total; false (nothing taken) when it would go over. */
  takeNames(characters: number): boolean {
    if (!Number.isSafeInteger(characters) || characters < 0 || this.names + characters > this.limits.nameCharacters) return false;
    this.names += characters; return true;
  }

  /** Lets other work run when the read has run for a while since the last pause. False once cancelled. */
  async pause(): Promise<boolean> {
    if (performance.now() - this.lastPause >= PAUSE_AFTER_MS) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      this.lastPause = performance.now();
    }
    return !this.cancelled;
  }
}

/**
 * The bytes a piece of a stream leaves over (the start of a record or object that continues in the next pieces),
 * gathered with the pieces after it without copying them again for each piece: they are joined once, when `need` bytes
 * are there. So a long record costs its size, not its size times the number of pieces it spans.
 */
export class ByteGather {
  private parts: Buffer[] = [];
  private size = 0;
  private need = 0;
  /** Bytes gathered so far. */
  get length(): number { return this.size; }
  /** The last byte gathered (-1 when there is none). */
  get lastByte(): number { const last = this.parts[this.parts.length - 1]; return last?.length ? last[last.length - 1] : -1; }
  /** Starts again with `rest` (copied: the buffer it is in is let go), waiting for `need` bytes in all. */
  keep(rest: Buffer, need: number): void { this.parts = rest.length ? [Buffer.from(rest)] : []; this.size = rest.length; this.need = need; }
  /** Adds the next piece: what is gathered, joined, once `need` bytes are there; otherwise undefined (wait for more). */
  add(chunk: Buffer): Buffer | undefined {
    if (!this.size) { if (chunk.length >= this.need) return chunk; this.parts = [chunk]; this.size = chunk.length; return undefined; }
    this.parts.push(chunk); this.size += chunk.length;
    if (this.size < this.need) return undefined;
    return this.take();
  }
  /** Adds the next piece, whatever is gathered. */
  append(chunk: Buffer): void { if (chunk.length) { this.parts.push(chunk); this.size += chunk.length; } }
  /** Everything gathered, joined (at the end of the stream); empties the gather. */
  take(): Buffer {
    const joined = this.parts.length === 1 ? this.parts[0] : this.parts.length ? Buffer.concat(this.parts, this.size) : Buffer.alloc(0);
    this.parts = []; this.size = 0; this.need = 0;
    return joined;
  }
}
