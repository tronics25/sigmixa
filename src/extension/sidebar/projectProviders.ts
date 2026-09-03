import * as vscode from 'vscode';
import type { FrameDefinitionStub, PluginRegistrationStub } from '../../core/project/schema';
import { formatCanId } from '../../core/frame/canId';

export class FrameDefinitionsProvider implements vscode.TreeDataProvider<FrameDefinitionStub> {
  private readonly changes = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changes.event;
  private frames: readonly FrameDefinitionStub[] = [];
  setItems(frames: readonly FrameDefinitionStub[]): void { this.frames = frames; this.changes.fire(); }
  getChildren(item?: FrameDefinitionStub): FrameDefinitionStub[] { return item ? [] : [...this.frames]; }
  getTreeItem(frame: FrameDefinitionStub): vscode.TreeItem {
    const id = formatCanId(frame.canId, frame.extended);
    const item = new vscode.TreeItem(frame.name ? `${id}  ${frame.name}` : id);
    item.iconPath = new vscode.ThemeIcon('symbol-struct');
    item.contextValue = frame.origin?.type === 'plugin' ? 'sigmixa.pluginFrame' : 'sigmixa.manualFrame';
    item.command = { command: 'sigmixa.openFrame', title: 'Open frame definition', arguments: [frame.id] };
    return item;
  }
}

export class PluginsProvider implements vscode.TreeDataProvider<PluginRegistrationStub> {
  private readonly changes = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changes.event;
  private plugins: readonly PluginRegistrationStub[] = [];
  setItems(plugins: readonly PluginRegistrationStub[]): void { this.plugins = plugins; this.changes.fire(); }
  getChildren(item?: PluginRegistrationStub): PluginRegistrationStub[] { return item ? [] : [...this.plugins]; }
  getTreeItem(plugin: PluginRegistrationStub): vscode.TreeItem {
    const item = new vscode.TreeItem(plugin.id);
    item.description = `${plugin.version}${plugin.enabled ? '' : ' (disabled)'}`;
    item.iconPath = new vscode.ThemeIcon(plugin.enabled ? 'extensions' : 'circle-slash');
    item.contextValue = 'sigmixa.plugin';
    item.command = { command: 'sigmixa.openPlugin', title: 'Open plugin configuration', arguments: [plugin.id] };
    return item;
  }
}
