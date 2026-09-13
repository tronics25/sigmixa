import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { ClipDefinition, FrameDefinitionStub, PluginRegistrationStub } from '../../core/project/schema';
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

export class ClipsProvider implements vscode.TreeDataProvider<ClipDefinition> {
  private readonly changes = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changes.event;
  private clips: readonly ClipDefinition[] = [];
  constructor(private readonly resolvePath: (clip: ClipDefinition) => string) {}
  setItems(clips: readonly ClipDefinition[]): void { this.clips = clips; this.changes.fire(); }
  getChildren(item?: ClipDefinition): ClipDefinition[] { return item ? [] : [...this.clips]; }
  getTreeItem(clip: ClipDefinition): vscode.TreeItem {
    const duration = Math.max(0, clip.endTimestamp - clip.startTimestamp);
    const item = new vscode.TreeItem(clip.name || `${path.basename(clip.sourceFileName)} clip`);
    item.id = clip.id; item.description = `${clip.sourceFileName} · ${duration.toFixed(3)} s`;
    item.tooltip = `${this.resolvePath(clip)}\n${clip.startTimestamp.toFixed(6)}–${clip.endTimestamp.toFixed(6)} s`;
    item.iconPath = new vscode.ThemeIcon(fs.existsSync(this.resolvePath(clip)) ? 'symbol-event' : 'warning');
    item.contextValue = fs.existsSync(this.resolvePath(clip)) ? 'sigmixa.clip' : 'sigmixa.clipMissing';
    item.command = { command: 'sigmixa.openClip', title: 'Open clip', arguments: [clip] };
    return item;
  }
}
