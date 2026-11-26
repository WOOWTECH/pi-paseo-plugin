import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { isDeepStrictEqual as equal } from 'node:util';
import { ParentChannel } from './parent-channel.mjs';
import { createProductionGuard, guardProtocol } from './production-guard.mjs';
import { productionReader, validateProductionManifest } from '../production-scope.mjs';
import { privateDirectory, validateManifest, validatedProductionContext, validatePairingReport, validateJobs, contract } from './common.mjs';

// Deliberately no caller command, exchange callback, guard, manifest, authority
// boolean or test mode. Only this fixed reviewed parent can mint a live session.
const parent = fileURLToPath(new URL('../../../../live-acceptance/canary_browser_transport.py', import.meta.url));
const sessions = new WeakMap();
const check = (ok, why) => { if (!ok) throw Error('Production launcher: ' + why); };
const invariant = manifest => {
  const value = structuredClone(manifest); delete value.guard.manifestPath;
  for (const host of value.hosts) { delete host.baseUrl; delete host.productionBinding.tunnel; }
  return value;
};
export function productionSessionState(session) {
  const state = sessions.get(session); check(state, 'actual managed ParentTransport session required'); return state;
}
export async function openProductionSession({ receipts, root, brand, action, seconds = 1800, env = process.env }) {
  check(['pair','coordination','conversations'].includes(action) && Object.hasOwn(contract.brands, brand), 'explicit action/brand required');
  check(Number.isInteger(seconds) && seconds >= 1 && seconds <= 1800, 'session must be bounded to 1..1800 seconds');
  check(path.isAbsolute(receipts) && path.isAbsolute(root), 'absolute receipts/evidence paths required');
  const reader = productionReader(receipts), original = reader.read('validation-manifest.json');
  privateDirectory(root);
  const envPath = key => { const value = env[key]; check(typeof value === 'string' && path.isAbsolute(value), key + ' must be an absolute installed path'); return value; };
  const browserOptions = { playwright:envPath('SMART_PARITY_PLAYWRIGHT_MODULE'), chromium:envPath('SMART_PARITY_CHROMIUM_EXECUTABLE_PATH'),
    craft:envPath('SMART_PARITY_CRAFT_CLI'), noSandbox:env.SMART_PARITY_NO_SANDBOX === '1' };
  const logs = privateDirectory(path.join(root, 'parent-logs'));
  const stderrFile = path.join(logs, `${brand}-${action}-${Date.now()}-${process.pid}.stderr`);
  const stderr = fs.openSync(stderrFile, 'wx', 0o600);
  const parentEnv = { ...process.env, PYTHONDONTWRITEBYTECODE:'1' }; delete parentEnv.PYTHONPATH; delete parentEnv.PYTHONSTARTUP;
  const child = spawn('python3', ['-u', parent, 'serve', '--receipts', receipts, '--phase', brand, '--seconds', String(seconds),
    ...(action === 'conversations' ? ['--with-jobs'] : []), ...(action === 'coordination' ? ['--coordination'] : [])],
    { stdio:['pipe','pipe',stderr], env:parentEnv });
  fs.closeSync(stderr);
  const channel = new ParentChannel(child);
  let lifetime;
  try {
    const ready = await channel.receive(value => value.protocol === guardProtocol && value.status === 'ready' &&
      value.parentPid === child.pid && value.phase === brand && value.productionMutations === false, { timeoutMs:180000 });
    check(path.resolve(ready.evidenceDirectory) === reader.root, 'parent proof root differs');
    const manifestFile = reader.read(ready.browserManifest), jobsFile = reader.read(ready.jobsPath);
    const manifest = validateManifest(manifestFile.value, { evidenceDirectory:reader.root, manifestName:manifestFile.proof.path });
    const context = validatedProductionContext(manifest);
    check(reader.read(context.transportProof).raw.equals(original.raw), 'original validation bytes changed');
    reader.read(original.proof);
    const jobs = action === 'conversations' ? validateJobs(jobsFile.value, manifest, brand) : jobsFile.value;
    check(Array.isArray(jobs) && (action === 'conversations' || jobs.length === 0), 'unexpected job capture');
    const registry = reader.read(ready.sessions).value;
    check(registry.schema === 'agent-connect-browser-sessions/v1', 'session registry required');
    const previous = new Map();
    for (const [key, refs] of Object.entries(registry.entries)) {
      const file = reader.read(refs.manifest), transport = reader.read(refs.transport);
      check(file.canonical() === key && transport.raw.equals(original.raw) && equal(invariant(file.value), invariant(manifest)), 'historical session epoch/bytes differ');
      validateManifest(file.value, { evidenceDirectory:reader.root, manifestName:file.proof.path });
      previous.set(key, file.value);
    }
    check(previous.has(context.manifestSha256), 'current session missing from registry');
    const coordinationBefore = {};
    if (action === 'coordination') {
      const observation = reader.read(ready.coordination).value;
      check(observation.phase === brand && observation.sourceManifestSha256 === context.manifestSha256, 'coordination observation differs');
      for (const host of manifest.hosts) {
        const value = observation.hosts[host.label];
        check(value?.podUid === host.productionBinding.identity.podUid && typeof value.enabled === 'boolean', 'coordination host/config observation required');
        coordinationBefore[host.label] = value.enabled;
      }
    }
    const session = Object.freeze({
      pairing(report) {
        channel.assertAlive(); reader.read(ready.sessions);
        const source = previous.get(report?.sourceManifestSha256); check(source, 'pairing report needs its registered original session');
        const old = validatedProductionContext(source); old.reader.read(old.manifestProof); old.reader.read(old.transportProof);
        return validatePairingReport(report, source, brand);
      },
      assertAlive:() => channel.assertAlive(),
      onFailure(callback) { channel.onFailure = callback; channel.assertAlive(); },
      async close() { clearTimeout(lifetime); channel.onFailure = null; return channel.close(); },
    });
    const config = Object.freeze({ root, output:privateDirectory(path.join(root, 'web-live')), brand, url:contract.brands[brand],
      manifest, productionSession:session, coordinationBefore, ...browserOptions });
    const guard = createProductionGuard({ context, phase:brand, exchange:(...args) => channel.exchange(...args), jobs });
    const state = Object.freeze({ config, guard, jobs, ready, assertAlive:session.assertAlive });
    sessions.set(session, state);
    const expiry = Math.min(...manifest.hosts.map(h => h.productionBinding.tunnel.expiresAt));
    check(expiry > Date.now()/1000, 'session already expired');
    lifetime = setTimeout(() => channel.fail(Error('Parent lease expired; no retry')), (expiry-Date.now()/1000)*1000);
    return session;
  } catch (error) { clearTimeout(lifetime); await channel.close(); throw error; }
}
