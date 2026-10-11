import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';

/** The installed SigMixa version, recorded in reports. */
export function extensionVersion(extensionUri: vscode.Uri): string {
  try { return String((JSON.parse(fs.readFileSync(path.join(extensionUri.fsPath, 'package.json'), 'utf8')) as { version?: unknown }).version ?? ''); } catch { return ''; }
}
