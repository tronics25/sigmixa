import * as vscode from 'vscode';

function nonce(): string { return Array.from({ length: 32 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 62)]).join(''); }

export function pluginEditorHtml(webview: vscode.Webview, extensionUri: vscode.Uri, title: string, locale: string): string {
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'out', 'webview', 'pluginEditor.js'));
  const codicons = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'codicons', 'codicon.css'));
  const token = nonce();
  const escaped = title.replace(/[&<>"']/g, (value) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[value]!));
  return '<!doctype html><html lang="' + (locale.toLowerCase().startsWith('ja') ? 'ja' : 'en') + '"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src " + webview.cspSource + " 'unsafe-inline'; font-src " + webview.cspSource + "; script-src 'nonce-" + token + "';\">" +
    '<link rel="stylesheet" href="' + codicons + '"><title>' + escaped + '</title></head><body><main id="app"></main><script nonce="' + token + '" src="' + script + '"></script></body></html>';
}
