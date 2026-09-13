import * as path from 'path';
import * as vscode from 'vscode';
import type { ClipDefinition } from '../../core/project/schema';

export function resolveClipPath(clip: ClipDefinition, workspaceRoot?: string): string {
  return path.isAbsolute(clip.sourcePath) ? clip.sourcePath : path.resolve(workspaceRoot ?? '', clip.sourcePath);
}

export function portableClipPath(sourcePath: string, workspaceRoot?: string): string {
  if (!workspaceRoot) return sourcePath;
  const relative = path.relative(workspaceRoot, sourcePath);
  return !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative) ? relative : sourcePath;
}

export function clipResourceUri(clip: ClipDefinition, workspaceRoot?: string): vscode.Uri {
  return vscode.Uri.file(resolveClipPath(clip, workspaceRoot)).with({ fragment: `sigmixa-clip=${encodeURIComponent(clip.id)}` });
}

export function clipIdFromUri(uri: vscode.Uri): string | undefined {
  const match = /^sigmixa-clip=(.+)$/.exec(uri.fragment);
  if (!match) return undefined;
  try { return decodeURIComponent(match[1]); } catch { return undefined; }
}
