import { promises as fs } from 'node:fs';
import path from 'node:path';

const coreRoot = path.resolve('src/core');
const forbiddenImports = [
  /from\s+['"][^'"]*(?:\/extension\/|\/webview\/|sample\/)[^'"]*['"]/,
];

async function files(directory) {
  const result = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(absolute));
    else if (entry.name.endsWith('.ts')) result.push(absolute);
  }
  return result;
}

const failures = [];
for (const file of await files(coreRoot)) {
  const source = await fs.readFile(file, 'utf8');
  for (const rule of forbiddenImports) if (rule.test(source)) failures.push(`${path.relative(process.cwd(), file)}: ${rule}`);
}
if (failures.length) {
  console.error('Core module boundary violations:\n' + failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log('Core module boundary check passed.');
}
