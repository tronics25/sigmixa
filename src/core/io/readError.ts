/** Why a log could not be read, so the message can say what to do rather than only echo the system error. */
export type LogReadErrorKind = 'unc-not-allowed' | 'access-denied' | 'not-found' | 'busy' | 'network' | 'other';

/** The server name of a Windows UNC path (\\server\share\...), if it is one. */
export function uncHost(filePath: string): string | undefined {
  return /^(?:\\\\|\/\/)(?!\?\\|\.\\)([^\\/]+)[\\/]/.exec(filePath)?.[1];
}

export function classifyLogReadError(error: unknown, filePath: string): LogReadErrorKind {
  const value = error as { code?: unknown; message?: unknown } | undefined;
  const code = typeof value?.code === 'string' ? value.code : ''; const message = typeof value?.message === 'string' ? value.message : String(error ?? '');
  // VS Code blocks UNC hosts that are not listed in the `security.allowedUNCHosts` setting.
  if (/allowedUNCHosts|UNC host/i.test(message)) return 'unc-not-allowed';
  if (code === 'EACCES' || code === 'EPERM' || /access is denied|permission denied|operation not permitted/i.test(message)) return uncHost(filePath) && /UNC/i.test(message) ? 'unc-not-allowed' : 'access-denied';
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'not-found';
  if (code === 'EBUSY' || /being used by another process/i.test(message)) return 'busy';
  if (['ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNRESET', 'ENETDOWN', 'EIO'].includes(code) || /network (?:name|path)/i.test(message)) return 'network';
  return 'other';
}
