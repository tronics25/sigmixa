import { diagnosticText } from '../shared/diagnosticText';
import * as vscode from 'vscode';

/** Extension-side counterpart of the Webview `t()`: Japanese when VS Code runs in Japanese, English otherwise. */
export function t(english: string, japanese: string): string {
  return vscode.env.language.toLowerCase().startsWith('ja') ? japanese : english;
}

/** Localize built-in error details at the presentation boundary, retaining unknown external errors. */
export function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return diagnosticText(message, vscode.env.language);
}
