import type { ClipDefinition } from './schema';

/**
 * A Clip is a time range OF a log, so it is identified by its log and its ID together, never by the ID alone.
 *
 * The files cannot keep IDs unique: copying a group's folder copies its Clips with their IDs. Told apart by the log they
 * belong to, the original and the copy are simply two Clips, each of its own log. No ID is ever changed for that, so
 * whatever holds a Clip (an open tab, a comparison, a list) keeps meaning the same Clip, and a Clip that is gone is found
 * by nobody: its ID in another log is another Clip.
 */
export interface ClipRef { readonly id: string; readonly sourcePath: string }
export function isClip(clip: ClipRef, ref: ClipRef): boolean { return clip.id === ref.id && clip.sourcePath === ref.sourcePath; }
export function findClip(clips: readonly ClipDefinition[], ref: ClipRef): ClipDefinition | undefined { return clips.find((clip) => isClip(clip, ref)); }
/** One string per Clip, for sets and keys. */
export function clipKey(ref: ClipRef): string { return `${ref.sourcePath}\n${ref.id}`; }

export interface LogMove { readonly from: string; readonly to: string }
/**
 * Where a log that a holder knew at `source` is after `moves` (of logs or of folders above them), or `source` itself.
 *
 * A move is applied once, at the time it happens, to the paths that are held at that time. It is never applied to a path
 * given later: after a log moved from A to B, a new file may be put at A, and that is another log with Clips of its own.
 */
export function movedSource(source: string, moves: readonly LogMove[]): string {
  for (const move of moves) if (source === move.from || source.startsWith(`${move.from}/`)) return move.to + source.slice(move.from.length);
  return source;
}
