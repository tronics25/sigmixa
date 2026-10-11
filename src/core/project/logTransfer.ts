import { posix } from 'path';
import { levelOf, locationLevel, type WorkspaceLog } from './folderLevels';

/** What can be done with a log dropped on (or sent to) a group or folder. */
export type TransferMode = 'link' | 'move' | 'copy';

/** Why a transfer is not carried out. Nothing is changed when one of these applies. */
export type TransferRefusal = 'not-found' | 'link-cannot-move' | 'same-folder' | 'already-in-group' | 'target-exists';

export interface TransferItem {
  /** Where the file is: workspace-relative with '/', or absolute when it is outside the workspace. */
  readonly located: string;
  /** The item is a log added to a group (a reference), not the file where it is. */
  readonly listed: boolean;
  readonly exists: boolean;
}

const isOutside = (located: string) => posix.isAbsolute(located) || /^[A-Za-z]:[\\/]/.test(located);
const folderOf = (located: string) => { const folder = posix.dirname(located); return folder === '.' ? '' : folder; };

/**
 * The one rule for moving, copying or adding a log to `destination` (a workspace-relative folder, '' = the workspace):
 * - link: the file stays; the destination's group also shows it. Refused when that group already holds or shows it.
 * - move: the file itself goes to the destination folder, also from outside the workspace. Refused for a reference.
 * - copy: the file is duplicated into the destination folder; only the file, so the copy uses the destination's settings.
 * Move and copy never overwrite, and never target the folder the file is already in.
 */
export function refuseTransfer(mode: TransferMode, item: TransferItem, destination: string, levels: readonly string[], logs: readonly WorkspaceLog[], targetExists: boolean): TransferRefusal | undefined {
  if (!item.exists) return 'not-found';
  const outside = isOutside(item.located);
  if (mode === 'link') {
    const level = levelOf(levels, destination ? `${destination}/x` : 'x');
    if (!outside && locationLevel(levels, item.located) === level) return 'already-in-group';
    return logs.some((log) => log.level === level && log.path === item.located) ? 'already-in-group' : undefined;
  }
  if (mode === 'move' && item.listed) return 'link-cannot-move';
  if (!outside && folderOf(item.located) === destination) return 'same-folder';
  return targetExists ? 'target-exists' : undefined;
}
