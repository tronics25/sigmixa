import type { AnalysisGroup, SigMixaProject } from './schema';

type ViewState = Record<string, unknown>;
const localKeys = ['activeTab', 'visualizeSelectedViewId', 'visualizeOptionsCollapsed'] as const;
const object = (value: unknown): ViewState => value && typeof value === 'object' && !Array.isArray(value) ? value as ViewState : {};
export function viewSettingsScope(project: SigMixaProject, key: string, group?: AnalysisGroup): 'file' | 'group' {
  if (!group) return 'file';
  const saved = object(project.viewStates[key]);
  return saved.viewStateScope === 'group' || (!project.viewStates[key] && group.viewState !== undefined) ? 'group' : 'file';
}
export function resolveViewSettings(project: SigMixaProject, key: string, group?: AnalysisGroup): ViewState {
  const saved = object(project.viewStates[key]);
  if (viewSettingsScope(project, key, group) === 'group') {
    const local = Object.fromEntries(localKeys.filter((key) => key in saved).map((key) => [key, saved[key]]));
    return { ...object(project.viewStates['log-view-default']), ...object(group?.viewState), ...local };
  }
  const { viewStateScope: _scope, ...settings } = object(project.viewStates[key] ?? group?.viewState ?? project.viewStates['log-view-default']);
  return settings;
}
export function saveViewSettings(project: SigMixaProject, key: string, state: ViewState, group?: AnalysisGroup): SigMixaProject {
  const { viewStateScope: _scope, ...settings } = state;
  if (viewSettingsScope(project, key, group) !== 'group') return { ...project, viewStates: { ...project.viewStates, [key]: { ...settings, viewStateScope: 'file' } } };
  const shared = { ...settings }; const local: ViewState = { viewStateScope: 'group' };
  for (const key of localKeys) { if (key in shared) local[key] = shared[key]; delete shared[key]; }
  return { ...project, analysisGroups: project.analysisGroups?.map((item) => item.id === group!.id ? { ...item, viewState: shared } : item), viewStates: { ...project.viewStates, [key]: local } };
}
export function switchViewSettingsScope(project: SigMixaProject, key: string, state: ViewState, group: AnalysisGroup, scope: 'file' | 'group'): SigMixaProject {
  if (scope === 'file') return { ...project, viewStates: { ...project.viewStates, [key]: { ...state, viewStateScope: 'file' } } };
  const local: ViewState = { viewStateScope: 'group' }; for (const key of localKeys) if (key in state) local[key] = state[key];
  let next = { ...project, viewStates: { ...project.viewStates, [key]: local } };
  if (group.viewState === undefined) next = saveViewSettings(next, key, state, group);
  return next;
}
