import * as vscode from 'vscode';
import { RawLogEditorProvider } from '../editors/rawLogEditor';
import { LogFilesProvider } from '../sidebar/logFilesProvider';
import { FrameDefinitionsProvider, PluginsProvider } from '../sidebar/projectProviders';
import { ProjectStore } from '../storage/projectStore';
import { FrameDefinitionEditor, type NewFramePrefill } from '../frame-editor/frameDefinitionEditor';
import { PluginManager } from '../plugins/pluginManager';
import { PluginEditor } from '../plugin-editor/pluginEditor';
import { exportDbc, importDbc } from '../../core/dbc/dbc';

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
  const dbcOutput = vscode.window.createOutputChannel('SigMixa DBC');
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
    dbcOutput,
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
          const answer = await vscode.window.showWarningMessage(`${conflicts.length} imported CAN Frame(s) already exist. Replace existing manual definitions or skip duplicates? Plugin-owned definitions are always preserved.`, { modal: true }, 'Replace Manual', 'Skip Duplicates');
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
