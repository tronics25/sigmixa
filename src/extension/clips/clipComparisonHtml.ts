import * as vscode from 'vscode';

function nonce(): string { return Array.from({ length: 32 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 62)]).join(''); }

export function clipComparisonHtml(webview: vscode.Webview, extensionUri: vscode.Uri, locale: string): string {
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'out', 'webview', 'clipComparison.js')); const token = nonce();
  return `<!doctype html><html lang="${locale.toLowerCase().startsWith('ja') ? 'ja' : 'en'}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${token}';"><title>Clip Comparison</title></head><body><main id="app"></main><script nonce="${token}" src="${script}"></script></body></html>`;
}
