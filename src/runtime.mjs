import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { locations, readState, updateState, atomicJson, privateDirectory, withRuntimeLock, processIdentity, RuntimeError, assertSafePath } from './state.mjs';
import { findExecutable, runProcess } from './process.mjs';
import { resolveProviderLaunchers, configureProviders } from './provider-launchers.mjs';
import { providerReplyError } from './provider-reply.mjs';
import { assistantEntries, latestAssistantCursor, chatResult } from './chat-result.mjs';
import {DAEMON_STOP_TIMEOUT_MS,CLOSING_RECORDS_WARNING_AT} from './lifecycle-timeouts.mjs';
import {singleFlight,daemonStatusWindow} from './single-flight.mjs';
import {usingAcceptanceAgent} from './acceptance-agent.mjs';
import {acceptanceWorkspace} from './acceptance-workspace.mjs';
import {runtimeDirectory,runtimeReady,prepareRuntimeManifest,markRuntimeReady,previousRuntimeDirectory,priorRuntimeDirectory,prunePlan,claimReleases,removeTombs,RUNTIME_REVISION,PASEO_VERSION,LEGACY_PASEO_VERSION} from './runtime-layout.mjs';
import { observeOwnedInstance, rememberOwnedInstance, recoverStaleInstance } from './daemon-identity.mjs';
import { readRecord, writeRecord } from './onboarding.mjs';
import { connectionPreferences, connectionTarget, targetEnvironment, targetConfiguration, targetPairUrl } from './connection-targets.mjs';
import { checkProcessTable } from './host-checks.mjs';
export { locations, readState, updateState } from './state.mjs';
export { PASEO_VERSION };
const PROVIDERS = ['claude', 'codex', 'pi'];
const safeCode = error => /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code || '') ? error.code : 'RUNTIME_FAILED';
function credentialPresent(provider, file) {
  if (!fs.existsSync(file)) return false;
  if (provider !== 'pi') return true;
  try {
    const credentials = JSON.parse(fs.readFileSync(file, 'utf8'));
    return !!credentials && typeof credentials === 'object' && !Array.isArray(credentials) && Object.keys(credentials).length > 0;
  } catch { return false; }
}
function packageRoot(pkg = 'cli') { return path.join(runtimeDirectory(locations()), 'node_modules/@getpaseo', pkg); }
function cliPath(root=runtimeDirectory(locations())) { return path.join(root, 'node_modules/@getpaseo/cli/bin/paseo'); }
function runtimeVersion() { try { return JSON.parse(fs.readFileSync(path.join(packageRoot(), 'package.json'), 'utf8')).version; } catch { return null; } }
function inheritedEnv() {
  const loc = locations(); const env = { ...process.env, HOME: loc.home, PI_CODING_AGENT_DIR: loc.agentDir, PI_AGENT_DATA_DIR: process.env.PI_AGENT_DATA_DIR || loc.agentDir, PASEO_HOME: loc.paseoHome, NO_COLOR: '1' };
  delete env.PASEO_HOST; delete env.PASEO_AGENT_ID; delete env.PASEO_WORKSPACE_ID; delete env.PASEO_PASSWORD;
  // Web login protects the host UI; provider children do not need this credential.
  delete env.PI_WEB_PASSWORD;
  env.PI_PASEO_RUNTIME_REVISION=RUNTIME_REVISION;
  Object.assign(env, targetEnvironment(connectionPreferences(loc).target));
  env.PI_PASEO_CONNECTION_PROFILE_VERSION = '1';
  return env;
}
async function cli(args, options, root) {
  const result = await runProcess(process.execPath, [cliPath(root), '--home', locations().paseoHome, '--json', ...args], { env: inheritedEnv(), ...options });
  try { return JSON.parse(result); } catch { throw new RuntimeError('INVALID_COMMAND_OUTPUT'); }
}
function ownerFile() { return path.join(locations().paseoHome, '.pi-paseo-owner.json'); }
function ensureOwnedHome() {
  const loc = locations(); const state = readState().installationId ? readState() : updateState({ phase: 'installing' });
  if (fs.existsSync(ownerFile())) {
    const marker = JSON.parse(fs.readFileSync(ownerFile(), 'utf8'));
    if (marker.installationId !== state.installationId || marker.home !== loc.paseoHome) throw new RuntimeError('DAEMON_NOT_OWNED');
  } else {
    if (fs.existsSync(loc.paseoHome) && fs.readdirSync(loc.paseoHome).length) throw new RuntimeError('DAEMON_NOT_OWNED');
    privateDirectory(loc.paseoHome); atomicJson(ownerFile(), { installationId: state.installationId, home: loc.paseoHome });
  }
  return state;
}
function ownsHome() {
  try { const marker = JSON.parse(fs.readFileSync(ownerFile(), 'utf8')); return marker.installationId === readState().installationId && marker.home === locations().paseoHome; } catch { return false; }
}
function legacyVersion() {try{return JSON.parse(fs.readFileSync(path.join(locations().runtimeDir,'node_modules/@getpaseo/cli/package.json'))).version;}catch{return null;}}
const REVISION_ENTRY='PI_PASEO_RUNTIME_REVISION=';
// Upstream readPidLock (pid-lock.js PID_LOCK_READ_RETRY_ATTEMPTS/_DELAY_MS) reads an empty or partial
// lock again: updatePidLock truncates the file before it writes.
const PID_READ_ATTEMPTS=10,PID_READ_DELAY_MS=50;
async function readPidLockFile(file) {
 for(let attempt=1;;attempt++){
  try {
   const lock=JSON.parse(fs.readFileSync(file,'utf8'));
   if(Number.isInteger(lock?.pid)&&lock.pid>1)return lock;
  } catch(error) {if(error.code==='ENOENT')return null;}
  if(attempt>=PID_READ_ATTEMPTS)return null;
  await delay(PID_READ_DELAY_MS);
 }
}
// Which release a live daemon of this home runs, as far as the plugin can tell without upstream
// modules: Linux reads the revision pinned in that process's environment, other platforms the one
// recorded when this plugin started that PID. null: no live process of this home holds the PID lock.
async function daemonRelease(loc) {
 const lock=await readPidLockFile(path.join(loc.paseoHome,'paseo.pid'));
 if(!lock)return null;
 let revision;
 if(process.platform==='linux'){
  let env;
  try {env=fs.readFileSync(`/proc/${lock.pid}/environ`,'utf8').split('\0');} catch {return null;}
  if(!env.includes(`PASEO_HOME=${loc.paseoHome}`))return null;
  revision=env.find(entry=>entry.startsWith(REVISION_ENTRY))?.slice(REVISION_ENTRY.length);
 } else {
  const state=readState();
  if(state.daemonPid!==lock.pid||state.daemonStartedAt!==lock.startedAt)return null;
  revision=state.daemonRuntimeRevision;
 }
 return {pid:lock.pid,revision:revision||null};
}
// The releases that live processes of this user pin in their environment, for pruning. Linux only (elsewhere the
// release a daemon uses is only recorded for this home's own daemon, see daemonRelease). Fails closed: `unknown`
// means something this scan cannot see through, and nothing is pruned then. That is a process of this user whose
// environment is denied (the owner is told by /proc/<pid>/status, which a non-dumpable process of ours still shows
// although /proc/<pid> itself is then root's) unless its command line, which anyone can read, shows that it cannot
// be running a release; or a process of this home that pins no release. This process and its ancestors are not
// daemons, so an ambient PASEO_HOME in their environment does not count.
// Paseo runs its releases with node, and its supervisor and daemon retitle themselves "Paseo ...". A tmux client or a
// python helper whose environment is denied is no release: without this a single one would stop all pruning.
function couldRunRelease(pid) {
 try {
  const args=fs.readFileSync(`/proc/${pid}/cmdline`,'utf8').split('\0');
  return /(^|\/)node(js)?$/.test(args[0])||/paseo/i.test(args.join(' '));
 } catch(error) {return error?.code!=='ENOENT'&&error?.code!=='ESRCH';} // unreadable: it cannot be ruled out
}
function runningRevisions(loc) {
 const found=new Set();
 if(process.platform!=='linux')return {found,unknown:false};
 const gone=error=>error?.code==='ENOENT'||error?.code==='ESRCH';
 let names;try {names=fs.readdirSync('/proc');}catch {return {found,unknown:true};}
 const own=new Set([process.pid]);
 for(let pid=process.pid,hops=0;hops<64;hops++){
  let ppid;try {const stat=fs.readFileSync(`/proc/${pid}/stat`,'utf8');ppid=Number(stat.slice(stat.lastIndexOf(')')+2).split(' ')[1]);}catch {break;}
  if(!Number.isInteger(ppid)||ppid<=1||own.has(ppid))break;
  own.add(ppid);pid=ppid;
 }
 let unknown=false;
 for(const name of names){
  if(!/^\d+$/.test(name))continue;
  let uid;
  try {uid=Number(/^Uid:\s+(\d+)/m.exec(fs.readFileSync(`/proc/${name}/status`,'utf8'))?.[1]);}
  catch(error) {if(!gone(error))unknown=true;continue;}
  if(uid!==process.getuid())continue;
  let env;
  try {env=fs.readFileSync(`/proc/${name}/environ`,'utf8').split('\0');}
  catch(error) {if(!gone(error)&&couldRunRelease(name))unknown=true;continue;}
  const revision=env.find(entry=>entry.startsWith(REVISION_ENTRY))?.slice(REVISION_ENTRY.length);
  if(revision)found.add(revision);else if(env.includes(`PASEO_HOME=${loc.paseoHome}`)&&!own.has(Number(name)))unknown=true;
 }
 return {found,unknown};
}
// Daemon control (read, verify, client, pair, stop, live config) runs through the release that
// started the daemon: an upgrade never stops, queries or reconfigures an older daemon through newer
// upstream modules. Resolved once per operation, so reading and stopping use the same release.
//  * This release's daemon, or none: this release (before it is installed, the newest verified earlier
//    release still reads the PID lock, so a foreign owner is reported instead of ignored).
//  * A daemon of exactly one of the verified earlier releases: that release. Every Linux release since
//    0.1.1 pins its revision in the daemon's environment; elsewhere 0.1.18+ (r4) record it, and a daemon
//    without one was started by 0.1.4-0.1.17, all of them r2/r3 releases of 0.11.2.
//  * Anything else (no verified release of that revision, an unknown or newer one): refused with
//    DAEMON_RELEASE_UNAVAILABLE, never controlled through another release's modules.
async function resolveControl(loc=locations()) {
 const daemon=await daemonRelease(loc);
 if(!daemon||daemon.revision===RUNTIME_REVISION){
  if(runtimeReady(loc))return {root:runtimeDirectory(loc),version:PASEO_VERSION};
  if(!daemon){const root=previousRuntimeDirectory(loc)||(legacyVersion()===LEGACY_PASEO_VERSION?loc.runtimeDir:null);return {root,version:root&&LEGACY_PASEO_VERSION};}
 }
 const root=daemon.revision?priorRuntimeDirectory(loc,daemon.revision)
  :process.platform!=='linux'?previousRuntimeDirectory(loc,{unrecordedOnly:true}):null;
 return root?{root,version:LEGACY_PASEO_VERSION}:{root:null,refused:'DAEMON_RELEASE_UNAVAILABLE',pid:daemon.pid};
}
async function serverModule(relative, root) { return import(pathToFileURL(path.join(root,'node_modules/@getpaseo/server',relative)).href); }
// config.json goes through the configuration module (@getpaseo/server/configuration, which re-exports
// persisted-config.js) of the release that reads it next, the same read path its daemon loads with:
// readPersistedConfig applies that release's compatibility normalization (0.17.4 folds providers.openai
// into the speech settings that use it, gives speech settings without a provider "local", and drops what
// that provider cannot take), then its strict schema. The plugin merges its keys into that result; it
// never drops or rewrites user settings beyond what upstream does there.
async function configModule(root) { return serverModule('dist/server/server/config.js', root); }
/** A private directory for a config.json copy, removed afterwards. */
function withScratchHome(loc, fn) {
  const dir = path.join(loc.stateDir, `.config-scratch-${randomUUID()}`);
  try { privateDirectory(dir); return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
// Agent Connect never got daemon.name past Paseo's strict schema, but such a key is removed (see
// writeConfig): that one key is taken out of a private copy, which then goes through the same read path.
function readDaemonConfig(config, loc = locations()) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(path.join(loc.paseoHome, 'config.json'), 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw new RuntimeError('CONFIG_CORRUPT'); }
  const legacyName = !!raw?.daemon && typeof raw.daemon === 'object' && Object.hasOwn(raw.daemon, 'name');
  try {
    if (!legacyName) return config.readPersistedConfig(loc.paseoHome);
    const { name: _name, ...daemon } = raw.daemon;
    return withScratchHome(loc, home => { atomicJson(path.join(home, 'config.json'), { ...raw, daemon }); return config.readPersistedConfig(home); });
  } catch {
    // Valid JSON the release cannot load even after its own normalization.
    throw new RuntimeError('CONFIG_INCOMPATIBLE');
  }
}
async function currentInstance(control) {
  if (!ownsHome()) return null;
  if (control.refused) throw new RuntimeError(control.refused);
  if (!control.root) return null;
  return (await serverModule('dist/server/server/daemon-instance.js', control.root)).readDaemonInstance(locations().paseoHome);
}
function instanceNeedsRuntimeRestart(instance) {
 if(process.platform!=='linux'){
   const state=readState();
   return state.daemonPid!==instance.pid||state.daemonStartedAt!==instance.startedAt||state.daemonRuntimeRevision!==RUNTIME_REVISION;
 }
 try {
   const env = fs.readFileSync(`/proc/${instance.pid}/environ`, 'utf8').split('\0');
   return !env.includes(`PI_PASEO_RUNTIME_REVISION=${RUNTIME_REVISION}`) || !env.includes('PI_PASEO_CONNECTION_PROFILE_VERSION=1');
 } catch { return true; }
}
function verifyInstanceOwnership(instance, control) {
  if (!ownsHome() || !instance || !processIdentity(instance.pid)) throw new RuntimeError('DAEMON_NOT_OWNED');
  if (instance.uid !== (process.getuid?.() ?? instance.uid)) throw new RuntimeError('DAEMON_NOT_OWNED');
  // Linux metadata additionally checks argv and the home actually inherited by this PID.
  if (process.platform === 'linux') {
    try {
      const args = fs.readFileSync(`/proc/${instance.pid}/cmdline`, 'utf8').split('\0');
      const env = fs.readFileSync(`/proc/${instance.pid}/environ`, 'utf8').split('\0');
      const entry = path.join(control.root, 'node_modules/@getpaseo/server/dist/scripts/supervisor-entrypoint.js');
      const executable = fs.realpathSync(`/proc/${instance.pid}/exe`);
      const expectedNode = fs.realpathSync(process.execPath);
      // Paseo sets process.title, which replaces its original argv on Linux.
      const supervisor = args.includes(entry) || args[0] === 'Paseo Supervisor';
      if (!supervisor || executable !== expectedNode || instance.heartbeat !== true || !env.includes(`PASEO_HOME=${locations().paseoHome}`)) throw new RuntimeError('DAEMON_NOT_OWNED');
    } catch { throw new RuntimeError('DAEMON_NOT_OWNED'); }
  }
}
/** Behind a healthy daemon of this release, the older releases nothing needs are removed (runtime-layout.mjs: it keeps
 * this release, the newest earlier one for a rollback, every newer one, and what a live process still pins).
 * Nothing is claimed unless this release's daemon is the one control resolves to; leftovers of an earlier removal
 * are finished whatever else is running, they are no release any more.
 * Under the runtime lock only the cheap part happens: reading, deciding, renaming. It returns what is left to delete,
 * and removeInBackground deletes it after the lock is released: a 0.7 GB tree takes long on an SD card, and a
 * pairing or a stop must not wait for it. Best effort throughout: it never throws, so a failed removal cannot fail an
 * activation or a status, and what a crash leaves is finished by the next activation. */
async function claimOldReleases(loc) {
  try {
    const plan = prunePlan(loc);
    // This release and the one before it are all there is in the steady state: nothing to do.
    if (plan.skipped || (!plan.candidates.length && !plan.tombs.length)) return null;
    const prune = { loc, work: [...plan.tombs], kept: plan.kept, failed: [], skipped: null };
    if (plan.candidates.length && (await resolveControl(loc)).root === runtimeDirectory(loc)) {
      const running = runningRevisions(loc);
      if (running.unknown) prune.skipped = 'RELEASE_IN_USE_UNKNOWN';
      else {
        const next = prunePlan(loc, { keep: [...running.found] }), claim = claimReleases(loc, next.candidates);
        prune.work.push(...claim.claimed); prune.failed.push(...claim.failed); prune.kept = next.kept;
      }
    }
    return prune;
  } catch { return null; }
}
const removing = new Set(), removals = new Set();
/** Deletes what claimOldReleases renamed, then records the outcome in state.lastPrune (names only, no lock needed). */
function removeInBackground(prune) {
  if (!prune) return;
  const items = prune.work.filter(item => !removing.has(item.tomb));
  for (const item of items) removing.add(item.tomb);
  const task = (async () => {
    const done = items.length ? await removeTombs(prune.loc, items, { rm: (target, options) => fs.promises.rm(target, options) }) : { removed: [], failed: [] };
    const failed = [...prune.failed, ...done.failed];
    if (!done.removed.length && !failed.length && !prune.skipped) return;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try { updateState({ lastPrune: { at: new Date().toISOString(), removed: done.removed, kept: prune.kept, failed, ...(prune.skipped ? { skipped: prune.skipped } : {}) } }); return; }
      catch { await delay(250 * attempt); }
    }
  })().catch(() => {}).finally(() => { for (const item of items) removing.delete(item.tomb); removals.delete(task); });
  removals.add(task);
}
/** Resolves once every removal this process started has finished and recorded its outcome. */
export async function pruneSettled() { while (removals.size) await Promise.allSettled([...removals]); }
async function installRuntime() {
  privateDirectory(locations().runtimeDir);
  if (!runtimeReady(locations())) {
    const npm = findExecutable('npm'); if (!npm) throw new RuntimeError('NPM_UNAVAILABLE');
    const root=prepareRuntimeManifest(locations());
    await runProcess(npm, ['ci', '--prefix', root, '--omit=dev', '--no-audit', '--no-fund'], { timeoutMs: 300000, env: inheritedEnv() });
  }
  const version = await runProcess(process.execPath, [cliPath(), '--version'], { env: inheritedEnv() });
  if (version.trim() !== PASEO_VERSION || runtimeVersion() !== PASEO_VERSION) throw new RuntimeError('VERSION_MISMATCH');
  if (!fs.existsSync(path.join(packageRoot('server'), 'dist/server/web-ui/index.html'))) throw new RuntimeError('WEB_UI_MISSING');
  markRuntimeReady(locations());
  updateState({ installedVersion: PASEO_VERSION,installedRuntimeRevision:RUNTIME_REVISION });
}
async function choosePort(preferred) {
  for (let port = preferred; port <= Math.min(65535, preferred + 50); port++) {
    const free = await new Promise(resolve => { const server = net.createServer(); server.once('error', () => resolve(false)); server.listen(port, '127.0.0.1', () => server.close(() => resolve(true))); });
    if (free) return port;
  }
  throw new RuntimeError('PORT_UNAVAILABLE');
}
async function detectLaunchers({ installMissing = false } = {}) {
  return resolveProviderLaunchers(locations(), { installMissing, env: inheritedEnv() });
}
// Paseo (0.11.2 and 0.17.4) hands its agents the Paseo MCP tools (create_agent, create_terminal,
// send_agent_prompt, set_agent_mode, respond_to_permission, create_schedule, ...)
// only when daemon.mcp.injectIntoAgents is true, and leaves it false by default.
// The daemon's config.json is the one source of truth: the Agent Connect switch
// writes it, and a Paseo client's host setting writes the same key. Before the
// first start there is no config.json, so the choice waits in preferences.json.
// The daemon reloads the key without a restart.
const COLLABORATION_PATH = 'daemon.mcp.injectIntoAgents';
function collaborationMcp(mcp, enabled) { return { ...mcp, enabled: true, injectIntoAgents: enabled === true }; }
function daemonCollaboration() {
  const file = path.join(locations().paseoHome, 'config.json');
  if (!ownsHome() || !fs.existsSync(file)) return undefined;
  try { const value = JSON.parse(fs.readFileSync(file, 'utf8')).daemon?.mcp?.injectIntoAgents; return typeof value === 'boolean' ? value : undefined; }
  catch { return undefined; }
}
/** What agents get now (the daemon config), else the choice waiting for the first start. Never throws: status relies on it. */
export function agentCollaborationEnabled() {
  try {
    const value = daemonCollaboration();
    return value === undefined ? connectionPreferences(locations()).agentCollaboration === true : value;
  } catch { return false; }
}
async function applyAgentCollaboration(enabled) {
  const loc = locations(), file = path.join(loc.paseoHome, 'config.json');
  // Not this installation's daemon home, or no config yet: the next start applies the saved choice.
  if (!ownsHome() || !fs.existsSync(file)) return 'next-start';
  // Written for the daemon that reloads it, through the persisted-config module of its own release;
  // with no daemon this release can control, for this release's next start.
  const control = await resolveControl(loc), root = control.root || (runtimeReady(loc) ? runtimeDirectory(loc) : null);
  if (!root) return 'next-start';
  const module = await configModule(root);
  const config = readDaemonConfig(module, loc);
  if (config.daemon?.mcp?.injectIntoAgents === enabled && config.daemon?.mcp?.enabled === true) return 'unchanged';
  try { module.savePersistedConfig(loc.paseoHome, { ...config, daemon: { ...config.daemon, mcp: collaborationMcp(config.daemon?.mcp, enabled) } }); fs.chmodSync(file, 0o600); }
  catch { throw new RuntimeError('CONFIG_INVALID'); }
  let instance = null;
  try { instance = await currentInstance(control); if (instance) verifyInstanceOwnership(instance, control); }
  catch { instance = null; }
  if (!instance) return 'next-start';
  try {
    const reload = await withClient(client => client.reloadDaemonConfig(), 15000, control);
    const owns = paths => Array.isArray(paths) && paths.some(p => p === COLLABORATION_PATH || COLLABORATION_PATH.startsWith(p + '.'));
    if (!Array.isArray(reload?.restartRequiredPaths) || !Array.isArray(reload?.overrideControlledPaths) || owns(reload.restartRequiredPaths) || owns(reload.overrideControlledPaths)) throw new RuntimeError('RESTART_REQUIRED');
    return 'applied';
  } catch {
    // Written, but the running daemon did not take it: a stop and start applies it.
    updateState({ phase: 'restart_required', lastError: { code: 'RESTART_REQUIRED', at: new Date().toISOString() } });
    return 'restart-required';
  }
}
/** The plugin's keys merged into a config as its release's readPersistedConfig returned it. */
function managedConfig(config, port, launchers) {
  const loc = locations();
  const providers = configureProviders(config.agents?.providers, launchers, loc, inheritedEnv());
  // Paseo's strict daemon schema (0.11.2 and 0.17.4) rejects daemon.name. Display preferences
  // belong to the host plugin; remove any legacy injected name while retaining other fields.
  const daemon = { ...config.daemon };
  delete daemon.name;
  const providersChanged = JSON.stringify(config.agents?.providers || {}) !== JSON.stringify(providers);
  const merged = {
    ...config, $schema: 'https://paseo.sh/schemas/paseo.config.v1.json', version: 1,
    daemon: { ...daemon, listen: `127.0.0.1:${port}`, hostnames: ['localhost', '127.0.0.1', '.localhost'], relay: { ...config.daemon?.relay, enabled: true }, mcp: collaborationMcp(config.daemon?.mcp, typeof config.daemon?.mcp?.injectIntoAgents === 'boolean' ? config.daemon.mcp.injectIntoAgents : connectionPreferences(loc).agentCollaboration) },
    agents: { ...config.agents, providers, metadataGeneration: config.agents?.metadataGeneration || { providers: [] } },
    features: { ...config.features, webUi: { ...config.features?.webUi, enabled: true } },
    log: { ...config.log, console: { level: 'warn' }, file: { level: 'warn', path: 'daemon.log', rotate: { maxSize: '5m', maxFiles: 2 } } },
  };
  return { config: targetConfiguration(merged, connectionPreferences(loc).target), providersChanged };
}
async function writeConfig(port, launchers) {
  const loc = locations(); const file = path.join(loc.paseoHome, 'config.json');
  // Written for this release's daemon: the one about to start, or a running one of this revision.
  const module = await configModule(runtimeDirectory(loc));
  const { config, providersChanged } = managedConfig(readDaemonConfig(module, loc), port, launchers);
  try { module.savePersistedConfig(loc.paseoHome, config); fs.chmodSync(file, 0o600); } catch { throw new RuntimeError('CONFIG_INVALID'); }
  updateState({ port, providerLaunchers: launchers });
  return providersChanged;
}
/** While an older daemon still serves: would the start after an explicit stop accept the config it writes?
 * Nothing is written. A config this release cannot load would otherwise surface only after that stop,
 * leaving Paseo down while the supervisor retried the start. */
async function checkNextStartConfig(launchers) {
  const loc = locations(), module = await configModule(runtimeDirectory(loc));
  const { config } = managedConfig(readDaemonConfig(module, loc), loc.port, launchers);
  // Upstream's own save is the schema check: into a private scratch home, never the daemon's.
  try { withScratchHome(loc, home => module.savePersistedConfig(home, config)); } catch { throw new RuntimeError('CONFIG_INVALID'); }
}
function safeProvider(entry) {
  return { provider: entry.provider, label: entry.label || entry.provider, status: entry.status || (entry.available === true ? 'ready' : entry.available === false ? 'unavailable' : 'unknown'), enabled: entry.enabled !== false, defaultModeId: entry.defaultModeId || null, modes: (entry.modes || []).map(mode => ({ id: mode.id, label: mode.label || mode.id })), chatVerified: readState().acceptance?.providers?.some(row => row.provider === entry.provider && row.passed) || false };
}
async function withClient(fn, timeoutMs = 30000, control) {
  control ??= await resolveControl();
  if (!control.root) throw new RuntimeError(control.refused || 'DAEMON_UNREACHABLE');
  const { connectToDaemon } = await import(pathToFileURL(path.join(control.root, 'node_modules/@getpaseo/cli/dist/utils/client.js')).href);
  const client = await connectToDaemon({ target: { kind: 'instance', home: locations().paseoHome }, timeout: 5000 });
  let timer;
  try {
    return await Promise.race([fn(client), new Promise((_, reject) => { timer = setTimeout(() => { void client.close().catch(() => {}); reject(new RuntimeError('DAEMON_REQUEST_TIMEOUT')); }, timeoutMs); timer.unref(); })]);
  } catch (error) { throw new RuntimeError(safeCode(error)); }
  finally { clearTimeout(timer); await client.close().catch(() => {}); }
}
// 0.1.9-0.1.22 downloaded a patched Paseo web build into <stateDir>/web-client for the
// Paseo target. The target now opens the official app, so drop that copy: only the
// release (<sha256>) and staging (.stage-<uuid>) entries those versions created, then the
// directory if nothing else is left. A symlinked web-client is left alone, rmSync never
// follows links, and a failure never blocks activation; the next activation tries again.
const RETIRED_WEB_ENTRY = /^(?:[a-f0-9]{64}|\.stage-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
function removeRetiredWebClient(loc) {
  const dir = path.join(loc.stateDir, 'web-client');
  try {
    if (!fs.lstatSync(dir).isDirectory()) return;
    for (const name of fs.readdirSync(dir)) if (RETIRED_WEB_ENTRY.test(name)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    fs.rmdirSync(dir);
  } catch { /* absent, holds other entries, or not removable now */ }
}
/** Records whether this host's `ps` can serve Paseo's terminal cleanup (host-checks.mjs). A diagnostic only:
 * it never throws and never keeps Paseo from starting. Not checked off Linux. */
async function recordProcessTable() {
  try {
    const check = await checkProcessTable();
    if (check?.checked) updateState({ processTable: { ok: check.ok === true, ...(check.ok === true ? {} : { code: check.code }), checkedAt: new Date().toISOString() } });
  } catch { /* a diagnostic that cannot be recorded is not worth a failed start */ }
}
export async function activate(options = {}) {
  let pruning = null;
  // The removal of old releases starts once the lock is released, whichever way the activation ends.
  try { return await activateLocked(options, claimed => { pruning = claimed; }); } finally { removeInBackground(pruning); }
}
async function activateLocked(options, claimedReleases) {
  return withRuntimeLock(async () => {
    ensureOwnedHome(); updateState({ desiredEnabled: true, phase: 'installing', lastError: null });
    try {
      if (Number(process.versions.node.split('.')[0]) < 22) throw new RuntimeError('NODE_VERSION_UNSUPPORTED');
      await recordProcessTable();
      // Before the runtime install, so a host short of disk gets the retired copy's space back first.
      removeRetiredWebClient(locations());
      await installRuntime();
      let control = await resolveControl();
      let existing = await currentInstance(control);
      if (existing) {
        try { verifyInstanceOwnership(existing, control); }
        catch (error) {
          if (error.code !== 'DAEMON_NOT_OWNED') throw error;
          await recoverStaleInstance(locations(), existing);
          control = await resolveControl(); existing = await currentInstance(control);
          if (existing) verifyInstanceOwnership(existing, control);
        }
      }
      const launchers = await detectLaunchers({ installMissing: true });
      if (existing) {
        verifyInstanceOwnership(existing, control);
        const configurationPending = readState().configurationPending === true;
        if (configurationPending || instanceNeedsRuntimeRestart(existing)) {
          // Only an explicit stop and start applies this, and that start writes this release's config:
          // check it now, while the running daemon still serves, so the user is not told to stop it in
          // vain. A failure is reported as itself (CONFIG_INCOMPATIBLE...) with phase 'error'.
          await checkNextStartConfig(launchers);
          updateState({ phase: 'restart_required', lastError: { code: configurationPending ? 'CONFIGURATION_PENDING' : 'RESTART_REQUIRED', at: new Date().toISOString() } });
          return status();
        }
        const pending = readState().providerReloadPending;
        const needsApply = await writeConfig(locations().port, launchers) || (pending?.pid === existing.pid && pending?.startedAt === existing.startedAt);
        updateState({ providerReloadPending: { pid: existing.pid, startedAt: existing.startedAt } });
        try {
          const reload = await withClient(client => client.reloadDaemonConfig(), 30000, control);
          if (!Array.isArray(reload?.appliedPaths) || !Array.isArray(reload?.restartRequiredPaths) || !Array.isArray(reload?.overrideControlledPaths) ||
              reload.restartRequiredPaths.length || reload.overrideControlledPaths.some(p => p === 'agents.providers' || p.startsWith('agents.providers.')) ||
              (needsApply && !reload.appliedPaths.includes('agents.providers'))) throw new RuntimeError('RESTART_REQUIRED');
        } catch { throw new RuntimeError('RESTART_REQUIRED'); }
        updateState({ phase: 'running', providerReloadPending: null, daemonPid: existing.pid, daemonStartedAt: existing.startedAt });
      } else {
        const port = await choosePort(locations().port); await writeConfig(port, launchers);
        updateState({ phase: 'starting' });
        await cli(['daemon', 'start', '--timeout', '90'], { timeoutMs: 105000 }, runtimeDirectory(locations()));
        // The daemon this release just started is controlled by this release.
        control = { root: runtimeDirectory(locations()), version: PASEO_VERSION };
        const instance = await currentInstance(control); verifyInstanceOwnership(instance, control);
        // A new daemon retries any cleanup the last stop left open and reports what it could not confirm itself.
        updateState({ phase: 'running', providerReloadPending: null, daemonPid: instance.pid, daemonStartedAt: instance.startedAt, daemonRuntimeRevision: RUNTIME_REVISION, activeTarget: connectionPreferences(locations()).target, configurationPending: false, terminalCleanup: null });
      }
      const healthy = await currentInstance(control), verify = instance => verifyInstanceOwnership(instance, control);
      const observation = await observeOwnedInstance(locations(), healthy, verify);
      const result = await status();
      if (!result.daemon.reachable) throw new RuntimeError('DAEMON_UNREACHABLE');
      if (!healthy || healthy.pid !== result.daemon.pid) throw new RuntimeError('DAEMON_STATE_CHANGED');
      await rememberOwnedInstance(locations(), healthy, verify, observation);
      updateState({ lastDiagnostic: { checkedAt: new Date().toISOString(), daemonReachable: true, providers: result.providers.map(row => ({ provider: row.provider, status: row.status })) } });
      claimedReleases(await claimOldReleases(locations()));
      return status();
    } catch (error) { updateState({ phase: error.code === 'RESTART_REQUIRED' ? 'restart_required' : 'error', lastError: { code: safeCode(error), at: new Date().toISOString() } }); throw new RuntimeError(safeCode(error)); }
  }, { timeoutMs: options.lockTimeoutMs || 360000 });
}
const TERMINAL_CLEANUP_NOT_CONFIRMED = 'TERMINAL_CLEANUP_NOT_CONFIRMED';
// Is the daemon this stop signaled really gone? The supervisor process ended (a reused PID is some other
// process, not that supervisor), no live daemon holds the PID lock, and the lock file itself was released.
async function daemonStopped(lifecycle, loc, instance, identity) {
  try {
    const now = processIdentity(instance.pid);
    if (now !== null && now === identity) return false;
    if (await lifecycle.readDaemonInstance(loc.paseoHome)) return false;
    return !fs.existsSync(path.join(loc.paseoHome, 'paseo.pid'));
  } catch { return false; }
}
/** Stops the daemon `instance` through the release that reads it (`control`: one resolution per operation).
 * Resolves to the non-fatal warning to record, or null. Every stop of a daemon goes through here.
 *
 * 0.17.4's stopDaemonInstance waits for the supervisor to exit, releases the PID lock, and only then closes the
 * terminal workers once more (reapTerminalWorkers). Where that cannot confirm every terminal process gone (no
 * usable `ps`, a process that outlives SIGKILL) it throws TERMINAL_CLEANUP_NOT_CONFIRMED and keeps a closing
 * record that the next stop or start retries; nothing is signaled on a guess. By then the daemon is stopped, so
 * the stop is done once that is verified here: the supervisor is gone and the PID lock is released. Any other
 * outcome stays an error: DAEMON_STILL_PRESENT when the daemon, its supervisor or a lock file is still there after
 * that cleanup error, and upstream's own codes (STOP_NOT_CONFIRMED, DAEMON_REPLACED) as they are. The stop is never forced. */
async function stopOwnedDaemon(loc, control, instance) {
  const lifecycle = await serverModule('dist/server/server/daemon-instance.js', control.root);
  const identity = processIdentity(instance.pid);
  try {
    // The official lifecycle rechecks PID plus startedAt immediately before signaling.
    await lifecycle.stopDaemonInstance(loc.paseoHome, { instance, timeoutMs: DAEMON_STOP_TIMEOUT_MS, force: false });
    return null;
  } catch (error) {
    if (error?.code !== TERMINAL_CLEANUP_NOT_CONFIRMED) throw new RuntimeError(safeCode(error));
    // Not the warning's code: here the daemon (or its supervisor, or a lock file) is still there and nothing stopped.
    if (!(await daemonStopped(lifecycle, loc, instance, identity))) throw new RuntimeError('DAEMON_STILL_PRESENT');
    return { code: TERMINAL_CLEANUP_NOT_CONFIRMED, at: new Date().toISOString() };
  }
}
export async function deactivate() {
  return withRuntimeLock(async () => {
    updateState({ desiredEnabled: false });
    // One resolution: the release that read the instance is the one that stops it.
    const control = await resolveControl(), instance = await currentInstance(control);
    if (instance) {
      verifyInstanceOwnership(instance, control);
      const terminalCleanup = await stopOwnedDaemon(locations(), control, instance);
      // A stop that confirmed its terminals also retried and settled what an earlier one left open.
      updateState({ phase: 'disabled', daemonPid: null, daemonStartedAt: null, terminalCleanup });
    } else updateState({ phase: 'disabled', daemonPid: null, daemonStartedAt: null });
    return status();
  });
}
export async function status() {
  return singleFlight(`status:${locations().paseoHome}`,readStatus);
}
/** The supervisor's poll: status().daemon.running from the PID lock and /proc alone. It never asks the daemon, because
 * Paseo answers each status request by running `--version` of every enabled provider, uncached; at the supervisor's
 * 15 s poll that was about 60% of the idle CPU of a 4-core H618 board. */
export async function daemonRunning() {
  try {
    const control = await resolveControl();
    // A live daemon of this home that no verified release can control is still running: status reports why.
    if (control.refused) return ownsHome();
    const instance = await currentInstance(control); if (!instance) return false; verifyInstanceOwnership(instance, control); return true;
  } catch { return false; }
}
// Pi builds its model list from these files in the agent directory the Pi provider is given. The daemon caches that
// list until a refresh or a restart, so a provider configured after the daemon started (LiteLLM written to
// models.json, for example) stayed out of Paseo's Pi models.
const PI_CATALOG_FILES = ['models.json', 'settings.json'];
function piCatalogFiles() {
  return PI_CATALOG_FILES.map(name => {
    try { const s = fs.statSync(path.join(locations().agentDir, name)); return { id: `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}`, mtimeMs: s.mtimeMs }; }
    catch { return { id: null, mtimeMs: 0 }; }
  });
}
/** Asks the running daemon to rebuild its Pi model list once after models.json or settings.json changed. Best effort:
 * it never throws, so a models read cannot fail because of it. */
export async function refreshPiCatalogIfChanged() {
  try {
    const control = await resolveControl(), instance = await currentInstance(control); if (!instance) return false; verifyInstanceOwnership(instance, control);
    const files = piCatalogFiles(), fingerprint = files.map(file => file.id).join('|');
    const seen = readState().piCatalog;
    const sameDaemon = seen?.pid === instance.pid && seen?.startedAt === instance.startedAt;
    // A daemon builds its list after it starts, so for a daemon not seen before only a later change leaves it stale.
    const stale = sameDaemon ? seen.fingerprint !== fingerprint : files.some(file => file.mtimeMs > Date.parse(instance.startedAt));
    if (sameDaemon && !stale) return false;
    // Recorded before asking: one attempt per change. A refresh starts Pi, so a failing one must not repeat every poll.
    updateState({ piCatalog: { pid: instance.pid, startedAt: instance.startedAt, fingerprint } });
    if (!stale) return false;
    await withClient(client => client.refreshProvidersSnapshot({ providers: ['pi'] }), 150000, control);
    return true;
  } catch { return false; }
}
const CONFIG_BLOCKERS = new Set(['CONFIG_CORRUPT', 'CONFIG_INCOMPATIBLE', 'CONFIG_INVALID']);
const CLOSING_RECORD = /^closing-[A-Za-z0-9-]+\.json$/;
/** How many closing records upstream keeps in <PASEO_HOME>/terminal-worker: what earlier cleanups could not confirm. Names are all it reads. */
function closingTerminalRecords(loc) {
  const dir = path.join(loc.paseoHome, 'terminal-worker');
  try { return fs.lstatSync(dir).isDirectory() ? fs.readdirSync(dir).filter(name => CLOSING_RECORD.test(name)).length : 0; }
  catch { return 0; }
}
/** Conditions that do not stop Paseo from working, as { code, at? } (health lists them apart from its blocking codes).
 * Terminal cleanup: a running 0.17.4 daemon says what its last cleanup could not confirm; a stopped one is covered
 * by the record of the stop that finished with the cleanup unconfirmed. Host: the last check of `ps`. */
function statusWarnings(state, daemon) {
  const warnings = [], add = (code, at, extra = {}) => {
    if (/^[A-Z][A-Z0-9_]{0,63}$/.test(code || '') && !warnings.some(row => row.code === code)) warnings.push({ code, ...(typeof at === 'string' ? { at } : {}), ...extra });
  };
  if (daemon.running) { if (daemon.terminalCleanupUnconfirmed > 0) add(TERMINAL_CLEANUP_NOT_CONFIRMED, daemon.statusCheckedAt); }
  else if (state.terminalCleanup) add(state.terminalCleanup.code, state.terminalCleanup.at);
  // The last check of the host's `ps` (start and diagnose): PS_UNAVAILABLE or PS_INCOMPATIBLE.
  if (state.processTable?.ok === false) add(state.processTable.code, state.processTable.checkedAt);
  // Every cleanup that could not confirm leaves a record each later cleanup walks again (3 s each, per pass): from
  // CLOSING_RECORDS_WARNING_AT on, the stop budget no longer has room for them in the worst case.
  if (daemon.closingTerminalRecords >= CLOSING_RECORDS_WARNING_AT) add('TERMINAL_RECORDS_ACCUMULATING', undefined, { count: daemon.closingTerminalRecords });
  return warnings;
}
async function readStatus() {
  const state = readState(), loc = locations(), control = await resolveControl(loc), owned = ownsHome();
  const installed = runtimeReady(loc) || !!control.root;
  // daemon.version: the Paseo release serving it (0.11.2 until an upgrade's explicit stop and start).
  const daemon = { running: false, reachable: false, owned, pid: null, listen: null, version: null, relayEnabled: false, relayConnected: null, relayVerified: state.relayVerification?.verified === true, relayVerifiedAt: state.relayVerification?.checkedAt || null, terminalCleanupUnconfirmed: null, closingTerminalRecords: owned ? closingTerminalRecords(loc) : 0 };
  // A config the next start cannot write outranks RESTART_REQUIRED: stopping would only take Paseo down.
  const configBlocker = state.phase === 'error' && CONFIG_BLOCKERS.has(state.lastError?.code) ? state.lastError.code : null;
  let providers = [], diagnosticCode = configBlocker || (state.lastError?.code === 'RESTART_REQUIRED' ? 'RESTART_REQUIRED' : null);
  if (owned && (control.root || control.refused)) {
    try {
      const instance = await currentInstance(control);
      if (instance) {
        verifyInstanceOwnership(instance, control); daemon.running = true; daemon.pid = instance.pid; daemon.listen = instance.listen; daemon.version = control.version;
        if(instanceNeedsRuntimeRestart(instance))diagnosticCode=configBlocker||'RESTART_REQUIRED';
        const key=JSON.stringify([loc.paseoHome,instance.pid,instance.startedAt,state.updatedAt]);
        const sample = await daemonStatusWindow(key,()=>withClient(client => client.getDaemonStatus({ timeout: 5000 }), 8000, control));
        const result=sample.value;
        daemon.statusCheckedAt=new Date(sample.checkedAt).toISOString();daemon.statusMaxAgeMs=3000;
        daemon.reachable = true; daemon.workerPid = result.pid; daemon.relayEnabled = result.relay?.enabled === true; daemon.relayConnected = typeof result.relay?.connected === 'boolean' ? result.relay.connected : null;
        // 0.17.4 daemons name the terminal processes their last cleanup could not confirm gone; 0.11.2 has no such report.
        daemon.terminalCleanupUnconfirmed = Array.isArray(result.terminalCleanupUnconfirmed) ? result.terminalCleanupUnconfirmed.length : 0;
        providers = (result.providers || []).filter(row => PROVIDERS.includes(row.provider)).map(safeProvider);
      }
    } catch (error) {
      diagnosticCode = safeCode(error);
      if (control.refused) { daemon.running = true; daemon.pid = control.pid; }
    }
  }
  const phase = state.phase === 'running' && !daemon.running ? 'stopped' : state.phase || 'not_installed';
  // version: the managed Paseo release installed for the next start (0.11.2 only before 0.17.4 is installed).
  return { installed, version: runtimeReady(loc) ? PASEO_VERSION : control.root ? control.version : null, enabled: state.desiredEnabled === true, phase, daemon, providers, chatVerified: state.acceptance?.passed === true, pairingAvailable: fs.existsSync(path.join(locations().stateDir, 'pairing.private.json')), agentCollaboration: agentCollaborationEnabled(), diagnosticCode, warnings: statusWarnings(state, daemon), state };
}
export async function diagnose() {
  await recordProcessTable();
  const snapshot = await status(); const launchers = await detectLaunchers();
  let providers = snapshot.providers;
  if (snapshot.daemon.reachable) {
    try { providers = await withClient(async client => (await client.getProvidersSnapshot()).entries.filter(row => PROVIDERS.includes(row.provider)).map(safeProvider), 150000); }
    catch (error) { snapshot.diagnosticCode = safeCode(error); }
  }
  const loc = locations();
  const credentialPaths = { claude: [path.join(loc.home, '.claude/.credentials.json')], codex: [path.join(process.env.CODEX_HOME || path.join(loc.home, '.codex'), 'auth.json')], pi: [path.join(loc.agentDir, 'auth.json')] };
  providers = PROVIDERS.map(provider => {
    const check = snapshot.state.acceptance?.providers?.find(row => row.provider === provider);
    return { ...(providers.find(row => row.provider === provider) || { provider, status: 'unknown', modes: [] }), launcher: launchers[provider], credentialPresent: credentialPaths[provider].some(file => credentialPresent(provider, file)), authentication: check?.passed ? 'chat_verified' : check?.code === 'PROVIDER_AUTH_REQUIRED' ? 'login_required' : 'needs_chat_verification', chatErrorCode: check?.code || null, loginHint: provider === 'claude' ? 'claude auth login' : provider === 'codex' ? 'codex login' : 'pi /login' };
  });
  const result = { ...snapshot, providers, checkedAt: new Date().toISOString() };
  updateState({ lastDiagnostic: { checkedAt: result.checkedAt, daemonReachable: result.daemon.reachable, providers: providers.map(row => ({ provider: row.provider, status: row.status, startup: row.launcher.startup, authentication: row.authentication })) } });
  return result;
}
export async function listModels(provider) {
  if (!PROVIDERS.includes(provider)) throw new RuntimeError('INVALID_PROVIDER');
  return singleFlight(`models:${locations().paseoHome}:${provider}`,async()=>{
    // The supervisor makes this refresh within a poll; a read right after the change makes it first.
    if (provider === 'pi') await refreshPiCatalogIfChanged();
    return readModels(provider);
  });
}
async function readModels(provider) {
  return withClient(async client => {
    let result = await client.listProviderModels(provider);
    // The daemon answers from a cached provider snapshot that is only rebuilt on request or restart, so a catalog cached
    // before the provider was ready stays empty (not logged in yet) or failed (it could not start, e.g. a missing home
    // directory) afterwards. Ask for one refresh of just this provider and read again; if the refresh itself fails, keep
    // the first answer (what this call returned before).
    if (result.error || !(result.models || []).length) {
      try { await client.refreshProvidersSnapshot({ providers: [provider] }); result = await client.listProviderModels(provider); }
      catch { /* keep the first answer */ }
    }
    const snapshot = await client.getProvidersSnapshot(); const entry = snapshot.entries.find(row => row.provider === provider);
    if (result.error) throw new RuntimeError('PROVIDER_MODELS_UNAVAILABLE');
    return { ...safeProvider(entry || { provider, status: 'unknown' }), models: (result.models || []).map(model => ({ id: model.id, label: model.label || model.id, isDefault: model.isDefault === true, defaultThinkingOptionId: model.defaultThinkingOptionId || null, thinkingOptions: (model.thinkingOptions || []).map(option => ({ id: option.id, label: option.label || option.id, isDefault: option.isDefault === true })) })) };
  }, 150000);
}
export async function pair() {
  return withRuntimeLock(async () => {
    const target = connectionPreferences(locations()).target;
    if (readState().configurationPending === true || (readState().activeTarget || 'paseo') !== target) throw new RuntimeError('CONFIGURATION_PENDING');
    const result = await status(); if (!result.daemon.reachable) throw new RuntimeError('DAEMON_UNREACHABLE');
    const control = await resolveControl(); if (!control.root) throw new RuntimeError(control.refused || 'DAEMON_UNREACHABLE');
    const offer = await cli(['daemon', 'pair', '--relay'], { timeoutMs: 15000 }, control.root);
    if (!offer.url || !offer.relayEnabled) throw new RuntimeError('PAIRING_UNAVAILABLE');
    const pairing = { url: targetPairUrl(offer.url, target), target, createdAt: new Date().toISOString() };
    atomicJson(path.join(locations().stateDir, 'pairing.private.json'), pairing);
    updateState({ pairingCreatedAt: pairing.createdAt });
    return pairing;
  }, { timeoutMs: 30000 });
}

export async function saveConnectionSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid settings');
  if (Object.keys(input).some(key => !['name', 'target', 'agentCollaboration'].includes(key))) throw new Error('Unsupported setting');
  if (input.agentCollaboration !== undefined && typeof input.agentCollaboration !== 'boolean') throw new RuntimeError('INVALID_SETTING');
  if (input.name !== undefined && typeof input.name !== 'string') throw new Error('Invalid name');
  const name = input.name?.trim();
  if (name !== undefined && (name.length > 100 || /[\x00-\x1f\x7f]/.test(name))) throw new Error('Invalid name');
  if (Object.hasOwn(input, 'target')) {
    if (typeof input.target !== 'string') throw new RuntimeError('INVALID_TARGET');
    connectionTarget(input.target);
  }
  return withRuntimeLock(async () => {
    const loc = locations(), file = path.join(loc.stateDir, 'preferences.json');
    const previous = readRecord(file), previousTarget = connectionTarget(previous.target).id;
    const target = input.target === undefined ? previousTarget : connectionTarget(input.target).id;
    const changed = target !== previousTarget;
    if (changed) {
      const pairingFile = path.join(loc.stateDir, 'pairing.private.json');
      assertSafePath(pairingFile);
      // Pending is published before preferences, so a partial write cannot make
      // the UI offer a new brand while an old daemon still owns the connection.
      updateState({ configurationPending: true, relayVerification: null, pairingCreatedAt: null });
      fs.rmSync(pairingFile, { force: true });
    }
    const collaboration = input.agentCollaboration;
    writeRecord(file, { ...previous, name: name === undefined ? previous.name || 'Pi Agent' : name || 'Pi Agent', connection: 'relay', target,
      ...(collaboration === undefined ? {} : { agentCollaboration: collaboration }) });
    if (collaboration === undefined) return { saved: true, target, configurationPending: readState().configurationPending === true };
    // Compared with the daemon config, not the old preference: a Paseo client may have changed it.
    const applied = await applyAgentCollaboration(collaboration);
    return { saved: true, target, agentCollaboration: agentCollaborationEnabled(), agentCollaborationApplied: applied, configurationPending: readState().configurationPending === true };
  }, { timeoutMs: 30000 });
}
/** Runs exactly two tiny turns per selected provider. Call only after user authorization. */
export async function acceptance(options = {}) {
  const selectedProviders = options.providers || PROVIDERS;
  if (!Array.isArray(selectedProviders) || selectedProviders.some(provider => !PROVIDERS.includes(provider))) throw new RuntimeError('INVALID_PROVIDER');
  const timeoutMs = Math.min(Math.max(options.timeoutMs || 180000, 10000), 600000);
  const results = [];
  const previous = readState().acceptance?.providers || [];
  const cwd = options.cwd || path.join(locations().stateDir, 'acceptance-workspace'); privateDirectory(cwd);
  for (const provider of selectedProviders) {
    const row = { provider, passed: false, firstReply: false, followup: false, model: null, modeId: null, agentId: null };
    try {
      const catalog = await listModels(provider);
      const model = options.models?.[provider] || catalog.models.find(model => model.isDefault)?.id || catalog.models[0]?.id;
      if (!model || !catalog.models.some(entry => entry.id === model)) throw new RuntimeError('NO_AVAILABLE_MODEL');
      const modeId = options.modes?.[provider] || catalog.defaultModeId || undefined;
      if (modeId && catalog.modes.length && !catalog.modes.some(mode => mode.id === modeId)) throw new RuntimeError('INVALID_MODE');
      row.model = model; row.modeId = modeId || null;
      await withClient(async client => {
        const marker = `PI_PASEO_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
        const workspaceId = await acceptanceWorkspace(client,cwd);
        await usingAcceptanceAgent(client,{ provider, model, modeId, cwd, workspaceId, title: `Pi Paseo ${provider} connection check`, initialPrompt: `Connection check only. Do not use tools or edit files. Remember ${marker}. Reply with exactly ${marker}.`, labels: { 'pi-paseo-acceptance': 'true' } },row,async agent=>{
        const first = await client.waitForFinish(agent.id, timeoutMs);
        if (first.status !== 'idle') throw new RuntimeError(first.status === 'permission' ? 'PERMISSION_REQUIRED' : first.status === 'timeout' ? 'PROVIDER_TIMEOUT' : 'PROVIDER_TURN_FAILED');
        const firstEntries = await assistantEntries(client, agent.id);
        const firstReply = firstEntries.at(-1)?.item.text || ''; row.firstReply = String(firstReply).includes(marker);
        if (providerReplyError(firstReply)) throw new RuntimeError(providerReplyError(firstReply));
        if (!row.firstReply) throw new RuntimeError('EMPTY_OR_UNEXPECTED_REPLY');
        await client.sendAgentMessage(agent.id, 'What marker did I ask you to remember? Reply with that marker only. Do not use tools.');
        const second = await client.waitForFinish(agent.id, timeoutMs);
        if (second.status !== 'idle') throw new RuntimeError(second.status === 'permission' ? 'PERMISSION_REQUIRED' : second.status === 'timeout' ? 'PROVIDER_TIMEOUT' : 'PROVIDER_TURN_FAILED');
        const secondEntries = await assistantEntries(client, agent.id);
        const followup = secondEntries.at(-1)?.item.text || ''; row.followup = latestAssistantCursor(secondEntries) !== latestAssistantCursor(firstEntries) && String(followup).includes(marker);
        if (providerReplyError(followup)) throw new RuntimeError(providerReplyError(followup));
        row.passed = row.firstReply && row.followup;
        });
      }, timeoutMs * 2 + 30000);
    } catch (error) { row.code = safeCode(error); }
    results.push(row);
    updateState({ acceptance: { checkedAt: new Date().toISOString(), passed: false, providers: results } });
    if (options.onProgress) await options.onProgress({ ...row });
  }
  const merged = [...previous.filter(row => !selectedProviders.includes(row.provider)), ...results];
  const result = { checkedAt: new Date().toISOString(), passed: PROVIDERS.every(provider => merged.some(row => row.provider === provider && row.passed && row.cleanup?.archived!==false)), providers: merged };
  updateState({ acceptance: result }); return result;
}
function chatInput(message) {
  if (typeof message !== 'string' || !message.trim() || message.length > 100000) throw new RuntimeError('INVALID_MESSAGE');
}
function chatCwd(cwd) {
  const directory = path.resolve(cwd || readState().settings?.cwd || locations().home);
  try { fs.accessSync(directory, fs.constants.R_OK); if (!fs.statSync(directory).isDirectory()) throw new Error(); }
  catch { throw new RuntimeError('INVALID_WORKSPACE'); }
  return directory;
}
export async function createChat(options = {}) {
  chatInput(options.message); const provider = options.provider;
  const catalog = await listModels(provider); const cwd = chatCwd(options.cwd);
  const model = options.model || catalog.models.find(model => model.isDefault)?.id || catalog.models[0]?.id;
  if (!model || !catalog.models.some(entry => entry.id === model)) throw new RuntimeError('INVALID_MODEL');
  const modeId = options.mode || catalog.defaultModeId || undefined;
  if (modeId && !catalog.modes.some(mode => mode.id === modeId)) throw new RuntimeError('INVALID_MODE');
  const selected = catalog.models.find(entry => entry.id === model);
  const thinkingOptionId = options.thinking || selected.defaultThinkingOptionId || undefined;
  if (thinkingOptionId && !selected.thinkingOptions.some(option => option.id === thinkingOptionId)) throw new RuntimeError('INVALID_THINKING_OPTION');
  const timeoutMs = Math.min(Math.max(options.timeoutMs || 120000, 1000), 600000);
  let agentId;
  try {
    return await withClient(async client => {
      const workspace = await client.createWorkspace({ source: { kind: 'directory', path: cwd } });
      if (!workspace.workspace?.id) throw new RuntimeError('WORKSPACE_CREATE_FAILED');
      const agent = await client.createAgent({ provider, model, modeId, thinkingOptionId, cwd, workspaceId: workspace.workspace.id, title: options.title || `Pi Web ${provider}`, initialPrompt: options.message, labels: { 'pi-paseo-plugin': readState().installationId } });
      agentId = agent.id;
      return chatResult(client, agentId, provider, model, timeoutMs);
    }, timeoutMs + 30000);
  } catch (error) {
    if (agentId && ['DAEMON_REQUEST_TIMEOUT', 'COMMAND_TIMEOUT'].includes(error.code)) return { agentId, provider, model, reply: '', status: 'pending' };
    throw error;
  }
}
export async function continueChat(options = {}) {
  chatInput(options.message);
  if (typeof options.agentId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(options.agentId)) throw new RuntimeError('INVALID_AGENT_ID');
  const timeoutMs = Math.min(Math.max(options.timeoutMs || 120000, 1000), 600000);
  let provider = null, model = null;
  try {
    return await withClient(async client => {
      const found = await client.fetchAgent({ agentId: options.agentId });
      if (!found?.agent) throw new RuntimeError('AGENT_NOT_FOUND');
      provider = found.agent.provider; model = found.agent.model || found.agent.config?.model || null;
      const previousCursor = latestAssistantCursor(await assistantEntries(client, options.agentId));
      await client.sendAgentMessage(options.agentId, options.message);
      return chatResult(client, options.agentId, provider, model, timeoutMs, previousCursor);
    }, timeoutMs + 30000);
  } catch (error) {
    if (['DAEMON_REQUEST_TIMEOUT', 'COMMAND_TIMEOUT'].includes(error.code)) return { agentId: options.agentId, provider, model, reply: '', status: 'pending' };
    throw error;
  }
}
