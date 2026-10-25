import { overrideTemplate, sharedSignalIds, updateGroup } from '../../core/project/analysisGroups';
import type { SigMixaProject } from '../../core/project/schema';
import { t } from '../i18n';
import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import type { Diagnostic } from '../../core/diagnostics/diagnostic';
import { formatCanId, parseCanId } from '../../core/frame/canId';
import { normalizeFrameDefinition, validateFrameDefinition, type ManualFrameDefinition } from '../../core/manual/manualDefinition';
import type { ProjectStore } from '../storage/projectStore';
import { frameDefinitionHtml } from './frameDefinitionHtml';
import type { FrameEditorToExtension, FrameEditorToWebview } from './frameDefinitionProtocol';

export interface NewFramePrefill {
  readonly canId?: number;
  readonly extended?: boolean;
  readonly frameLength?: number;
  readonly groupId?: string;
}

export class FrameDefinitionEditor implements vscode.Disposable {
  private readonly panels = new Map<string, vscode.WebviewPanel>();

  constructor(private readonly extensionUri: vscode.Uri, private readonly store: ProjectStore) {}

  async create(prefill: NewFramePrefill = {}): Promise<void> {
    if (!this.store.requireWorkspace()) return;
    const defaultId = prefill.canId === undefined ? '' : formatCanId(prefill.canId, prefill.extended === true);
    const idText = await vscode.window.showInputBox({ title: t('Register CAN Frame', "フレームを登録"), prompt: 'CAN ID', value: defaultId, validateInput: (value) => parseCanId(value) ? undefined : t('Enter a valid CAN ID.', "有効なCAN IDを入力してください。") });
    if (!idText) return;
    const parsed = parseCanId(idText);
    if (!parsed) return;
    const existing = this.frames(prefill.groupId).find((frame) => frame.canId === parsed.canId && frame.extended === parsed.extended);
    if (existing) { this.open(existing.id, undefined, prefill.groupId); return; }
    // In a group, a CAN ID already defined above it starts from that definition (name, length, Signals).
    const id = `frame-${randomUUID()}`;
    const template = prefill.groupId ? overrideTemplate(this.store.current, prefill.groupId, parsed.canId, parsed.extended, id) : undefined;
    const name = await vscode.window.showInputBox({ title: t('Register CAN Frame', "フレームを登録"), prompt: template ? t(`Frame name (starts from the definition above: ${template.name})`, `フレーム名（上の定義「${template.name}」を元に作成）`) : t('Frame name', "フレーム名"), value: template?.name ?? 'New Frame', validateInput: (value) => value.trim() ? undefined : t('Frame name is required.', "フレーム名を入力してください。") });
    if (!name) return;
    const frame: ManualFrameDefinition = template ? { ...template, name: name.trim() } : {
      id,
      canId: parsed.canId,
      extended: parsed.extended,
      name: name.trim(),
      frameLength: Math.min(64, Math.max(0, prefill.frameLength ?? 8)),
      signals: [],
      derivedSignals: [],
      origin: { type: 'manual' },
    };
    await this.store.update((project) => prefill.groupId ? updateGroup(project, prefill.groupId, (group) => ({ ...group, frames: [...group.frames, frame] })) : ({ ...project, frames: [...project.frames, frame] }));
    this.open(frame.id, undefined, prefill.groupId);
  }

  open(frameId: string, focusSignalId?: string, groupId?: string, preserveFocus = false): void {
    const frame = this.frames(groupId).find((item) => item.id === frameId);
    if (!frame) { void vscode.window.showErrorMessage(t('CAN frame definition was not found.', "フレーム定義が見つかりません。")); return; }
    const panelKey = `${groupId ?? 'common'}:${frameId}`;
    const existing = this.panels.get(panelKey);
    if (existing) { existing.reveal(undefined, preserveFocus); return; }
    const panel = vscode.window.createWebviewPanel('sigmixa.frameDefinition', frame.name, { viewColumn: vscode.ViewColumn.One, preserveFocus }, { enableScripts: true, retainContextWhenHidden: true, enableFindWidget: true });
    panel.webview.html = frameDefinitionHtml(panel.webview, this.extensionUri, frame.name, vscode.env.language);
    this.panels.set(panelKey, panel);
    panel.onDidDispose(() => this.panels.delete(panelKey));
    panel.onDidChangeViewState(({ webviewPanel }) => {
      if (webviewPanel.active) void this.send(webviewPanel, { type: 'sortSignals' });
    });
    panel.webview.onDidReceiveMessage((message: FrameEditorToExtension) => {
      if (message.type === 'ready') void this.send(panel, { type: 'init', frame: this.frames(groupId).find((item) => item.id === frameId) ?? frame, crumbs: this.store.placeCrumbs(groupId ?? ''), listLevel: groupId ?? '', widths: this.savedWidths() });
      else if (message.type === 'save') void this.save(panel, frameId, message.revision, message.frame, groupId);
      else if (message.type === 'saveViewState') void this.saveWidths(message.widths);
      else if (message.type === 'openList') void vscode.commands.executeCommand('sigmixa.openDefinitionsPage', message.level);
    });
    void focusSignalId;
  }

  /** Shows a definition changed elsewhere (renamed in the sidebar) in its open page. */
  reload(frameId: string, groupId?: string): void {
    const panel = this.panels.get(`${groupId ?? 'common'}:${frameId}`); const frame = this.frames(groupId).find((item) => item.id === frameId); if (!panel || !frame) return;
    panel.title = frame.name; void this.send(panel, { type: 'init', frame, crumbs: this.store.placeCrumbs(groupId ?? ''), listLevel: groupId ?? '', widths: this.savedWidths() });
  }

  close(frameId: string, groupId?: string): void { this.panels.get(`${groupId ?? 'common'}:${frameId}`)?.dispose(); }

  private frames(groupId?: string): readonly ManualFrameDefinition[] { return groupId ? this.store.current.analysisGroups?.find((group) => group.id === groupId)?.frames ?? [] : this.store.current.frames; }

  dispose(): void { for (const panel of this.panels.values()) panel.dispose(); this.panels.clear(); }

  private async save(panel: vscode.WebviewPanel, frameId: string, revision: number, candidate: ManualFrameDefinition, groupId?: string): Promise<void> {
    const current = this.frames(groupId).find((frame) => frame.id === frameId);
    if (!current) return;
    const frame = normalizeFrameDefinition({ ...candidate, id: frameId, origin: current.origin });
    const validation = validateFrameDefinition(frame);
    const diagnostics: Diagnostic[] = [...validation.diagnostics];
    const apply = (project: SigMixaProject): SigMixaProject => groupId ? updateGroup(project, groupId, (group) => ({ ...group, frames: group.frames.map((item) => item.id === frameId ? frame : item) })) : ({ ...project, frames: project.frames.map((item) => item.id === frameId ? frame : item) });
    const duplicate = this.frames(groupId).find((item) => item.id !== frameId && item.canId === frame.canId && item.extended === frame.extended);
    if (duplicate) diagnostics.push({ id: `definition:FRAME_CAN_ID_DUPLICATE:${frameId}`, source: 'definition', code: 'FRAME_CAN_ID_DUPLICATE', severity: 'error', message: `CAN ID is already registered as “${duplicate.name}”.` });
    const otherSignalIds = new Set(this.frames(groupId).filter((item) => item.id !== frameId).flatMap((item) => [...item.signals, ...(item.derivedSignals ?? [])].map((signal) => signal.id)));
    for (const signal of [...frame.signals, ...(frame.derivedSignals ?? [])]) if (otherSignalIds.has(signal.id)) diagnostics.push({ id: `definition:SIGNAL_ID_PROJECT_DUPLICATE:${signal.id}`, source: 'definition', code: 'SIGNAL_ID_PROJECT_DUPLICATE', severity: 'error', message: `Signal ID “${signal.id}” is already used by another frame.`, details: { signalId: signal.id } });
    // The same check over every place the Frame applies in: an override shares its Signal IDs with the definition it
    // started from, so the two must stay on one CAN ID, or samples of two CAN IDs would be mixed into one Signal.
    if (!diagnostics.length) {
      const next = apply(this.store.current); const before = new Set(sharedSignalIds(this.store.current).map((item) => `${item.place ?? ''}|${item.signalId}`));
      const clash = sharedSignalIds(next).find((item) => !before.has(`${item.place ?? ''}|${item.signalId}`) && item.frames.some((item) => item.id === frameId));
      if (clash) {
        const other = clash.frames.find((item) => item.id !== frameId) ?? clash.frames[0]; const where = clash.place === undefined ? t('the workspace', 'ワークスペース') : this.store.placeLabel(clash.place);
        diagnostics.push({ id: `definition:FRAME_OVERRIDE_CAN_ID:${frameId}`, source: 'definition', code: 'FRAME_OVERRIDE_CAN_ID', severity: 'error',
          message: t(`This Frame and “${formatCanId(other.canId, other.extended)} ${other.name}” define the same Signals (${clash.signalName}, …), so in ${where} both would apply and their values would be mixed. Keep the two on the same CAN ID.`,
            `このフレームと「${formatCanId(other.canId, other.extended)} ${other.name}」は同じシグナル（${clash.signalName} など）を定義しています。CAN ID が異なると${where}で両方が有効になり、値が混ざります。2 つは同じ CAN ID のままにしてください。`) });
      }
    }
    if (diagnostics.length) { await this.send(panel, { type: 'saveResult', revision, saved: false, diagnostics }); return; }
    try {
      await this.store.update(apply);
      panel.title = frame.name;
      await this.send(panel, { type: 'saveResult', revision, saved: true, diagnostics: [], frame });
    } catch (error) {
      await this.send(panel, { type: 'saveResult', revision, saved: false, diagnostics: [{ id: `storage:save:${frameId}`, source: 'storage', code: 'PROJECT_SAVE_FAILED', severity: 'error', message: (error as Error).message }] });
    }
  }

  private send(panel: vscode.WebviewPanel, message: FrameEditorToWebview): Thenable<boolean> { return panel.webview.postMessage(message); }

  private savedWidths(): Readonly<Record<string, number>> | undefined {
    const value = this.store.current.viewStates['frame-definition-columns'];
    return value && typeof value === 'object' ? value as Readonly<Record<string, number>> : undefined;
  }

  private async saveWidths(widths: Readonly<Record<string, number>>): Promise<void> {
    const textColumns = new Set(['name', 'unit', 'derivedName', 'derivedUnit', 'definition']);
    const safe = Object.fromEntries(Object.entries(widths).filter(([id, value]) => Number.isFinite(value) && value >= 32 && value <= (textColumns.has(id) ? 4096 : 1000)));
    try { await this.store.update((project) => ({ ...project, viewStates: { ...project.viewStates, 'frame-definition-columns': safe } })); }
    catch { /* Definition saving surfaces storage failures; width persistence is best-effort. */ }
  }
}
