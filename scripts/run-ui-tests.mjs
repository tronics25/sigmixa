// UI tests: the extension runs outside VS Code (tests/ui/vscodeHost.ts stands in for VS Code) and its screens run in a real
// browser through Playwright, on a copy of the sample workspace. Every button and menu item of every screen is pressed.
// Kept apart from `npm test` (fast, no browser); run by `npm run verify`.
import { build } from 'esbuild';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import os from 'node:os';

const output = path.resolve('work/ui-test-build');
await fs.rm(output, { recursive: true, force: true });
await fs.mkdir(output, { recursive: true });
// The screens, built as the extension ships them but into the test folder, so out/ is never touched.
const screens = { rawLog: 'webview/raw/rawLog', frameDefinition: 'webview/frame-editor/frameDefinition', pluginEditor: 'webview/plugin-editor/pluginEditor', comparison: 'webview/comparison/comparison', report: 'webview/report/report' };
await Promise.all(Object.entries(screens).map(([name, source]) => build({ entryPoints: [`src/${source}.ts`], outfile: path.join(output, 'out/webview', `${name}.js`), bundle: true, platform: 'browser', format: 'iife', target: 'es2020', sourcemap: true, logLevel: 'silent' })));
// Large logs are read on worker threads, loaded from next to the test bundle.
await build({ entryPoints: ['src/parsers/parallel/logWorker.ts'], outfile: path.join(output, 'tests/logWorker.js'), bundle: true, platform: 'node', format: 'cjs', target: 'node18', sourcemap: true, logLevel: 'silent' });
// Reports embed the report page and the icon font from next to the extension.
await fs.mkdir(path.join(output, 'media/codicons'), { recursive: true });
for (const file of ['codicon.css', 'codicon.ttf']) await fs.copyFile(path.join('node_modules/@vscode/codicons/dist', file), path.join(output, 'media/codicons', file));
await fs.writeFile(path.join(output, 'package.json'), await fs.readFile('package.json'));
const only = process.argv.slice(2);
const entries = (await fs.readdir('tests/ui')).filter((name) => name.endsWith('.ui.ts') && (!only.length || only.some((part) => name.includes(part)))).map((name) => `tests/ui/${name}`);
await build({ entryPoints: entries, outdir: path.join(output, 'tests'), bundle: true, platform: 'node', format: 'cjs', target: 'node18', sourcemap: true, logLevel: 'silent', external: ['playwright', 'playwright-core', 'esbuild'], alias: { vscode: path.resolve('tests/ui/vscodeHost.ts') }, define: { 'process.env.SIGMIXA_UI_BUILD': JSON.stringify(output), 'process.env.SIGMIXA_REPOSITORY': JSON.stringify(process.cwd()) } });
const files = (await fs.readdir(path.join(output, 'tests'))).filter((name) => name.endsWith('.ui.js')).map((name) => path.join(output, 'tests', name));
// Each file runs in a process of its own, with its own copy of the sample workspace and its own browser: a few side by side.
const concurrency = Math.max(1, Math.min(4, Math.floor(os.availableParallelism() / 2)));
const result = spawnSync(process.execPath, ['--enable-source-maps', '--test', `--test-concurrency=${concurrency}`, ...files], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
