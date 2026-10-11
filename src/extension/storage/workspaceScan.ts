import { promises as fs } from 'fs';
import * as path from 'path';
import { isLogFileName, isSkippedFolderName, LEVEL_DIRECTORY, type WorkspaceLog } from '../../core/project/folderLevels';

export interface WorkspaceScan {
  /** Workspace-relative folders (with `/`) that hold a `.sigmixa` folder; '' is always the root. */
  readonly levels: readonly string[];
  readonly logs: readonly WorkspaceLog[];
}

/**
 * Walks the workspace for levels and logs. Folders whose names start with '.' and `node_modules` are not
 * searched; symbolic links to files are read through, symbolic links to folders are not followed (no cycles).
 */
export async function scanWorkspace(root: string): Promise<WorkspaceScan> {
  const levels: string[] = ['']; const logs: WorkspaceLog[] = [];
  const walk = async (relative: string): Promise<void> => {
    let entries: import('fs').Dirent[];
    try { entries = await fs.readdir(path.join(root, relative), { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.name === LEVEL_DIRECTORY && entry.isDirectory()) { if (relative) levels.push(relative); continue; }
      if (entry.isDirectory()) { if (!isSkippedFolderName(entry.name)) await walk(child); continue; }
      const isFile = entry.isFile() || (entry.isSymbolicLink() && await fs.stat(path.join(root, child)).then((stat) => stat.isFile(), () => false));
      if (!isFile) continue;
      if (isLogFileName(entry.name)) logs.push({ path: child });
    }
  };
  await walk('');
  return { levels, logs };
}
