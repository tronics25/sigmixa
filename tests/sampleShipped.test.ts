import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Every file under sample/ that a sample workspace reads: its logs, DBC, CSV, and every .sigmixa setting and Plugin. */
function sampleFiles(folder = 'sample'): string[] {
  return fs.readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const file = path.posix.join(folder, entry.name);
    if (entry.isDirectory()) return entry.name === 'large-logs' ? [] : sampleFiles(file);
    return /\.(bak|tmp)$/.test(entry.name) || entry.name === '.DS_Store' ? [] : [file];
  });
}

test('git ignores none of the sample workspace files, so a commit ships every sample setting', (context) => {
  let inside = false; try { inside = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === 'true'; } catch { /* no git */ }
  if (!inside) { context.skip('not a git working tree'); return; }
  const files = sampleFiles(); assert.ok(files.some((file) => file.endsWith('.sigmixa/project.json')));
  let ignored = '';
  try { ignored = execFileSync('git', ['check-ignore', '--no-index', '--stdin'], { input: files.join('\n'), encoding: 'utf8' }); } catch (error) { ignored = (error as { stdout?: string }).stdout ?? ''; }
  assert.deepEqual(ignored.split('\n').filter(Boolean), [], 'ignored sample files');
});
