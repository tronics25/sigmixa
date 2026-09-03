import * as vscode from 'vscode';
import { RawLogEditorProvider } from '../editors/rawLogEditor';
import { LogFilesProvider } from '../sidebar/logFilesProvider';
import { FrameDefinitionsProvider, PluginsProvider } from '../sidebar/projectProviders';
import { ProjectStore } from '../storage/projectStore';
import { FrameDefinitionEditor, type NewFramePrefill } from '../frame-editor/frameDefinitionEditor';
import { PluginManager } from '../plugins/pluginManager';
import { PluginEditor } from '../plugin-editor/pluginEditor';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const logFiles = new LogFilesProvider(context.workspaceState);
  const frames = new FrameDefinitionsProvider();
  const plugins = new PluginsProvider();
  const projectStore = new ProjectStore();
  await projectStore.load();
  const pluginManager = new PluginManager(projectStore);
  await pluginManager.sync();
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0];
  const projectWatcher = workspaceRoot ? vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(workspaceRoot, '.sigmixa/project.json')) : undefined;
  projectWatcher?.onDidChange(() => void projectStore.load());
  projectWatcher?.onDidCreate(() => void projectStore.load());
  const frameEditor = new FrameDefinitionEditor(context.extensionUri, projectStore);
  const pluginEditor = new PluginEditor(context.extensionUri, projectStore, pluginManager);
  const refreshProjectViews = () => {
    frames.setItems(projectStore.current.frames);
    plugins.setItems(projectStore.current.plugins);
  };
  refreshProjectViews();

  context.subscriptions.push(
    projectStore,
    ...(projectWatcher ? [projectWatcher] : []),
    frameEditor,
    pluginManager,
    pluginEditor,
    projectStore.onDidChange(() => void pluginManager.sync()),
    projectStore.onDidChange(refreshProjectViews),
    vscode.window.registerTreeDataProvider('sigmixa.logFiles', logFiles),
    vscode.window.registerTreeDataProvider('sigmixa.frames', frames),
    vscode.window.registerTreeDataProvider('sigmixa.plugins', plugins),
    vscode.window.registerCustomEditorProvider(
      'sigmixa.rawLog',
      new RawLogEditorProvider(context.extensionUri, logFiles, projectStore, frameEditor, pluginManager),
      { webviewOptions: { retainContextWhenHidden: true } }
    ),
    vscode.commands.registerCommand('sigmixa.openLog', async () => {
      const selected = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'CAN logs (ASC and experimental BLF)': ['asc', 'blf'] } });
      if (!selected?.[0]) return;
      await vscode.commands.executeCommand('vscode.openWith', selected[0], 'sigmixa.rawLog');
      await logFiles.add(selected[0].fsPath);
    }),
    vscode.commands.registerCommand('sigmixa.addFrame', (prefill?: NewFramePrefill) => frameEditor.create(prefill)),
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

export function deactivate(): void {
  // Documents own and cancel their active parser sessions.
}
