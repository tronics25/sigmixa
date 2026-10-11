import * as path from 'path';
import * as vscode from 'vscode';
import { classifyLogReadError, uncHost } from '../../core/io/readError';
import { t } from '../i18n';

/** A read failure explained in terms of what to do, followed by the system's own message. */
export function describeLogReadError(error: unknown, filePath: string): string {
  const host = uncHost(filePath); const detail = error instanceof Error ? error.message : String(error);
  const hint = (() => {
    switch (classifyLogReadError(error, filePath)) {
      case 'unc-not-allowed': return t(`VS Code does not allow access to the network host “${host ?? '?'}”. Add it to the security.allowedUNCHosts setting, or copy the log to a local folder.`, `VS Code がネットワーク上のホスト「${host ?? '?'}」へのアクセスを許可していません。設定 security.allowedUNCHosts に追加するか、ログをローカルにコピーしてください。`);
      case 'access-denied': return t('Access to the file was denied. Check that you can read this shared folder, and that no other program has the log open exclusively.', 'ファイルへのアクセスが拒否されました。この共有フォルダーの読み取り権限と、他のアプリがログを占有していないかを確認してください。');
      case 'not-found': return t('The log file was not found.', 'ログファイルが見つかりません。');
      case 'busy': return t('Another program is using the log. Close it and open the log again.', '他のアプリがログを使用中です。閉じてから開き直してください。');
      case 'network': return t('The network location could not be reached. Check the connection to the share.', 'ネットワーク上の場所に接続できません。共有への接続を確認してください。');
      default: return t('The log could not be read.', 'ログを読み込めませんでした。');
    }
  })();
  return `${hint} (${detail})`;
}

/** For a blocked UNC host, offer to open the setting that allows it (the user decides; nothing is changed here). */
export function notifyLogReadError(error: unknown, filePath: string): void {
  if (classifyLogReadError(error, filePath) !== 'unc-not-allowed') return;
  const host = uncHost(filePath); const open = t('Open Settings', '設定を開く');
  void vscode.window.showErrorMessage(t(`Could not open ${path.basename(filePath)}: VS Code does not allow the network host “${host}”. Add it to security.allowedUNCHosts to open logs from this share.`, `${path.basename(filePath)} を開けません: VS Code がネットワーク上のホスト「${host}」を許可していません。この共有のログを開くには security.allowedUNCHosts に追加してください。`), open)
    .then((choice) => { if (choice === open) void vscode.commands.executeCommand('workbench.action.openSettings', 'security.allowedUNCHosts'); });
}
