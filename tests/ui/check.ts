import * as fs from 'node:fs';
import * as path from 'node:path';
import { Harness, type Screen } from './harness';
import { describe, explore } from './explore';
import type { Pressed } from './harness';

export const repository = process.env.SIGMIXA_REPOSITORY!;
export const start = (language: 'en' | 'ja' = 'en') => Harness.start({ repository, buildPath: process.env.SIGMIXA_UI_BUILD!, language });

/** Presses everything on a screen and fails with the list of what went wrong: an error, or a press that did nothing. */
export async function pressEverything(harness: Harness, screen: Screen, name: string): Promise<Pressed[]> {
  const results = await explore(harness, screen, { outputFolder: path.join(harness.workspacePath, '.ui-out', name.replace(/[^\w.-]+/g, '-')) });
  const report = path.join(repository, 'work', 'ui-test-build', 'reports'); fs.mkdirSync(report, { recursive: true });
  fs.writeFileSync(path.join(report, `${name.replace(/[^\w.-]+/g, '-')}.txt`), describe(results));
  const broken = results.filter((result) => result.errors.length || !result.effect.length);
  if (broken.length) throw new Error(`${name}: ${broken.length} of ${results.length} presses failed\n${describe(broken)}`);
  if (results.length < 5) throw new Error(`${name}: only ${results.length} presses were found; the screen did not open properly`);
  return results;
}

/** Presses everything on the screen of a log of the sample, as opened from the Analysis Groups pane. */
export async function pressLog(log: string, language: 'en' | 'ja' = 'en'): Promise<void> {
  const harness = await start(language);
  try {
    const screen = await harness.openLog(log);
    await harness.settle(600);
    await pressEverything(harness, screen, `${language === 'ja' ? 'ja ' : ''}${log.split('/').pop()}`);
  } finally { await harness.close(); }
}
