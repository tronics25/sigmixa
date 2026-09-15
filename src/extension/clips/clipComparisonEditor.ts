import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ClipDefinition } from '../../core/project/schema';
import type { SignalDefinition } from '../../core/signal/signal';
import { formatCanId } from '../../core/frame/canId';
import type { ProjectStore } from '../storage/projectStore';
import type { PluginManager } from '../plugins/pluginManager';
import { RawLogDocument } from '../editors/rawLogDocument';
import type { SignalGroupDto } from '../editors/rawLogProtocol';
import { resolveClipPath } from './clipPaths';
import { clipComparisonHtml } from './clipComparisonHtml';
import type { ClipComparisonToExtension, ClipComparisonToWebview, ComparisonClipDto } from './clipComparisonProtocol';
import { saveRenderedImage } from '../imageExport';

export class ClipComparisonEditor implements vscode.Disposable {
  private panels = new Set<vscode.WebviewPanel>();
  constructor(private readonly extensionUri: vscode.Uri, private readonly store: ProjectStore, private readonly plugins: PluginManager) {}

  open(clips: readonly ClipDefinition[]): void {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath; const unique = [...new Map(clips.map((clip) => [clip.id, clip])).values()];
    if (unique.length < 1) { void vscode.window.showInformationMessage('Select one or more Clips to compare.'); return; }
    const available = unique.filter((clip) => fs.existsSync(resolveClipPath(clip, root)));
    if (!available.length) { void vscode.window.showErrorMessage('The selected Clip source files could not be found.'); return; }
    if (available.length !== unique.length) void vscode.window.showWarningMessage(`${unique.length - available.length} Clip source file(s) could not be found and were excluded.`);
    const panel = vscode.window.createWebviewPanel('sigmixa.clipComparison', 'Clip Comparison', vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true });
    panel.webview.html = clipComparisonHtml(panel.webview, this.extensionUri, vscode.env.language); this.panels.add(panel);
    const documentsByPath = new Map<string, RawLogDocument>(); const documentsByClip = new Map<string, RawLogDocument>();
    const anchors = new Map(available.map((clip) => [clip.id, clip.startTimestamp]));
    let payload: { readonly clips: readonly ComparisonClipDto[]; readonly definitions: readonly SignalDefinition[]; readonly groups: readonly SignalGroupDto[]; readonly selectedSignalIds: readonly string[] } | undefined; let disposed = false;
    const documentFor = (filePath: string): RawLogDocument => {
      let document = documentsByPath.get(filePath);
      if (!document) { document = new RawLogDocument(vscode.Uri.file(filePath), this.store.current, this.store.analysisRevision, this.plugins.registry); documentsByPath.set(filePath, document); }
      return document;
    };
    const load = async () => {
      if (payload) { if (!disposed) await panel.webview.postMessage({ type: 'init', ...payload } satisfies ClipComparisonToWebview); return; }
      const loaded: ClipDefinition[] = []; const definitionsById = new Map<string, SignalDefinition>();
      const failed: string[] = [];
      await Promise.all(available.map(async (clip) => {
        try {
          const filePath = resolveClipPath(clip, root); const document = documentFor(filePath); documentsByClip.set(clip.id, document);
          await document.whenReady(); for (const definition of document.signalCatalog()) definitionsById.set(definition.id, definition); loaded.push(clip);
        } catch { failed.push(clip.name); }
      }));
      if (disposed) return;
      if (failed.length) void vscode.window.showWarningMessage(`Could not load ${failed.length} Clip(s): ${failed.join(', ')}`);
      const ordered = available.filter((clip) => loaded.includes(clip)); const definitions = [...definitionsById.values()]; const validIds = new Set(definitionsById.keys());
      const selectedSignalIds = [...new Set(ordered.flatMap((clip) => clip.signalIds))].filter((id) => validIds.has(id));
      const seriesByClip = buildSeries(ordered, documentsByClip, selectedSignalIds);
      const clipsPayload = ordered.map((clip) => ({ id: clip.id, name: clip.name, fileName: clip.sourceFileName, startTimestamp: clip.startTimestamp, endTimestamp: clip.endTimestamp, anchorTimestamp: clip.startTimestamp, series: seriesByClip.find((item) => item.clipId === clip.id)?.series ?? [] }));
      payload = { clips: clipsPayload, definitions, groups: comparisonGroups(definitions, this.store.current), selectedSignalIds };
      await panel.webview.postMessage({ type: 'init', ...payload } satisfies ClipComparisonToWebview);
    };
    panel.webview.onDidReceiveMessage((message: ClipComparisonToExtension) => {
      if (message.type === 'ready') void load();
      else if (message.type === 'measuredSignalsRequest') {
        const clip = available.find((item) => item.id === message.clipId);
        const samples = clip ? documentsByClip.get(clip.id)?.measuredSignals(message.signalIds, message.timestamp, { start: clip.startTimestamp, end: clip.endTimestamp }) ?? [] : [];
        void panel.webview.postMessage({ type: 'measuredSignals', requestId: message.requestId, samples } satisfies ClipComparisonToWebview);
      }
      else if (message.type === 'selectSignals' && payload) {
        const valid = new Set(payload.definitions.map((item) => item.id)); const selectedSignalIds = [...new Set(message.signalIds)].filter((id) => valid.has(id));
        const loadedClips = available.filter((clip) => documentsByClip.has(clip.id)); const seriesByClip = buildSeries(loadedClips, documentsByClip, selectedSignalIds);
        payload = { ...payload, selectedSignalIds, clips: payload.clips.map((clip) => ({ ...clip, series: seriesByClip.find((item) => item.clipId === clip.id)?.series ?? [] })) };
        void panel.webview.postMessage({ type: 'seriesChanged', requestId: message.requestId, seriesByClip } satisfies ClipComparisonToWebview);
      }
      else if (message.type === 'resetAnchor') {
        const clip = available.find((item) => item.id === message.clipId); if (!clip) return;
        anchors.set(message.clipId, clip.startTimestamp);
        void panel.webview.postMessage({ type: 'anchorChanged', clipId: message.clipId, anchorTimestamp: clip.startTimestamp } satisfies ClipComparisonToWebview);
      }
      else if (message.type === 'shiftAnchor') {
        const document = documentsByClip.get(message.clipId); const current = anchors.get(message.clipId); if (!document || current === undefined) return;
        let next = current; const steps = Math.max(1, Math.min(100, Math.floor(message.steps ?? 1)));
        for (let step = 0; step < steps; step++) { const adjacent = document.adjacentFrameTimestamp(next, message.direction); if (adjacent === undefined) break; next = adjacent; }
        if (next === current) return; anchors.set(message.clipId, next);
        void panel.webview.postMessage({ type: 'anchorChanged', clipId: message.clipId, anchorTimestamp: next } satisfies ClipComparisonToWebview);
      }
      else if (message.type === 'setAnchor') {
        const document = documentsByClip.get(message.clipId); if (!document || !Number.isFinite(message.timestamp)) return;
        const next = document.nearestFrameTimestamp(message.timestamp); if (next === undefined) return; anchors.set(message.clipId, next);
        void panel.webview.postMessage({ type: 'anchorChanged', clipId: message.clipId, anchorTimestamp: next } satisfies ClipComparisonToWebview);
      }
      else if (message.type === 'saveClipComparisonImage') {
        void saveRenderedImage({ title: 'Save Clip Comparison Image', japaneseTitle: 'クリップ比較画像を保存', defaultBasePath: root ? path.join(root, 'sigmixa-clip-comparison') : undefined, image: message });
      }
    });
    panel.onDidDispose(() => { disposed = true; this.panels.delete(panel); for (const document of documentsByPath.values()) document.dispose(); });
  }
  dispose(): void { for (const panel of this.panels) panel.dispose(); this.panels.clear(); }
}

function buildSeries(clips: readonly ClipDefinition[], documents: ReadonlyMap<string, RawLogDocument>, signalIds: readonly string[]) {
  const divisor = Math.max(1, clips.length * signalIds.length); const maxPoints = Math.max(2, Math.min(4000, Math.floor(100_000 / divisor)));
  return clips.map((clip) => ({
    clipId: clip.id,
    series: documents.get(clip.id)?.signalSeries(signalIds, { start: clip.startTimestamp, end: clip.endTimestamp }, maxPoints).series.map((item) => ({ ...item, events: item.events ?? [] })) ?? [],
  }));
}

function comparisonGroups(definitions: readonly SignalDefinition[], project: ProjectStore['current']): SignalGroupDto[] {
  const groups = new Map<string, { label: string; signalIds: string[] }>();
  for (const definition of definitions) {
    const source = definition.source; let key: string; let label: string;
    if (source.type === 'manual-can') {
      const frame = project.frames.find((item) => item.id === source.frameDefinitionId); key = `frame:${source.frameDefinitionId}`;
      label = frame ? `${formatCanId(frame.canId, frame.extended)}${frame.name ? ` ${frame.name}` : ''}` : definition.group || 'CAN Frame';
    } else if (source.type === 'plugin') {
      key = `plugin:${source.pluginId}:${source.bindingId}:${definition.group ?? ''}`; label = `Plugin ${source.pluginId}${definition.group ? ` · ${definition.group}` : ''}`;
    } else if (source.type === 'external-csv') {
      const external = project.externalCsvSources.find((item) => item.id === source.sourceId); key = `external:${source.sourceId}`; label = `External · ${external?.fileName ?? source.sourceId}`;
    } else { key = 'calculated'; label = 'Calculated Signals'; }
    const group = groups.get(key) ?? { label, signalIds: [] }; group.signalIds.push(definition.id); groups.set(key, group);
  }
  return [...groups].map(([id, group]) => ({ id, ...group }));
}
