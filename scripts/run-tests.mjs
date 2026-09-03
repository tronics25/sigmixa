import { build } from 'esbuild';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const output = path.resolve('work/test-build');
await fs.rm(output, { recursive: true, force: true });
await fs.mkdir(output, { recursive: true });
await build({
  entryPoints: ['tests/**/*.test.ts'],
  outdir: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  sourcemap: true,
  logLevel: 'silent',
});
const testFiles = (await fs.readdir(output)).filter((name) => name.endsWith('.test.js')).map((name) => path.join(output, name));
const result = spawnSync(process.execPath, ['--test', ...testFiles], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
