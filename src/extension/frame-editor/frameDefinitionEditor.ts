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
}

export class FrameDefinitionEditor implements vscode.Disposable {
  private readonly panels = new Map<string, vscode.WebviewPanel>();

  constructor(private readonly extensionUri: vscode.Uri, private readonly store: ProjectStore) {}

  async create(prefill: NewFramePrefill = {}): Promise<void> {
    if (!this.store.requireWorkspace()) return;
    const defaultId = prefill.canId === undefined ? '' : formatCanId(prefill.canId, prefill.extended === true);
    const idText = await vscode.window.showInputBox({ title: 'Register CAN Frame', prompt: 'CAN ID', value: defaultId, validateInput: (value) => parseCanId(value) ? undefined : 'Enter a valid CAN ID.' });
    if (!idText) return;
    const parsed = parseCanId(idText);
    if (!parsed) return;
    const existing = this.store.current.frames.find((frame) => frame.canId === parsed.canId && frame.extended === parsed.extended);
    if (existing) { this.open(existing.id); return; }
    const name = await vscode.window.showInputBox({ title: 'Register CAN Frame', prompt: 'Frame name', value: 'New Frame', validateInput: (value) => value.trim() ? undefined : 'Frame name is required.' });
    if (!name) return;
    const frame: ManualFrameDefinition = {
      id: `frame-${randomUUID()}`,
      canId: parsed.canId,
      extended: parsed.extended,
      name: name.trim(),
      frameLength: Math.min(64, Math.max(0, prefill.frameLength ?? 8)),
      signals: [],
      derivedSignals: [],
      origin: { type: 'manual' },
    };
    await this.store.update((project) => ({ ...project, frames: [...project.frames, frame] }));
    this.open(frame.id);
  }

  open(frameId: string, focusSignalId?: string): void {
    const frame = this.store.current.frames.find((item) => item.id === frameId);
    if (!frame) { void vscode.window.showErrorMessage('CAN frame definition was not found.'); return; }
    const existing = this.panels.get(frameId);
    if (existing) { existing.reveal(); void this.send(existing, { type: 'init', frame, widths: this.savedWidths() }); return; }
    const panel = vscode.window.createWebviewPanel('sigmixa.frameDefinition', frame.name, vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true });
    panel.webview.html = frameDefinitionHtml(panel.webview, this.extensionUri, frame.name);
    this.panels.set(frameId, panel);
    panel.onDidDispose(() => this.panels.delete(frameId));
    panel.webview.onDidReceiveMessage((message: FrameEditorToExtension) => {
      if (message.type === 'ready') void this.send(panel, { type: 'init', frame: this.store.current.frames.find((item) => item.id === frameId) ?? frame, widths: this.savedWidths() });
      else if (message.type === 'save') void this.save(panel, frameId, message.frame);
      else if (message.type === 'saveViewState') void this.saveWidths(message.widths);
    });
    void focusSignalId;
  }

  close(frameId: string): void { this.panels.get(frameId)?.dispose(); }

  dispose(): void { for (const panel of this.panels.values()) panel.dispose(); this.panels.clear(); }

  private async save(panel: vscode.WebviewPanel, frameId: string, candidate: ManualFrameDefinition): Promise<void> {
    const current = this.store.current.frames.find((frame) => frame.id === frameId);
    if (!current) return;
    const frame = normalizeFrameDefinition({ ...candidate, id: frameId, origin: current.origin });
    const validation = validateFrameDefinition(frame);
    const diagnostics: Diagnostic[] = [...validation.diagnostics];
    const duplicate = this.store.current.frames.find((item) => item.id !== frameId && item.canId === frame.canId && item.extended === frame.extended);
    if (duplicate) diagnostics.push({ id: `definition:FRAME_CAN_ID_DUPLICATE:${frameId}`, source: 'definition', code: 'FRAME_CAN_ID_DUPLICATE', severity: 'error', message: `CAN ID is already registered as “${duplicate.name}”.` });
    const otherSignalIds = new Set(this.store.current.frames.filter((item) => item.id !== frameId).flatMap((item) => [...item.signals, ...(item.derivedSignals ?? [])].map((signal) => signal.id)));
    for (const signal of [...frame.signals, ...(frame.derivedSignals ?? [])]) if (otherSignalIds.has(signal.id)) diagnostics.push({ id: `definition:SIGNAL_ID_PROJECT_DUPLICATE:${signal.id}`, source: 'definition', code: 'SIGNAL_ID_PROJECT_DUPLICATE', severity: 'error', message: `Signal ID “${signal.id}” is already used by another frame.`, details: { signalId: signal.id } });
    if (diagnostics.length) { await this.send(panel, { type: 'saveResult', saved: false, diagnostics }); return; }
    try {
      await this.store.update((project) => ({ ...project, frames: project.frames.map((item) => item.id === frameId ? frame : item) }));
      panel.title = frame.name;
      await this.send(panel, { type: 'saveResult', saved: true, diagnostics: [], frame });
    } catch (error) {
      await this.send(panel, { type: 'saveResult', saved: false, diagnostics: [{ id: `storage:save:${frameId}`, source: 'storage', code: 'PROJECT_SAVE_FAILED', severity: 'error', message: (error as Error).message }] });
    }
  }

  private send(panel: vscode.WebviewPanel, message: FrameEditorToWebview): Thenable<boolean> { return panel.webview.postMessage(message); }

  private savedWidths(): Readonly<Record<string, number>> | undefined {
    const value = this.store.current.viewStates['frame-definition-columns'];
    return value && typeof value === 'object' ? value as Readonly<Record<string, number>> : undefined;
  }

  private async saveWidths(widths: Readonly<Record<string, number>>): Promise<void> {
    const safe = Object.fromEntries(Object.entries(widths).filter(([, value]) => Number.isFinite(value) && value >= 32 && value <= 1000));
    try { await this.store.update((project) => ({ ...project, viewStates: { ...project.viewStates, 'frame-definition-columns': safe } })); }
    catch { /* Definition saving surfaces storage failures; width persistence is best-effort. */ }
  }
}
