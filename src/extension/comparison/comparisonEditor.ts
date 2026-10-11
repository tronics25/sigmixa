import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { removeComparisonTarget, reorderComparisonTargets, setComparisonTargetOffset, snapAnchor, stepAnchor, type FrameTimes, splitSignalGroupsByTarget, uniqueComparisonTargets, type ComparisonDefinition, type ComparisonTarget } from '../../core/project/comparison';
import { clipRange, clipRangeLabel, type ClipDefinition } from '../../core/project/schema';
import type { SignalDefinition } from '../../core/signal/signal';
import { t } from '../i18n';
import { RawLogDocument } from '../editors/rawLogDocument';
import type { MeasuredSignalDto, SignalGroupDto } from '../editors/rawLogProtocol';
import { signalCatalogGroups } from '../editors/signalCatalogGroups';
import { chooseExportFormat, requireRenderedImage, saveRenderedImage } from '../imageExport';
import type { PluginManager } from '../plugins/pluginManager';
import { sourceGroup, sourceProject } from '../sidebar/analysisGroupsProvider';
import type { ProjectStore } from '../storage/projectStore';
import { resolveClipPath } from '../clips/clipPaths';
import { resolveViewSettings } from '../../core/project/viewSettings';
import { reportGraphs } from '../report/reportGraphs';
import { comparisonHtml } from './comparisonHtml';
import { chooseReportDetail, reportCatalog, reportSeries, saveReport } from '../report/reportExporter';
import { REPORT_FORMAT_VERSION } from '../report/reportData';
import { extensionVersion } from '../report/extensionVersion';
import type { ComparisonSeriesDto, ComparisonTargetStateDto, ComparisonToExtension, ComparisonToWebview } from './comparisonProtocol';

type TargetSeed = Omit<ComparisonTarget, 'id' | 'offset'>;

const workspaceRoot = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

/** Opens comparisons straight from the sidebar selection. Comparisons are not saved; export an image or report instead. */
export class ComparisonEditor implements vscode.Disposable {
  private readonly sessions = new Set<ComparisonSession>();
  constructor(private readonly extensionUri: vscode.Uri, private readonly store: ProjectStore, private readonly plugins: PluginManager) {}

  /** Opens a comparison of the selected files/Clips. */
  create(seeds: readonly TargetSeed[]): void {
    const targets = uniqueComparisonTargets(seeds.map((seed) => ({ ...seed, id: randomUUID(), offset: 0 })));
    if (targets.length < 2) { void vscode.window.showInformationMessage(t('Select two or more logs or Clips to compare.', '比較するログまたはクリップを2つ以上選んでください。')); return; }
    // The first graph starts with the Signals of the first graph in the view settings of the place the first target was selected in.
    const first = targets[0]; const firstClip = first.kind === 'clip' ? this.store.current.clips.find((clip) => clip.id === first.clipId) : undefined;
    const firstFile = path.isAbsolute(first.sourcePath ?? '') ? first.sourcePath! : path.resolve(workspaceRoot() ?? '', first.sourcePath ?? '');
    const firstUri = first.kind === 'clip' ? firstClip && this.store.clipUri(firstClip, first.level) : first.level === undefined ? vscode.Uri.file(firstFile) : this.store.logUri(firstFile, first.level);
    const settings = firstUri ? resolveViewSettings(this.store.current, this.store.viewKey(firstUri), sourceGroup(this.store, firstUri)) : {};
    const signalIds = reportGraphs(settings).find((graph) => graph.kind !== 'trajectory')?.signalIds ?? [];
    const comparison: ComparisonDefinition = {
      id: randomUUID(), name: t('Comparison', '比較'), targets,
      graphs: [{ id: randomUUID(), name: t('Graph 1', 'グラフ 1'), signalIds: [...new Set(signalIds)] }],
    };
    this.sessions.add(new ComparisonSession(this, comparison));
  }

  get projectStore(): ProjectStore { return this.store; }
  get pluginManager(): PluginManager { return this.plugins; }
  get uri(): vscode.Uri { return this.extensionUri; }
  forget(session: ComparisonSession): void { this.sessions.delete(session); }
  dispose(): void { for (const session of [...this.sessions]) session.dispose(); this.sessions.clear(); }
}

interface LoadedTarget { readonly target: ComparisonTarget; readonly filePath: string; readonly uri?: vscode.Uri; readonly clip?: ClipDefinition; readonly document?: RawLogDocument; readonly range?: { readonly start: number; readonly end: number }; readonly error?: string }

class ComparisonSession implements vscode.Disposable {
  private readonly panel: vscode.WebviewPanel;
  private readonly documents = new Map<string, RawLogDocument>();
  /** Where each parsed log was opened from, for its definitions. */
  private readonly levels = new Map<string, vscode.Uri | string>();
  private loaded = new Map<string, LoadedTarget>();
  private comparison: ComparisonDefinition;
  private disposed = false;
  private loadToken = 0;
  private analysisRevision: number;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(private readonly owner: ComparisonEditor, comparison: ComparisonDefinition) {
    this.comparison = comparison;
    this.analysisRevision = this.store.analysisRevision;
    this.panel = vscode.window.createWebviewPanel('sigmixa.comparison', this.title(), vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true });
    this.panel.iconPath = new vscode.ThemeIcon('diff-multiple');
    this.panel.webview.html = comparisonHtml(this.panel.webview, owner.uri, vscode.env.language);
    this.subscriptions.push(
      this.panel.webview.onDidReceiveMessage((message: ComparisonToExtension) => void this.handle(message)),
      this.store.onDidChange(() => this.projectChanged()),
    );
    this.panel.onDidDispose(() => this.dispose());
  }

  private get store(): ProjectStore { return this.owner.projectStore; }
  reveal(): void { this.panel.reveal(); }
  /** Names what is compared, e.g. "比較: run-001.asc・Braking". */
  private title(): string { const names = this.comparison.targets.map((target) => this.targetName(target)).filter(Boolean); return names.length ? `${this.comparison.name}: ${names.join('・')}` : this.comparison.name; }
  private post(message: ComparisonToWebview): void { if (!this.disposed) void this.panel.webview.postMessage(message); }

  private async handle(message: ComparisonToExtension): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.post({ type: 'init', comparison: this.comparison });
        void this.load();
        return;
      case 'reorderTargets': this.comparison = reorderComparisonTargets(this.comparison, message.order); this.changed(); return;
      case 'removeTarget': this.comparison = removeComparisonTarget(this.comparison, message.targetId); this.changed(); void this.load(); return;
      case 'update': {
        this.comparison = { ...this.comparison, ...message.comparison }; return;
      }
      case 'seriesRequest': return this.sendSeries(message.requestId, message.graphId, message.signalIds, message.maxPoints);
      case 'measuredSignalsRequest': {
        const item = this.loaded.get(message.targetId); const document = item?.document;
        const pairs = this.mapSignals(message.targetId, message.signalIds);
        const samples: MeasuredSignalDto[] = document ? document.measuredSignals([...new Set(pairs.map(([, id]) => id))], message.timestamp, item?.clip ? clipRange(item.clip) : undefined).flatMap((sample) => pairs.filter(([, id]) => id === sample.signalId).map(([signalId]) => ({ ...sample, signalId }))) : [];
        this.post({ type: 'measuredSignals', requestId: message.requestId, samples }); return;
      }
      case 'shiftOffset': case 'setOffset': case 'resetOffset': return this.moveOffset(message);
      case 'exportAll': {
        const format = await chooseExportFormat('Export', 'エクスポート'); if (!format) return;
        if (format === 'html') return this.exportReport();
        if (!requireRenderedImage(message)) return;
        const root = workspaceRoot();
        void saveRenderedImage({ title: 'Save Comparison Image', japaneseTitle: '比較画像を保存', defaultBasePath: root ? path.join(root, `sigmixa-${this.comparison.name.replace(/[\\/:*?"<>|]+/g, '_')}`) : undefined, image: message, format });
        return;
      }
      case 'openTarget': {
        const item = this.loaded.get(message.targetId); if (!item) return;
        if (item.clip) await vscode.commands.executeCommand('sigmixa.openClip', item.clip);
        else await vscode.commands.executeCommand('vscode.openWith', item.uri ?? vscode.Uri.file(item.filePath), 'sigmixa.rawLog');
        return;
      }
      case 'saveComparisonImage': {
        const root = workspaceRoot();
        void saveRenderedImage({ title: 'Save Comparison Image', japaneseTitle: '比較画像を保存', defaultBasePath: root ? path.join(root, `sigmixa-${(this.comparison.name ?? 'comparison').replace(/[\\/:*?"<>|]+/g, '_')}`) : undefined, image: message });
        return;
      }
    }
  }

  private changed(): void { this.post({ type: 'comparison', comparison: this.comparison }); this.panel.title = this.title(); }

  /** Resolves every target, parses each log once (shared by its Clips) and reports progress per target. */
  private async load(): Promise<void> {
    const comparison = this.comparison;
    const token = ++this.loadToken; const root = workspaceRoot(); const project = this.store.current;
    const next = new Map<string, LoadedTarget>();
    for (const target of comparison.targets) {
      if (target.kind === 'clip') {
        const clip = project.clips.find((item) => item.id === target.clipId);
        next.set(target.id, clip ? { target, clip, filePath: resolveClipPath(clip, root), uri: this.store.clipUri(clip, target.level) } : { target, filePath: '', error: t('This Clip was deleted.', 'このクリップは削除されています。') });
      } else {
        const filePath = path.isAbsolute(target.sourcePath ?? '') ? target.sourcePath! : path.resolve(root ?? '', target.sourcePath ?? '');
        next.set(target.id, { target, filePath, uri: target.level === undefined ? vscode.Uri.file(filePath) : this.store.logUri(filePath, target.level) });
      }
    }
    this.loaded = next; this.postTargets();
    // One parsed log per file and definitions in use: a log opened from two groups decodes differently.
    const used = new Set([...next.values()].filter((item) => !item.error).map((item) => this.documentKey(item)));
    for (const [key, document] of this.documents) if (!used.has(key)) { document.dispose(); this.documents.delete(key); }
    await Promise.all([...next.values()].map(async (item) => {
      if (item.error) return;
      let result: LoadedTarget;
      try {
        if (!fs.existsSync(item.filePath)) throw new Error(t(`Log file not found: ${item.filePath}`, `ログファイルが見つかりません: ${item.filePath}`));
        const document = this.documentFor(item); await document.whenReady();
        if (document.readError) throw new Error(document.readError);
        const range = (item.clip ? clipRange(item.clip) : undefined) ?? document.timelineRange;
        if (!range) throw new Error(t('The log contains no frames.', 'ログにフレームがありません。'));
        result = { ...item, document, range };
      } catch (error) { result = { ...item, error: error instanceof Error ? error.message : String(error) }; }
      if (token !== this.loadToken || this.disposed) return;
      this.loaded.set(item.target.id, result); this.postTargets();
    }));
    if (token !== this.loadToken || this.disposed) return;
    this.postCatalog();
    this.post({ type: 'reload' });
  }

  private documentKey(item: LoadedTarget): string { return `${this.store.levelOfUri(item.uri ?? item.filePath)}>${item.filePath}`; }
  private documentFor(item: LoadedTarget): RawLogDocument {
    const key = this.documentKey(item); let document = this.documents.get(key);
    if (!document) { document = new RawLogDocument(vscode.Uri.file(item.filePath), sourceProject(this.store, item.uri ?? item.filePath), this.store.analysisRevision, this.owner.pluginManager.registry); this.documents.set(key, document); this.levels.set(key, item.uri ?? item.filePath); }
    return document;
  }

  private postTargets(): void { this.post({ type: 'targets', targets: this.targetStates() }); this.panel.title = this.title(); }

  private targetStates(): ComparisonTargetStateDto[] {
    const comparison = this.comparison;
    return comparison.targets.map((target): ComparisonTargetStateDto => {
      const item = this.loaded.get(target.id); const filePath = item?.filePath ?? '';
      const name = item?.clip?.name ?? (target.kind === 'clip' ? t('(deleted Clip)', '（削除されたクリップ）') : path.basename(filePath));
      const status = item?.error ? 'error' : item?.range ? 'ready' : 'loading';
      return {
        id: target.id, kind: target.kind, name, fileName: item?.clip?.sourceFileName || path.basename(filePath), filePath,
        groupName: filePath ? sourceGroup(this.store, item?.uri ?? filePath)?.name : undefined,
        rangeLabel: item?.clip ? clipRangeLabel(item.clip, t('Whole file', 'ファイル全体')) : t('Whole file', 'ファイル全体'),
        status, message: item?.error, start: item?.range?.start, end: item?.range?.end,
      };
    });
  }

  private postCatalog(): void { this.post({ type: 'catalog', ...this.catalog() }); }

  private catalog() {
    const definitions = new Map<string, SignalDefinition>(); const groups = new Map<string, SignalGroupDto>(); const availability: Record<string, string[]> = {}; const measured = new Set<string>();
    const commonFrames = new Set(this.store.current.frames.map((frame) => `frame:${frame.id}`));
    for (const item of this.loaded.values()) {
      if (!item.document || !item.range) continue;
      const catalog = item.document.signalCatalog(); availability[item.target.id] = catalog.map((definition) => definition.id); for (const id of item.document.measuredSignalIds()) measured.add(id);
      for (const definition of catalog) if (!definitions.has(definition.id)) definitions.set(definition.id, definition);
      const groupName = sourceGroup(this.store, item.uri ?? item.filePath)?.name;
      for (const group of signalCatalogGroups(catalog, sourceProject(this.store, item.uri ?? item.filePath), true)) {
        const label = groupName && group.id.startsWith('frame:') && !commonFrames.has(group.id) ? `${group.label} · ${groupName}` : group.label;
        const existing = groups.get(group.id);
        groups.set(group.id, existing ? { ...existing, signalIds: [...new Set([...existing.signalIds, ...group.signalIds])] } : { ...group, label, remove: undefined });
      }
    }
    // Targets resolve different definitions (e.g. other analysis groups): list what only some of them have separately.
    const owners = this.comparison.targets.flatMap((target) => availability[target.id] ? [{ id: target.id, name: this.targetName(target), signalIds: new Set(availability[target.id]) }] : []);
    const split = splitSignalGroupsByTarget([...groups.values()], owners, (names) => t(`Only in ${names}`, `${names}のみ`), (names) => t(`Not in ${names}`, `${names}にはなし`));
    return { definitions: [...definitions.values()], groups: split.map((group) => ({ ...group, signalIds: [...group.signalIds] })), availability, measuredIds: [...measured] };
  }

  /** A standalone HTML report of this comparison: targets with their time shifts, graphs and trajectories. */
  private async exportReport(): Promise<void> {
    const ready = [...this.loaded.values()].filter((item) => item.document && item.range);
    if (!ready.length) { void vscode.window.showWarningMessage(t('Nothing has loaded yet.', 'まだ読み込みが終わっていません。')); return; }
    const detail = await chooseReportDetail(); if (!detail || this.disposed) return;
    const included = new Set(this.comparison.graphs.flatMap((graph) => graph.signalIds)); const notices: string[] = [];
    const catalog = this.catalog(); const kept = reportCatalog(catalog.definitions, catalog.groups, included);
    const series = ready.map((item) => { const available = new Set(catalog.availability[item.target.id] ?? []); return { targetId: item.target.id, items: reportSeries(item.document!, [...included].filter((id) => available.has(id)), item.clip ? clipRange(item.clip) : undefined, detail, notices, this.targetName(item.target)) }; });
    const targets = this.targetStates().filter((target) => target.status === 'ready').map((target) => ({ ...target, filePath: target.fileName }));
    const title = this.title();
    await saveReport(this.owner.uri, {
      formatVersion: REPORT_FORMAT_VERSION, kind: 'comparison', title, generatedAt: new Date().toISOString(), appVersion: extensionVersion(this.owner.uri),
      source: targets.map((target) => `${target.name} (${target.rangeLabel})`), notices,
      comparison: { ...this.comparison, targets: this.comparison.targets.filter((target) => targets.some((item) => item.id === target.id)) },
      targets, definitions: kept.definitions, groups: kept.groups,
      availability: Object.fromEntries(Object.entries(catalog.availability).map(([id, ids]) => [id, ids.filter((signalId) => included.has(signalId))])), series,
    }, title);
  }

  private targetName(target: ComparisonTarget): string {
    const item = this.loaded.get(target.id); return item?.clip?.name ?? path.basename(item?.filePath || target.sourcePath || '');
  }

  /** A target without a selected Signal simply has no line for it; Signals are never matched by name. */
  private mapSignals(targetId: string, signalIds: readonly string[]): [string, string][] {
    const item = this.loaded.get(targetId); if (!item?.document) return [];
    const available = new Set(item.document.signalCatalog().map((definition) => definition.id));
    return signalIds.filter((id) => available.has(id)).map((id) => [id, id]);
  }

  private sendSeries(requestId: number, graphId: string, signalIds: readonly string[], requestedPoints?: number): void {
    const ready = [...this.loaded.values()].filter((item) => item.document && item.range);
    // Trajectories ask for more points: their axes come from one Frame, so the same timestamps survive downsampling.
    const maxPoints = requestedPoints ?? Math.max(2, Math.min(4000, Math.floor(100_000 / Math.max(1, ready.length * signalIds.length))));
    const seriesByTarget = ready.map((item) => {
      const pairs = this.mapSignals(item.target.id, signalIds);
      const series = item.document!.signalSeries([...new Set(pairs.map(([, id]) => id))], item.clip ? clipRange(item.clip) : undefined, maxPoints).series;
      return { targetId: item.target.id, series: pairs.flatMap(([signalId, mapped]): ComparisonSeriesDto[] => { const match = series.find((entry) => entry.definition.id === mapped); return match ? [{ signalId, series: { ...match, events: match.events ?? [] } }] : []; }) };
    });
    this.post({ type: 'series', requestId, graphId, seriesByTarget });
  }

  private async moveOffset(message: Extract<ComparisonToExtension, { type: 'shiftOffset' | 'setOffset' | 'resetOffset' }>): Promise<void> {
    const comparison = this.comparison; const item = this.loaded.get(message.targetId); if (!item?.document || !item.range) return;
    const current = comparison.targets.find((target) => target.id === message.targetId)?.offset ?? 0; const start = item.range.start;
    const document = item.document; const span = document.timelineRange; if (!span) return;
    const times: FrameTimes = { first: span.start, last: span.end, adjacent: (timestamp, direction) => document.adjacentFrameTimestamp(timestamp, direction), nearest: (timestamp) => document.nearestFrameTimestamp(timestamp) };
    let anchor = snapAnchor(times, start + current);
    if (message.type === 'resetOffset') anchor = start;
    else if (message.type === 'setOffset') anchor = snapAnchor(times, start + message.offset);
    else { const steps = Math.max(1, Math.min(100, Math.floor(message.steps ?? 1))); for (let step = 0; step < steps; step++) anchor = stepAnchor(times, anchor, message.direction); }
    const offset = anchor - start; if (offset === current && message.type !== 'setOffset') return;
    this.comparison = setComparisonTargetOffset(comparison, message.targetId, offset);
    this.changed();
  }

  private projectChanged(): void {
    if (this.disposed) return;
    if (this.analysisRevision !== this.store.analysisRevision) {
      this.analysisRevision = this.store.analysisRevision;
      void Promise.all([...this.documents].map(([key, document]) => document.rebuildSignals(sourceProject(this.store, this.levels.get(key) ?? document.uri.fsPath), this.analysisRevision))).then(() => this.load());
    } else if ([...this.loaded.values()].some((item) => item.target.kind === 'clip' && !this.store.current.clips.some((clip) => clip.id === item.target.clipId && clip.startTimestamp === item.clip?.startTimestamp && clip.endTimestamp === item.clip?.endTimestamp && clip.name === item.clip?.name))) void this.load();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.owner.forget(this);
    for (const subscription of this.subscriptions) subscription.dispose();
    for (const document of this.documents.values()) document.dispose();
    this.documents.clear();
    this.panel.dispose();
  }
}
