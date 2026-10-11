import { createHash } from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { CURRENT_PROJECT_SCHEMA_VERSION, emptyProject, migrateProject, parseProjectJson, serializeProject, type AnalysisGroup, type ClipDefinition, type SigMixaProject } from '../../core/project/schema';
import { clipViewKey, composeWorkspace, addedLogsOf, GROUP_VIEW_KEY, LEVEL_DIRECTORY, LEVEL_FILE, locationLevel, logViewKey, parseLogViewKey, splitWorkspace, type LevelFile, type WorkspaceLog } from '../../core/project/folderLevels';
import { findClip, type ClipRef, type LogMove } from '../../core/project/clipIdentity';
import { scanWorkspace } from './workspaceScan';

/**
 * Loads and saves the folder-based levels: every folder holding a `.sigmixa` folder keeps its own
 * `.sigmixa/project.json`. The rest of the extension sees them composed into one project (`current`).
 */
export class ProjectStore implements vscode.Disposable {
  private project: SigMixaProject = emptyProject();
  private levelFolders: readonly string[] = [''];
  private workspaceLogs: readonly WorkspaceLog[] = [];
  /** The text last read from or written to each level's file, so unchanged levels are never rewritten. */
  private readonly written = new Map<string, string>();
  /** Levels whose file could not be read: never written, so the original stays recoverable. */
  private readonly failed = new Set<string>();
  /** Analysis groups of the former single-file format, kept untouched in the root file until they are migrated to folders. */
  private legacyGroups: readonly AnalysisGroup[] = [];
  private revisionValue = 0;
  private frameRevisionValue = 0;
  private frameSignature = '';
  private analysisRevisionValue = 0;
  private analysisSignature = '';
  private writeChain = Promise.resolve();
  private readonly migrationBytes = new Map<string, Uint8Array>();
  private readonly changes = new vscode.EventEmitter<SigMixaProject>();
  readonly onDidChange = this.changes.event;

  get current(): SigMixaProject { return this.project; }
  get revision(): number { return this.revisionValue; }
  get frameRevision(): number { return this.frameRevisionValue; }
  get analysisRevision(): number { return this.analysisRevisionValue; }
  /** True while a change is being reported that came from reading the level files, not from an edit made here. */
  get changeIsFromDisk(): boolean { return this.readingDisk; }
  private readingDisk = false;
  get levels(): readonly string[] { return this.levelFolders; }
  get logs(): readonly WorkspaceLog[] { return this.workspaceLogs; }
  get legacyGroupCount(): number { return this.legacyGroups.length; }
  /** Logs opened from outside the workspace by an older version (its recent-logs list), so their view settings carry over. */
  private externalLogHints: readonly string[] = [];
  setExternalLogHints(paths: readonly string[]): void { this.externalLogHints = paths; }

  private readonly logMoves = new vscode.EventEmitter<readonly LogMove[]>();
  /**
   * Logs or folders were moved or renamed here (paths as the project has them). Fired once, before the project shows the
   * move, so whoever holds the path of a log rewrites it first and never sees its Clips missing in between.
   */
  readonly onDidMoveLogs = this.logMoves.event;
  /** While a move is followed, the steps in between are not shown: the project is published once, as it is at the end. */
  private quiet = 0; private unpublished = false; private unpublishedFromDisk = false;

  /** Reads every level again. Unchanged files are not reported as a change. */
  async load(): Promise<SigMixaProject> {
    const root = this.root();
    if (!root) { this.setCurrent(emptyProject()); return this.project; }
    let result = this.project;
    this.writeChain = this.writeChain.catch(() => undefined).then(async () => { result = await this.read(root); });
    await this.writeChain;
    return result;
  }

  private async read(root: vscode.Uri): Promise<SigMixaProject> {
    const scan = await scanWorkspace(root.fsPath);
    const levels: LevelFile[] = [];
    this.failed.clear(); this.legacyGroups = [];
    for (const folder of scan.levels) {
      const file = this.levelUri(folder);
      try {
        const bytes = await vscode.workspace.fs.readFile(file); const text = new TextDecoder().decode(bytes); const issues: string[] = [];
        const parsed = parseProjectJson(text, issues);
        this.written.set(folder, text);
        // A file from an older version (e.g. 1.0.1) is backed up before it is first saved in the current format.
        if (Number(record(JSON.parse(text)).schemaVersion) < CURRENT_PROJECT_SCHEMA_VERSION) this.migrationBytes.set(folder, bytes);
        if (issues.length) { this.migrationBytes.set(folder, bytes); void vscode.window.showWarningMessage(`Skipped ${issues.length} invalid entr${issues.length === 1 ? 'y' : 'ies'} in ${this.label(folder)}. The original file is backed up before the next save. ${issues.join('; ')}`); }
        if (!folder) this.legacyGroups = parsed.analysisGroups ?? [];
        const converted = folder ? parsed : this.withConvertedLegacyKeys(parsed, scan.logs, root.fsPath);
        if (converted !== parsed) this.migrationBytes.set(folder, bytes);
        levels.push({ folder, project: converted });
      } catch (error) {
        if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') { this.written.delete(folder); levels.push({ folder, project: emptyProject() }); continue; }
        this.failed.add(folder); levels.push({ folder, project: emptyProject() });
        const backup = vscode.Uri.joinPath(file, '..', `${LEVEL_FILE}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}.bak`);
        try { await vscode.workspace.fs.copy(file, backup, { overwrite: false }); void vscode.window.showErrorMessage(`Could not load ${this.label(folder)}. An unchanged recovery copy was saved as ${path.basename(backup.path)}. ${(error as Error).message}`); }
        catch { void vscode.window.showErrorMessage(`Could not load ${this.label(folder)} and a recovery copy could not be created. ${(error as Error).message}`); }
      }
    }
    // A log added to a level appears there as well as where it is, like a shortcut.
    const added: WorkspaceLog[] = [];
    for (const log of addedLogsOf(levels)) { const located = this.locateIn(root.fsPath, log.path); if (!added.some((item) => item.path === located && item.level === log.level)) added.push({ path: located, level: log.level }); }
    const logs = [...scan.logs, ...added];
    this.levelFolders = scan.levels; this.workspaceLogs = logs;
    this.readingDisk = true;
    try { this.setCurrent(composeWorkspace(levels, logs)); } finally { this.readingDisk = false; }
    return this.project;
  }

  async update(mutator: (project: SigMixaProject) => SigMixaProject): Promise<SigMixaProject> {
    let result = this.project;
    this.writeChain = this.writeChain.catch(() => undefined).then(async () => {
      // A level file changed on disk since it was read (another window, a sync, a script) is read again first, so the
      // change is applied on top of it instead of overwriting it.
      const root = this.root(); if (root && await this.changedOnDisk()) await this.read(root);
      result = migrateProject(mutator(this.project));
      await this.write(result);
      this.setCurrent(result);
    });
    await this.writeChain;
    return result;
  }

  private async changedOnDisk(): Promise<boolean> {
    for (const folder of this.levelFolders) {
      if (this.failed.has(folder)) continue;
      let text: string | undefined;
      try { text = new TextDecoder().decode(await vscode.workspace.fs.readFile(this.levelUri(folder))); } catch { text = undefined; }
      if (text !== this.written.get(folder)) return true;
    }
    return false;
  }

  requireWorkspace(): vscode.Uri | undefined {
    const root = this.root();
    if (!root) void vscode.window.showErrorMessage('Open a workspace folder before saving SigMixa definitions.');
    return root;
  }

  /** How a log is referred to: its workspace-relative path with '/', or its absolute path when it is outside the workspace. */
  locate(fsPath: string): string {
    const root = this.root()?.fsPath; const resolved = path.resolve(fsPath);
    if (!root) return fsPath;
    return this.locateIn(root, resolved);
  }
  private locateIn(root: string, file: string): string {
    const absolute = path.isAbsolute(file) ? file : path.join(root, file); const relative = path.relative(root, absolute);
    return relative.startsWith('..') || path.isAbsolute(relative) ? absolute : relative.split(path.sep).join('/');
  }
  /** The level a log's location gives it ('' = common, also for a log outside the workspace). */
  levelOfFile(fsPath: string): string { return locationLevel(this.levelFolders, this.locate(fsPath)) ?? ''; }
  /**
   * The level a log or Clip was opened from, which decides its definitions and view settings: the level named in the URI
   * (opened from a group the log was added to), or else the level of the log's location.
   */
  levelOfUri(uri: vscode.Uri | string): string {
    if (typeof uri === 'string') return this.levelOfFile(uri);
    const named = /(?:^|&)sigmixa-level=([^&]*)/.exec(uri.fragment); if (named) { const level = decodeURIComponent(named[1]); if (!level || this.levelFolders.includes(level)) return level; }
    return this.levelOfFile(uri.fsPath);
  }
  /** The URI that opens a log from `level`: the plain file where it is, or the file with the level named for an added log. */
  logUri(fsPath: string, level: string): vscode.Uri {
    const uri = vscode.Uri.file(fsPath); return level === this.levelOfFile(fsPath) && !path.isAbsolute(this.locate(fsPath)) ? uri : uri.with({ fragment: `sigmixa-level=${encodeURIComponent(level)}` });
  }
  /**
   * Adds logs to a level, like shortcuts: they then also appear in that level and, opened from there, use its definitions.
   * A log already in that level (by location or added before) is left as it is. Nothing is created next to the logs.
   */
  async addLogs(level: string, files: readonly string[]): Promise<void> {
    const listed = (file: string) => this.workspaceLogs.some((log) => log.level === level && log.path === file);
    const located = [...new Set(files.map((file) => this.locate(file)))].filter((file) => !listed(file) && (path.isAbsolute(file) || locationLevel(this.levelFolders, file) !== level));
    if (!located.length) return;
    // The level files are written from the composed project, so the new entries must be known as logs before the split.
    this.workspaceLogs = [...this.workspaceLogs, ...located.map((file) => ({ path: file, level }))];
    await this.update((project) => level ? { ...project, analysisGroups: project.analysisGroups?.map((group) => group.id === level ? { ...group, addedLogs: [...new Set([...(group.addedLogs ?? []), ...located])] } : group) }
      : { ...project, addedLogs: [...new Set([...(project.addedLogs ?? []), ...located])] });
    await this.load();
  }
  /** Takes an added log off `level`; the file and its other places are untouched. */
  async removeAddedLog(file: string, level: string): Promise<void> {
    const target = this.locate(file); const keep = (list?: readonly string[]) => list?.filter((item) => item !== target);
    await this.update((project) => level ? { ...project, analysisGroups: project.analysisGroups?.map((group) => group.id === level ? { ...group, addedLogs: keep(group.addedLogs) } : group) } : { ...project, addedLogs: keep(project.addedLogs) });
    await this.load();
  }
  /** The key of a log's view settings for the place it was opened from. A Clip uses the settings of its log there. */
  viewKey(uri: vscode.Uri | string): string {
    return logViewKey(this.levelFolders, this.locate(typeof uri === 'string' ? uri : uri.fsPath), this.levelOfUri(uri));
  }
  private absolute(located: string): string { const root = this.root()?.fsPath ?? ''; return path.isAbsolute(located) ? located : path.join(root, ...located.split('/')); }
  /** The workspace folder a level lives in. */
  levelFolderUri(folder: string): vscode.Uri | undefined { const root = this.root(); return root && (folder ? vscode.Uri.joinPath(root, ...folder.split('/')) : root); }

  /** Makes `folder` a level by creating its `.sigmixa/project.json`. */
  async createLevel(folder: vscode.Uri): Promise<void> {
    const file = vscode.Uri.joinPath(folder, LEVEL_DIRECTORY, LEVEL_FILE);
    const exists = await vscode.workspace.fs.stat(file).then(() => true, () => false);
    if (!exists) { await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder, LEVEL_DIRECTORY)); await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(`${JSON.stringify(levelJson(emptyProject()), null, 2)}\n`)); }
    await this.load();
  }

  /**
   * After logs or folders were renamed or moved inside the workspace, points Clips and per-log view settings at the new
   * locations. The workspace is read again first, so levels are written to the folders as they are now.
   */
  async followRenames(pairs: readonly { readonly from: string; readonly to: string }[]): Promise<void> {
    const announced = pairs.map((pair) => ({ from: this.locate(pair.from), to: this.locate(pair.to) })).filter((move) => move.from !== move.to && !path.isAbsolute(move.to) && !path.isAbsolute(move.from));
    if (announced.length) this.logMoves.fire(announced);
    this.quiet++;
    try { await this.follow(pairs); }
    finally {
      if (!--this.quiet && this.unpublished) {
        // What was read from disk on the way is still told as such, so screens do not save stale settings over it.
        const fromDisk = this.unpublishedFromDisk; this.unpublished = false; this.unpublishedFromDisk = false; const before = this.readingDisk; this.readingDisk = before || fromDisk;
        try { this.changes.fire(this.project); } finally { this.readingDisk = before; }
      }
    }
  }
  private async follow(pairs: readonly { readonly from: string; readonly to: string }[]): Promise<void> {
    await this.load();
    const moves = pairs.map((pair) => ({ from: this.locate(pair.from), to: this.locate(pair.to) })).filter((move) => move.from !== move.to && !path.isAbsolute(move.to));
    if (!moves.length) return;
    const moved = (value: string) => { for (const move of moves) if (value === move.from || value.startsWith(`${move.from}/`)) return move.to + value.slice(move.from.length); return undefined; };
    // A level's file keeps paths relative to its own folder. A level that moved was just read from its new place, so a path
    // leading out of it was resolved from there and points somewhere else: work out what it pointed to from the old place.
    const relinked = (level: string | undefined, file: string): string | undefined => {
      if (!level || path.isAbsolute(file)) return undefined;
      const move = moves.find((item) => level === item.to || level.startsWith(`${item.to}/`)); if (!move) return undefined;
      const relative = path.posix.relative(level, file); if (!relative.startsWith('..')) return undefined;
      const original = path.posix.normalize(path.posix.join(move.from + level.slice(move.to.length), relative)); if (original.startsWith('..')) return undefined;
      const target = moved(original) ?? original; return target === file ? undefined : target;
    };
    const placed = (level: string | undefined, file: string) => relinked(level, file) ?? moved(file);
    const groups = this.project.analysisGroups ?? [];
    const listChange = (this.project.addedLogs ?? []).some((file) => moved(file) !== undefined) || groups.some((group) => (group.addedLogs ?? []).some((file) => placed(group.id, file) !== undefined));
    const sourcesChange = groups.some((group) => (group.definitionDependencies?.externalCsvSources ?? []).some((source) => relinked(group.id, source.path) !== undefined));
    const clipsChange = listChange || this.project.clips.some((clip) => moved(clip.sourcePath) !== undefined);
    const keysChange = Object.keys(this.project.viewStates).some((key) => { const parsed = parseLogViewKey(key); return !!parsed && placed(parsed.level, parsed.path) !== undefined; });
    if (!clipsChange && !keysChange && !sourcesChange) return;
    // A log moved into the group it was added to no longer needs the link: it is listed there as the file itself.
    const needed = (level: string) => (file: string) => path.isAbsolute(file) || locationLevel(this.levelFolders, file) !== level;
    const follow = (list: readonly string[] | undefined, level: string) => list?.map((file) => placed(level, file) ?? file).filter(needed(level));
    if (listChange) this.workspaceLogs = this.workspaceLogs.map((log) => log.level !== undefined ? { ...log, path: placed(log.level, log.path) ?? log.path } : log).filter((log) => log.level === undefined || needed(log.level)(log.path));
    await this.update((project) => ({ ...project, addedLogs: follow(project.addedLogs, ''), analysisGroups: project.analysisGroups?.map((group) => ({ ...group, addedLogs: follow(group.addedLogs, group.id),
        ...(group.definitionDependencies ? { definitionDependencies: { ...group.definitionDependencies, externalCsvSources: group.definitionDependencies.externalCsvSources.map((source) => { const next = relinked(group.id, source.path); return next === undefined ? source : { ...source, path: next }; }) } } : {}) })),
      // Clips follow their log. View settings made where the log is go with it; those made in a group it was added to stay in that group.
      clips: project.clips.map((clip) => { const next = moved(clip.sourcePath); return next === undefined ? clip : { ...clip, sourcePath: next }; }),
      // Settings follow the log into its new place. Where the log moves into a group it was added to, the settings made
      // in that group are the ones kept for it there.
      viewStates: Object.fromEntries(Object.entries(project.viewStates).map(([key, value]) => { const parsed = parseLogViewKey(key); const next = parsed ? placed(parsed.level, parsed.path) : undefined;
        return [next === undefined ? key : logViewKey(this.levelFolders, next, parsed!.level), value, next !== undefined && parsed!.level !== undefined] as const; })
        .sort((a, b) => Number(a[2]) - Number(b[2])).map(([key, value]) => [key, value])) }));
  }

  /** What identifies the Clip `id` of a log, named by its file or by its path as the project has it; see `ClipRef`. */
  clipRef(id: string, fileOrSource: string): ClipRef { return { id, sourcePath: path.isAbsolute(fileOrSource) ? this.locate(fileOrSource) : fileOrSource }; }
  /**
   * The Clip `id` of that log, or undefined when that log has no such Clip (any more). The path is taken as it is given:
   * nothing is guessed from the ID, and no earlier move is applied to it. A holder follows a move by rewriting the path it
   * holds when `onDidMoveLogs` tells of it.
   */
  findClip(id: string, fileOrSource: string): ClipDefinition | undefined { return findClip(this.project.clips, this.clipRef(id, fileOrSource)); }

  /** The URI that opens a Clip from `level` (default: where its log is): the log's URI there, with the Clip named. */
  clipUri(clip: ClipDefinition, level?: string): vscode.Uri {
    const file = this.absolute(clip.sourcePath); const base = this.logUri(file, level ?? this.levelOfFile(file));
    return base.with({ fragment: [base.fragment, `sigmixa-clip=${encodeURIComponent(clip.id)}`].filter(Boolean).join('&') });
  }

  /** After a log was copied, gives the copy the same Clips (names and ranges). Returns how many were copied. */
  async copyClips(from: string, to: string, newId: () => string): Promise<number> {
    await this.load();
    const source = this.locate(from); const target = this.locate(to);
    const copies = this.project.clips.filter((clip) => clip.sourcePath === source).map((clip) => ({ ...clip, id: newId(), sourcePath: target, sourceFileName: path.basename(to) }));
    if (copies.length) await this.update((project) => ({ ...project, clips: [...project.clips, ...copies] }));
    return copies.length;
  }

  /** After logs were deleted, drops what only existed for them: their Clips, their view settings and the places they were added to. */
  async forgetLogs(files: readonly string[]): Promise<void> {
    const gone = new Set(files.map((file) => this.locate(file))); if (!gone.size) return;
    this.workspaceLogs = this.workspaceLogs.filter((log) => !gone.has(log.path));
    const keep = (list?: readonly string[]) => list?.filter((item) => !gone.has(item));
    await this.update((project) => {
      const removed = new Set(project.clips.filter((clip) => gone.has(clip.sourcePath)).map((clip) => clipViewKey(clip.id)));
      return { ...project, addedLogs: keep(project.addedLogs), analysisGroups: project.analysisGroups?.map((group) => ({ ...group, addedLogs: keep(group.addedLogs) })),
        clips: project.clips.filter((clip) => !gone.has(clip.sourcePath)),
        viewStates: Object.fromEntries(Object.entries(project.viewStates).filter(([key]) => { const parsed = parseLogViewKey(key); return !(parsed && gone.has(parsed.path)) && !removed.has(key); })) };
    });
    await this.load();
  }

  /** Stops `folder` being a level: its `.sigmixa` folder goes to the trash, while the folder and its logs stay. */
  async removeLevel(folder: string): Promise<void> {
    const uri = folder ? this.levelFolderUri(folder) : undefined; if (!uri) return;
    await this.writeChain.catch(() => undefined);
    await vscode.workspace.fs.delete(vscode.Uri.joinPath(uri, LEVEL_DIRECTORY), { recursive: true, useTrash: true });
    this.written.delete(folder);
    await this.load();
  }

  dispose(): void { this.changes.dispose(); this.logMoves.dispose(); }

  private root(): vscode.Uri | undefined { return vscode.workspace.workspaceFolders?.[0]?.uri; }
  /** The start of every breadcrumb: the workspace's name, then the group folders down to `level` ('' = the workspace itself). */
  placeLabel(level: string): string | undefined {
    const name = vscode.workspace.workspaceFolders?.[0]?.name; if (!name) return undefined;
    return [name, ...level.split('/').filter(Boolean)].join(' › ');
  }
  private levelUri(folder: string): vscode.Uri { return vscode.Uri.joinPath(this.levelFolderUri(folder)!, LEVEL_DIRECTORY, LEVEL_FILE); }
  private label(folder: string): string { return `${folder ? `${folder}/` : ''}${LEVEL_DIRECTORY}/${LEVEL_FILE}`; }

  private async write(project: SigMixaProject): Promise<void> {
    if (!this.requireWorkspace()) throw new Error('A workspace folder is required.');
    const split = splitWorkspace(project, this.levelFolders, this.workspaceLogs);
    for (const [folder, level] of split) {
      const text = `${JSON.stringify(levelJson(folder ? level : { ...level, analysisGroups: this.legacyGroups }), null, 2)}\n`;
      // An empty root file is not created just because the workspace was opened.
      if (text === this.written.get(folder) || (!this.written.has(folder) && !folder && isEmptyLevel(level) && !this.legacyGroups.length)) continue;
      await this.writeLevel(folder, text);
    }
  }

  private async writeLevel(folder: string, text: string): Promise<void> {
    if (this.failed.has(folder)) throw new Error(`${this.label(folder)} could not be loaded. Recover it before saving changes.`);
    const directory = vscode.Uri.joinPath(this.levelFolderUri(folder)!, LEVEL_DIRECTORY);
    await vscode.workspace.fs.createDirectory(directory);
    const original = this.migrationBytes.get(folder);
    if (original) { await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(directory, `${LEVEL_FILE}.pre-v${CURRENT_PROJECT_SCHEMA_VERSION}-${Date.now()}.bak`), original); this.migrationBytes.delete(folder); }
    const temporary = vscode.Uri.joinPath(directory, `${LEVEL_FILE}.tmp`);
    await vscode.workspace.fs.writeFile(temporary, new TextEncoder().encode(text));
    await vscode.workspace.fs.rename(temporary, vscode.Uri.joinPath(directory, LEVEL_FILE), { overwrite: true });
    this.written.set(folder, text);
  }

  /**
   * The former format keyed view settings by a hash of the log's URI. Converts those keys to the location-based keys
   * for the logs found now, and keeps the original bytes so the next save backs them up.
   */
  private withConvertedLegacyKeys(project: SigMixaProject, logs: readonly WorkspaceLog[], root: string): SigMixaProject {
    const legacy = Object.keys(project.viewStates).filter((key) => /^log-view:[0-9a-f]{20}$/.test(key));
    if (!legacy.length) return project;
    const hash = (uri: vscode.Uri) => `log-view:${createHash('sha256').update(uri.toString()).digest('hex').slice(0, 20)}`;
    const renamed = new Map<string, string>();
    // The root file's own key format: `log:<path>` (a workspace path, or an absolute one outside the workspace).
    for (const log of logs) renamed.set(hash(vscode.Uri.file(path.isAbsolute(log.path) ? log.path : path.join(root, log.path))), `log:${log.path}`);
    // Logs outside the workspace keep their settings under their absolute path (Clip sources and the former recent-logs list).
    for (const file of [...this.externalLogHints, ...project.clips.map((clip) => clip.sourcePath), ...(project.analysisGroups ?? []).flatMap((group) => group.sourcePaths), ...(project.addedLogs ?? [])].filter((source) => path.isAbsolute(source))) {
      const key = hash(vscode.Uri.file(file)); if (!renamed.has(key)) renamed.set(key, `log:${file}`);
    }
    for (const clip of project.clips) {
      const file = path.isAbsolute(clip.sourcePath) ? clip.sourcePath : path.join(root, clip.sourcePath);
      renamed.set(hash(vscode.Uri.file(file).with({ fragment: `sigmixa-clip=${encodeURIComponent(clip.id)}` })), clipViewKey(clip.id));
    }
    // Keys of logs that are no longer found cannot be converted; they are kept as they are. Only an actual conversion
    // counts as a change (and makes a backup), so such leftovers do not create a new backup on every save.
    if (!legacy.some((key) => renamed.has(key))) return project;
    const viewStates = Object.fromEntries(Object.entries(project.viewStates).map(([key, value]) => [renamed.get(key) ?? key, value]));
    return { ...project, viewStates };
  }

  private setCurrent(project: SigMixaProject): void {
    const groupDefinitions = project.analysisGroups?.map(({ id, parentId, frames, sourcePaths, definitionDependencies }) => ({ id, parentId, frames, sourcePaths, definitionDependencies }));
    const nextFrameSignature = JSON.stringify([project.frames, groupDefinitions]);
    if (nextFrameSignature !== this.frameSignature) { this.frameSignature = nextFrameSignature; this.frameRevisionValue++; }
    const nextAnalysisSignature = JSON.stringify([project.frames, groupDefinitions, project.plugins, project.pluginBindings, project.externalCsvSources, project.lookupTables, project.calculations]);
    if (nextAnalysisSignature !== this.analysisSignature) { this.analysisSignature = nextAnalysisSignature; this.analysisRevisionValue++; }
    this.project = project;
    this.revisionValue++;
    if (this.quiet) { this.unpublished = true; this.unpublishedFromDisk ||= this.readingDisk; } else this.changes.fire(project);
  }
}

/** A level's file: the project format, without the composed-only fields when they are empty. */
function levelJson(project: SigMixaProject): unknown {
  const { analysisGroups, logPaths: _logPaths, ...rest } = serializeProject(project) as Record<string, unknown> & { analysisGroups?: unknown[]; logPaths?: unknown };
  return analysisGroups?.length ? { ...rest, analysisGroups } : rest;
}
function isEmptyLevel(level: SigMixaProject): boolean {
  // A link to a log elsewhere is content too: a level holding nothing but links must still be written.
  return !level.addedLogs?.length && !level.frames.length && !level.plugins.length && !level.pluginBindings.length && !level.externalCsvSources.length && !level.clips.length && !level.lookupTables.length && !level.calculations.length && !Object.keys(level.viewStates).length;
}
function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' ? value as Record<string, unknown> : {}; }
