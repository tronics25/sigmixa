import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Files copied in the OS file manager (Finder, Explorer) are on the clipboard as file references, which VS Code's
 * clipboard API does not expose: it only returns text. They are read here with the tools the OS ships with.
 */
const MAC_SCRIPT = `ObjC.import('AppKit');
function run() {
  const urls = $.NSPasteboard.generalPasteboard.readObjectsForClassesOptions($.NSArray.arrayWithObject($.NSURL), $.NSDictionary.dictionaryWithObjectForKey(true, 'NSPasteboardURLReadingFileURLsOnly'));
  const paths = [];
  if (urls && !urls.isNil()) for (let i = 0; i < urls.count; i++) paths.push(ObjC.unwrap(urls.objectAtIndex(i).path));
  return paths.join('\\n');
}`;
const WINDOWS_SCRIPT = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }';

function run(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve) => execFile(command, [...args], { timeout: 5000, windowsHide: true, encoding: 'utf8' }, (error, stdout) => resolve(error ? '' : stdout)));
}

/** Absolute paths written as text, one per line: plain paths or file: URIs. Anything else is not a file list. */
export function pathsFromClipboardText(text: string): string[] {
  const paths: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(); if (!line) continue;
    if (/^file:\/\//i.test(line)) { try { paths.push(fileURLToPath(line)); continue; } catch { return []; } }
    if (!path.isAbsolute(line)) return [];
    paths.push(line);
  }
  return [...new Set(paths)];
}

/** The files on the clipboard: those copied in the OS file manager, or else paths copied as text. */
export async function clipboardFiles(text: () => Thenable<string>, platform: NodeJS.Platform = process.platform): Promise<string[]> {
  const listed = platform === 'darwin' ? await run('osascript', ['-l', 'JavaScript', '-e', MAC_SCRIPT])
    : platform === 'win32' ? await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_SCRIPT]) : '';
  const files = pathsFromClipboardText(listed);
  return files.length ? files : pathsFromClipboardText(await text());
}
