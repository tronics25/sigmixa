/**
 * A stand-in for the `vscode` module that runs the whole extension outside VS Code, so the UI tests can activate it,
 * open its screens in a real browser and press what a user presses.
 *
 * Everything a test needs to see is recorded on `host`: the messages shown, the commands run, the files written through
 * VS Code. Questions VS Code would ask the user (quick picks, save dialogs, input boxes) are answered by `host.answer`.
 */
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

type Listener<T> = (value: T) => unknown;

export class Disposable {
  constructor(private readonly callOnDispose: () => unknown = () => undefined) {}
  static from(...items: { dispose(): unknown }[]): Disposable { return new Disposable(() => { for (const item of items) item.dispose(); }); }
  dispose(): void { this.callOnDispose(); }
}

export class EventEmitter<T> {
  private listeners: Listener<T>[] = [];
  readonly event = (listener: Listener<T>): Disposable => {
    this.listeners.push(listener);
    return new Disposable(() => { this.listeners = this.listeners.filter((item) => item !== listener); });
  };
  fire(value: T): void { for (const listener of [...this.listeners]) listener(value); }
  dispose(): void { this.listeners = []; }
}

export class Uri {
  readonly path: string;
  constructor(readonly scheme: string, readonly authority: string, uriPath: string, readonly query: string, readonly fragment: string) { this.path = uriPath; }
  get fsPath(): string { return this.path; }
  static file(filePath: string): Uri { return new Uri('file', '', path.resolve(filePath), '', ''); }
  static joinPath(base: Uri, ...parts: string[]): Uri { return new Uri(base.scheme, base.authority, path.posix.join(base.path, ...parts), base.query, base.fragment); }
  static from(parts: { scheme: string; authority?: string; path?: string; query?: string; fragment?: string }): Uri { return new Uri(parts.scheme, parts.authority ?? '', parts.path ?? '', parts.query ?? '', parts.fragment ?? ''); }
  static parse(value: string): Uri {
    const match = /^([a-zA-Z][\w+.-]*):(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(value);
    if (!match) throw new Error(`Not a URI: ${value}`);
    return new Uri(match[1], match[2] ?? '', decodeURIComponent(match[3]), match[4] ?? '', match[5] !== undefined ? decodeURIComponent(match[5]) : '');
  }
  with(change: { scheme?: string; authority?: string; path?: string; query?: string; fragment?: string }): Uri {
    return new Uri(change.scheme ?? this.scheme, change.authority ?? this.authority, change.path ?? this.path, change.query ?? this.query, change.fragment ?? this.fragment);
  }
  toString(): string { return `${this.scheme}://${this.authority}${encodeURI(this.path)}${this.query ? `?${this.query}` : ''}${this.fragment ? `#${encodeURIComponent(this.fragment)}` : ''}`; }
  toJSON(): unknown { return { scheme: this.scheme, path: this.path, query: this.query, fragment: this.fragment }; }
}

export class FileSystemError extends Error {
  constructor(readonly code: string, message?: string) { super(message ?? code); }
  static FileNotFound(target?: unknown): FileSystemError { return new FileSystemError('FileNotFound', String(target ?? '')); }
  static NoPermissions(target?: unknown): FileSystemError { return new FileSystemError('NoPermissions', String(target ?? '')); }
  static FileExists(target?: unknown): FileSystemError { return new FileSystemError('FileExists', String(target ?? '')); }
  static Unavailable(target?: unknown): FileSystemError { return new FileSystemError('Unavailable', String(target ?? '')); }
}
export enum FileType { Unknown = 0, File = 1, Directory = 2, SymbolicLink = 64 }
export enum FilePermission { Readonly = 1 }
export enum ViewColumn { Active = -1, Beside = -2, One = 1, Two = 2 }
export enum TreeItemCollapsibleState { None = 0, Collapsed = 1, Expanded = 2 }
export enum FileChangeType { Changed = 1, Created = 2, Deleted = 3 }
export enum ProgressLocation { SourceControl = 1, Window = 10, Notification = 15 }
export class ThemeIcon { constructor(readonly id: string, readonly color?: ThemeColor) {} static readonly File = new ThemeIcon('file'); static readonly Folder = new ThemeIcon('folder'); }
export class ThemeColor { constructor(readonly id: string) {} }
export class TreeItem { [key: string]: unknown; constructor(readonly label: unknown, readonly collapsibleState?: TreeItemCollapsibleState) {} }
export class RelativePattern { constructor(readonly base: unknown, readonly pattern: string) {} }
export class MarkdownString { constructor(public value = '') {} appendMarkdown(text: string): this { this.value += text; return this; } appendText(text: string): this { this.value += text; return this; } }
export class DataTransferItem { constructor(readonly value: unknown) {} asString(): Promise<string> { return Promise.resolve(typeof this.value === 'string' ? this.value : JSON.stringify(this.value)); } asFile(): undefined { return undefined; } }
export class DataTransfer {
  private readonly items = new Map<string, DataTransferItem>();
  get(mime: string): DataTransferItem | undefined { return this.items.get(mime); }
  set(mime: string, item: DataTransferItem): void { this.items.set(mime, item); }
  forEach(callback: (item: DataTransferItem, mime: string) => void): void { this.items.forEach(callback); }
}
export class WorkspaceEdit {
  readonly renames: { from: Uri; to: Uri }[] = [];
  renameFile(from: Uri, to: Uri): void { this.renames.push({ from, to }); }
  createFile(): void { /* not used by the UI tests */ }
  deleteFile(): void { /* not used by the UI tests */ }
}
export class CancellationTokenSource { readonly token = { isCancellationRequested: false, onCancellationRequested: () => new Disposable() }; cancel(): void { this.token.isCancellationRequested = true; } dispose(): void { /* nothing held */ } }

/** One question VS Code would put to the user, as the extension asked it. */
export interface Question { readonly kind: 'quickPick' | 'saveDialog' | 'openDialog' | 'inputBox' | 'warning' | 'information' | 'error'; readonly title?: string; readonly items?: readonly unknown[]; readonly message?: string }
/** How a test answers a question: a value to return, or a function of the question. Unanswered questions are cancelled. */
export type Answer = (question: Question) => unknown;

export interface FakeWebview {
  html: string;
  options: unknown;
  readonly cspSource: string;
  asWebviewUri(uri: Uri): Uri;
  postMessage(message: unknown): Promise<boolean>;
  readonly onDidReceiveMessage: (listener: Listener<unknown>) => Disposable;
  /** What the page sends; called by the browser bridge. */
  receive(message: unknown): void;
}

export class FakePanel {
  title: string;
  visible = true;
  active = true;
  viewColumn = ViewColumn.One;
  disposed = false;
  readonly webview: FakeWebview;
  private readonly received = new EventEmitter<unknown>();
  private readonly disposeEmitter = new EventEmitter<void>();
  private readonly stateEmitter = new EventEmitter<unknown>();
  readonly onDidDispose = this.disposeEmitter.event;
  readonly onDidChangeViewState = this.stateEmitter.event;
  /** Messages the extension sent to the page, in order. */
  readonly sent: unknown[] = [];
  constructor(readonly viewType: string, title: string) {
    this.title = title;
    let html = '';
    const panel = this;
    this.webview = {
      get html() { return html; },
      set html(value: string) { html = value; host.htmlChanged.fire(panel); },
      options: {},
      cspSource: 'https://sigmixa.test',
      asWebviewUri: (uri: Uri) => Uri.parse(`https://sigmixa.test/${path.relative(host.extensionPath, uri.fsPath).split(path.sep).join('/')}`),
      postMessage: (message: unknown) => { if (panel.disposed) return Promise.resolve(false); panel.sent.push(message); host.toPage.fire({ panel, message }); return Promise.resolve(true); },
      onDidReceiveMessage: this.received.event,
      receive: (message: unknown) => { if (!panel.disposed) panel.received.fire(message); },
    };
  }
  reveal(): void { this.visible = true; }
  dispose(): void { if (this.disposed) return; this.disposed = true; this.disposeEmitter.fire(); host.panelClosed.fire(this); }
}

export interface TreeProvider { getChildren(element?: unknown): unknown; getTreeItem(element: unknown): unknown }
interface CustomEditorProvider { openCustomDocument(uri: Uri, context: unknown, token: unknown): unknown; resolveCustomEditor(document: unknown, panel: FakePanel, token: unknown): unknown }

/** What the extension did, for the tests to look at, and how its questions are answered. */
export const host = {
  extensionPath: '',
  language: 'en',
  messages: [] as { kind: 'error' | 'warning' | 'information'; text: string }[],
  questions: [] as Question[],
  commandsRun: [] as { id: string; args: unknown[] }[],
  answer: undefined as Answer | undefined,
  clipboard: '',
  commands: new Map<string, (...args: unknown[]) => unknown>(),
  editors: new Map<string, CustomEditorProvider>(),
  trees: new Map<string, { id: string; selection: unknown[]; treeDataProvider: TreeProvider }>(),
  panels: [] as FakePanel[],
  htmlChanged: new EventEmitter<FakePanel>(),
  toPage: new EventEmitter<{ panel: FakePanel; message: unknown }>(),
  panelClosed: new EventEmitter<FakePanel>(),
  workspaceState: new Map<string, unknown>(),
  opened: [] as { uri: Uri; viewType: string }[],
  textDocuments: [] as { uri?: Uri; content?: string }[],
  externalLinks: [] as string[],
  /** The file patterns the extension watches. */
  watched: [] as string[],
  reset(): void { this.messages.length = 0; this.questions.length = 0; this.commandsRun.length = 0; this.answer = undefined; },
};

function ask(question: Question): unknown {
  host.questions.push(question);
  return host.answer?.(question);
}

function show(kind: 'error' | 'warning' | 'information', text: string, rest: unknown[]): Promise<unknown> {
  host.messages.push({ kind, text });
  const items = rest.filter((item) => typeof item === 'string' || (item && typeof item === 'object' && 'title' in (item as object)));
  if (!items.length) return Promise.resolve(undefined);
  return Promise.resolve(ask({ kind, message: text, items }));
}

const wrap = async <T>(action: () => Promise<T>): Promise<T> => {
  try { return await action(); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new FileSystemError('FileNotFound', (error as Error).message); throw error; }
};

/** A file watcher: told of what the extension itself writes, moves and deletes, as VS Code's watchers are. */
class Watcher {
  private readonly emitters = [new EventEmitter<Uri>(), new EventEmitter<Uri>(), new EventEmitter<Uri>()];
  onDidChange = this.emitters[0].event; onDidCreate = this.emitters[1].event; onDidDelete = this.emitters[2].event;
  constructor(private readonly base: string | undefined, private readonly pattern: string) { watchers.add(this); }
  notify(kind: 'change' | 'create' | 'delete', file: string): void {
    const relative = this.base ? path.relative(this.base, file) : file;
    if (relative.startsWith('..') || !path.matchesGlob(relative.split(path.sep).join('/'), this.pattern)) return;
    this.emitters[kind === 'change' ? 0 : kind === 'create' ? 1 : 2].fire(Uri.file(file));
  }
  dispose(): void { watchers.delete(this); }
}
const watchers = new Set<Watcher>();
const renamed = new EventEmitter<{ files: { oldUri: Uri; newUri: Uri }[] }>();
/** Tells the watchers, a moment later as VS Code does. */
const changed = (kind: 'change' | 'create' | 'delete', ...files: string[]) => { setTimeout(() => { for (const file of files) for (const watcher of [...watchers]) watcher.notify(kind, file); }, 10); };

export const workspace = {
  workspaceFolders: undefined as { uri: Uri; name: string; index: number }[] | undefined,
  fs: {
    readFile: (uri: Uri) => wrap(async () => new Uint8Array(await fsp.readFile(uri.fsPath))),
    writeFile: (uri: Uri, data: Uint8Array) => wrap(async () => { await fsp.mkdir(path.dirname(uri.fsPath), { recursive: true }); const existed = fs.existsSync(uri.fsPath); await fsp.writeFile(uri.fsPath, data); changed(existed ? 'change' : 'create', uri.fsPath); }),
    stat: (uri: Uri) => wrap(async () => { const stat = await fsp.stat(uri.fsPath); return { type: stat.isDirectory() ? FileType.Directory : FileType.File, size: stat.size, mtime: stat.mtimeMs, ctime: stat.ctimeMs }; }),
    readDirectory: (uri: Uri) => wrap(async () => (await fsp.readdir(uri.fsPath, { withFileTypes: true })).map((entry) => [entry.name, entry.isDirectory() ? FileType.Directory : FileType.File] as [string, FileType])),
    createDirectory: (uri: Uri) => wrap(async () => { await fsp.mkdir(uri.fsPath, { recursive: true }); changed('create', uri.fsPath); }),
    rename: (from: Uri, to: Uri, options?: { overwrite?: boolean }) => wrap(async () => { if (!options?.overwrite && fs.existsSync(to.fsPath)) throw FileSystemError.FileExists(to.fsPath); await fsp.rename(from.fsPath, to.fsPath); changed('delete', from.fsPath); changed('create', to.fsPath); }),
    copy: (from: Uri, to: Uri) => wrap(async () => { await fsp.cp(from.fsPath, to.fsPath, { recursive: true }); changed('create', to.fsPath); }),
    delete: (uri: Uri, options?: { recursive?: boolean }) => wrap(async () => { await fsp.rm(uri.fsPath, { recursive: !!options?.recursive }); changed('delete', uri.fsPath); }),
  },
  createFileSystemWatcher: (pattern: string | RelativePattern) => { host.watched.push(typeof pattern === 'string' ? pattern : pattern.pattern); return typeof pattern === 'string' ? new Watcher(undefined, pattern) : new Watcher((pattern.base as Uri | { uri?: Uri } | string | undefined) instanceof Uri ? (pattern.base as Uri).fsPath : typeof pattern.base === 'string' ? pattern.base : (pattern.base as { uri?: Uri } | undefined)?.uri?.fsPath, pattern.pattern); },
  onDidRenameFiles: renamed.event,
  onDidChangeConfiguration: new EventEmitter<unknown>().event,
  onDidChangeWorkspaceFolders: new EventEmitter<unknown>().event,
  getConfiguration: () => ({ get: <T>(_key: string, fallback?: T) => fallback, has: () => false, update: () => Promise.resolve() }),
  registerFileSystemProvider: () => new Disposable(),
  openTextDocument: async (value: Uri | { content?: string; language?: string }) => { const document = value instanceof Uri ? { uri: value } : { content: value.content }; host.textDocuments.push(document); return document; },
  applyEdit: async (edit: WorkspaceEdit) => { for (const { from, to } of edit.renames) { await fsp.mkdir(path.dirname(to.fsPath), { recursive: true }); await fsp.rename(from.fsPath, to.fsPath); changed('delete', from.fsPath); changed('create', to.fsPath); } if (edit.renames.length) setTimeout(() => renamed.fire({ files: edit.renames.map(({ from, to }) => ({ oldUri: from, newUri: to })) }), 0); return true; },
  asRelativePath: (value: Uri | string) => { const root = workspace.workspaceFolders?.[0]?.uri.fsPath; const file = typeof value === 'string' ? value : value.fsPath; return root ? path.relative(root, file) : file; },
};

export const window = {
  showErrorMessage: (text: string, ...rest: unknown[]) => show('error', text, rest),
  showWarningMessage: (text: string, ...rest: unknown[]) => show('warning', text, rest),
  showInformationMessage: (text: string, ...rest: unknown[]) => show('information', text, rest),
  showQuickPick: async (items: unknown, options?: { title?: string; placeHolder?: string; canPickMany?: boolean }) => ask({ kind: 'quickPick', title: options?.title ?? options?.placeHolder, items: await items as unknown[] }),
  showSaveDialog: async (options?: { title?: string; defaultUri?: Uri }) => ask({ kind: 'saveDialog', title: options?.title, items: options?.defaultUri ? [options.defaultUri] : [] }),
  showOpenDialog: async (options?: { title?: string }) => ask({ kind: 'openDialog', title: options?.title }),
  showInputBox: async (options?: { title?: string; prompt?: string; value?: string }) => ask({ kind: 'inputBox', title: options?.title ?? options?.prompt, items: options?.value !== undefined ? [options.value] : [] }),
  showTextDocument: async (document: unknown) => document,
  createWebviewPanel: (viewType: string, title: string) => { const panel = new FakePanel(viewType, title); host.panels.push(panel); return panel; },
  registerCustomEditorProvider: (viewType: string, provider: CustomEditorProvider) => { host.editors.set(viewType, provider); return new Disposable(() => host.editors.delete(viewType)); },
  createTreeView: (id: string, options: { treeDataProvider: TreeProvider }) => { const view = { id, selection: [] as unknown[], visible: true, treeDataProvider: options.treeDataProvider, onDidChangeSelection: new EventEmitter<unknown>().event, onDidChangeVisibility: new EventEmitter<unknown>().event, onDidExpandElement: new EventEmitter<unknown>().event, onDidCollapseElement: new EventEmitter<unknown>().event, reveal: () => Promise.resolve(), dispose: () => undefined }; host.trees.set(id, view); return view; },
  createOutputChannel: () => ({ append: () => undefined, appendLine: () => undefined, clear: () => undefined, show: () => undefined, dispose: () => undefined }),
  withProgress: async <T>(_options: unknown, task: (progress: { report(value: unknown): void }, token: unknown) => Promise<T>) => task({ report: () => undefined }, new CancellationTokenSource().token),
  setStatusBarMessage: () => new Disposable(),
  get activeTextEditor() { return undefined; },
};

/** Opens a log the way VS Code opens a custom editor: the provider reads it and fills a new panel. */
async function openWith(uri: Uri, viewType: string): Promise<void> {
  const provider = host.editors.get(viewType);
  host.opened.push({ uri, viewType });
  if (!provider) throw new Error(`No editor for ${viewType}`);
  const document = await provider.openCustomDocument(uri, {}, new CancellationTokenSource().token);
  const panel = new FakePanel(viewType, path.basename(uri.path));
  host.panels.push(panel);
  await provider.resolveCustomEditor(document, panel, new CancellationTokenSource().token);
  panel.onDidDispose(() => (document as { dispose?(): void }).dispose?.());
}

export const commands = {
  registerCommand: (id: string, callback: (...args: unknown[]) => unknown) => { host.commands.set(id, callback); return new Disposable(() => host.commands.delete(id)); },
  executeCommand: async (id: string, ...args: unknown[]) => {
    host.commandsRun.push({ id, args });
    if (id === 'vscode.openWith') return openWith(args[0] as Uri, args[1] as string);
    const command = host.commands.get(id);
    if (command) return command(...args);
    return undefined; // VS Code's own commands (setContext, revealInExplorer, ...) have nothing to do here.
  },
  getCommands: async () => [...host.commands.keys()],
};

export const env = {
  get language() { return host.language; },
  clipboard: { readText: async () => host.clipboard, writeText: async (text: string) => { host.clipboard = text; } },
  openExternal: async (uri: Uri) => { host.externalLinks.push(uri.toString()); return true; },
  appName: 'SigMixa UI test',
  uiKind: 1,
};

export const extensions = { getExtension: () => undefined, all: [] };
export const l10n = { t: (message: string) => message };
export const version = '1.99.0';
