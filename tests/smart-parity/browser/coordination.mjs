import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { configuration, launch, readJson, validatePairingReport, runtimeBinding,
  reportWriter, until, redact, writePrivate, screenshotPrivate } from './common.mjs';

// Configure the product's existing opt-in through the public UI. This does not
// change the package default or grant provider turns. Existing agents must be
// recreated after enabling injection; their captured failures remain evidence.
export async function runCoordination(config, open = launch) {
const { brand } = config;
const pairing = config.productionSession ? config.productionSession.pairing(readJson(path.join(config.output, brand + '-hosts.json'))) :
  validatePairingReport(readJson(path.join(config.output, brand + '-hosts.json')), config.manifest, brand);
const browser = await open(config, 'coordination');
const report = { brand, scope: config.manifest.scope, runId: config.manifest.runId,
  ...runtimeBinding(config.manifest), attempt: browser.attempt, craftProject: browser.craftProject,
  attemptDirectory: path.relative(config.root, browser.output), hosts: [], passed: false };
const save = reportWriter(config, browser, brand + '-coordination-settings.json', report);
try {
  const page = await browser.context.newPage();
  for (const host of pairing.hosts) {
    const observed = config.coordinationBefore?.[host.host] ?? config.manifest.hosts.find(value => value.label === host.host)?.coordinationBefore;
    if (typeof observed !== 'boolean') throw Error('Fresh externally observed injection setting is required');
    const route = `/settings/hosts/${encodeURIComponent(host.serverId)}/agents`;
    const row = { host: host.host, serverId: host.serverId, route, observedBefore: observed, evidence: [] };
    report.hosts.push(row); save();
    await page.goto(config.url + route, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForURL(value => value.origin === new URL(config.url).origin && value.pathname === route);
    row.evidence.push((await browser.record(page, `${brand}-${host.host}-coordination-host`, [
      { step_id: 'observe-owned-host-agents-settings', kind: 'wait', ms: 500 },
    ])).id);
    const control = page.getByTestId('host-page-inject-mcp-card').getByRole('switch');
    await control.waitFor({ timeout: 30000 });
    // The app initially renders true before its config arrives. Match a fresh
    // host-side observation instead of trusting that optimistic default.
    await until(async () => await control.getAttribute('aria-checked') === String(observed), 30000);
    row.before = await control.getAttribute('aria-checked');
    if (!['true', 'false'].includes(row.before)) throw Error('Unknown Paseo tools switch state');
    if (row.before === 'false') {
      row.evidence.push((await browser.record(page, `${brand}-${host.host}-enable-coordination`, [
        { step_id: 'enable-paseo-agent-tools', kind: 'click', selector: '[data-testid="host-page-inject-mcp-card"] [role="switch"]' },
        { step_id: 'await-saved-coordination', kind: 'wait', ms: 750 },
      ], [], { kind: 'coordination.enable', hostLabel: host.host })).id);
    }
    await until(async () => await control.getAttribute('aria-checked') === 'true', 15000);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForURL(value => value.origin === new URL(config.url).origin && value.pathname === route);
    await control.waitFor({ timeout: 30000 });
    row.afterReload = await control.getAttribute('aria-checked');
    row.passed = row.afterReload === 'true';
    row.evidence.push((await browser.record(page, `${brand}-${host.host}-coordination-persisted`, [
      { step_id: 'verify-persisted-coordination', kind: 'wait', ms: 300 },
    ])).id); save();
    if (!row.passed) throw Error('Paseo tools opt-in did not persist');
    console.log(JSON.stringify({ brand, host: row.host, before: row.before, afterReload: row.afterReload }));
  }
  report.passed = report.hosts.length === config.manifest.hosts.length && report.hosts.every(row => row.passed);
  save();
} catch (error) {
  for (const [index, page] of browser.context.pages().entries()) {
    writePrivate(path.join(browser.output, `error-${index}.aria.txt`), redact(await page.locator('body').ariaSnapshot().catch(() => '')));
    await screenshotPrivate(page, path.join(browser.output, `error-${index}.png`)).catch(() => {});
  }
  report.error = redact(error.message); save(); console.error(JSON.stringify({ brand, error: report.error })); process.exitCode = 1;
} finally { await browser.close(); }

}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCoordination(configuration(process.argv[2]));
}
