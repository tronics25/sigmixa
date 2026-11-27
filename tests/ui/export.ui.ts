// The export of Visualize, as a user does it: the Export button, then SVG, PNG or HTML report, then a file name.
// Every format of every basic log must end in a file; a report must then open without an error.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { start } from './check';
import { host, Uri } from './vscodeHost';

for (const log of ['sigmixa-basic.asc', 'sigmixa-basic.blf', 'sigmixa-basic.mf4', 'sigmixa-basic-decoded.mdf', 'sigmixa-basic-decoded.csv']) {
  test(`Export of basic/${log} writes SVG, PNG and an HTML report that opens`, async () => {
    const harness = await start();
    try {
      const screen = await harness.openLog(`basic/${log}`);
      await harness.settle(800);
      for (const format of ['SVG', 'PNG', 'HTML report']) {
        const target = path.join(harness.workspacePath, '.ui-out', `${log}.${format === 'HTML report' ? 'html' : format.toLowerCase()}`);
        host.answer = (question) => question.kind === 'quickPick' ? question.items?.find((item) => (item as { label?: string }).label === format) : question.kind === 'saveDialog' ? Uri.file(target) : undefined;
        const errors = screen.errors.length; const shown = host.messages.length;
        await screen.page.locator('.save-sheet').first().click();
        await harness.waitFor(() => fs.existsSync(target) && fs.statSync(target).size > 0, `${format} of ${log} to be written`, 20000).catch((error) => {
          throw new Error(`${(error as Error).message}\npage errors: ${screen.errors.slice(errors).join('\n')}\nshown: ${JSON.stringify(host.messages.slice(shown))}\nasked: ${JSON.stringify(host.questions.slice(-3).map((question) => question.kind))}`);
        });
        assert.deepEqual(screen.errors.slice(errors), [], `${format}: errors on the page`);
        assert.deepEqual(host.messages.slice(shown).filter((message) => message.kind === 'error'), [], `${format}: errors shown`);
        if (format === 'HTML report') {
          const report = await harness.openFile(target);
          await harness.settle(500);
          assert.deepEqual(report.errors, [], 'the report opens without an error');
          assert.ok(await report.page.locator('canvas, svg, table').count() > 0, 'the report shows its views');
        }
      }
    } finally { host.answer = undefined; await harness.close(); }
  });
}
