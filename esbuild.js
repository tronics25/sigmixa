// Build script for the extension host bundle and the webview client bundles.
// Run with `node esbuild.js` (one-shot) or `node esbuild.js --watch`.
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const watch = process.argv.includes('--watch');

// Copy VS Code's Codicon font assets for use inside Webviews.
function copyCodicons() {
  const srcDir = path.join(__dirname, 'node_modules/@vscode/codicons/dist');
  const destDir = path.join(__dirname, 'media/codicons');
  fs.mkdirSync(destDir, { recursive: true });
  for (const file of ['codicon.css', 'codicon.ttf']) {
    fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file));
  }
}

/** @type {import('esbuild').BuildOptions} */
const extensionConfig = {
  entryPoints: [path.join(__dirname, 'src/extension.ts')],
  bundle: true,
  outfile: path.join(__dirname, 'out/extension.js'),
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
  sourcemap: true,
  minify: false,
  logLevel: 'info',
};

// One entry per webview UI screen. Each is a standalone script loaded
// directly into its webview's <script> tag (IIFE, no module system needed).
const webviewEntries = [
  { name: 'rawLog', source: 'webview/raw/rawLog' },
  { name: 'frameDefinition', source: 'webview/frame-editor/frameDefinition' },
  { name: 'pluginEditor', source: 'webview/plugin-editor/pluginEditor' },
];

/** @type {import('esbuild').BuildOptions[]} */
const webviewConfigs = webviewEntries.map(({ name, source }) => ({
  entryPoints: [path.join(__dirname, `src/${source}.ts`)],
  bundle: true,
  outfile: path.join(__dirname, `out/webview/${name}.js`),
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
  sourcemap: true,
  minify: false,
  logLevel: 'info',
}));

async function run() {
  // Remove stale bundles before creating a release package.
  fs.rmSync(path.join(__dirname, 'out'), { recursive: true, force: true });
  copyCodicons();
  const configs = [extensionConfig, ...webviewConfigs];
  if (watch) {
    console.log('[sigmixa-watch] starting');
    const contexts = await Promise.all(configs.map((c) => esbuild.context(c)));
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    console.log('[sigmixa-watch] ready');
  } else {
    await Promise.all(configs.map((c) => esbuild.build(c)));
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
