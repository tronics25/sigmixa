import { clipRangeLabel } from '../../core/project/schema';
import * as vscode from 'vscode';
import { t } from '../i18n';
import { RawLogEditorProvider } from '../editors/rawLogEditor';
import { AnalysisGroupsProvider, type AnalysisTreeNode } from '../sidebar/analysisGroupsProvider';
import { GroupDefinitionsEditor } from '../frame-editor/groupDefinitionsEditor';
import * as path from 'path';
import * as fs from 'fs';
import { clipboardFiles } from '../platform/clipboardFiles';
import { parseClipRangeInput, withClipRange } from '../../core/project/clipRangeEdit';
import { randomUUID } from 'crypto';
import { isLogFileName, levelOf } from '../../core/project/folderLevels';
import { clipKey, findClip, isClip } from '../../core/project/clipIdentity';
import { refuseTransfer, type TransferRefusal } from '../../core/project/logTransfer';
import { portableClipPath } from '../clips/clipPaths';
import { FrameDefinitionsProvider, PluginsProvider } from '../sidebar/projectProviders';
import { ProjectStore } from '../storage/projectStore';
import { FrameDefinitionEditor, type NewFramePrefill } from '../frame-editor/frameDefinitionEditor';
import { PluginManager } from '../plugins/pluginManager';
import { PluginEditor } from '../plugin-editor/pluginEditor';
import { exportDbc, importDbc } from '../../core/dbc/dbc';
import type { ClipDefinition } from '../../core/project/schema';
import { resolveClipPath } from '../clips/clipPaths';
import { ComparisonEditor } from '../comparison/comparisonEditor';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const frames = new FrameDefinitionsProvider();
  const plugins = new PluginsProvider();
  const projectStore = new ProjectStore();
  projectStore.setExternalLogHints(context.workspaceState.get<string[]>('sigmixa.recentLogs', []));
  await projectStore.load();
  const workspacePath = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const logFiles = new AnalysisGroupsProvider(projectStore);
  // Logs dragged onto a group or folder are added as links, moved or copied (asked on drop): logs of this pane, and log
  // files dragged in from the Explorer or the OS file manager.
  const TREE_MIME = 'application/vnd.code.tree.sigmixa.analysisgroups';
  let dropLogs: ((nodes: readonly AnalysisTreeNode[], target?: AnalysisTreeNode) => void) | undefined;
  let dropFiles: ((files: readonly vscode.Uri[], target?: AnalysisTreeNode) => void) | undefined;
  const groupTree = vscode.window.createTreeView('sigmixa.analysisGroups', { treeDataProvider: logFiles, canSelectMany: true, dragAndDropController: {
    dragMimeTypes: [TREE_MIME], dropMimeTypes: [TREE_MIME, 'text/uri-list', 'files'],
    // VS Code offers no way to stop a drag from starting on single items, so whatever is dragged is carried and the drop
    // decides: only logs move. Clips, groups and folders are refused with a message.
    handleDrag: (source: readonly AnalysisTreeNode[], data: vscode.DataTransfer) => { data.set(TREE_MIME, new vscode.DataTransferItem(source)); },
    handleDrop: async (target: AnalysisTreeNode | undefined, data: vscode.DataTransfer) => {
      const value = data.get(TREE_MIME)?.value; const nodes = (typeof value === 'string' ? JSON.parse(value) : value) as readonly AnalysisTreeNode[] | undefined;
      if (Array.isArray(nodes) && nodes.length) { dropLogs?.(nodes, target); return; }
      const files = new Map<string, vscode.Uri>();
      const list = data.get('text/uri-list');
      if (list) for (const line of (await list.asString()).split(/\r?\n/)) {
        if (!line.trim() || line.startsWith('#')) continue;
        try { const uri = vscode.Uri.parse(line.trim(), true); if (uri.scheme === 'file') files.set(uri.fsPath, uri); } catch { /* not a URI */ }
      }
      data.forEach((item) => { const uri = item.asFile()?.uri; if (uri?.scheme === 'file') files.set(uri.fsPath, uri); });
      if (files.size) dropFiles?.([...files.values()], target);
    },
  } });
  const selectedClips = () => groupTree.selection.flatMap((node) => node.kind === 'clip' ? [node.clip] : []);
  const clipValue = (value?: ClipDefinition | AnalysisTreeNode) => value && 'kind' in value ? value.kind === 'clip' ? value.clip : undefined : value;
  const pluginManager = new PluginManager(projectStore);
  await pluginManager.sync();
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0];
  // Levels, logs and links are found from the folders: reload when any of them appears, changes or disappears.
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  const reload = () => { if (reloadTimer) clearTimeout(reloadTimer); reloadTimer = setTimeout(() => void projectStore.load(), 300); };
  const watchers = workspaceRoot ? ['**/.sigmixa/project.json', '**/.sigmixa', '**/*.{asc,blf,ASC,BLF}'].map((pattern) => vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(workspaceRoot, pattern))) : [];
  for (const watcher of watchers) { watcher.onDidChange(reload); watcher.onDidCreate(reload); watcher.onDidDelete(reload); }
  // Logs moved or renamed in VS Code keep their Clips and view settings.
  const renames = vscode.workspace.onDidRenameFiles((event) => void projectStore.followRenames(event.files.map((file) => ({ from: file.oldUri.fsPath, to: file.newUri.fsPath }))));
  const frameEditor = new FrameDefinitionEditor(context.extensionUri, projectStore);
  const groupDefinitions = new GroupDefinitionsEditor(projectStore, frameEditor);
  const pluginEditor = new PluginEditor(context.extensionUri, projectStore, pluginManager);
  const comparisonEditor = new ComparisonEditor(context.extensionUri, projectStore, pluginManager);
  // The compare icon appears in the view title once two or more logs/Clips are selected.
  const comparable = () => groupTree.selection.filter((node) => node.kind === 'file' || node.kind === 'clip');
  const updateComparable = () => void vscode.commands.executeCommand('setContext', 'sigmixa.canCompare', comparable().length >= 2);
  updateComparable();
  const trashName = process.platform === 'win32' ? 'Recycle Bin' : 'Trash'; const trashNameJa = 'ごみ箱';
  const deleteClips = async (clips: readonly ClipDefinition[]) => {
    if (!clips.length) return; const remove = t('Delete', '削除');
    const message = clips.length === 1 ? t(`Delete Clip “${clips[0].name}”? The source log will not be deleted.`, `クリップ「${clips[0].name}」を削除しますか？元ログは削除されません。`)
      : t(`Delete ${clips.length} Clips? The source logs will not be deleted.`, `クリップ ${clips.length} 件を削除しますか？元ログは削除されません。`);
    if (await vscode.window.showWarningMessage(message, { modal: true }, remove) !== remove) return;
    // A Clip is its log and its ID together: a Clip with the same ID in a copied group is another Clip and stays.
    const keys = new Set(clips.map((clip) => clipKey(clip)));
    await projectStore.update((project) => ({ ...project, clips: project.clips.filter((item) => !keys.has(clipKey(item))) }));
  };
  /** Moves logs to the trash (never a permanent delete) and drops their Clips and view settings, after one confirmation. */
  const trashLogs = async (nodes: readonly AnalysisTreeNode[]) => {
    const files = [...new Set(nodes.flatMap((node) => node.kind === 'file' && !node.listed && !node.external ? [node.filePath] : []))]; if (!files.length) return;
    const clipCount = projectStore.current.clips.filter((clip) => files.some((file) => path.resolve(resolveClipPath(clip, workspacePath())) === path.resolve(file))).length;
    const move = t(`Move to ${trashName}`, `${trashNameJa}へ移動`);
    const message = files.length === 1 ? t(`Move “${path.basename(files[0])}” to the ${trashName}?`, `「${path.basename(files[0])}」を${trashNameJa}へ移動しますか？`) : t(`Move ${files.length} logs to the ${trashName}?`, `ログ ${files.length} 件を${trashNameJa}へ移動しますか？`);
    const detail = clipCount ? t(`${clipCount} Clip${clipCount === 1 ? '' : 's'} and the view settings of ${files.length === 1 ? 'this log' : 'these logs'} are deleted as well, in every group.`, `クリップ ${clipCount} 件と表示設定も、すべてのグループから削除されます。`)
      : t(`The view settings of ${files.length === 1 ? 'this log' : 'these logs'} are deleted as well.`, '表示設定も削除されます。');
    if (await vscode.window.showWarningMessage(message, { modal: true, detail }, move) !== move) return;
    const gone: string[] = [];
    for (const file of files) {
      try { await vscode.workspace.fs.delete(vscode.Uri.file(file), { useTrash: true }); gone.push(file); }
      catch (error) {
        // A log that is already gone ("Not found") only has its Clips and settings left to remove.
        if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') gone.push(file);
        else void vscode.window.showErrorMessage(t(`Could not move ${path.basename(file)} to the ${trashName}: ${(error as Error).message}`, `${path.basename(file)} を${trashNameJa}へ移動できませんでした: ${(error as Error).message}`));
      }
    }
    await projectStore.forgetLogs(gone);
  };
  const refusalText = (refusal: TransferRefusal): string => ({
    'not-found': t('the log file was not found', 'ログファイルが見つかりません'),
    'link-cannot-move': t('a link cannot be moved; move the log where it is', 'リンクは移動できません。元の場所のログを移動してください'),
    'same-folder': t('it is already in this folder', 'すでにこのフォルダにあります'),
    'already-in-group': t('this group already has it', 'すでにこのグループにあります'),
    'target-exists': t('a file of the same name is already there', '宛先に同じ名前のファイルがあります'),
  })[refusal];
  /**
   * Adds logs to `destination` (a workspace-relative folder) as links, or moves or copies them there. What cannot be done is
   * reported and left untouched. With `open`, each log is then opened from the destination.
   */
  const transferLogs = async (nodes: readonly AnalysisTreeNode[], destination: string, options?: { open?: boolean }) => {
    if (!projectStore.requireWorkspace()) return;
    const files = nodes.flatMap((node) => node.kind === 'file' ? [node] : []);
    if (!files.length) { void vscode.window.showErrorMessage(t('Only logs can be moved, copied or added to a group.', '移動・コピー・リンク追加ができるのはログだけです。')); return; }
    const place = destination || t('the workspace folder', 'ワークスペース直下');
    const picked = await vscode.window.showQuickPick([
      { label: t('Add as a link', 'リンクとして追加'), detail: t('The file stays where it is and is also shown in the destination group.', 'ファイルは動かさず、宛先のグループにも表示します。'), mode: 'link' as const },
      { label: t('Move', '移動'), detail: t('The file moves to the destination folder. Its Clips, view settings and links follow.', 'ファイルを宛先のフォルダへ移します。クリップ、表示設定、リンクは付いていきます。'), mode: 'move' as const },
      { label: t('Copy', 'コピー'), detail: t('The file is copied with its Clips. The copy uses the settings of the destination group.', 'ファイルをクリップごと複製します。コピーは宛先グループの設定を使います。'), mode: 'copy' as const },
    ], { title: files.length === 1 ? `${path.basename(files[0].filePath)} → ${place}` : t(`${files.length} logs → ${place}`, `ログ ${files.length} 件 → ${place}`) });
    if (!picked) return;
    const folder = projectStore.levelFolderUri(destination); if (!folder) return;
    const found = (uri: vscode.Uri) => vscode.workspace.fs.stat(uri).then(() => true, () => false);
    const refused: string[] = []; const links: string[] = []; const placed: string[] = []; let copied = false;
    for (const node of files) {
      const name = path.basename(node.filePath); const from = vscode.Uri.file(node.filePath); const to = vscode.Uri.joinPath(folder, name);
      const refusal = refuseTransfer(picked.mode, { located: projectStore.locate(node.filePath), listed: !!node.listed, exists: await found(from) }, destination, projectStore.levels, projectStore.logs, picked.mode !== 'link' && await found(to));
      if (refusal) { refused.push(`${name}: ${refusalText(refusal)}`); continue; }
      try {
        if (picked.mode === 'link') links.push(node.filePath);
        else if (picked.mode === 'copy') { await vscode.workspace.fs.copy(from, to, { overwrite: false }); copied = true; await projectStore.copyClips(from.fsPath, to.fsPath, () => `clip-${randomUUID()}`); placed.push(to.fsPath); }
        else {
          // Moved like the Explorer does, so an open editor follows; Clips, view settings and links follow the file.
          const edit = new vscode.WorkspaceEdit(); edit.renameFile(from, to, { overwrite: false });
          if (!await vscode.workspace.applyEdit(edit)) throw new Error(t('VS Code did not move the file', 'VS Code がファイルを移動できませんでした'));
          await projectStore.followRenames([{ from: from.fsPath, to: to.fsPath }]); placed.push(to.fsPath);
        }
      } catch (error) { refused.push(`${name}: ${(error as Error).message}`); }
    }
    const level = levelOf(projectStore.levels, destination);
    if (links.length) await projectStore.addLogs(level, links);
    if (copied) await projectStore.load();
    if (options?.open) for (const file of [...links.map((file) => projectStore.logUri(file, level)), ...placed.map((file) => projectStore.logUri(file, projectStore.levelOfFile(file)))]) await vscode.commands.executeCommand('vscode.openWith', file, 'sigmixa.rawLog');
    if (refused.length) void vscode.window.showErrorMessage(t(`Not done. ${refused.join(' / ')}`, `実行できませんでした。${refused.join(' / ')}`));
  };
  // Dropped on a log, the destination is the place that log is shown in.
  const dropDestination = (target?: AnalysisTreeNode): string | undefined => {
    if (target?.kind === 'clip') { void vscode.window.showErrorMessage(t('Logs cannot be dropped on a Clip.', 'クリップの上にはドロップできません。')); return undefined; }
    return !target ? '' : target.kind === 'file' ? target.listed ? target.groupId ?? '' : path.isAbsolute(target.located) ? '' : path.posix.dirname(target.located) === '.' ? '' : path.posix.dirname(target.located) : target.folder;
  };
  dropLogs = (nodes, target) => {
    const logs = nodes.filter((node) => node?.kind === 'file');
    if (!logs.length) {
      // A Clip follows its log and has no place of its own, so it is the log that is moved.
      void vscode.window.showErrorMessage(nodes.some((node) => node?.kind === 'clip') ? t('A Clip cannot be moved.', 'クリップは移動できません。') : t('Only logs can be moved, copied or added to a group.', '移動・コピー・リンク追加ができるのはログだけです。'));
      return;
    }
    const destination = dropDestination(target); if (destination !== undefined) void transferLogs(logs, destination);
  };
  dropFiles = (files, target) => {
    const logs = files.filter((file) => isLogFileName(path.basename(file.fsPath)));
    if (!logs.length) { void vscode.window.showErrorMessage(t('Only ASC and BLF logs can be added.', '追加できるのは ASC と BLF のログだけです。')); return; }
    const destination = dropDestination(target); if (destination === undefined) return;
    void transferLogs(logs.map((file) => ({ kind: 'file' as const, filePath: file.fsPath, located: projectStore.locate(file.fsPath) })), destination);
  };
  const dbcOutput = vscode.window.createOutputChannel('SigMixa DBC');
  const refreshProjectViews = () => {
    frames.setItems(projectStore.current.frames);
    logFiles.refresh();
    plugins.setItems(projectStore.current.plugins);
  };
  refreshProjectViews();

  context.subscriptions.push(
    groupTree.onDidChangeSelection(updateComparable),
    projectStore,
    ...watchers,
    renames,
    { dispose: () => { if (reloadTimer) clearTimeout(reloadTimer); } },
    frameEditor,
    pluginManager,
    pluginEditor,
    comparisonEditor,
    groupTree,
    groupDefinitions,
    logFiles,
    dbcOutput,
    projectStore.onDidChange(() => void pluginManager.sync()),
    projectStore.onDidChange(refreshProjectViews),
    vscode.window.registerTreeDataProvider('sigmixa.frames', frames),
    vscode.window.registerTreeDataProvider('sigmixa.plugins', plugins),
    vscode.window.registerCustomEditorProvider(
      'sigmixa.rawLog',
      new RawLogEditorProvider(context.extensionUri, logFiles, projectStore, frameEditor, pluginManager),
      { webviewOptions: { retainContextWhenHidden: true } }
    ),
    vscode.commands.registerCommand('sigmixa.openLog', async (node?: AnalysisTreeNode) => {
      // A log that is already in the place it is opened from (a group, a folder, or - from the pane's title bar - anywhere in the
      // workspace) just opens. For any other log, the user chooses: add it as a link, move it or copy it there; then it opens there.
      const files = await vscode.window.showOpenDialog({ canSelectMany: true, title: t('Open CAN Log', 'CANログを開く'), filters: { 'CAN logs (ASC and BLF)': ['asc', 'blf'] } });
      if (!files?.length) return;
      if (projectStore.requireWorkspace()) {
        const place = node && (node.kind === 'group' || node.kind === 'folder') ? node.folder : undefined; const destination = place ?? ''; const level = levelOf(projectStore.levels, destination);
        const isHere = (file: vscode.Uri) => { const located = projectStore.locate(file.fsPath); return place === undefined ? !path.isAbsolute(located) : refuseTransfer('link', { located, listed: false, exists: true }, destination, projectStore.levels, projectStore.logs, false) === 'already-in-group'; };
        for (const file of files.filter(isHere)) await vscode.commands.executeCommand('vscode.openWith', projectStore.logUri(file.fsPath, place === undefined ? projectStore.levelOfFile(file.fsPath) : level), 'sigmixa.rawLog');
        const others = files.filter((file) => !isHere(file));
        if (others.length) await transferLogs(others.map((file) => ({ kind: 'file' as const, filePath: file.fsPath, located: projectStore.locate(file.fsPath) })), destination, { open: true });
        return;
      }
      for (const file of files) await vscode.commands.executeCommand('vscode.openWith', file, 'sigmixa.rawLog');
    }),
    vscode.commands.registerCommand('sigmixa.openClip', async (value?: ClipDefinition, options?: { preserveFocus?: boolean; level?: string }) => {
      // A Clip is always named by its log and its ID; an ID alone is not accepted, as it may also be a Clip of another log.
      const clip = value && typeof value === 'object' ? findClip(projectStore.current.clips, value) : undefined;
      if (!clip) return; const filePath = resolveClipPath(clip, workspacePath());
      try { await vscode.workspace.fs.stat(vscode.Uri.file(filePath)); await vscode.commands.executeCommand('vscode.openWith', projectStore.clipUri(clip, options?.level), 'sigmixa.rawLog', ...(options?.preserveFocus ? [{ preserveFocus: true }] : [])); }
      catch { void vscode.window.showErrorMessage(`Clip source file was not found: ${filePath}`); }
    }),
    vscode.commands.registerCommand('sigmixa.openClipSource', async (value?: ClipDefinition | AnalysisTreeNode) => {
      const clip = clipValue(value) ?? selectedClips()[0]; if (!clip) return; const filePath = resolveClipPath(clip, workspacePath());
      try { await vscode.workspace.fs.stat(vscode.Uri.file(filePath)); await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(filePath), 'sigmixa.rawLog'); }
      catch { void vscode.window.showErrorMessage(`Clip source file was not found: ${filePath}`); }
    }),
    vscode.commands.registerCommand('sigmixa.compareClips', (value?: ClipDefinition | AnalysisTreeNode, selected?: readonly AnalysisTreeNode[]) => {
      // Compares the selected logs and Clips directly, in selection order.
      const nodes = selected?.length ? selected : comparable().length ? comparable() : value && 'kind' in value ? [value] : [];
      comparisonEditor.create(nodes.flatMap((node): { kind: 'clip' | 'file'; clipId?: string; sourcePath?: string; level?: string }[] => node.kind === 'clip' ? [{ kind: 'clip' as const, clipId: node.clip.id, sourcePath: node.clip.sourcePath, level: node.level }] : node.kind === 'file' ? [{ kind: 'file' as const, sourcePath: portableClipPath(node.filePath, workspacePath()), ...(node.listed ? { level: node.groupId ?? '' } : {}) }] : []));
    }),
    vscode.commands.registerCommand('sigmixa.addGroup', async (node?: AnalysisTreeNode) => {
      // A new analysis group is a new folder with a `.sigmixa` folder, inside the selected group or folder (or the workspace).
      const root = projectStore.requireWorkspace(); if (!root) return;
      const parentFolder = node && (node.kind === 'group' || node.kind === 'folder') ? node.folder : '';
      const parent = projectStore.levelFolderUri(parentFolder) ?? root;
      const name = await vscode.window.showInputBox({ title: t('Add Analysis Group', '解析グループを追加'), prompt: t(`Folder name (created in ${parentFolder || 'the workspace'})`, `フォルダ名（${parentFolder || 'ワークスペース直下'}に作成）`),
        validateInput: (value) => !value.trim() ? t('Enter a name.', '名前を入力してください') : /[\\/:*?"<>|]/.test(value) ? t('A folder name cannot contain \\ / : * ? " < > |', 'フォルダ名に \\ / : * ? " < > | は使えません') : undefined });
      if (!name) return;
      try { await projectStore.createLevel(vscode.Uri.joinPath(parent, name.trim())); }
      catch (error) { void vscode.window.showErrorMessage(t(`Could not create the analysis group: ${(error as Error).message}`, `解析グループを作成できませんでした: ${(error as Error).message}`)); }
    }),
    vscode.commands.registerCommand('sigmixa.makeFolderGroup', async (value?: vscode.Uri | AnalysisTreeNode) => {
      const folder = value instanceof vscode.Uri ? value : value?.kind === 'folder' ? projectStore.levelFolderUri(value.folder) : undefined; if (!folder) return;
      try { await projectStore.createLevel(folder); }
      catch (error) { void vscode.window.showErrorMessage(t(`Could not make the folder an analysis group: ${(error as Error).message}`, `フォルダを解析グループにできませんでした: ${(error as Error).message}`)); }
    }),
    vscode.commands.registerCommand('sigmixa.openItem', async (value?: AnalysisTreeNode) => {
      const node = value ?? groupTree.selection[0];
      if (node?.kind === 'clip') await vscode.commands.executeCommand('sigmixa.openClip', node.clip, { level: node.level });
      else if (node?.kind === 'file') await vscode.commands.executeCommand('vscode.openWith', node.external ? vscode.Uri.file(node.filePath) : projectStore.logUri(node.filePath, node.groupId ?? ''), 'sigmixa.rawLog');
    }),
    vscode.commands.registerCommand('sigmixa.renameItem', async (value?: AnalysisTreeNode) => {
      const node = value ?? groupTree.selection[0]; if (!node) return;
      const invalid = (text: string) => !text.trim() ? t('Enter a name.', '名前を入力してください') : /[\\/:*?"<>|]/.test(text) ? t('A name cannot contain \\ / : * ? " < > |', '名前に \\ / : * ? " < > | は使えません') : undefined;
      if (node.kind === 'clip') {
        const name = await vscode.window.showInputBox({ title: t('Rename Clip', 'クリップ名を変更'), value: node.clip.name, validateInput: (text) => !text.trim() ? t('Enter a name.', '名前を入力してください') : undefined });
        if (!name || name.trim() === node.clip.name) return;
        await projectStore.update((project) => ({ ...project, clips: project.clips.map((clip) => isClip(clip, node.clip) ? { ...clip, name: name.trim() } : clip) }));
        return;
      }
      // A log is renamed where it is; an added log is only a reference to a file somewhere else.
      if (node.kind === 'file' && (node.listed || node.external)) return;
      const from = node.kind === 'file' ? vscode.Uri.file(node.filePath) : projectStore.levelFolderUri(node.folder); if (!from) return;
      const current = path.basename(from.fsPath); const extension = node.kind === 'file' ? path.extname(current) : '';
      const name = await vscode.window.showInputBox({ title: node.kind === 'file' ? t('Rename Log', 'ログ名を変更') : node.kind === 'group' ? t('Rename Analysis Group', '解析グループ名を変更') : t('Rename Folder', 'フォルダ名を変更'),
        value: current, valueSelection: [0, current.length - extension.length],
        validateInput: (text) => invalid(text) ?? (extension && path.extname(text.trim()).toLowerCase() !== extension.toLowerCase() ? t(`Keep the ${extension} extension.`, `拡張子 ${extension} はそのままにしてください`) : undefined) });
      if (!name || name.trim() === current) return;
      try {
        const to = vscode.Uri.joinPath(from, '..', name.trim());
        if (to.fsPath.toLowerCase() !== from.fsPath.toLowerCase() && await vscode.workspace.fs.stat(to).then(() => true, () => false)) throw new Error(t(`“${name.trim()}” already exists.`, `「${name.trim()}」は既にあります。`));
        if (node.kind === 'file') {
          // A workspace edit renames like the Explorer does, so an open editor of the log follows the new name.
          const edit = new vscode.WorkspaceEdit(); edit.renameFile(from, to, { overwrite: false });
          if (!await vscode.workspace.applyEdit(edit)) throw new Error(t('VS Code did not rename the file.', 'VS Code がファイル名を変更できませんでした。'));
        } else await vscode.workspace.fs.rename(from, to, { overwrite: false });
        // Clips, view settings and references from other groups follow the new name.
        await projectStore.followRenames([{ from: from.fsPath, to: to.fsPath }]);
      }
      catch (error) { void vscode.window.showErrorMessage(t(`Could not rename: ${(error as Error).message}`, `名前を変更できませんでした: ${(error as Error).message}`)); }
    }),
    ...['sigmixa.trashLog', 'sigmixa.trashLogWindows'].map((command) => vscode.commands.registerCommand(command, (node?: AnalysisTreeNode, selected?: readonly AnalysisTreeNode[]) => trashLogs(selected?.length ? selected : node ? [node] : groupTree.selection))),
    vscode.commands.registerCommand('sigmixa.deleteItem', async () => {
      // The Delete key: logs go to the trash, added logs leave the group, Clips are deleted.
      const nodes = groupTree.selection;
      await trashLogs(nodes);
      for (const node of nodes) if (node.kind === 'file' && node.listed) await projectStore.removeAddedLog(node.filePath, node.groupId ?? '');
      await deleteClips(nodes.flatMap((node) => node.kind === 'clip' ? [node.clip] : []));
    }),
    vscode.commands.registerCommand('sigmixa.transferLogs', async (node?: AnalysisTreeNode, selected?: readonly AnalysisTreeNode[]) => {
      const nodes = selected?.length ? selected : node ? [node] : groupTree.selection; if (!nodes.some((item) => item.kind === 'file')) return;
      // Destinations: the workspace folder, every group, and every folder that holds logs.
      const folders = new Set<string>(['', ...projectStore.levels, ...projectStore.logs.filter((log) => log.level === undefined && !path.isAbsolute(log.path)).map((log) => path.posix.dirname(log.path) === '.' ? '' : path.posix.dirname(log.path))]);
      const picked = await vscode.window.showQuickPick([...folders].sort((a, b) => a.localeCompare(b)).map((folder) => ({ label: folder || t('Workspace folder', 'ワークスペース直下'), folder,
        description: !folder ? '' : projectStore.levels.includes(folder) ? t('analysis group', '解析グループ') : t('folder', 'フォルダ') })), { title: t('Move or copy to…', '移動またはコピーの宛先') });
      if (picked) await transferLogs(nodes, picked.folder);
    }),
    // The exact start and end of a Clip, typed in seconds. (On a graph, the ends of its span marker can be dragged.)
    vscode.commands.registerCommand('sigmixa.editClipRange', async (value?: ClipDefinition | AnalysisTreeNode) => {
      const picked = clipValue(value) ?? selectedClips()[0]; const clip = picked && findClip(projectStore.current.clips, picked); if (!clip) return;
      const text = await vscode.window.showInputBox({
        title: t(`Change the range of Clip “${clip.name}”`, `クリップ「${clip.name}」の範囲を変更`), prompt: t('Start and end in seconds, for example 12.5 - 20', '開始と終了を秒で入力します。例: 12.5 - 20'),
        value: clip.startTimestamp === undefined || clip.endTimestamp === undefined ? '' : `${clip.startTimestamp} - ${clip.endTimestamp}`,
        validateInput: (input) => parseClipRangeInput(input) ? undefined : t('Enter a start and a later end in seconds, for example 12.5 - 20.', '開始と、それより後の終了を秒で入力してください。例: 12.5 - 20'),
      });
      const range = text === undefined ? undefined : parseClipRangeInput(text); if (!range) return;
      try { await projectStore.update((project) => withClipRange(project, clip, range.start, range.end)); }
      catch (error) { void vscode.window.showErrorMessage(t(`Could not change the Clip: ${(error as Error).message}`, `クリップを変更できませんでした: ${(error as Error).message}`)); }
    }),
    // Logs copied in the OS file manager (or paths copied as text) are added to the selected place, as a drop would.
    vscode.commands.registerCommand('sigmixa.pasteLogs', async (node?: AnalysisTreeNode) => {
      const files = (await clipboardFiles(() => vscode.env.clipboard.readText())).filter((file) => fs.existsSync(file));
      if (!files.length) { void vscode.window.showInformationMessage(t('There are no copied logs to paste.', '貼り付けられるログがありません。')); return; }
      dropFiles?.(files.map((file) => vscode.Uri.file(file)), node ?? groupTree.selection[0]);
    }),
    vscode.commands.registerCommand('sigmixa.copyPath', async (node?: AnalysisTreeNode, selected?: readonly AnalysisTreeNode[]) => {
      const paths = (selected?.length ? selected : node ? [node] : groupTree.selection).flatMap((item) => item.kind === 'file' ? [item.filePath] : []);
      if (paths.length) await vscode.env.clipboard.writeText(paths.join('\n'));
    }),
    vscode.commands.registerCommand('sigmixa.dissolveGroup', async (value?: AnalysisTreeNode) => {
      const node = value ?? groupTree.selection[0]; if (node?.kind !== 'group') return;
      const remove = t('Remove Group', 'グループを解除');
      const answer = await vscode.window.showWarningMessage(t(`Remove analysis group “${path.posix.basename(node.folder)}”?`, `解析グループ「${path.posix.basename(node.folder)}」を解除しますか？`),
        { modal: true, detail: t(`The folder and its logs stay. The group's Frame definitions, view settings and Clips (its .sigmixa folder) are moved to the ${trashName}.`, `フォルダとログは残ります。グループのフレーム定義、表示設定、クリップ（.sigmixa フォルダ）は${trashNameJa}へ移動します。`) }, remove);
      if (answer !== remove) return;
      try { await projectStore.removeLevel(node.folder); }
      catch (error) { void vscode.window.showErrorMessage(t(`Could not remove the analysis group: ${(error as Error).message}`, `解析グループを解除できませんでした: ${(error as Error).message}`)); }
    }),
    // Same as the Explorer's "Reveal in Finder / File Explorer": one command, with the title for each OS in package.json.
    ...['sigmixa.revealInOS', 'sigmixa.revealInOSWindows', 'sigmixa.revealInOSLinux'].map((command) => vscode.commands.registerCommand(command, (node?: AnalysisTreeNode) => {
      const uri = node?.kind === 'group' || node?.kind === 'folder' ? projectStore.levelFolderUri(node.folder) : node?.kind === 'file' ? vscode.Uri.file(node.filePath) : undefined;
      if (uri) void vscode.commands.executeCommand('revealFileInOS', uri);
    })),
    vscode.commands.registerCommand('sigmixa.openGroupDefinitions', (node: AnalysisTreeNode) => { if (node?.kind === 'group') groupDefinitions.open(node.folder); }),
    vscode.commands.registerCommand('sigmixa.removeAddedLog', async (node?: AnalysisTreeNode) => {
      if (node?.kind !== 'file' || !node.listed) return;
      await projectStore.removeAddedLog(node.filePath, node.groupId ?? '');
    }),
    vscode.commands.registerCommand('sigmixa.deleteClip', (value?: ClipDefinition | AnalysisTreeNode) => { const clip = clipValue(value) ?? selectedClips()[0]; return deleteClips(clip ? [clip] : []); }),
    vscode.commands.registerCommand('sigmixa.addFrame', (prefill?: NewFramePrefill) => frameEditor.create(prefill)),
    vscode.commands.registerCommand('sigmixa.importDbc', async () => {
      if (!projectStore.requireWorkspace()) return;
      const selected = await vscode.window.showOpenDialog({ title: 'Import DBC Frame Definitions', canSelectFiles: true, canSelectFolders: false, canSelectMany: false, filters: { 'CAN database': ['dbc'] } });
      if (!selected?.[0]) return;
      try {
        const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(selected[0]));
        const result = importDbc(text, selected[0].fsPath);
        writeDbcDiagnostics(dbcOutput, result.diagnostics);
        if (!result.frames.length) { void vscode.window.showErrorMessage(`No valid CAN Frames were imported from ${selected[0].path.split('/').pop() ?? 'DBC'}. See “SigMixa DBC” output for details.`); return; }
        const existingByCan = new Map(projectStore.current.frames.map((frame) => [`${frame.extended ? 'e' : 's'}:${frame.canId}`, frame]));
        const conflicts = result.frames.filter((frame) => existingByCan.has(`${frame.extended ? 'e' : 's'}:${frame.canId}`));
        let replace = false;
        if (conflicts.length) {
          const answer = await vscode.window.showWarningMessage(t(`${conflicts.length} imported CAN Frame(s) already exist. Replace them?`, `${conflicts.length}件のフレームはすでにあります。置き換えますか？`), { modal: true }, 'Replace Manual', 'Skip Duplicates');
          if (!answer) return;
          replace = answer === 'Replace Manual';
        }
        const replacedIds = new Set<string>(); let added = 0; let replaced = 0; let skipped = 0;
        await projectStore.update((project) => {
          const frames = [...project.frames];
          for (const imported of result.frames) {
            const index = frames.findIndex((frame) => frame.canId === imported.canId && frame.extended === imported.extended);
            if (index < 0) { frames.push(imported); added++; continue; }
            const existing = frames[index];
            if (!replace || existing.origin?.type === 'plugin') { skipped++; continue; }
            frames[index] = { ...imported, id: existing.id }; replacedIds.add(existing.id); replaced++;
          }
          return { ...project, frames };
        });
        replacedIds.forEach((id) => frameEditor.close(id));
        const warnings = result.diagnostics.filter((item) => item.severity !== 'info').length;
        void vscode.window.showInformationMessage(`DBC import complete: ${added} added, ${replaced} replaced, ${skipped} skipped${warnings ? `, ${warnings} diagnostic(s)` : ''}.`);
        if (warnings) dbcOutput.show(true);
      } catch (error) { void vscode.window.showErrorMessage(`DBC import failed: ${(error as Error).message}`); }
    }),
    vscode.commands.registerCommand('sigmixa.exportDbc', async (selection?: { id?: string } | string) => {
      const selectedId = typeof selection === 'string' ? selection : selection?.id;
      const candidates = selectedId ? projectStore.current.frames.filter((frame) => frame.id === selectedId) : projectStore.current.frames;
      if (!candidates.length) { void vscode.window.showInformationMessage('There are no CAN Frame definitions to export.'); return; }
      const result = exportDbc(candidates);
      writeDbcDiagnostics(dbcOutput, result.diagnostics);
      if (!/^BO_ /m.test(result.text)) { void vscode.window.showErrorMessage('No valid CAN Frame definitions could be exported. See “SigMixa DBC” output for details.'); dbcOutput.show(true); return; }
      const root = vscode.workspace.workspaceFolders?.[0]?.uri;
      const target = await vscode.window.showSaveDialog({ title: selectedId ? 'Export CAN Frame as DBC' : 'Export CAN Frames as DBC', defaultUri: root ? vscode.Uri.joinPath(root, selectedId ? `${dbcFileName(candidates[0].name)}.dbc` : 'sigmixa-frames.dbc') : undefined, filters: { 'CAN database': ['dbc'] } });
      if (!target) return;
      try {
        await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(result.text));
        const warnings = result.diagnostics.filter((item) => item.severity !== 'info').length;
        const exportedCount = result.text.match(/^BO_ /gm)?.length ?? 0;
        void vscode.window.showInformationMessage(`Exported ${exportedCount} CAN Frame definition(s) to ${target.path.split('/').pop() ?? target.path}${warnings ? ` with ${warnings} diagnostic(s)` : ''}.`);
        if (warnings) dbcOutput.show(true);
      } catch (error) { void vscode.window.showErrorMessage(`DBC export failed: ${(error as Error).message}`); }
    }),
    vscode.commands.registerCommand('sigmixa.openFrame', (frameId: string) => frameEditor.open(frameId)),
    vscode.commands.registerCommand('sigmixa.deleteFrame', async (frame: { id?: string; name?: string } | string) => {
      const frameId = typeof frame === 'string' ? frame : frame?.id;
      const current = projectStore.current.frames.find((item) => item.id === frameId);
      if (!current || current.origin?.type === 'plugin') return;
      const answer = await vscode.window.showWarningMessage(`Delete CAN frame “${current.name}”?`, { modal: true }, 'Delete');
      if (answer !== 'Delete') return;
      await projectStore.update((project) => ({ ...project, frames: project.frames.filter((item) => item.id !== current.id) }));
      frameEditor.close(current.id);
    }),
    vscode.commands.registerCommand('sigmixa.addPlugin', async () => {
      if (!projectStore.requireWorkspace()) return;
      const selected = await vscode.window.showOpenDialog({ title: 'Register SigMixa Plugin Directory', canSelectFiles: false, canSelectFolders: true, canSelectMany: false });
      if (!selected?.[0]) return;
      try { const id = await pluginManager.registerSource(selected[0]); pluginEditor.open(id); }
      catch (error) { void vscode.window.showErrorMessage(`Plugin registration failed: ${(error as Error).message}`); }
    }),
    vscode.commands.registerCommand('sigmixa.openPlugin', (plugin: { id?: string } | string) => pluginEditor.open(typeof plugin === 'string' ? plugin : plugin?.id ?? '')),
    vscode.commands.registerCommand('sigmixa.refresh', () => {
      logFiles.refresh();
      void projectStore.load();
    })
  );
}

function writeDbcDiagnostics(output: vscode.OutputChannel, diagnostics: readonly { readonly severity: string; readonly code: string; readonly message: string; readonly location?: { readonly line?: number } }[]): void {
  output.clear();
  if (!diagnostics.length) { output.appendLine('DBC operation completed without diagnostics.'); return; }
  for (const item of diagnostics) output.appendLine(`${item.severity.toUpperCase()} ${item.code}${item.location?.line ? ` · line ${item.location.line}` : ''}: ${item.message}`);
}

function dbcFileName(value: string): string { return value.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'frame'; }

export function deactivate(): void {
  // Documents own and cancel their active parser sessions.
}
