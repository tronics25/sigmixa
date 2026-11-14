import { GROUP_VIEW_KEY } from './folderLevels';
import type { AnalysisGroup, SigMixaProject } from './schema';

type ViewState = Record<string, unknown>;
/** Kept with the log in both modes: which tab and view are open, and whether the view options are open. */
const localKeys = ['activeTab', 'visualizeSelectedViewId', 'visualizeOptionsCollapsed'] as const;
/** Column widths are fitted to the content each time a log opens, so they are never saved. */
const unsavedKeys = ['rawWidths', 'tableWidths'] as const;
const object = (value: unknown): ViewState => value && typeof value === 'object' && !Array.isArray(value) ? value as ViewState : {};
const withoutUnsaved = (state: ViewState): ViewState => {
  const result = { ...state }; for (const key of unsavedKeys) delete result[key];
  // The Trace's column widths are fitted the same way.
  if (result.traceSettings && typeof result.traceSettings === 'object' && 'widths' in result.traceSettings) { const { widths: _widths, ...trace } = result.traceSettings as ViewState; result.traceSettings = trace; }
  return result;
};
/**
 * The settings shared in the analysis group a log is opened from. `group` is undefined for the workspace root, which is a
 * group like any other: its shared settings are kept under `GROUP_VIEW_KEY` among the root's own view settings.
 */
const sharedState = (project: SigMixaProject, group?: AnalysisGroup): unknown => group ? group.viewState : project.viewStates[GROUP_VIEW_KEY];
/**
 * A log's own entry holds its per-file settings in both modes, plus which mode it shows (`viewStateScope`). Showing the
 * group's settings never removes or changes the per-file ones, so switching back to "This file" shows them again.
 */
export function viewSettingsScope(project: SigMixaProject, key: string, group?: AnalysisGroup): 'file' | 'group' {
  const saved = object(project.viewStates[key]);
  if (saved.viewStateScope === 'group' || saved.viewStateScope === 'file') return saved.viewStateScope;
  return !project.viewStates[key] && sharedState(project, group) !== undefined ? 'group' : 'file';
}
export function resolveViewSettings(project: SigMixaProject, key: string, group?: AnalysisGroup): ViewState {
  const { viewStateScope: _scope, ...saved } = object(project.viewStates[key]);
  const base = object(project.viewStates['log-view-default']);
  if (viewSettingsScope(project, key, group) === 'group') {
    const local = Object.fromEntries(localKeys.filter((name) => name in saved).map((name) => [name, saved[name]]));
    return withoutUnsaved({ ...base, ...object(sharedState(project, group)), ...local });
  }
  // A log without per-file settings of its own (never edited in "This file") starts from the default view.
  const ownSettings = Object.keys(withoutUnsaved(saved)).some((name) => !(localKeys as readonly string[]).includes(name));
  return withoutUnsaved(ownSettings ? saved : { ...base, ...saved });
}
export function saveViewSettings(project: SigMixaProject, key: string, state: ViewState, group?: AnalysisGroup): SigMixaProject {
  const { viewStateScope: _scope, ...settings } = withoutUnsaved(state);
  const own = withoutUnsaved(object(project.viewStates[key]));
  if (viewSettingsScope(project, key, group) !== 'group') return { ...project, viewStates: { ...project.viewStates, [key]: { ...settings, viewStateScope: 'file' } } };
  const shared = { ...settings }; const entry: ViewState = { ...own, viewStateScope: 'group' };
  for (const name of localKeys) { if (name in shared) entry[name] = shared[name]; delete shared[name]; }
  if (!group) return { ...project, viewStates: { ...project.viewStates, [GROUP_VIEW_KEY]: shared, [key]: entry } };
  return { ...project, analysisGroups: project.analysisGroups?.map((item) => item.id === group.id ? { ...item, viewState: shared } : item), viewStates: { ...project.viewStates, [key]: entry } };
}
/**
 * Chooses which settings a log shows. The per-file settings are kept as they are and are never filled from the group's:
 * a log that has none yet starts from the default view. The group's settings start from the shown view only when the
 * group has none yet.
 */
export function switchViewSettingsScope(project: SigMixaProject, key: string, state: ViewState, group: AnalysisGroup | undefined, scope: 'file' | 'group', shown?: 'file' | 'group'): SigMixaProject {
  // Edits not saved yet belong to the settings shown before the switch, unless another view of the log has switched since.
  const current = viewSettingsScope(project, key, group);
  const saved = shown === undefined || shown === current ? saveViewSettings(project, key, state, group) : project;
  const savedGroup = group && saved.analysisGroups?.find((item) => item.id === group.id);
  if (current === scope) return saved;
  const own = withoutUnsaved(object(saved.viewStates[key]));
  const local: ViewState = {}; for (const name of localKeys) if (name in state) local[name] = state[name];
  const entry: ViewState = { ...own, ...local, viewStateScope: scope };
  let next: SigMixaProject = { ...saved, viewStates: { ...saved.viewStates, [key]: entry } };
  if (scope === 'group' && sharedState(saved, savedGroup) === undefined) next = saveViewSettings(next, key, state, savedGroup);
  return next;
}
