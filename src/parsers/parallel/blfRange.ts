import * as zlib from 'zlib';
import type { Diagnostic } from '../../core/diagnostics/diagnostic';
import { findObjectOffset, LOG_CONTAINER, parseBlfObjects, readBaseObjectHeader } from '../blf/parseBlf';
import { FramePacker, type PackedFrames } from './packedFrames';

/**
 * Something `parseBlfBuffer` reports, recorded in a worker with the number of frames read before it, so the main
 * thread reports it in order and numbers it as `parseBlfBuffer` does. `shifted`: `offset` is inside the first
 * container of a piece read without what the container before it left, so the length of that is still to be added.
 */
export interface BlfEvent {
  readonly frames: number;
  readonly code: string; readonly severity: Diagnostic['severity']; readonly message: string;
  readonly offset?: number; readonly details?: Diagnostic['details'];
  readonly shifted?: boolean;
}

export interface BlfRangeResult {
  readonly frames: PackedFrames;
  readonly events: readonly BlfEvent[];
  /** What the last container left for the next one. */
  readonly tail: Uint8Array;
  /**
   * When the piece was read without what came before it: where reading started in the first container whose objects
   * were read (`anchorPrefix`: its bytes before that point), and `anchorEvents` events were reported before it. The
   * main thread checks that the bytes left before the piece, followed by `anchorPrefix`, end exactly there.
   */
  readonly anchorPrefix?: Uint8Array;
  readonly anchorEvents?: number;
  /** The piece could not be read without what came before it; it must be read again with `tail`. */
  readonly unsure: boolean;
}

/**
 * Reads the top-level BLF objects at `objects` (offsets into `buffer`, which starts at `fileOffset` in the file) as
 * `parseBlfBuffer` reads them. `tail`: what the container before them left; undefined when unknown, and then the
 * first container is read from the first place where its objects line up (see `anchorPrefix`).
 */
export function parseBlfRange(buffer: Buffer, fileOffset: number, objects: ArrayLike<number>, startTimestamp: number, tail: Uint8Array | undefined): BlfRangeResult {
  const packer = new FramePacker(); const events: BlfEvent[] = [];
  let known = tail !== undefined; let rest: Buffer = tail ? Buffer.from(tail.buffer, tail.byteOffset, tail.byteLength) : Buffer.alloc(0);
  let anchorPrefix: Uint8Array | undefined; let anchorEvents: number | undefined; let unsure = false;
  let shifted = false;
  const report = (code: string, severity: Diagnostic['severity'], message: string, offset?: number, details?: Diagnostic['details']) => {
    events.push({ frames: packer.size, code, severity, message, ...(offset === undefined ? {} : { offset }), ...(details ? { details } : {}), ...(shifted ? { shifted } : {}) });
  };
  const fileReport = (code: string, severity: Diagnostic['severity'], message: string, offset: number, details?: Diagnostic['details']) => report(code, severity, message, fileOffset + offset, details);
  const append = (frame: Parameters<FramePacker['push']>[0]) => packer.push(frame);
  for (let index = 0; index < objects.length && !unsure; index++) {
    const offset = objects[index];
    const header = readBaseObjectHeader(buffer, offset)!;
    if (header.objectType === LOG_CONTAINER) {
      const containerOffset = offset + header.headerSize;
      if (containerOffset + 16 > offset + header.objectSize) { fileReport('BLF_CONTAINER_HEADER', 'error', 'A LogContainer header is truncated.', offset); continue; }
      const method = buffer.readUInt16LE(containerOffset);
      const expectedSize = buffer.readUInt32LE(containerOffset + 8);
      const compressed = buffer.subarray(containerOffset + 16, offset + header.objectSize);
      try {
        let contents: Buffer;
        if (method === 0) contents = compressed;
        else if (method === 2) contents = zlib.inflateSync(compressed);
        else {
          fileReport('BLF_COMPRESSION_UNSUPPORTED', 'warning', `LogContainer compression method ${method} is not supported.`, offset, { compressionMethod: method });
          contents = Buffer.alloc(0);
          // What is left before an empty container would be read again by itself: leave that to the main thread's order.
          if (!known) { unsure = true; break; }
        }
        if (expectedSize && contents.length !== expectedSize) {
          fileReport('BLF_CONTAINER_SIZE', 'warning', 'The expanded LogContainer size differs from the declared size.', offset, { expectedSize, actualSize: contents.length });
        }
        if (known) {
          const combined = rest.length ? Buffer.concat([rest, contents]) : contents;
          rest = parseBlfObjects(combined, startTimestamp, undefined, report, append).rest;
        } else {
          const start = firstAlignedObject(contents);
          if (start < 0 || packer.size) { unsure = true; break; }
          anchorPrefix = Uint8Array.from(contents.subarray(0, start)); anchorEvents = events.length; known = true;
          // Offsets reported for this container count from `start`; the main thread adds what came before.
          shifted = true;
          const result = parseBlfObjects(contents.subarray(start), startTimestamp, undefined, (code, severity, message, at, details) => report(code, severity, message, at === undefined ? undefined : at + start, details), append);
          shifted = false; rest = result.rest;
        }
      } catch (error) {
        fileReport('BLF_CONTAINER_DECOMPRESSION', 'error', `LogContainer decompression failed: ${(error as Error).message}`, offset);
      }
    } else {
      parseBlfObjects(buffer.subarray(offset, offset + header.objectSize), startTimestamp, undefined, report, append);
    }
  }
  return { frames: packer.finish(), events, tail: Uint8Array.from(rest), ...(anchorPrefix ? { anchorPrefix, anchorEvents } : {}), unsure };
}

/** The first offset in `contents` from which a chain of valid objects runs to its end, or -1. */
function firstAlignedObject(contents: Buffer): number {
  const limit = Math.min(contents.length - 16, 1 << 16);
  for (let start = contents.indexOf('LOBJ', 0, 'ascii'); start >= 0 && start <= limit; start = contents.indexOf('LOBJ', start + 1, 'ascii')) {
    if (chainHolds(contents, start)) return start;
  }
  return contents.length < 16 ? 0 : -1;
}

function chainHolds(contents: Buffer, start: number): boolean {
  let offset = start;
  for (;;) {
    if (offset + 16 > contents.length) return true;
    const next = findObjectOffset(contents, offset);
    if (next === undefined) return contents.length - offset <= 7;
    const header = readBaseObjectHeader(contents, next);
    if (!header) return false;
    if (next + header.objectSize > contents.length) return true;
    offset = next + header.objectSize;
  }
}
