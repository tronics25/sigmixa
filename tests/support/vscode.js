// Minimal stand-in for the `vscode` module, enough for storage tests that run outside VS Code (file system, Uri, messages).
const fs = require('fs'); const fsp = require('fs/promises'); const path = require('path');
class Uri { constructor(fsPath, fragment = '') { this.fsPath = fsPath; this.path = fsPath; this.fragment = fragment; this.scheme = 'file'; }
  static file(p) { return new Uri(path.resolve(p)); } static joinPath(base, ...parts) { return new Uri(path.join(base.fsPath, ...parts)); }
  with(change) { return new Uri(this.fsPath, change.fragment ?? this.fragment); } toString() { return 'file://' + encodeURI(this.fsPath) + (this.fragment ? '#' + this.fragment : ''); } }
class FileSystemError extends Error { constructor(code, message) { super(message); this.code = code; } }
const wrap = async (fn) => { try { return await fn(); } catch (error) { if (error.code === 'ENOENT') throw new FileSystemError('FileNotFound', error.message); throw error; } };
const messages = [];
class EventEmitter { constructor() { this.listeners = []; this.event = (l) => { this.listeners.push(l); return { dispose() {} }; }; } fire(v) { for (const l of this.listeners) l(v); } dispose() {} }
module.exports = {
  Uri, FileSystemError, EventEmitter, messages, env: { language: 'en' },
  workspace: { workspaceFolders: [], fs: {
    readFile: (u) => wrap(() => fsp.readFile(u.fsPath)), writeFile: (u, b) => wrap(() => fsp.writeFile(u.fsPath, b)),
    stat: (u) => wrap(() => fsp.stat(u.fsPath)), createDirectory: (u) => fsp.mkdir(u.fsPath, { recursive: true }),
    rename: (a, b, o) => wrap(async () => { if (!o?.overwrite && fs.existsSync(b.fsPath)) throw new Error('exists'); await fsp.rename(a.fsPath, b.fsPath); }),
    copy: (a, b) => wrap(() => fsp.copyFile(a.fsPath, b.fsPath)),
    delete: (u, o) => wrap(() => fsp.rm(u.fsPath, { recursive: !!o?.recursive })) } },
  window: { showErrorMessage: (m) => { messages.push(['error', m]); return Promise.resolve(); }, showWarningMessage: (m) => { messages.push(['warn', m]); return Promise.resolve(); }, showInformationMessage: (m) => { messages.push(['info', m]); return Promise.resolve(); } },
};
