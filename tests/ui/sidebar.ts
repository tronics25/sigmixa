/**
 * The sidebar as VS Code builds it from package.json: every row of every SigMixa tree, and every command its right-click
 * menu and title bar offer there. The tests run each offered command on each kind of row.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { host } from './vscodeHost';

export interface Row { readonly view: string; readonly node: unknown; readonly contextValue: string; readonly label: string }
export interface MenuEntry { readonly view: string; readonly command: string; readonly title: string; readonly when: string; readonly onRow: boolean }

/** Every row of a tree, expanded all the way down. */
export async function rows(view: string): Promise<Row[]> {
  const tree = host.trees.get(view); if (!tree) return [];
  const found: Row[] = [];
  const walk = async (parent: unknown, depth: number) => {
    if (depth > 8) return;
    const children = (await tree.treeDataProvider.getChildren(parent)) as unknown[] | undefined ?? [];
    for (const node of children) {
      const item = (await tree.treeDataProvider.getTreeItem(node)) as { contextValue?: string; label?: unknown; collapsibleState?: number };
      const label = typeof item.label === 'string' ? item.label : (item.label as { label?: string } | undefined)?.label ?? '';
      found.push({ view, node, contextValue: item.contextValue ?? '', label });
      if (item.collapsibleState) await walk(node, depth + 1);
    }
  };
  await walk(undefined, 0);
  return found;
}

/** The menus package.json gives the SigMixa views, with their titles in English. */
export function menus(repository: string): MenuEntry[] {
  const manifest = JSON.parse(fs.readFileSync(path.join(repository, 'package.json'), 'utf8')) as { contributes: { commands: { command: string; title: string }[]; menus: Record<string, { command: string; when?: string }[]> } };
  const names = JSON.parse(fs.readFileSync(path.join(repository, 'package.nls.json'), 'utf8')) as Record<string, string>;
  const title = (command: string) => { const raw = manifest.contributes.commands.find((item) => item.command === command)?.title ?? command; return raw.replace(/^%(.*)%$/, (_all, key: string) => names[key] ?? key); };
  const entries: MenuEntry[] = [];
  for (const [place, items] of Object.entries(manifest.contributes.menus)) {
    if (place !== 'view/title' && place !== 'view/item/context') continue;
    for (const item of items) {
      const view = /view == ([\w.]+)/.exec(item.when ?? '')?.[1]; if (!view) continue;
      entries.push({ view, command: item.command, title: title(item.command), when: item.when ?? '', onRow: place === 'view/item/context' });
    }
  }
  return entries;
}

/** Whether a menu's `when` holds for a row, as VS Code decides it (one row selected, on this platform). */
export function offered(entry: MenuEntry, row: Row | undefined, platform = process.platform): boolean {
  const context: Record<string, unknown> = { view: entry.view, viewItem: row?.contextValue ?? '', listMultiSelection: false, isMac: platform === 'darwin', isWindows: platform === 'win32', isLinux: platform === 'linux', 'sigmixa.canCompare': false, explorerResourceIsFolder: false };
  return entry.when.split('&&').every((part) => {
    const term = part.trim(); const negated = term.startsWith('!'); const body = negated ? term.slice(1).trim() : term;
    let value: boolean;
    const equals = /^([\w.]+) == ([\w.]+)$/.exec(body); const matches = /^([\w.]+) =~ \/(.*)\/$/.exec(body);
    if (equals) value = String(context[equals[1]]) === equals[2];
    else if (matches) value = new RegExp(matches[2]).test(String(context[matches[1]]));
    else value = Boolean(context[body]);
    return negated ? !value : value;
  });
}
