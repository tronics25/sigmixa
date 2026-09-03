import * as vscode from 'vscode';
import { emptyProject, migrateProject, parseProjectJson, serializeProject, type SigMixaProject } from '../../core/project/schema';

const PROJECT_DIRECTORY = '.sigmixa';
const PROJECT_FILE = 'project.json';

export class ProjectStore implements vscode.Disposable {
  private project: SigMixaProject = emptyProject();
  private revisionValue = 0;
  private frameRevisionValue = 0;
  private frameSignature = '';
  private analysisRevisionValue = 0;
  private analysisSignature = '';
  private writeChain = Promise.resolve();
  private readonly changes = new vscode.EventEmitter<SigMixaProject>();
  readonly onDidChange = this.changes.event;

  get current(): SigMixaProject { return this.project; }
  get revision(): number { return this.revisionValue; }
  get frameRevision(): number { return this.frameRevisionValue; }
  get analysisRevision(): number { return this.analysisRevisionValue; }

  async load(): Promise<SigMixaProject> {
    const file = this.projectUri();
    if (!file) {
      this.setCurrent(emptyProject());
      return this.project;
    }
    try {
      const bytes = await vscode.workspace.fs.readFile(file);
      this.setCurrent(parseProjectJson(new TextDecoder().decode(bytes)));
    } catch (error) {
      if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') this.setCurrent(emptyProject());
      else {
        this.setCurrent(emptyProject());
        const backup = vscode.Uri.joinPath(file, '..', `${PROJECT_FILE}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}.bak`);
        try {
          await vscode.workspace.fs.copy(file, backup, { overwrite: false });
          void vscode.window.showErrorMessage(`Could not load .sigmixa/project.json. An unchanged recovery copy was saved as ${pathBaseName(backup.path)}. ${(error as Error).message}`);
        } catch {
          void vscode.window.showErrorMessage(`Could not load .sigmixa/project.json and a recovery copy could not be created. ${(error as Error).message}`);
        }
      }
    }
    return this.project;
  }

  async update(mutator: (project: SigMixaProject) => SigMixaProject): Promise<SigMixaProject> {
    let result = this.project;
    this.writeChain = this.writeChain.catch(() => undefined).then(async () => {
      result = migrateProject(mutator(this.project));
      await this.write(result);
      this.setCurrent(result);
    });
    await this.writeChain;
    return result;
  }

  requireWorkspace(): vscode.Uri | undefined {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) void vscode.window.showErrorMessage('Open a workspace folder before saving SigMixa definitions.');
    return root;
  }

  dispose(): void { this.changes.dispose(); }

  private projectUri(): vscode.Uri | undefined {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    return root ? vscode.Uri.joinPath(root, PROJECT_DIRECTORY, PROJECT_FILE) : undefined;
  }

  private async write(project: SigMixaProject): Promise<void> {
    const root = this.requireWorkspace();
    if (!root) throw new Error('A workspace folder is required.');
    const directory = vscode.Uri.joinPath(root, PROJECT_DIRECTORY);
    const target = vscode.Uri.joinPath(directory, PROJECT_FILE);
    const temporary = vscode.Uri.joinPath(directory, `${PROJECT_FILE}.tmp`);
    await vscode.workspace.fs.createDirectory(directory);
    await vscode.workspace.fs.writeFile(temporary, new TextEncoder().encode(`${JSON.stringify(serializeProject(project), null, 2)}\n`));
    await vscode.workspace.fs.rename(temporary, target, { overwrite: true });
  }

  private setCurrent(project: SigMixaProject): void {
    const nextFrameSignature = JSON.stringify(project.frames);
    if (nextFrameSignature !== this.frameSignature) {
      this.frameSignature = nextFrameSignature;
      this.frameRevisionValue++;
    }
    const nextAnalysisSignature = JSON.stringify([project.frames, project.plugins, project.pluginBindings, project.externalCsvSources]);
    if (nextAnalysisSignature !== this.analysisSignature) {
      this.analysisSignature = nextAnalysisSignature;
      this.analysisRevisionValue++;
    }
    this.project = project;
    this.revisionValue++;
    this.changes.fire(project);
  }
}

function pathBaseName(value: string): string { return value.slice(Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\')) + 1); }
