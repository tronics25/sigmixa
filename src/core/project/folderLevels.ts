import * as path from 'path';
import { emptyProject, type AnalysisGroup, type ClipDefinition, type ExternalCsvSourceDefinition, type SigMixaProject } from './schema';

/**
 * Folder-based analysis groups. A folder that holds a `.sigmixa` folder is one definition level; the workspace root is
 * the common level. A log belongs to the nearest level above it. Each level keeps its own `.sigmixa/project.json`,
 * with every path in it relative to that level's folder, so a level can be copied or moved as a folder. A log added to a
 * level is listed in its `addedLogs` (a path relative to the level, or an absolute path outside the workspace). Like a
 * shortcut, it then appears both where it is and in that level; it uses the definitions of the place it was opened from.
 * Nothing is created next to the logs.
 *
 * In memory the levels are composed into one `SigMixaProject` (the root's own definitions at the top, every other level
 * as an `AnalysisGroup` with `parentId`), with paths relative to the workspace. All paths here use `/`.
 */
export const LEVEL_DIRECTORY = '.sigmixa';
export const LEVEL_FILE = 'project.json';
/** Group-wide view settings of a level are kept in its own `viewStates` under this key. */
export const GROUP_VIEW_KEY = 'group-view';

/**
 * A log the levels can see. `path` is workspace-relative for a log in the workspace, absolute for one outside it;
 * `level` is set for an added log: the level whose `addedLogs` lists it.
 */
export interface WorkspaceLog { readonly path: string; readonly level?: string }
/** One level as stored on disk: `folder` is workspace-relative ('' for the root), paths inside are relative to it. */
export interface LevelFile { readonly folder: string; readonly project: SigMixaProject }

/** Names never searched for logs or levels. */
export function isSkippedFolderName(name: string): boolean { return name.startsWith('.') || name === 'node_modules'; }
export function isLogFileName(name: string): boolean { return /\.(asc|blf)$/i.test(name); }

/** The nearest level folder containing `file` (workspace-relative); '' is the root. */
export function levelOf(levelFolders: readonly string[], file: string): string {
  let best = '';
  for (const folder of levelFolders) if (folder && (file === folder || file.startsWith(`${folder}/`)) && folder.length > best.length) best = folder;
  return best;
}
/** The level directly above `folder`, or undefined for the root. */
export function parentLevelOf(levelFolders: readonly string[], folder: string): string | undefined {
  return folder ? levelOf(levelFolders, path.posix.dirname(folder) === '.' ? '' : path.posix.dirname(folder)) : undefined;
}

/** The level a log belongs to: the listing level for an added log, otherwise the nearest level above it. */
export function levelOfLog(levelFolders: readonly string[], log: WorkspaceLog): string { return log.level ?? levelOf(levelFolders, log.path); }
/** The logs every level lists, with workspace-relative paths for logs in the workspace. */
export function addedLogsOf(levels: readonly LevelFile[]): WorkspaceLog[] {
  return levels.flatMap((level) => (level.project.addedLogs ?? []).map((file) => ({ path: toWorkspace(level.folder, file), level: level.folder })));
}

const isAbsolute = (value: string) => path.isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\');
const toWorkspace = (folder: string, value: string) => isAbsolute(value) ? value : path.posix.normalize(folder ? `${folder}/${value.replace(/\\/g, '/')}` : value.replace(/\\/g, '/'));
const toLevel = (folder: string, value: string) => {
  if (isAbsolute(value)) return value;
  const normalized = value.replace(/\\/g, '/');
  return folder ? path.posix.relative(folder, normalized) : normalized;
};

/** Composes every level into the in-memory project. */
export function composeWorkspace(levels: readonly LevelFile[], logs: readonly WorkspaceLog[]): SigMixaProject {
  const root = levels.find((level) => level.folder === '')?.project ?? emptyProject();
  const folders = levels.map((level) => level.folder);
  const owned = (folder: string) => logs.filter((log) => levelOfLog(folders, log) === folder).map((log) => log.path);
  // A Clip belongs to its log, whichever level's file it was read from (files of earlier versions kept it where it was made).
  const clipToMemory = (folder: string, clip: ClipDefinition): ClipDefinition => ({ ...clip, sourcePath: toWorkspace(folder, clip.sourcePath) });
  const viewStates: Record<string, unknown> = {};
  for (const level of levels) {
    for (const [key, value] of Object.entries(level.project.viewStates)) {
      if (key === GROUP_VIEW_KEY) continue;
      if (key.startsWith('log:')) viewStates[logViewKey(folders, toWorkspace(level.folder, key.slice(4)), level.folder)] = value;
      // Clips have no view settings of their own; settings saved for them by earlier versions are not carried over.
      else if (!key.startsWith('clip:') && !level.folder) viewStates[key] = value;
    }
  }
  const csvToMemory = (folder: string, sources: readonly ExternalCsvSourceDefinition[]) => sources.map((source) => ({ ...source, path: toWorkspace(folder, source.path) }));
  const groups: AnalysisGroup[] = levels.filter((level) => level.folder).map(({ folder, project }) => ({
    id: folder, folder, name: path.posix.basename(folder), parentId: parentLevelOf(folders, folder) || undefined,
    sourcePaths: owned(folder), addedLogs: (project.addedLogs ?? []).map((file) => toWorkspace(folder, file)), frames: project.frames, viewState: project.viewStates[GROUP_VIEW_KEY],
    definitionDependencies: { plugins: [], pluginBindings: project.pluginBindings, externalCsvSources: csvToMemory(folder, project.externalCsvSources), lookupTables: project.lookupTables, calculations: project.calculations },
  }));
  return {
    ...root,
    externalCsvSources: csvToMemory('', root.externalCsvSources),
    analysisGroups: groups,
    logPaths: owned(''),
    clips: levels.flatMap((level) => level.project.clips.map((clip) => clipToMemory(level.folder, clip))),
    viewStates,
  };
}

/** Splits the in-memory project back into one project per level, with paths relative to each level's folder. */
export function splitWorkspace(project: SigMixaProject, levelFolders: readonly string[], logs: readonly WorkspaceLog[]): Map<string, SigMixaProject> {
  const folders = levelFolders.includes('') ? levelFolders : ['', ...levelFolders];
  const result = new Map<string, SigMixaProject>(folders.map((folder) => [folder, { ...emptyProject(), viewStates: {} }]));
  const edit = (folder: string, change: (level: SigMixaProject) => SigMixaProject) => result.set(folder, change(result.get(folder)!));
  // View settings are stored in the level they were made in; without one, in the level of the log's location.
  // A Clip is stored with its log: in the level of the log's location (the common level for a log outside the workspace).
  const normalize = (value: string) => isAbsolute(value) ? value : value.replace(/\\/g, '/');
  const ownerOf = (value: string, level?: string) => level !== undefined && result.has(level) ? level : isAbsolute(normalize(value)) ? '' : levelOf(folders, normalize(value));
  edit('', (level) => ({ ...level, ...(project.addedLogs?.length ? { addedLogs: project.addedLogs.map((file) => toLevel('', file)) } : {}), frames: project.frames, plugins: project.plugins, pluginBindings: project.pluginBindings, lookupTables: project.lookupTables, calculations: project.calculations,
    externalCsvSources: project.externalCsvSources.map((source) => ({ ...source, path: toLevel('', source.path) })) }));
  for (const group of project.analysisGroups ?? []) {
    const folder = group.folder ?? group.id; if (!result.has(folder) || !folder) continue;
    const dependencies = group.definitionDependencies;
    edit(folder, (level) => ({ ...level, ...(group.addedLogs?.length ? { addedLogs: group.addedLogs.map((file) => toLevel(folder, file)) } : {}), frames: group.frames, pluginBindings: dependencies?.pluginBindings ?? [], lookupTables: dependencies?.lookupTables ?? [], calculations: dependencies?.calculations ?? [],
      externalCsvSources: (dependencies?.externalCsvSources ?? []).map((source) => ({ ...source, path: toLevel(folder, source.path) })),
      viewStates: { ...level.viewStates, ...(group.viewState === undefined ? {} : { [GROUP_VIEW_KEY]: group.viewState }) } }));
  }
  for (const clip of project.clips) {
    const owner = ownerOf(clip.sourcePath);
    edit(owner, (level) => ({ ...level, clips: [...level.clips, { ...clip, sourcePath: toLevel(owner, normalize(clip.sourcePath)) }] }));
  }
  for (const [key, value] of Object.entries(project.viewStates)) {
    const parsed = parseLogViewKey(key);
    if (parsed) { const owner = ownerOf(parsed.path, parsed.level); edit(owner, (level) => ({ ...level, viewStates: { ...level.viewStates, [`log:${toLevel(owner, parsed.path)}`]: value } })); }
    else if (!key.startsWith('clip:')) edit('', (level) => ({ ...level, viewStates: { ...level.viewStates, [key]: value } }));
  }
  return result;
}

/** The level a log's location gives it, if it is in the workspace. */
export function locationLevel(levelFolders: readonly string[], file: string): string | undefined { return isAbsolute(file) ? undefined : levelOf(levelFolders, file.replace(/\\/g, '/')); }
/**
 * The in-memory view-settings key of a log opened from `level`: `log:<path>` when opened where it is,
 * `log@<level>:<path>` when opened from a level it was added to. `path` is workspace-relative, or absolute outside it.
 */
export function logViewKey(levelFolders: readonly string[], file: string, level?: string): string {
  // A log outside the workspace is where the common level is.
  const located = isAbsolute(file) ? file : file.replace(/\\/g, '/'); const where = locationLevel(levelFolders, located) ?? '';
  const opened = level ?? where;
  return opened === where ? `log:${located}` : `log@${opened}:${located}`;
}
export function parseLogViewKey(key: string): { path: string; level?: string } | undefined {
  if (key.startsWith('log:')) return { path: key.slice(4) };
  const match = /^log@([^:]*):(.*)$/s.exec(key); return match ? { level: match[1], path: match[2] } : undefined;
}
export function clipViewKey(clipId: string): string { return `clip:${clipId}`; }
