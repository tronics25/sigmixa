/**
 * Runs the extension as VS Code would, with its screens in a real browser (Chromium through Playwright), on a copy of the
 * sample workspace. A test opens a log, presses buttons and menu items on the page, and sees what the extension did.
 */
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Browser, Page } from 'playwright';
import { chromium } from 'playwright';
import { FakePanel, host, Uri, workspace } from './vscodeHost';
import { activate } from '../../src/extension/activation/activate';
import { INSTRUMENT } from './explore';

const ORIGIN = 'https://sigmixa.test';
const CONTENT_TYPES: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.ttf': 'font/ttf', '.map': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

export interface Screen {
  /** The VS Code panel it is shown in; none for a report opened in a browser. */
  readonly panel?: FakePanel;
  readonly page: Page;
  /** Messages the page sent to the extension, in order. */
  readonly received: { type?: string; [key: string]: unknown }[];
  /** Uncaught errors and console errors on the page. */
  readonly errors: string[];
}

export class Harness {
  readonly screens: Screen[] = [];
  private browser?: Browser;
  private readonly pages = new Map<FakePanel, Screen>();
  private pending: Promise<unknown>[] = [];
  readonly failures: string[] = [];
  private readonly disposables: { dispose(): unknown }[] = [];

  private constructor(readonly repository: string, readonly workspacePath: string, readonly buildPath: string) {}

  /** A copy of the sample workspace (without its large logs), the extension activated on it, and a browser for its screens. */
  static async start(options: { repository: string; buildPath: string; language?: 'en' | 'ja' }): Promise<Harness> {
    const workspacePath = await fsp.mkdtemp(path.join(os.tmpdir(), 'sigmixa-ui-'));
    await fsp.cp(path.join(options.repository, 'sample'), workspacePath, { recursive: true, filter: (source) => !source.includes(`${path.sep}large-logs`) });
    const harness = new Harness(options.repository, workspacePath, options.buildPath);
    host.extensionPath = options.buildPath;
    host.language = options.language ?? 'en';
    workspace.workspaceFolders = [{ uri: Uri.file(workspacePath), name: 'sample', index: 0 }];
    harness.browser = await chromium.launch(process.env.SIGMIXA_CHROMIUM ? { executablePath: process.env.SIGMIXA_CHROMIUM } : {});
    harness.disposables.push(
      host.htmlChanged.event((panel) => { harness.pending.push(harness.show(panel)); }),
      host.toPage.event(({ panel, message }) => { harness.pending.push(harness.deliver(panel, message)); }),
      host.panelClosed.event((panel) => { const screen = harness.pages.get(panel); if (screen) void screen.page.close().catch(() => undefined); }));
    const context = {
      extensionUri: Uri.file(options.buildPath), extensionPath: options.buildPath, subscriptions: [] as { dispose(): void }[],
      workspaceState: { get: <T>(key: string, fallback?: T) => (host.workspaceState.has(key) ? host.workspaceState.get(key) : fallback) as T, update: async (key: string, value: unknown) => { host.workspaceState.set(key, value); }, keys: () => [...host.workspaceState.keys()] },
      globalState: { get: <T>(_key: string, fallback?: T) => fallback, update: async () => undefined, keys: () => [], setKeysForSync: () => undefined },
      storageUri: undefined, globalStorageUri: Uri.file(path.join(workspacePath, '.global')), logUri: Uri.file(path.join(workspacePath, '.log')),
      asAbsolutePath: (relative: string) => path.join(options.buildPath, relative),
    };
    await activate(context as never);
    harness.disposables.push(...context.subscriptions);
    return harness;
  }

  /** A log of the workspace copy, by its path in the sample folder. */
  file(relative: string): string { return path.join(this.workspacePath, relative); }

  /** Opens a log as the Analysis Groups pane does, and waits until its screen has loaded it. */
  async openLog(relative: string, level = path.dirname(relative) === '.' ? '' : path.dirname(relative)): Promise<Screen> {
    const before = this.screens.length;
    // As the Analysis Groups pane opens it: the log, named with the place it is shown in.
    await this.execute('vscode.openWith', this.logUri(relative, level), 'sigmixa.rawLog');
    const screen = await this.waitFor(() => this.screens[before], `the screen of ${relative}`);
    await this.waitFor(() => screen.received.some((message) => message.type === 'ready'), 'the screen to start');
    return screen;
  }

  private logUri(relative: string, level: string): Uri {
    const fragment = `sigmixa-level=${encodeURIComponent(level === '.' ? '' : level)}`;
    return Uri.file(this.file(relative)).with({ fragment });
  }

  async execute(command: string, ...args: unknown[]): Promise<unknown> {
    const { commands } = await import('./vscodeHost');
    return commands.executeCommand(command, ...args);
  }

  /** Waits until what the extension and the page are doing has settled. */
  async settle(milliseconds = 150): Promise<void> {
    for (let round = 0; round < 20; round++) {
      const pending = this.pending; this.pending = [];
      await Promise.allSettled(pending);
      await new Promise((resolve) => setTimeout(resolve, milliseconds));
      if (!this.pending.length) return;
    }
  }

  async waitFor<T>(check: () => T | undefined | false, what: string, timeout = 30000): Promise<T> {
    const started = Date.now();
    for (;;) {
      const value = check(); if (value) return value;
      if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /** A page with its errors recorded and its presses counted. */
  private async newScreen(panel?: FakePanel): Promise<Screen> {
    const page = await this.browser!.newPage({ viewport: { width: 1400, height: 900 } });
    const screen: Screen = { panel, page, received: [], errors: [] };
    page.on('pageerror', (error) => { screen.errors.push(`${error.message}\n${error.stack ?? ''}`); });
    page.on('console', (message) => { if (message.type() === 'error') screen.errors.push(message.text()); });
    await page.addInitScript(INSTRUMENT);
    this.screens.push(screen);
    return screen;
  }

  /** A file the extension wrote (an HTML report), opened in the browser as a user opens it. */
  async openFile(file: string): Promise<Screen> {
    const screen = await this.newScreen();
    await screen.page.goto(`file://${file}`);
    await this.settle(300);
    return screen;
  }

  private async show(panel: FakePanel): Promise<void> {
    if (panel.disposed) return;
    let screen = this.pages.get(panel);
    if (!screen) {
      screen = await this.newScreen(panel);
      const current = screen; const page = screen.page;
      this.pages.set(panel, screen);
      await page.exposeBinding('__sigmixaToExtension', (_source, message: { type?: string }) => { current.received.push(message); panel.webview.receive(message); });
      await page.addInitScript(() => {
        let state: unknown;
        const api = { postMessage: (message: unknown) => (window as unknown as { __sigmixaToExtension(message: unknown): void }).__sigmixaToExtension(JSON.parse(JSON.stringify(message))), getState: () => state, setState: (value: unknown) => { state = value; } };
        (window as unknown as { acquireVsCodeApi(): unknown }).acquireVsCodeApi = () => api;
      });
      await page.route(`${ORIGIN}/**`, async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === '/__panel') { await route.fulfill({ contentType: 'text/html', body: this.pages.get(panel)?.panel.webview.html ?? '' }); return; }
        const relative = decodeURIComponent(url.pathname.slice(1));
        const candidates = [path.join(this.buildPath, relative), path.join(this.repository, relative)];
        const file = candidates.find((candidate) => fs.existsSync(candidate));
        if (!file) { await route.fulfill({ status: relative.endsWith('.css') ? 200 : 404, contentType: CONTENT_TYPES[path.extname(relative)] ?? 'text/plain', body: '' }); return; }
        await route.fulfill({ contentType: CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream', body: await fsp.readFile(file) });
      });
    }
    // The extension may set the page twice in a row (a reload): the later load replaces the earlier, which is not a failure.
    try { await screen.page.goto(`${ORIGIN}/__panel`); }
    catch (error) { if (!screen.page.isClosed() && !/ERR_ABORTED|interrupted by another navigation|frame was detached/.test((error as Error).message)) this.failures.push(`Could not show ${panel.title}: ${(error as Error).message}`); }
  }

  private async deliver(panel: FakePanel, message: unknown): Promise<void> {
    const screen = this.pages.get(panel); if (!screen || screen.page.isClosed()) return;
    try { await screen.page.evaluate((value) => window.postMessage(value, '*'), message); }
    catch (error) { if (!screen.page.isClosed()) this.failures.push(`Could not deliver a message to ${panel.title}: ${(error as Error).message}`); }
  }

  async close(): Promise<void> {
    for (const panel of [...host.panels]) panel.dispose();
    await this.settle(50);
    for (const item of this.disposables.splice(0)) { try { item.dispose(); } catch { /* already gone */ } }
    host.panels.length = 0; host.commands.clear(); host.editors.clear(); host.trees.clear(); host.reset(); host.clipboard = ''; host.workspaceState.clear(); host.watched.length = 0;
    await this.browser?.close();
    await fsp.rm(this.workspacePath, { recursive: true, force: true });
  }
}

/** One thing a user can press: found on the page, pressed by the explorer. */
export interface Target { readonly key: string; readonly selector: string; readonly action: 'click' | 'contextmenu' | 'fill' | 'select'; readonly label: string; readonly options?: number; readonly away?: boolean }
/** What pressing a target did. */
export interface Pressed { readonly key: string; readonly label: string; readonly effect: string[]; readonly errors: string[] }
