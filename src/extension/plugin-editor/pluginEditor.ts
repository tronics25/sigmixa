import * as vscode from 'vscode';
import type { Diagnostic } from '../../core/diagnostics/diagnostic';
import type { ProjectStore } from '../storage/projectStore';
import type { PluginManager } from '../plugins/pluginManager';
import { pluginEditorHtml } from './pluginEditorHtml';
import type { PluginEditorModel, PluginEditorToExtension, PluginEditorToWebview } from './pluginEditorProtocol';
import { formatCanId } from '../../core/frame/canId';

export class PluginEditor implements vscode.Disposable {
  private readonly panels = new Map<string, vscode.WebviewPanel>();
  private readonly subscription: vscode.Disposable;

  constructor(private readonly extensionUri: vscode.Uri, private readonly store: ProjectStore, private readonly manager: PluginManager) {
    this.subscription = store.onDidChange(() => { for (const [id, panel] of this.panels) void this.sendModel(id, panel); });
  }

  open(id: string): void {
    const registration = this.store.current.plugins.find((item) => item.id === id);
    if (!registration) { void vscode.window.showErrorMessage('Plugin registration was not found.'); return; }
    const existing = this.panels.get(id);
    if (existing) { existing.reveal(); void this.sendModel(id, existing); return; }
    const panel = vscode.window.createWebviewPanel('sigmixa.pluginConfiguration', `Plugin: ${id}`, vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true });
    panel.webview.html = pluginEditorHtml(panel.webview, this.extensionUri, id, vscode.env.language);
    this.panels.set(id, panel);
    panel.onDidDispose(() => this.panels.delete(id));
    panel.webview.onDidReceiveMessage((message: PluginEditorToExtension) => void this.receive(id, panel, message));
  }

  dispose(): void { this.subscription.dispose(); for (const panel of this.panels.values()) panel.dispose(); this.panels.clear(); }

  private async receive(id: string, panel: vscode.WebviewPanel, message: PluginEditorToExtension): Promise<void> {
    try {
      if (message.type === 'ready') await this.sendModel(id, panel);
      else if (message.type === 'setEnabled') await this.manager.setEnabled(id, message.enabled);
      else if (message.type === 'setBindingEnabled') await this.manager.setBindingEnabled(message.bindingId, message.enabled);
      else if (message.type === 'reload') { await this.manager.reload(id); await this.sendModel(id, panel); }
      else if (message.type === 'saveConfig') {
        const diagnostics = await this.manager.setConfig(id, message.config);
        await this.send(panel, { type: 'operationResult', diagnostics });
        await this.sendModel(id, panel);
      } else if (message.type === 'addBinding') await this.addBinding(id);
      else if (message.type === 'unregister') {
        const answer = await vscode.window.showWarningMessage(`Unregister Plugin “${id}”? Bindings and unused Plugin-owned Frames will be removed.`, { modal: true }, 'Unregister');
        if (answer === 'Unregister') { await this.manager.unregister(id); panel.dispose(); }
      }
    } catch (error) {
      const diagnostic: Diagnostic = { id: `plugin:${id}:operation`, source: 'plugin', code: 'PLUGIN_OPERATION_FAILED', severity: 'error', message: (error as Error).message, details: { pluginId: id } };
      await this.send(panel, { type: 'operationResult', diagnostics: [diagnostic] });
    }
  }

  private async addBinding(pluginId: string): Promise<void> {
    const bound = new Set(this.store.current.pluginBindings.filter((item) => item.pluginId === pluginId).map((item) => item.frameId));
    const choices = this.store.current.frames.filter((item) => !bound.has(item.id)).map((frame) => ({
      label: `${formatCanId(frame.canId, frame.extended)}  ${frame.name}`,
      frameId: frame.id,
    }));
    if (!choices.length) { void vscode.window.showInformationMessage('All registered CAN Frames are already bound to this Plugin.'); return; }
    const selected = await vscode.window.showQuickPick(choices, { title: `Bind ${pluginId} to a CAN Frame`, placeHolder: 'Select a registered Frame' });
    if (selected) await this.manager.addBinding(pluginId, selected.frameId);
  }

  private model(id: string): PluginEditorModel | undefined {
    const registration = this.store.current.plugins.find((item) => item.id === id);
    if (!registration) return undefined;
    const status = this.manager.status(id);
    return {
      registration: { ...registration, config: this.manager.runtimeConfig(id) ?? registration.config }, loaded: status.loaded, loadMessage: status.message, schema: status.schema, diagnostics: status.diagnostics,
      bindings: this.store.current.pluginBindings.filter((item) => item.pluginId === id).map((binding) => {
        const frame = this.store.current.frames.find((item) => item.id === binding.frameId);
        const frameLabel = frame ? `${formatCanId(frame.canId, frame.extended)}  ${frame.name}` : `Missing Frame: ${binding.frameId}`;
        return { id: binding.id, enabled: binding.enabled, automatic: binding.automatic, frameLabel };
      }),
    };
  }

  private async sendModel(id: string, panel: vscode.WebviewPanel): Promise<void> { const model = this.model(id); if (model) await this.send(panel, { type: 'init', model }); }
  private send(panel: vscode.WebviewPanel, message: PluginEditorToWebview): Thenable<boolean> { return panel.webview.postMessage(message); }
}
