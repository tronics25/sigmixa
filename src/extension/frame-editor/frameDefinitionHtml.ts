import * as vscode from 'vscode';

function nonce(): string {
  return Array.from({ length: 32 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 62)]).join('');
}

export function frameDefinitionHtml(webview: vscode.Webview, extensionUri: vscode.Uri, title: string): string {
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'out', 'webview', 'frameDefinition.js'));
  const codicons = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'codicons', 'codicon.css'));
  const token = nonce();
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${token}';"><link rel="stylesheet" href="${codicons}"><title>${title.replace(/[<>]/g, '')}</title></head><body><main id="app"></main><script nonce="${token}" src="${script}"></script></body></html>`;
}
