import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const RECENT_KEY = 'sigmixa.recentLogs';

export class LogFilesProvider implements vscode.TreeDataProvider<string> {
  private readonly changes = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changes.event;

  constructor(private readonly state: vscode.Memento) {}

  refresh(): void { this.changes.fire(); }

  async add(filePath: string): Promise<void> {
    const current = this.state.get<string[]>(RECENT_KEY, []);
    await this.state.update(RECENT_KEY, [filePath, ...current.filter((item) => item !== filePath)].slice(0, 12));
    this.refresh();
  }

  getTreeItem(filePath: string): vscode.TreeItem {
    const item = new vscode.TreeItem(path.basename(filePath), vscode.TreeItemCollapsibleState.None);
    item.description = filePath;
    item.tooltip = filePath;
    item.iconPath = new vscode.ThemeIcon('file-binary');
    item.command = { command: 'vscode.openWith', title: 'Open CAN log', arguments: [vscode.Uri.file(filePath), 'sigmixa.rawLog'] };
    return item;
  }

  getChildren(element?: string): string[] {
    return element ? [] : this.state.get<string[]>(RECENT_KEY, []).filter((item) => fs.existsSync(item));
  }
}
