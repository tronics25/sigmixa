/**
 * Presses everything a user can press on a screen: every button, tab, menu item, checkbox, drop-down and text field, and
 * every place that has a right-click menu, then each item of each menu that opens. After each press it records what
 * happened (the page changed, drew, sent the extension a message, the extension asked or showed something, a screen
 * opened) and every error, on the page or shown by the extension.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Page } from 'playwright';
import { host, Uri } from './vscodeHost';
import type { Harness, Pressed, Screen, Target } from './harness';

/** Installed before a screen's own script: counts changes and drawing, and marks what listens for presses. */
export const INSTRUMENT = () => {
  const counts = { mutations: 0, draws: 0, inputs: 0 };
  (window as unknown as { __sigmixaCounts: typeof counts }).__sigmixaCounts = counts;
  const listened = new WeakMap<EventTarget, Set<string>>();
  (window as unknown as { __sigmixaListened: typeof listened }).__sigmixaListened = listened;
  const add = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (this: EventTarget, type: string, ...rest: unknown[]) {
    if (['click', 'dblclick', 'contextmenu', 'pointerdown', 'mousedown'].includes(type)) { const set = listened.get(this) ?? new Set<string>(); set.add(type); listened.set(this, set); }
    return (add as (...args: unknown[]) => void).call(this, type, ...rest);
  } as typeof EventTarget.prototype.addEventListener;
  for (const name of ['fillRect', 'strokeRect', 'clearRect', 'fill', 'stroke', 'fillText', 'strokeText', 'drawImage', 'putImageData'] as const) {
    const prototype = CanvasRenderingContext2D.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
    const original = prototype[name];
    prototype[name] = function (this: unknown, ...args: unknown[]) { counts.draws++; return original.apply(this, args); };
  }
  document.addEventListener('input', () => counts.inputs++, true);
  document.addEventListener('change', () => counts.inputs++, true);
  const observe = () => new MutationObserver((records) => { counts.mutations += records.length; }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', observe); else observe();
};

/** Everything pressable that is on screen now. Rows of a table count once: they are told apart by kind, not by content. */
function enumerate(): { key: string; selector: string; action: string; label: string; options?: number; away?: boolean }[] {
  const listened = (window as unknown as { __sigmixaListened: WeakMap<EventTarget, Set<string>> }).__sigmixaListened;
  const visible = (element: Element) => { const rect = element.getBoundingClientRect(); if (rect.width < 2 || rect.height < 2) return false; const style = getComputedStyle(element); return style.visibility !== 'hidden' && style.display !== 'none' && !element.closest('[hidden],[inert]') && Number(style.opacity) > 0; };
  const selectorOf = (element: Element): string => {
    const parts: string[] = []; let node: Element | null = element;
    while (node && node !== document.documentElement) {
      const parent: Element | null = node.parentElement; if (!parent) break;
      const index = [...parent.children].indexOf(node) + 1; parts.unshift(`${node.tagName.toLowerCase()}:nth-child(${index})`); node = parent;
    }
    return `html > ${parts.join(' > ')}`;
  };
  const clean = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim().slice(0, 48);
  const kindOf = (element: Element) => [...element.classList].filter((name) => !/^(active|selected|focused|hover|is-|checked|expanded|collapsed|dragging|pressed|sm-)/.test(name)).sort().join('.');
  const where = (element: Element) => { const card = element.closest('[role=menu], [role=dialog], dialog, .visualize-card, [role=tabpanel], section, header, nav, main'); return card ? `${card.tagName.toLowerCase()}.${kindOf(card)}${card.getAttribute('role') === 'menu' ? `[${card.getAttribute('aria-label')}]` : ''}` : ''; };
  const found = new Map<string, { key: string; selector: string; action: string; label: string; options?: number; away?: boolean }>();
  const offer = (element: Element, action: string, named: boolean) => {
    if ((element as HTMLButtonElement).disabled || element.getAttribute('aria-disabled') === 'true' || !visible(element)) return;
    const name = clean(element.getAttribute('aria-label') || element.getAttribute('title') || (named ? element.textContent : '') || (element as HTMLInputElement).placeholder);
    const label = `${element.tagName.toLowerCase()}${element.getAttribute('role') ? `[${element.getAttribute('role')}]` : ''} "${name}"`;
    const key = `${action} ${where(element)} ${element.tagName.toLowerCase()}.${kindOf(element)} ${element.getAttribute('role') ?? ''} ${(element as HTMLInputElement).type ?? ''} "${name}"`;
    // A link that leaves the screen (a breadcrumb step) is pressed after everything else on it.
    const away = Boolean(element.closest('.crumb-link, a[href]'));
    if (!found.has(key)) found.set(key, { key, selector: selectorOf(element), action, label, options: element instanceof HTMLSelectElement ? element.options.length : undefined, ...(away ? { away } : {}) });
  };
  for (const element of document.querySelectorAll('button, [role=button], [role=tab], [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio], [role=option], [role=treeitem], [role=switch], [role=checkbox], a[href], summary')) offer(element, 'click', true);
  for (const element of document.querySelectorAll('select')) offer(element, 'select', false);
  for (const element of document.querySelectorAll('input, textarea, [contenteditable=true]')) {
    const type = (element as HTMLInputElement).type;
    offer(element, type === 'checkbox' || type === 'radio' || type === 'button' ? 'click' : type === 'range' || type === 'color' || type === 'file' ? 'click' : 'fill', false);
  }
  for (const element of document.querySelectorAll('body *')) {
    const types = listened.get(element); if (!types) continue;
    if (types.has('contextmenu')) offer(element, 'contextmenu', false);
    if (types.has('click') || types.has('dblclick')) offer(element, 'click', false);
  }
  return [...found.values()];
}

/** The items of the menu that is open, in order. */
function menuItems(): { key: string; selector: string; action: string; label: string }[] {
  const menu = [...document.querySelectorAll('[role=menu]')].find((element) => element.getBoundingClientRect().width > 0); if (!menu) return [];
  const selectorOf = (element: Element): string => { const parts: string[] = []; let node: Element | null = element; while (node && node !== document.documentElement) { const parent: Element | null = node.parentElement; if (!parent) break; parts.unshift(`${node.tagName.toLowerCase()}:nth-child(${[...parent.children].indexOf(node) + 1})`); node = parent; } return `html > ${parts.join(' > ')}`; };
  return [...menu.querySelectorAll('[role^=menuitem]')].filter((item) => !(item as HTMLButtonElement).disabled).map((item, index) => {
    const label = `${item.getAttribute('role')} "${(item.getAttribute('aria-label') || item.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 48) || `#${index + 1}`}"`;
    return { key: `menu "${menu.getAttribute('aria-label')}" ${label}`, selector: selectorOf(item), action: 'click', label };
  });
}

/** Destructive presses come last, so everything else is pressed while the screen still has it. */
const LAST = /remove|delete|clear|close|reset|削除|消去|閉じる|リセット/i;
/** Never pressed by the explorer: it would leave the screen for good. Pressed by tests of their own. */
const NEVER = /^$/;

export interface ExploreOptions { readonly limit?: number; readonly skip?: RegExp; readonly outputFolder: string }

export async function explore(harness: Harness, screen: Screen, options: ExploreOptions): Promise<Pressed[]> {
  const results: Pressed[] = [];
  const pressed = new Set<string>();
  let saved = 0;
  fs.mkdirSync(options.outputFolder, { recursive: true });
  host.answer = (question) => {
    if (question.kind === 'quickPick') return question.items?.[0];
    if (question.kind === 'saveDialog') { const base = question.items?.[0] instanceof Uri ? path.basename((question.items[0] as Uri).fsPath) : 'export'; return Uri.file(path.join(options.outputFolder, `${++saved}-${base || 'export'}`)); }
    if (question.kind === 'inputBox') return (question.items?.[0] as string | undefined) || 'UI test';
    return undefined; // Confirmations are declined; opening files is cancelled.
  };
  const page = () => screen.page;
  // Many of a kind (a colour button per Signal, a row per CAN ID): the first few are pressed, the rest are the same code.
  const families = new Map<string, number>();
  const family = (key: string) => key.replace(/"[^"]*"$/, '');
  for (let round = 0; round < (options.limit ?? 400); round++) {
    if (page().isClosed()) break;
    const targets = (await page().evaluate(enumerate).catch(() => [])) as Target[];
    const fresh = targets.filter((target) => !pressed.has(target.key) && (families.get(family(target.key)) ?? 0) < 3 && !NEVER.test(target.label) && !(options.skip?.test(target.key)));
    const next = fresh.find((target) => !LAST.test(target.label) && !target.away) ?? fresh.find((target) => !target.away) ?? fresh[0];
    if (!next) break;
    pressed.add(next.key); families.set(family(next.key), (families.get(family(next.key)) ?? 0) + 1);
    results.push(await press(harness, screen, next, options));
    // A menu that opened: each of its items, reopening the menu for every one.
    const items = (await page().evaluate(menuItems).catch(() => [])) as Target[];
    if (items.length) {
      for (const item of items) pressed.add(item.key);
      await page().keyboard.press('Escape').catch(() => undefined);
      const order = [...items.keys()].sort((a, b) => Number(LAST.test(items[a].label)) - Number(LAST.test(items[b].label)));
      for (const index of order) {
        const item = items[index]; const key = `${family(next.key)} > ${item.label}`;
        if (pressed.has(key) || options.skip?.test(key)) continue; pressed.add(key);
        if (page().isClosed()) break;
        // The menu is opened again for each item, as a user would; its items are found by their place in it.
        await perform(page(), next).catch(() => undefined); await harness.settle(60);
        // Found again by its name; a menu that changed since (a graph moved to the top has no "Move up") offers it no more.
        const now = ((await page().evaluate(menuItems).catch(() => [])) as Target[]).find((candidate) => candidate.label === item.label);
        if (!now) { await page().keyboard.press('Escape').catch(() => undefined); continue; }
        results.push({ ...(await press(harness, screen, now, options)), key, label: `${next.label} > ${now.label}` });
      }
      await page().keyboard.press('Escape').catch(() => undefined);
    }
  }
  host.answer = undefined;
  return results;
}

async function perform(page: Page, target: Target): Promise<void> {
  const locator = page.locator(target.selector).first();
  if (target.action === 'contextmenu') await locator.click({ button: 'right', timeout: 2000 });
  else if (target.action === 'select') {
    const count = target.options ?? 0; if (count < 2) { await locator.click({ timeout: 2000 }); return; }
    const values = await locator.evaluate((element: HTMLSelectElement) => [...element.options].map((option) => option.value));
    const current = await locator.inputValue(); await locator.selectOption(values.find((value) => value !== current) ?? values[0], { timeout: 2000 });
  } else if (target.action === 'fill') { await locator.click({ timeout: 2000 }); await locator.press('End'); await locator.press('Backspace'); await locator.type('1'); await locator.press('Enter'); }
  else await locator.click({ timeout: 2000 });
}

async function press(harness: Harness, screen: Screen, target: Target, options: ExploreOptions): Promise<Pressed> {
  const page = screen.page;
  // Hovering changes the page by itself (emphasis, hover boxes): that is done first, so only the press is measured.
  if (target.action !== 'select') { await page.locator(target.selector).first().hover({ timeout: 1000 }).catch(() => undefined); await harness.settle(40); }
  const counts = async () => (await page.evaluate(() => ({ ...(window as unknown as { __sigmixaCounts: Record<string, number> }).__sigmixaCounts })).catch(() => ({} as Record<string, number>)));
  const before = { page: await counts(), received: screen.received.length, questions: host.questions.length, messages: host.messages.length, panels: host.panels.length, errors: screen.errors.length, failures: harness.failures.length, commands: host.commandsRun.length, clipboard: host.clipboard, files: listFiles(options.outputFolder).length };
  const errors: string[] = [];
  try { await perform(page, target); }
  catch (error) {
    // Covered by something (a sticky heading, a hover box): pressed where it is, as the keyboard would.
    try { await page.locator(target.selector).first().dispatchEvent(target.action === 'contextmenu' ? 'contextmenu' : 'click'); }
    catch { errors.push(`could not press it: ${(error as Error).message.split('\n')[0]}`); }
  }
  await harness.settle(80);
  const after = { page: await counts(), files: listFiles(options.outputFolder).length };
  const effect: string[] = [];
  if (page.isClosed()) effect.push('closed the screen');
  else {
    for (const name of ['mutations', 'draws', 'inputs']) if ((after.page[name] ?? 0) > (before.page[name] ?? 0)) effect.push(name);
    if (!Object.keys(after.page).length || (after.page.mutations ?? 0) < (before.page.mutations ?? 0)) effect.push('reloaded');
  }
  if (screen.received.length > before.received) effect.push(`sent ${screen.received.slice(before.received).map((message) => message.type).join(', ')}`);
  if (host.questions.length > before.questions) effect.push(`asked ${host.questions.slice(before.questions).map((question) => question.kind).join(', ')}`);
  if (host.panels.length > before.panels) effect.push('opened a screen');
  if (host.commandsRun.length > before.commands) effect.push(`ran ${host.commandsRun.slice(before.commands).map((command) => command.id).join(', ')}`);
  if (host.clipboard !== before.clipboard) effect.push('copied');
  if (after.files > before.files) effect.push('wrote a file');
  const shown = host.messages.slice(before.messages);
  for (const message of shown) (message.kind === 'error' ? errors : effect).push(`${message.kind}: ${message.text}`);
  errors.push(...screen.errors.slice(before.errors), ...harness.failures.slice(before.failures));
  // A save dialog that was answered must end in a file.
  const saves = host.questions.slice(before.questions).filter((question) => question.kind === 'saveDialog');
  if (saves.length && after.files <= before.files) errors.push('a save dialog was answered but no file was written');
  return { key: target.key, label: target.label, effect, errors };
}

function listFiles(folder: string): string[] { try { return fs.readdirSync(folder); } catch { return []; } }

/** One line per press, for the test report. */
export function describe(results: readonly Pressed[]): string {
  return results.map((result) => `${result.errors.length ? 'ERROR' : result.effect.length ? 'ok   ' : 'NONE '} ${result.label}  [${result.effect.join('; ')}]${result.errors.length ? `\n      ${result.errors.join('\n      ')}` : ''}`).join('\n');
}
