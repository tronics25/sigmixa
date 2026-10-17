import * as vscode from 'vscode';

/**
 * Clips and logs opened from a group they were added to are not files of their own, so they get their own URI scheme
 * instead of a file URI with a mark added: VS Code takes a file URI for the file on disk (its breadcrumb, for one, then
 * shows the whole path). The path is what VS Code shows and lists, as a folder tree: the place, the log, the Clip.
 *
 * What is opened is named in the query (the log, the place, the Clip ID), together with the path it was given for. A URI
 * SigMixa made (an open tab, restored or not) has that very path, and opens what its query names, even after other Clips
 * took or left names. VS Code makes the URIs of the items in its breadcrumb lists by joining a name to the path, keeping
 * the query: such a URI has another path than the query was given for, and opens what that path shows now.
 */
export const SOURCE_SCHEME = 'sigmixa';

export interface SourceLocation {
  /** The log file. */
  readonly file: string;
  /** The level it is opened from ('' = the workspace). */
  readonly level: string;
  readonly clipId?: string;
}

export function sourceUri(shownPath: string, location: SourceLocation): vscode.Uri {
  const query = new URLSearchParams({ file: location.file, level: location.level, ...(location.clipId ? { clip: location.clipId } : {}), at: shownPath });
  return vscode.Uri.from({ scheme: SOURCE_SCHEME, path: shownPath, query: query.toString() });
}

/** What a URI SigMixa made names (undefined when the URI was made from another one's path, by joining a name to it). */
export function issuedLocation(uri: vscode.Uri): SourceLocation | undefined {
  const query = new URLSearchParams(uri.query); const file = query.get('file');
  return file && query.get('at') === uri.path ? { file, level: query.get('level') ?? '', clipId: query.get('clip') ?? undefined } : undefined;
}

/**
 * Lists the logs and Clips for VS Code (its breadcrumb's lists) without anything on disk. A log without Clips is a file;
 * a log with Clips is a folder holding the whole log (under its own name) and its Clips.
 */
export class SourceFileSystem implements vscode.FileSystemProvider {
  private readonly changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changes.event;
  constructor(private readonly entries: () => ReadonlyMap<string, SourceLocation>) {}
  watch(): vscode.Disposable { return new vscode.Disposable(() => undefined); }
  stat(uri: vscode.Uri): vscode.FileStat {
    const entries = this.entries(); const folder = uri.path === '/' ? '/' : `${uri.path}/`;
    const type = [...entries.keys()].some((key) => key.startsWith(folder)) ? vscode.FileType.Directory : entries.has(uri.path) ? vscode.FileType.File : undefined;
    if (type === undefined) throw vscode.FileSystemError.FileNotFound(uri);
    return { type, ctime: 0, mtime: 0, size: 0, permissions: vscode.FilePermission.Readonly };
  }
  readDirectory(uri: vscode.Uri): [string, vscode.FileType][] {
    const entries = this.entries(); const folder = uri.path === '/' ? '/' : `${uri.path}/`; const children = new Map<string, vscode.FileType>();
    for (const key of entries.keys()) {
      if (!key.startsWith(folder)) continue;
      const name = key.slice(folder.length).split('/')[0];
      children.set(name, key === folder + name && children.get(name) !== vscode.FileType.Directory ? vscode.FileType.File : vscode.FileType.Directory);
    }
    return [...children];
  }
  readFile(uri: vscode.Uri): Uint8Array { throw vscode.FileSystemError.FileNotFound(uri); }
  createDirectory(uri: vscode.Uri): void { throw vscode.FileSystemError.NoPermissions(uri); }
  writeFile(uri: vscode.Uri): void { throw vscode.FileSystemError.NoPermissions(uri); }
  delete(uri: vscode.Uri): void { throw vscode.FileSystemError.NoPermissions(uri); }
  rename(uri: vscode.Uri): void { throw vscode.FileSystemError.NoPermissions(uri); }
  dispose(): void { this.changes.dispose(); }
}
