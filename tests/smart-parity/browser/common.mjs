import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Craft } from '../craft.mjs';
import { runtimeBinding, validateHostRuntime, validateReportRuntime, validateInitialRuntime } from './runtime.mjs';
export { runtimeBinding, packageSetDigest } from './runtime.mjs';

export const contract = JSON.parse(fs.readFileSync(new URL('../contract.json', import.meta.url)));
const name = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
export const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
export const redact = value => String(value).replace(/#offer=[A-Za-z0-9_-]+/g, '#offer=[REDACTED]');
export function writePrivate(file, value) {
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}
export function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  requireValue(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0,
    'Evidence/profile directories must be private real directories (mode 0700)');
  return directory;
}
export function validateManifest(manifest, { providerTurns = false } = {}) {
  requireValue(manifest?.scope === 'isolated-candidate' && manifest.productionMutations === false,
    'Explicit isolated-candidate scope with no production mutations is required');
  requireValue(name(manifest.runId), 'Run identity is required');
  const binding = runtimeBinding(manifest);
  requireValue(Array.isArray(manifest.hosts) && manifest.hosts.length >= contract.minimumIndependentHosts,
    'At least two independent owned hosts are required');
  const labels = new Set(), identities = new Set(), origins = new Set();
  for (const host of manifest.hosts) {
    requireValue(name(host.label) && !labels.has(host.label), 'Host labels must be distinct');
    validateHostRuntime(host, binding);
    requireValue(host.ownership?.runId === manifest.runId &&
      host.ownership?.hostLabel === host.label, 'Host ownership declaration must match this run');
    requireValue(nonempty(host.dataIdentity) && !identities.has(host.dataIdentity), 'Independent data identities are required');
    let url; try { url = new URL(host.baseUrl); } catch { throw new Error('Invalid private host origin'); }
    requireValue(['http:', 'https:'].includes(url.protocol) && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) &&
      !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash && !origins.has(url.origin),
    'Each owned host needs a distinct loopback origin without credentials, path or query');
    labels.add(host.label); identities.add(host.dataIdentity); origins.add(url.origin);
  }
  requireValue(!providerTurns || manifest.providerTurnsAuthorized === true,
    'Provider turns must already be explicitly authorized for these isolated hosts');
  return manifest;
}
export function validatePairingReport(report, manifest, brand, { complete = true } = {}) {
  requireValue(report?.brand === brand && report.scope === manifest.scope && report.runId === manifest.runId, 'Pairing report does not belong to this candidate run');
  const binding = validateReportRuntime(report, manifest);
  requireValue(Array.isArray(report.hosts), 'Pairing host records missing');
  const seen = new Set(), servers = new Set();
  for (const row of report.hosts) {
    requireValue(manifest.hosts.some(h => h.label === row.host) && !seen.has(row.host),
      'Pairing host identity/image mismatch');
    validateInitialRuntime(row, binding);
    seen.add(row.host);
    if (complete || row.status === 'paired') {
      requireValue(nonempty(row.serverId) && !servers.has(row.serverId) && row.status === 'paired' &&
        row.visibleInHostPicker === true && row.confirmationDismissed === true &&
        row.connection?.settingsAvailable === true && row.connection.afterReload === true &&
        row.connection.route === `/settings/hosts/${encodeURIComponent(row.serverId)}/agents` &&
        row.ready?.selectedTarget === brand && row.ready.activeTarget === brand &&
        row.ready.healthy === true && row.ready.configurationPending === false, 'Host pairing was not semantically verified');
      servers.add(row.serverId);
    }
  }
  requireValue(!complete || seen.size === manifest.hosts.length, 'Every owned host must be paired');
  requireValue(!complete || (Array.isArray(report.hostListEvidence) && report.hostListEvidence.length > 0 &&
    report.hosts.every(row => Array.isArray(row.evidence) && row.evidence.length >= 3)), 'Pairing Craft evidence IDs are required');
  return report;
}
export function completionMarker(job) {
  const marker = job.replyMarker || job.prompt?.match(/WEB_UI_OK[A-Za-z0-9_-]*/)?.[0];
  requireValue(nonempty(marker) && /^WEB_UI_OK[A-Za-z0-9_-]+$/.test(marker), 'Missing unique completion marker');
  return marker;
}
export function validateJobs(jobs, manifest, brand) {
  requireValue(Array.isArray(jobs) && jobs.length === manifest.hosts.length, 'One job file per owned host is required');
  const hosts = new Set(), markers = new Set();
  for (const group of jobs) {
    requireValue(manifest.hosts.some(h => h.label === group.hostLabel) && !hosts.has(group.hostLabel) &&
      group.phase === brand && group.runId === manifest.runId && group.runtimeIdentity === runtimeBinding(manifest).runtimeIdentity && nonempty(group.workspaceId), 'Unexpected browser job ownership or phase');
    hosts.add(group.hostLabel);
    requireValue(Array.isArray(group.jobs) && group.jobs.length === contract.providers.length, 'All providers are required');
    const providers = new Set(), agents = new Set();
    for (const job of group.jobs) {
      requireValue(contract.providers.includes(job.provider) && !providers.has(job.provider) && nonempty(job.agentId) &&
        !agents.has(job.agentId) && nonempty(job.prompt) && nonempty(job.targetModel) && nonempty(job.alternateModel) &&
        job.targetModel !== job.alternateModel, 'Unexpected provider/model/agent job');
      const marker = completionMarker(job);
      requireValue(!markers.has(marker), 'Completion markers must be unique across this browser run');
      providers.add(job.provider); agents.add(job.agentId); markers.add(marker);
    }
  }
  return jobs;
}
export function workspaceRoute(serverId, workspaceId, agentId) {
  const workspace = /^[A-Za-z0-9._~-]+$/.test(workspaceId) ? workspaceId : 'b64_' + Buffer.from(workspaceId).toString('base64url');
  return `/h/${encodeURIComponent(serverId)}/workspace/${workspace}?open=${encodeURIComponent('agent:' + agentId)}`;
}
export async function until(fn, timeout = 150000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await new Promise(r => setTimeout(r, 750)); }
  throw new Error('Timed out awaiting verified browser/connector state');
}
export async function connector(base, body) {
  const response = await fetch(new URL('/api/plugin-paseo', base), {
    signal: AbortSignal.timeout(30000),
    ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: new URL(base).origin }, body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`Connector HTTP ${response.status}`);
  return response.json();
}
export function configuration(brand, env = process.env, { providerTurns = false } = {}) {
  requireValue(Object.hasOwn(contract.brands, brand), 'Unknown contract brand');
  const required = key => { requireValue(nonempty(env[key]) && path.isAbsolute(env[key]), `${key} must be an absolute path`); return env[key]; };
  const root = privateDirectory(required('SMART_PARITY_EVIDENCE_DIR'));
  const manifestFile = env.SMART_PARITY_HOST_MANIFEST || path.join(root, 'browser-hosts.private.json');
  const manifest = validateManifest(readJson(manifestFile), { providerTurns });
  const output = privateDirectory(path.join(root, 'web-live'));
  return { root, output, manifest, brand, url: contract.brands[brand],
    playwright: required('SMART_PARITY_PLAYWRIGHT_MODULE'), chromium: required('SMART_PARITY_CHROMIUM_EXECUTABLE_PATH'),
    craft: required('SMART_PARITY_CRAFT_CLI'), noSandbox: env.SMART_PARITY_NO_SANDBOX === '1' };
}
export function acquireCraftProject(output) {
  const project = privateDirectory(path.join(output, 'shared.cany'));
  const lock = path.join(output, '.craft-run.lock');
  const fd = fs.openSync(lock, 'wx', 0o600);
  fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  fs.closeSync(fd);
  let released = false;
  return { project, release: () => { if (!released) { fs.unlinkSync(lock); released = true; } } };
}
export async function launch(config, action) {
  const attempt = `${config.brand}-${action}-${Date.now()}-${crypto.randomUUID()}`;
  const output = privateDirectory(path.join(privateDirectory(path.join(config.output, 'attempts')), attempt));
  const profile = privateDirectory(path.join(config.output, config.brand + '-profile'));
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const shared = acquireCraftProject(config.output);
  let context;
  try {
    const { chromium } = await import(pathToFileURL(config.playwright).href);
    context = await chromium.launchPersistentContext(profile, { executablePath: config.chromium, headless: true,
      viewport: { width: 1440, height: 1000 }, locale: 'en-US',
      args: [...(config.noSandbox ? ['--no-sandbox'] : []), `--remote-debugging-port=${port}`] });
    const craft = new Craft({ cli: config.craft, project: shared.project, outputDir: output });
    return { context, output, attempt, craftProject: path.relative(config.root, shared.project),
      close: async () => { try { await context.close(); } finally { shared.release(); } },
      record: (page, name, actions, secrets = []) => craft.record({ page, cdpEndpoint: `http://127.0.0.1:${port}`, name, actions, secrets }) };
  } catch (error) { try { await context?.close(); } finally { shared.release(); } throw error; }
}
export function reportWriter(config, browser, filename, report) {
  return () => {
    writePrivate(path.join(browser.output, filename), report);
    writePrivate(path.join(config.output, filename), report);
  };
}
export async function screenshotPrivate(page, file) {
  await page.screenshot({ path: file });
  fs.chmodSync(file, 0o600);
}

export async function verifyActiveAgent(page, agentId, timeout = 30000) {
  const tab = page.getByTestId(`workspace-tab-agent_${agentId}`);
  await until(async () => await tab.isVisible() && await tab.getAttribute('aria-selected') === 'true', timeout);
}
export async function verifyReconnectedConversation(page, { agentId, completion, url }, timeout = 45000) {
  await page.locator('[data-testid="message-input-root"]:visible textarea').waitFor({ timeout });
  await verifyActiveAgent(page, agentId, timeout);
  await page.getByTestId('assistant-message').filter({ hasText: completion }).waitFor({ timeout });
  requireValue(new URL(page.url()).origin === new URL(url).origin &&
    new URL(page.url()).pathname === new URL(url).pathname, 'Reconnected workspace/host route mismatch');
  return { reconnected: true, reconnectedAgentVerified: true, reconnectedAnswerVisible: true };
}
