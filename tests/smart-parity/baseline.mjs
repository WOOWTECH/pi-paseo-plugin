import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import { Craft } from './craft.mjs';

const contract = JSON.parse(fs.readFileSync(new URL('./contract.json', import.meta.url)));
const outputDir = path.resolve(process.env.PARITY_OUTPUT || 'artifacts/smart-parity');
const cli = process.env.CRAFT_CLI || path.join(outputDir, 'tools/craft-anything-cli');
const playwrightModule = process.env.PLAYWRIGHT_MODULE;
const { chromium } = await import(playwrightModule ? pathToFileURL(path.resolve(playwrightModule)).href : 'playwright');
const craft = new Craft({ cli, project: path.join(outputDir, 'evidence.cany'), outputDir });
const listener = net.createServer();
await new Promise((resolve, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
  args: [`--remote-debugging-port=${port}`, ...(process.env.PARITY_NO_SANDBOX === '1' ? ['--no-sandbox'] : [])],
});
const summary = { scope: 'Public pairing-dialog baseline only; no host/provider/deployment acceptance', brands: [], comparisons: [] };
const evidence = new Map();
try {
  for (const [brand, url] of Object.entries(contract.brands)) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US' });
    const page = await context.newPage();
    const row = { brand, url, status: 'fail' };
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.getByTestId('welcome-paste-pairing-link').waitFor({ timeout: 45000 });
      const captured = await craft.record({
        page, cdpEndpoint: `http://127.0.0.1:${port}`, name: `${brand}-pair-dialog`,
        actions: [
          { step_id: 'landing-ready', kind: 'wait', ms: 1 },
          { step_id: 'pair-link-dialog', kind: 'click', test_id: 'welcome-paste-pairing-link' },
          { step_id: 'dialog-settled', kind: 'wait', ms: 300 },
        ],
      });
      await page.getByRole('textbox', { name: 'Pairing link', exact: true }).waitFor({ timeout: 10000 });
      await page.getByRole('button', { name: 'Cancel', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Pair', exact: true }).waitFor();
      row.title = await page.title();
      row.semanticAssertions = { pairingTextbox: true, cancelButton: true, pairButton: true };
      row.evidenceId = captured.id;
      row.status = 'pass';
      evidence.set(brand, captured);
      await page.screenshot({ path: path.join(outputDir, `${brand}-pair-dialog.png`) });
      fs.chmodSync(path.join(outputDir, `${brand}-pair-dialog.png`), 0o600);
    } catch (error) {
      row.error = error.message;
    } finally {
      summary.brands.push(row);
      await context.close();
    }
  }
  for (const [before, after] of [['woowtech', 'apporo'], ['woowtech', 'paseo'], ['apporo', 'paseo']]) {
    if (!evidence.has(before) || !evidence.has(after)) {
      summary.comparisons.push({ before, after, status: 'blocked', reason: 'Missing passing walkthrough' });
      continue;
    }
    const diff = await craft.compare(evidence.get(before), evidence.get(after), `${before}-${after}-comparison`);
    summary.comparisons.push({
      before, after, comparable: diff.result.comparable,
      changedSteps: diff.result.summary.changed_steps,
      structuralChanges: diff.result.final_artifacts.map(item => item.field),
      eventCountsSame: diff.result.event_counts.same,
      evidenceId: diff.id,
    });
  }
} finally {
  await browser.close();
  fs.writeFileSync(path.join(outputDir, 'baseline.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
}
console.log(JSON.stringify(summary, null, 2));
if (summary.brands.length !== 3 || summary.brands.some(row => row.status !== 'pass')) process.exitCode = 1;
