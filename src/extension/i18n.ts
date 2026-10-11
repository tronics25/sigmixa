import * as vscode from 'vscode';

/** Extension-side counterpart of the Webview `t()`: Japanese when VS Code runs in Japanese, English otherwise. */
export function t(english: string, japanese: string): string {
  return vscode.env.language.toLowerCase().startsWith('ja') ? japanese : english;
}
