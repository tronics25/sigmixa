import * as path from 'path';
import * as vscode from 'vscode';
import type { ClipDefinition } from '../../core/project/schema';

export function resolveClipPath(clip: ClipDefinition, workspaceRoot?: string): string {
  return path.isAbsolute(clip.sourcePath) ? clip.sourcePath : path.resolve(workspaceRoot ?? '', clip.sourcePath);
}

export function portableClipPath(sourcePath: string, workspaceRoot?: string): string {
  if (!workspaceRoot) return sourcePath;
  const relative = path.relative(workspaceRoot, sourcePath);
  // Workspace paths are stored with '/' on every OS, so the same project reads the same on Windows and macOS.
  return !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative) ? relative.split(path.sep).join('/') : sourcePath;
}

export function clipIdFromUri(uri: vscode.Uri): string | undefined {
  // The fragment may also name the group the Clip was opened from.
  const match = /(?:^|&)sigmixa-clip=([^&]+)/.exec(uri.fragment);
  if (!match) return undefined;
  try { return decodeURIComponent(match[1]); } catch { return undefined; }
}
