import { clipRangeLabel } from '../../core/project/schema';
import { existsSync } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { t } from '../i18n';
import type { AnalysisGroup, ClipDefinition } from '../../core/project/schema';
import { resolveGroupProject } from '../../core/project/analysisGroups';
import { levelOfLog, type WorkspaceLog } from '../../core/project/folderLevels';
import type { ProjectStore } from '../storage/projectStore';
import { resolveClipPath } from '../clips/clipPaths';

/**
 * The analysis groups pane shows the workspace as it is on disk: levels (folders with `.sigmixa`), plain folders, logs
 * (an added log also in the group it was added to, like a shortcut), and each log's Clips, wherever the log is shown. `folder` is workspace-relative with '/'.
 */
export type AnalysisTreeNode =
  | { readonly kind: 'group'; readonly group?: AnalysisGroup; readonly folder: string }
  | { readonly kind: 'folder'; readonly folder: string }
  | { readonly kind: 'file'; readonly filePath: string; readonly located: string; readonly groupId?: string; readonly external?: boolean; readonly listed?: boolean }
  /** `level`: the place the Clip is shown in, whose definitions and view settings it opens with. */
  | { readonly kind: 'clip'; readonly clip: ClipDefinition; readonly level: string };

/** The level whose definitions a log uses, from where it was opened (undefined = the common definitions only). */
export function sourceGroup(store: ProjectStore, uri: vscode.Uri | string): AnalysisGroup | undefined {
  const level = store.levelOfUri(uri);
  return level ? store.current.analysisGroups?.find((group) => group.id === level) : undefined;
}

export function sourceProject(store: ProjectStore, uri: vscode.Uri | string) {
  return resolveGroupProject(store.current, sourceGroup(store, uri)?.id);
}

export class AnalysisGroupsProvider implements vscode.TreeDataProvider<AnalysisTreeNode>, vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changes.event;
  constructor(private readonly store: ProjectStore) {}
  refresh(): void { this.changes.fire(); }
  dispose(): void { this.changes.dispose(); }

  getChildren(node?: AnalysisTreeNode): AnalysisTreeNode[] {
    if (node?.kind === 'clip') return [];
    if (node?.kind === 'file') return this.clipsOf(node.filePath).map((clip) => ({ kind: 'clip', clip, level: node.external ? '' : node.groupId ?? '' }));
    const folder = node ? node.folder : '';
    const missing = this.missingClipSources();
    const folders = new Set<string>();
    const inside = (value: string) => folder ? value.startsWith(`${folder}/`) ? value.slice(folder.length + 1) : undefined : value;
    // Only folders that are levels or lead to a log are shown.
    for (const value of [...this.store.levels.filter(Boolean), ...this.store.logs.filter((log) => log.level === undefined).map((log) => log.path), ...missing]) {
      const rest = inside(value); if (!rest) continue;
      const slash = rest.indexOf('/'); if (slash >= 0) folders.add(rest.slice(0, slash));
      else if (this.store.levels.includes(value)) folders.add(rest);
    }
    const here = (value: string) => (path.posix.dirname(value) === '.' ? '' : path.posix.dirname(value)) === folder;
    const children: AnalysisTreeNode[] = [...folders].sort((a, b) => a.localeCompare(b)).map((name) => {
      const child = folder ? `${folder}/${name}` : name;
      const group = this.store.current.analysisGroups?.find((item) => item.id === child);
      return this.store.levels.includes(child) ? { kind: 'group', group, folder: child } : { kind: 'folder', folder: child };
    });
    for (const log of this.store.logs.filter((item) => item.level === undefined && here(item.path)).sort((a, b) => a.path.localeCompare(b.path))) children.push(this.fileNode(log));
    // Added logs are listed under the level that added them, wherever the files are.
    for (const log of this.store.logs.filter((item) => item.level === folder && (!folder || this.store.levels.includes(folder))).sort((a, b) => path.basename(a.path).localeCompare(path.basename(b.path)))) children.push(this.fileNode(log));
    for (const source of missing.filter(here)) children.push(this.fileNode({ path: source }));
    // Clips of logs outside the workspace (from before analysis groups were folders) stay listed at the top level.
    if (!folder) for (const source of this.externalClipSources()) children.push({ kind: 'file', filePath: source, located: source, external: true });
    return children;
  }

  getTreeItem(node: AnalysisTreeNode): vscode.TreeItem {
    if (node.kind === 'group') {
      const item = new vscode.TreeItem(path.posix.basename(node.folder), vscode.TreeItemCollapsibleState.Expanded);
      item.id = `level:${node.folder}`; item.contextValue = 'sigmixa.analysisGroup'; item.tooltip = t(`Analysis group · ${node.folder}`, `解析グループ・${node.folder}`);
      item.iconPath = new vscode.ThemeIcon('folder-library', new vscode.ThemeColor('charts.purple'));
      item.description = node.group?.frames.length ? `+${node.group.frames.length}` : undefined;
      return item;
    }
    if (node.kind === 'folder') {
      const item = new vscode.TreeItem(path.posix.basename(node.folder), vscode.TreeItemCollapsibleState.Expanded);
      item.id = `folder:${node.folder}`; item.contextValue = 'sigmixa.folder'; item.iconPath = new vscode.ThemeIcon('folder');
      return item;
    }
    if (node.kind === 'file') {
      const children = this.getChildren(node); const exists = existsSync(node.filePath);
      const label = path.basename(node.located);
      const item = new vscode.TreeItem(label, children.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
      item.id = `source:${node.listed ? `${node.groupId ?? ''}>` : ''}${node.located}`; item.contextValue = node.listed ? 'sigmixa.addedFile' : 'sigmixa.analysisFile';
      item.description = !exists ? t('Not found', '見つかりません') : node.external ? t('Outside the workspace', 'ワークスペース外') : undefined;
      // An added log shows the link icon; its tooltip says where the file actually is.
      item.tooltip = node.listed ? t(`Added to this group · ${node.filePath}`, `このグループに追加したログ・${node.filePath}`) : node.filePath;
      item.iconPath = !exists ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground')) : new vscode.ThemeIcon(node.listed ? 'file-symlink-file' : 'file-binary', new vscode.ThemeColor('charts.blue'));
      // Opened from here, the log uses this place's definitions (an added log: the group it was added to).
      // As in the Explorer, a click opens the log and leaves the focus in the pane, so F2 and Delete act on the clicked item.
      if (exists) item.command = { command: 'vscode.openWith', title: 'Open log', arguments: [node.external ? vscode.Uri.file(node.filePath) : this.store.logUri(node.filePath, node.groupId ?? ''), 'sigmixa.rawLog', { preserveFocus: true }] };
      return item;
    }
    const clip = node.clip;
    const item = new vscode.TreeItem(clip.name, vscode.TreeItemCollapsibleState.None);
    item.id = `clip:${node.level}>${clip.sourcePath}>${clip.id}`; item.contextValue = 'sigmixa.clip';
    item.description = clipRangeLabel(clip, t('Whole file', 'ファイル全体'));
    item.tooltip = `${clip.sourceFileName}\n${item.description}`;
    item.iconPath = new vscode.ThemeIcon('symbol-event', new vscode.ThemeColor('charts.green'));
    item.command = { command: 'sigmixa.openClip', title: 'Open Clip', arguments: [clip, { preserveFocus: true, level: node.level }] };
    return item;
  }

  private root(): string { return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? ''; }
  private fileNode(log: WorkspaceLog): AnalysisTreeNode {
    const listed = log.level !== undefined; const filePath = path.isAbsolute(log.path) ? log.path : path.join(this.root(), ...log.path.split('/'));
    const level = levelOfLog(this.store.levels, log);
    return { kind: 'file', filePath, located: log.path, groupId: level || undefined, listed };
  }
  /** A log's Clips: the same ones wherever the log is shown. */
  private clipsOf(filePath: string): ClipDefinition[] {
    return this.store.current.clips.filter((clip) => path.resolve(resolveClipPath(clip, this.root())) === path.resolve(filePath));
  }
  /** Clip sources outside the workspace that no level has added. */
  private externalClipSources(): string[] {
    const listed = new Set(this.store.logs.filter((log) => log.level !== undefined).map((log) => path.resolve(log.path)));
    return [...new Set(this.store.current.clips.map((clip) => clip.sourcePath).filter((source) => path.isAbsolute(source) && !listed.has(path.resolve(source))))];
  }
  /** Workspace locations of Clip sources that are no longer found, so their Clips stay visible and can be deleted. */
  private missingClipSources(): string[] {
    const known = new Set(this.store.logs.map((log) => path.resolve(path.isAbsolute(log.path) ? log.path : path.join(this.root(), log.path))));
    return [...new Set(this.store.current.clips.map((clip) => clip.sourcePath).filter((source) => !path.isAbsolute(source) && !known.has(path.resolve(this.root(), source))))];
  }
}
