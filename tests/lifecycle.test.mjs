import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Load Pi's local lookup implementation without loading its CLI or installing packages.
const piRoot = path.dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
const { DefaultPackageManager } = await import(pathToFileURL(path.join(piRoot, 'core/package-manager.js')));
const { SettingsManager } = await import(pathToFileURL(path.join(piRoot, 'core/settings-manager.js')));

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

function fixture(t, { clock } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-paseo-lifecycle-'));
  const loc = { home: path.join(dir, 'home'), agentDir: path.join(dir, 'agent'), stateDir: path.join(dir, 'state') };
  for (const p of Object.values(loc)) fs.mkdirSync(p, { recursive: true });
  const calls = [];
  const processes = new Map();
  const signals = new EventEmitter();
  let nextPid = 4100;
  let onSignal = (pid, signal) => { if (signal === 'SIGTERM') processes.delete(pid); };
  const fakeProcess = Object.assign(signals, {
    pid: 4000, platform: 'linux', execPath: process.execPath, env: { HOME: loc.home, PI_CODING_AGENT_DIR: loc.agentDir, PI_PASEO_STATE_DIR: loc.stateDir, PI_PASEO_RUNTIME_DIR: path.join(dir, 'runtime') }, cwd: () => loc.home,
    kill(pid, signal = 'SIGTERM') {
      if (signal === 0 && pid === this.pid) return true;
      if (signal === 0 && clock && processes.get(pid)?.exitAt <= clock.now) processes.delete(pid);
      if (!processes.has(pid)) throw Object.assign(new Error('No process'), { code: 'ESRCH' });
      if (signal !== 0) { calls.push(['signal', pid, signal]); onSignal(pid, signal); }
      return true;
    },
  });
  const fakeFs = {
    ...fs,
    readFileSync(file, ...args) {
      const proc = /^\/proc\/(\d+)\/cmdline$/.exec(String(file));
      if (proc) {
        const p = processes.get(Number(proc[1]));
        if (!p) throw Object.assign(new Error('No process'), { code: 'ENOENT' });
        return p.argv.join('\0') + '\0';
      }
      return fs.readFileSync(file, ...args);
    },
  };
  const runtime = {
    locations: () => loc,
    status: async () => ({ daemon: { running: true } }),
    daemonRunning: async () => true,
    refreshPiCatalogIfChanged: async () => false,
    activate: async () => { calls.push(['activate']); return {}; },
    deactivate: async () => { calls.push(['deactivate']); return {}; },
    abortPruning: () => {},
  };
  const cache = new Map();
  function load(file) {
    const absolute = path.resolve(root, file);
    if (cache.has(absolute)) return cache.get(absolute).exports;
    const module = { exports: {} };
    cache.set(absolute, module);
    // Transpile the actual modules for a VM with isolated process/spawn/runtime fakes.
    // Production code paths and the real onboarding lock/record implementation still run.
    const source = fs.readFileSync(absolute, 'utf8').replaceAll('import.meta.url', JSON.stringify(pathToFileURL(absolute).href));
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: absolute + '.ts' }).outputText;
    const localRequire = spec => {
      if (spec === 'node:fs') return fakeFs;
      if (spec === 'node:child_process') return { spawn: (_command, argv) => {
        const pid = ++nextPid;
        processes.set(pid, { identity: 'birth-' + pid, argv: [process.execPath, ...argv] });
        calls.push(['spawn', pid]);
        const child = Object.assign(new EventEmitter(), { pid, unref() {} });
        queueMicrotask(() => child.emit('spawn'));
        return child;
      } };
      if (spec === '@earendil-works/pi-coding-agent') return { DefaultPackageManager, SettingsManager };
      if (spec.endsWith('/runtime.mjs')) return runtime;
      if (spec.endsWith('/state.mjs')) return { ...load('src/state.mjs'), locations: () => loc, processIdentity: pid => pid === fakeProcess.pid ? 'self' : processes.get(pid)?.identity ?? null };
      if (spec.startsWith('.')) return load(path.relative(root, path.resolve(path.dirname(absolute), spec)));
      return require(spec);
    };
    vm.runInNewContext(`(function(require,module,exports){${code}\n})`, { process: fakeProcess, URL, Date: clock ? class extends Date { static now() { return clock.now; } } : Date, setTimeout: (fn, ms) => clock ? (clock.now += ms, queueMicrotask(fn), 0) : setTimeout(fn, ms >= 15000 ? 1 : ms), clearTimeout, console }, { filename: absolute })(localRequire, module, module.exports);
    return module.exports;
  }
  function write(name, value) { fs.writeFileSync(path.join(loc.stateDir, name + '.json'), JSON.stringify(value)); }
  function packages(entries) { fs.writeFileSync(path.join(loc.agentDir, 'settings.json'), JSON.stringify({ packages: entries })); }
  function owned({ argv = [process.execPath, path.join(root, 'bin/cli.mjs'), 'supervise'], identity = 'original', recordedIdentity = identity } = {}) {
    const pid = ++nextPid;
    processes.set(pid, { identity, argv });
    write('supervisor', { pid, identity: recordedIdentity, packageRoot: root });
    return pid;
  }
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { loc, calls, processes, signals, runtime, write, packages, owned, load, fakeProcess, fakeFs, setSignalHandler: fn => { onSignal = fn; } };
}

const enabledPackages = [{ source: root, installedPath: root, disabled: false, scope: 'global' }];

async function postinstallCli(f) {
  const source = fs.readFileSync(path.join(root, 'bin/cli.mjs'), 'utf8')
    .replace(/^#!.*\r?\n/, '')
    .replace(/^import .*;\r?\n/gm, '')
    .replace("await import('./install-host.mjs')", 'await installerImport()');
  let output = '', errors = '';
  const cliProcess = { argv: ['node', 'cli.mjs', 'postinstall'], env: {},
    stdout: { write: text => { output += text; } }, stderr: { write: text => { errors += text; } } };
  await vm.runInNewContext(`(async()=>{${source}\n})()`, {
    runtime: f.runtime, host: f.load('src/host-api.mjs'), process: cliProcess,repairSdkDependency:()=>({skipped:true}),
    installerImport: async () => ({ installHost: async () => ({ restartRequired: true }) }),
  });
  return { output, errors, exitCode: cliProcess.exitCode };
}

test('actual postinstall CLI preserves a manual stop even if activation would fail after starting', async t => {
  const f = fixture(t);
  f.packages([root]);
  f.write('host-registration', { enabled: false });
  f.runtime.activate = async () => { f.calls.push(['activate']); throw new Error('DAEMON_UNREACHABLE'); };
  const result = await postinstallCli(f);
  assert.equal(result.exitCode, undefined);
  assert.equal(result.errors, '');
  assert.equal(f.calls.some(row => row[0] === 'activate' || row[0] === 'spawn'), false);
  assert.equal(JSON.parse(result.output).lifecycle.phase, 'disabled');
});

test('actual first-install CLI prepares the daemon before Pi registers the package', async t => {
  const f = fixture(t);
  f.packages([]);
  const result = await postinstallCli(f);
  assert.equal(result.exitCode, undefined);
  assert.equal(result.errors, '');
  assert.equal(f.calls.filter(row => row[0] === 'activate').length, 1);
  assert.equal(JSON.parse(result.output).hostInstallation.restartRequired, true);
});

test('explicit stop overrides still-enabled Pi bindings and activate restarts only the service', async t => {
  const f = fixture(t);
  f.packages([root]);
  f.write('onboarding', { sessionId: 'existing-session', completed: false });
  const pid = f.owned();
  const host = f.load('src/host-api.mjs');
  const stopped = await host.lifecycle({ action: 'disable', packages: enabledPackages });
  assert.equal(stopped.phase, 'disabled');
  assert.equal(f.processes.has(pid), false);
  assert.equal(f.calls.some(c => c[0] === 'deactivate'), true);
  assert.equal((await f.load('src/supervisor.mjs').startSupervisor()).running, false);
  assert.equal((await host.restore()).phase, 'disabled');
  assert.equal(f.calls.some(c => c[0] === 'spawn'), false);
  const resumed = await host.lifecycle({ action: 'activate', packages: enabledPackages }, { createOnboarding: () => assert.fail('startup must not create a conversation') });
  assert.equal(resumed.phase, 'starting');
  assert.equal('onboardingSessionId' in resumed, false);
  assert.equal(f.calls.filter(c => c[0] === 'spawn').length, 1);
});

test('a stopped package stays stopped on session_start and discovery has no lifecycle effects', async t => {
  const f = fixture(t);
  f.packages([root]);
  f.write('host-registration', { enabled: false, packageRoot: root, cwd: f.loc.home });
  let sessionStart;
  const statuses = [];
  f.load('extensions/index.ts').default({ registerCommand() {}, registerTool() {}, sendMessage() {}, on: (_name, handler) => { sessionStart = handler; } });
  await sessionStart({}, { cwd: f.loc.home, ui: { setStatus: (...args) => statuses.push(args) } });
  assert.equal(f.calls.some(c => c[0] === 'spawn'), false);
  assert.equal(statuses.some(c => c[1]?.includes('已啟用')), false);
  f.write('host-registration', { enabled: true });
  f.load('src/supervisor.mjs');
  // The fake process environment is intentionally isolated from the test runner.
  f.signals.env.PI_PASEO_DISCOVERY_ONLY = '1';
  await sessionStart({}, { cwd: f.loc.home, ui: { setStatus: (...args) => statuses.push(args) } });
  assert.equal(f.calls.some(c => c[0] === 'spawn'), false);
});

test('Git installation paths decide enabled/disabled state without stale registration fallback', t => {
  const f = fixture(t);
  const source = 'git:github.com/example/renamed-remote@main';
  const installed = path.join(f.loc.agentDir, 'git/github.com/example/renamed-remote');
  fs.mkdirSync(path.dirname(installed), { recursive: true });
  fs.symlinkSync(root, installed, 'dir');
  const supervisor = f.load('src/supervisor.mjs');
  f.packages([source]);
  assert.equal(supervisor.packageEnabled(f.loc), true);
  f.write('host-registration', { enabled: true, packageRoot: root, cwd: f.loc.home });
  f.packages([{ source, extensions: [] }]);
  assert.equal(supervisor.packageEnabled(f.loc), false);
  f.packages([]);
  assert.equal(supervisor.packageEnabled(f.loc), false);
  f.packages(['git:github.com/example/@woowtech/pi-paseo-impostor']);
  assert.equal(supervisor.packageEnabled(f.loc), false);
});

test('local and npm installed paths remain supported, including extension disable filters', t => {
  const f = fixture(t);
  const supervisor = f.load('src/supervisor.mjs');
  for (const source of [root, path.relative(f.loc.agentDir, root), 'npm:@woowtech/pi-paseo@0.1.0']) {
    if (source.startsWith('npm:')) {
      const installed = path.join(f.loc.agentDir, 'npm/node_modules/@woowtech/pi-paseo');
      fs.mkdirSync(path.dirname(installed), { recursive: true });
      fs.symlinkSync(root, installed, 'dir');
    }
    f.packages([source]);
    assert.equal(supervisor.packageEnabled(f.loc), true, source);
    f.packages([{ source, extensions: [] }]);
    assert.equal(supervisor.packageEnabled(f.loc), false, source);
  }
});

test('shutdown waits for in-flight supervisor activation before deactivation', async t => {
  const f = fixture(t);
  f.packages([root]);
  f.write('host-registration', { enabled: true, packageRoot: root, cwd: f.loc.home });
  const pid = f.owned();
  const entered = deferred(), release = deferred(), signaled = deferred();
  f.runtime.activate = async () => { entered.resolve(); await release.promise; f.calls.push(['activate-finished']); };
  const supervising = f.load('src/supervisor.mjs').supervise({ fallbackOnboarding: true });
  await entered.promise;
  f.setSignalHandler(() => { f.signals.emit('SIGTERM'); signaled.resolve(); });
  const stopping = f.load('src/host-api.mjs').lifecycle({ action: 'disable' });
  await signaled.promise;
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.calls.some(c => c[0] === 'deactivate'), false);
  release.resolve();
  await supervising;
  f.processes.delete(pid);
  await stopping;
  assert.equal(f.calls.at(-1)[0], 'deactivate');
  assert.equal(f.calls.findIndex(c => c[0] === 'activate-finished') < f.calls.findIndex(c => c[0] === 'deactivate'), true);
  assert.equal(fs.existsSync(path.join(f.loc.stateDir, 'onboarding.json')), false);
});

test('shutdown timeout is bounded and cannot report success while the supervisor still owns its PID', async t => {
  const f = fixture(t);
  const pid = f.owned();
  f.setSignalHandler(() => {});
  await assert.rejects(f.load('src/supervisor.mjs').stopSupervisor({ timeoutMs: 20 }), /still stopping|timed out/i);
  assert.equal(f.processes.has(pid), true);
  assert.equal(f.calls.filter(c => c[0] === 'signal').length, 1);
});

test('shutdown never signals unrelated argv or reused process identities', async t => {
  for (const settings of [
    { argv: [process.execPath, '-e', 'unrelated'] },
    { argv: [process.execPath, path.join(root, 'bin/cli.mjs') + '.unrelated', 'supervise'] },
    { argv: [process.execPath, path.join(root, 'bin/cli.mjs'), 'not-supervise'] },
    { identity: 'new-owner', recordedIdentity: 'old-owner' },
  ]) {
    const f = fixture(t);
    const pid = f.owned(settings);
    await f.load('src/supervisor.mjs').stopSupervisor();
    assert.equal(f.processes.has(pid), true);
    assert.equal(f.calls.some(c => c[0] === 'signal'), false);
  }
});

test('supervisor rechecks shutdown after the daemon check and does not activate or create onboarding', async t => {
  const f = fixture(t);
  f.packages([root]);
  const entered = deferred(), release = deferred();
  f.runtime.daemonRunning = async () => { entered.resolve(); return release.promise; };
  const supervising = f.load('src/supervisor.mjs').supervise({ fallbackOnboarding: true });
  await entered.promise;
  f.signals.emit('SIGTERM');
  release.resolve(false);
  await supervising;
  assert.equal(f.calls.some(c => c[0] === 'activate'), false);
  assert.equal(fs.existsSync(path.join(f.loc.stateDir, 'onboarding.json')), false);
  assert.equal(f.signals.listenerCount('SIGTERM'), 0);
  assert.equal(f.signals.listenerCount('SIGINT'), 0);
});


test('the supervisor poll never asks the daemon for its status and does not wait for a Pi catalog refresh', async t => {
  const f = fixture(t);
  f.packages([root]);
  // Paseo answers every daemon status request by running each provider's --version.
  f.runtime.status = async () => { throw new Error('the supervisor asked the daemon for its status'); };
  let polls = 0, refreshes = 0;
  f.runtime.daemonRunning = async () => { polls++; return true; };
  f.runtime.refreshPiCatalogIfChanged = () => { refreshes++; return new Promise(() => {}); };
  const supervising = f.load('src/supervisor.mjs').supervise();
  const deadline = Date.now() + 5000;
  while (polls < 4 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  f.signals.emit('SIGTERM');
  await supervising;
  assert.equal(refreshes, 1, 'one refresh at a time, while the loop kept polling and still stopped');
  assert.deepEqual(f.calls.filter(c => c[0] === 'activate'), [['activate']]);
  assert.equal(fs.existsSync(path.join(f.loc.stateDir, 'supervisor-error.json')), false);
});

test('ordinary host restart recovers an enabled unpaused package', async t => {
  const f = fixture(t);
  f.packages([root]);
  f.write('host-registration', { enabled: true, packageRoot: root, cwd: f.loc.home });
  f.write('onboarding', { sessionId: 'existing-session', completed: true });
  const restored = await f.load('src/host-api.mjs').restore({ createOnboarding: () => assert.fail('restart must not create a conversation') });
  assert.equal(restored.phase, 'starting');
  assert.equal('onboardingSessionId' in restored, false);
  assert.equal(f.calls.filter(c => c[0] === 'spawn').length, 1);
});

test('host model buttons delegate provider model discovery to the runtime', async t => {
  const f = fixture(t);
  const expected = { models: ['fixture-model'], modes: ['fixture-mode'] };
  f.runtime.listModels = async provider => { assert.equal(provider, 'pi'); return expected; };
  assert.equal(await f.load('src/host-api.mjs').listModels('pi'), expected);
});


test('concurrent explicit activate waits until a pending stop has deactivated', async t => {
  const f = fixture(t);
  f.packages([root]);
  f.write('onboarding', { sessionId: 'existing-session', completed: false });
  const pid = f.owned();
  const signaled = deferred(), entered = deferred(), release = deferred();
  f.setSignalHandler(() => signaled.resolve());
  f.runtime.deactivate = async () => { entered.resolve(); await release.promise; f.calls.push(['deactivate']); };
  const host = f.load('src/host-api.mjs');
  const stopping = host.lifecycle({ action: 'stop', packages: enabledPackages });
  await signaled.promise;
  const starting = host.lifecycle({ action: 'activate', packages: enabledPackages });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.calls.some(c => c[0] === 'spawn'), false);
  f.processes.delete(pid);
  await entered.promise;
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.loc.stateDir, 'host-registration.json'))).enabled, false);
  assert.equal(f.calls.some(c => c[0] === 'spawn'), false);
  release.resolve();
  await Promise.all([stopping, starting]);
  assert.equal(f.calls.findIndex(c => c[0] === 'deactivate') < f.calls.findIndex(c => c[0] === 'spawn'), true);
});

test('disabled or removed Git packages stop supervision despite an old enabled registration', async t => {
  const f = fixture(t);
  const source = 'git:github.com/example/renamed-remote';
  const installed = path.join(f.loc.agentDir, 'git/github.com/example/renamed-remote');
  fs.mkdirSync(path.dirname(installed), { recursive: true });
  fs.symlinkSync(root, installed, 'dir');
  f.write('host-registration', { enabled: true, packageRoot: root, cwd: f.loc.home });
  f.packages([{ source, extensions: [] }]);
  await f.load('src/supervisor.mjs').supervise();
  assert.equal(f.calls.filter(c => c[0] === 'deactivate').length, 1);
  assert.equal(f.calls.some(c => c[0] === 'activate'), false);
  f.packages([]);
  assert.equal((await f.load('src/host-api.mjs').restore()).phase, 'disabled');
  assert.equal(f.calls.some(c => c[0] === 'spawn'), false);
});

test('package install and update cannot clear a user pause', async t => {
  const f = fixture(t);
  f.packages([root]);
  const host = f.load('src/host-api.mjs');
  await host.lifecycle({ action: 'stop', packages: enabledPackages });
  for (const action of ['restore', 'install', 'update']) {
    assert.equal((await host.lifecycle({ action, packages: enabledPackages })).phase, 'disabled');
  }
  assert.equal(f.calls.some(c => c[0] === 'spawn'), false);
  assert.equal((await host.lifecycle({ action: 'enable', packages: enabledPackages })).phase, 'starting');
});

test('supervisor stop finishes deactivation even without the original host waiter', async t => {
  const f = fixture(t);
  f.packages([root]);
  const entered = deferred(), release = deferred();
  f.runtime.activate = async () => { entered.resolve(); await release.promise; f.calls.push(['activate-finished']); };
  const supervising = f.load('src/supervisor.mjs').supervise();
  await entered.promise;
  // lifecycle() persists the disabled registration before it signals, so the
  // supervisor can still tell a disable apart from a plain stop when that host dies.
  f.write('host-registration', { enabled: false, packageRoot: root, cwd: f.loc.home });
  f.signals.emit('SIGTERM');
  assert.equal(f.calls.some(c => c[0] === 'deactivate'), false);
  release.resolve();
  await supervising;
  assert.deepEqual(f.calls.map(c => c[0]), ['activate-finished', 'deactivate']);
});

test('a stop while the package is still enabled never persists a user disable', async t => {
  const f = fixture(t);
  f.packages([root]);
  // No disabled registration: this is container shutdown, or startSupervisor()
  // replacing a supervisor that lives under another package root (a plugin-source
  // swap). Deactivating here wrote desiredEnabled=false to the tenant volume and
  // left Paseo off across restarts.
  f.write('host-registration', { enabled: true, packageRoot: root, cwd: f.loc.home });
  const entered = deferred(), release = deferred();
  f.runtime.activate = async () => { entered.resolve(); await release.promise; f.calls.push(['activate-finished']); };
  const supervising = f.load('src/supervisor.mjs').supervise();
  await entered.promise;
  f.signals.emit('SIGTERM');
  release.resolve();
  await supervising;
  assert.deepEqual(f.calls.map(c => c[0]), ['activate-finished']);
  assert.equal(f.calls.some(c => c[0] === 'deactivate'), false);
});

test('a stop still disables when Pi itself no longer has the package enabled', async t => {
  const f = fixture(t);
  f.packages([]);
  f.write('host-registration', { enabled: true, packageRoot: root, cwd: f.loc.home });
  const supervising = f.load('src/supervisor.mjs').supervise();
  await supervising;
  assert.deepEqual(f.calls.map(c => c[0]), ['deactivate']);
});

test('a PID reused while stopping is never signaled again or waited on as the original supervisor', async t => {
  const f = fixture(t);
  const pid = f.owned();
  f.setSignalHandler(() => { f.processes.set(pid, { identity: 'new-birth', argv: ['unrelated'] }); });
  await f.load('src/supervisor.mjs').stopSupervisor();
  assert.equal(f.processes.get(pid).identity, 'new-birth');
  assert.deepEqual(f.calls.map(c => c[0]), ['signal']);
});

test('project Git settings resolve through Pi installedPath using the recorded cwd', t => {
  const f = fixture(t);
  const source = 'git:github.com/example/project-remote';
  const installed = path.join(f.loc.home, '.pi/git/github.com/example/project-remote');
  fs.mkdirSync(path.dirname(installed), { recursive: true });
  fs.symlinkSync(root, installed, 'dir');
  const file = path.join(f.loc.home, '.pi/settings.json');
  f.write('host-registration', { enabled: true, packageRoot: root, cwd: f.loc.home });
  fs.writeFileSync(file, JSON.stringify({ packages: [source] }));
  assert.equal(f.load('src/supervisor.mjs').packageEnabled(f.loc), true);
  fs.writeFileSync(file, JSON.stringify({ packages: [{ source, extensions: [] }] }));
  assert.equal(f.load('src/supervisor.mjs').packageEnabled(f.loc), false);
});

test('supervisor startup refuses a symlinked log before spawning', async t => {
  const f = fixture(t);
  f.packages([root]);
  const target = path.join(f.loc.home, 'external.log');
  fs.writeFileSync(target, 'external-data');
  const log = path.join(f.loc.stateDir, 'supervisor.log');
  fs.symlinkSync(target, log);
  await assert.rejects(f.load('src/supervisor.mjs').startSupervisor(), error => error.code === 'UNSAFE_SYMLINK');
  assert.equal(fs.lstatSync(log).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'external-data');
  assert.equal(f.calls.some(row => row[0] === 'spawn'), false);
});


test('state path safety preserves only macOS fixed root-owned temporary aliases', t => {
  const f = fixture(t);
  f.fakeProcess.platform = 'darwin';
  const originalStat = f.fakeFs.lstatSync;
  f.fakeFs.lstatSync = file => String(file) === '/var' ? { isSymbolicLink: () => true, uid: 0 } : originalStat(file);
  f.fakeFs.readlinkSync = () => 'private/var';
  const state = f.load('src/state.mjs');
  assert.doesNotThrow(() => state.assertSafePath('/var/pi-paseo-test-does-not-exist'));
  f.fakeFs.readlinkSync = () => '/elsewhere';
  assert.throws(() => state.assertSafePath('/var/pi-paseo-test-does-not-exist'), error => error.code === 'UNSAFE_SYMLINK');
  f.fakeFs.readlinkSync = () => 'private/var';
  f.fakeFs.lstatSync = file => String(file) === '/var' ? { isSymbolicLink: () => true, uid: 1000 } : originalStat(file);
  assert.throws(() => state.assertSafePath('/var/pi-paseo-test-does-not-exist'), error => error.code === 'UNSAFE_SYMLINK');
});

test('SWAP: a stop sent by a replacing supervisor under another package root never persists a user disable', async t => {
  const f = fixture(t);
  const newRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-paseo-newroot-'));
  t.after(() => fs.rmSync(newRoot, { recursive: true, force: true }));
  f.packages([root]);                                   // the old supervisor starts while Pi still configures it
  f.write('host-registration', { enabled: true, packageRoot: root, cwd: f.loc.home });
  const entered = deferred(), release = deferred();
  f.runtime.activate = async () => { entered.resolve(); await release.promise; f.calls.push(['activate-finished']); };
  const supervising = f.load('src/supervisor.mjs').supervise();
  await entered.promise;
  f.packages([newRoot]);                                // plugin source swapped: Pi configures only the replacement
  f.write('host-registration', { enabled: true, packageRoot: newRoot, cwd: f.loc.home });
  f.signals.emit('SIGTERM');
  release.resolve();
  await supervising;
  assert.equal(f.calls.some(c => c[0] === 'deactivate'), false, 'old supervisor deactivated Paseo during a source swap');
});

// The SWAP case above drives the swap through a signal, so it only ever exercises the
// finally path. The loop reaches the same situation on its own -- Pi repins the plugin
// source while this supervisor is mid-activate -- and that path had no guard at all (#13).
test('LOOP-SWAP: a source swap the poll loop notices itself never persists a user disable', async t => {
  const f = fixture(t);
  const newRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-paseo-newroot-loop-'));
  t.after(() => fs.rmSync(newRoot, { recursive: true, force: true }));
  f.packages([root]);                                   // the old supervisor starts while Pi still configures it
  f.write('host-registration', { enabled: true, packageRoot: root, cwd: f.loc.home });
  const entered = deferred(), release = deferred();
  f.runtime.activate = async () => { entered.resolve(); await release.promise; f.calls.push(['activate-finished']); };
  const supervising = f.load('src/supervisor.mjs').supervise();
  await entered.promise;
  f.packages([newRoot]);                                // plugin source swapped: Pi configures only the replacement
  f.write('host-registration', { enabled: true, packageRoot: newRoot, cwd: f.loc.home });
  release.resolve();                                    // no signal: the loop itself has to notice
  await supervising;
  assert.equal(f.calls.some(c => c[0] === 'deactivate'), false, 'the poll loop deactivated Paseo during a source swap');
  assert.equal(f.calls.some(c => c[0] === 'activate-finished'), true, 'the in-flight activation was abandoned');
});

// The companion to LOOP-SWAP: leaving a superseded supervisor alone must not stop the loop
// from finishing a disable the host really did record.
test('LOOP-DISABLE: the poll loop still deactivates when the host recorded a real disable', async t => {
  const f = fixture(t);
  f.packages([root]);
  f.write('host-registration', { enabled: false, packageRoot: root, cwd: f.loc.home });
  await f.load('src/supervisor.mjs').supervise();
  assert.equal(f.calls.filter(c => c[0] === 'deactivate').length, 1, 'a recorded disable was not finished');
  assert.equal(f.calls.some(c => c[0] === 'activate'), false);
});

const timeouts=await import(pathToFileURL(path.join(root,'src/lifecycle-timeouts.mjs')).href);
test('first host stop waits through the full graceful daemon shutdown before reporting success',async t=>{
 const clock={now:Date.now()},f=fixture(t,{clock});f.packages([root]);const pid=f.owned();
 f.setSignalHandler((owner,signal)=>{assert.equal(signal,'SIGTERM');f.processes.get(owner).exitAt=clock.now+21000;});
 const start=clock.now,result=await f.load('src/host-api.mjs').lifecycle({action:'disable'});
 assert.equal(result.phase,'disabled');assert.equal(f.processes.has(pid),false);assert.ok(clock.now-start>=21000);
 assert.deepEqual(f.calls.filter(c=>c[0]==='signal'),[['signal',pid,'SIGTERM']]);
 assert.equal(f.calls.filter(c=>c[0]==='deactivate').length,1);
});
test('a plugin supervisor that stops the daemon and closes its terminals slowly is still waited for, up to the stop budget',async t=>{
 // The supervisor's own deactivate takes the daemon stop (up to 45 s) and then upstream's second terminal cleanup.
 const exit=timeouts.DAEMON_STOP_TIMEOUT_MS+timeouts.TERMINAL_CLEANUP_BUDGET_MS-1000;
 assert.ok(exit>timeouts.DAEMON_STOP_TIMEOUT_MS&&exit<timeouts.SUPERVISOR_STOP_TIMEOUT_MS);
 const clock={now:Date.now()},f=fixture(t,{clock});f.packages([root]);const pid=f.owned();
 f.setSignalHandler((owner,signal)=>{assert.equal(signal,'SIGTERM');f.processes.get(owner).exitAt=clock.now+exit;});
 const start=clock.now,result=await f.load('src/host-api.mjs').lifecycle({action:'disable'});
 assert.equal(result.phase,'disabled');assert.equal(f.processes.has(pid),false);assert.ok(clock.now-start>=exit&&clock.now-start<timeouts.SUPERVISOR_STOP_TIMEOUT_MS);
});
test('default supervisor shutdown remains bounded and never force-kills a process that does not exit',async t=>{
 const clock={now:Date.now()},f=fixture(t,{clock}),pid=f.owned();f.setSignalHandler(()=>{});
 const start=clock.now;await assert.rejects(f.load('src/supervisor.mjs').stopSupervisor(),/still stopping/);
 assert.equal(clock.now-start,timeouts.SUPERVISOR_STOP_TIMEOUT_MS);assert.equal(f.processes.has(pid),true);
 assert.deepEqual(f.calls.filter(c=>c[0]==='signal'),[['signal',pid,'SIGTERM']]);
});
// The supervisor stops the daemon itself when it ends for a disable (supervise()'s finally), and the host only waits
// for that process to end. Whether the stop worked is written down in supervisor-stop.json.
test('a disable whose supervisor failed to stop a daemon that is still running reports that, and does not stop it a second time',async t=>{
 const clock={now:Date.now()},f=fixture(t,{clock});f.packages([root]);f.owned();
 f.runtime.daemonRunning=async()=>{f.calls.push(['daemonRunning']);return true;};
 f.setSignalHandler((pid,signal)=>{assert.equal(signal,'SIGTERM');f.processes.delete(pid);f.write('supervisor-stop',{pid,ok:false,code:'STOP_NOT_CONFIRMED',at:new Date(clock.now+1).toISOString()});});
 const start=clock.now;
 await assert.rejects(f.load('src/host-api.mjs').lifecycle({action:'disable'}),error=>error.code==='STOP_NOT_CONFIRMED');
 assert.equal(f.calls.filter(c=>c[0]==='deactivate').length,0,'no second wait for the same daemon');
 assert.equal(f.calls.filter(c=>c[0]==='daemonRunning').length,1,'the daemon was looked at once');
 assert.ok(clock.now-start<timeouts.DAEMON_STOP_TIMEOUT_MS,'the failure is reported at once');
});
// The daemon stopped, and the supervisor's own stop then failed on something after it (upstream writes the closing
// records once the daemon is down: a full disk, permissions). Nothing is left to wait for: the host finishes the disable.
test('a disable whose supervisor failed after the daemon was already gone is finished by the host in one go',async t=>{
 const clock={now:Date.now()},f=fixture(t,{clock});f.packages([root]);f.owned();
 f.runtime.daemonRunning=async()=>{f.calls.push(['daemonRunning']);return false;};
 f.setSignalHandler((pid,signal)=>{assert.equal(signal,'SIGTERM');f.processes.delete(pid);f.write('supervisor-stop',{pid,ok:false,code:'OPERATION_FAILED',at:new Date(clock.now+1).toISOString()});});
 const start=clock.now,result=await f.load('src/host-api.mjs').lifecycle({action:'disable'});
 assert.equal(result.phase,'disabled');
 assert.equal(f.calls.filter(c=>c[0]==='deactivate').length,1,'the host\'s own deactivate finds no daemon and marks it disabled');
 assert.equal(f.calls.filter(c=>c[0]==='daemonRunning').length,1);
 assert.ok(clock.now-start<timeouts.DAEMON_STOP_TIMEOUT_MS,'and it does not wait');
});
test('the daemon is only looked at when the supervisor reported a failure',async t=>{
 const f=fixture(t);f.packages([root]);f.owned();
 f.runtime.daemonRunning=async()=>assert.fail('a supervisor that stopped the daemon needs no second look');
 assert.equal((await f.load('src/host-api.mjs').lifecycle({action:'disable'})).phase,'disabled');
 assert.equal(f.calls.filter(c=>c[0]==='deactivate').length,1);
});
for(const [name,record]of [
 ['the stop of another supervisor',(pid,clock)=>({pid:pid+1,ok:false,code:'STOP_NOT_CONFIRMED',at:new Date(clock.now+1).toISOString()})],
 ['an earlier stop of this supervisor\'s pid',(pid,clock)=>({pid,ok:false,code:'STOP_NOT_CONFIRMED',at:new Date(clock.now-60000).toISOString()})],
 ['a stop that worked',(pid,clock)=>({pid,ok:true,at:new Date(clock.now+1).toISOString()})],
 ['no record at all',()=>null],
])
test(`a disable is still finished by the host after ${name}`,async t=>{
 const clock={now:Date.now()},f=fixture(t,{clock});f.packages([root]);const pid=f.owned();
 if(record(pid,clock))f.write('supervisor-stop',record(pid,clock));
 const result=await f.load('src/host-api.mjs').lifecycle({action:'disable'});
 assert.equal(result.phase,'disabled');assert.equal(f.calls.filter(c=>c[0]==='deactivate').length,1);
});
for(const [name,failure,expected]of [
 ['worked',null,{ok:true}],
 ['failed with one of upstream\'s codes',Object.assign(new Error('private detail'),{code:'STOP_NOT_CONFIRMED'}),{ok:false,code:'STOP_NOT_CONFIRMED'}],
 ['failed without a code',new Error('private detail'),{ok:false,code:'OPERATION_FAILED'}],
])
test(`a supervisor that ends for a disable writes down that stopping the daemon ${name}`,async t=>{
 const f=fixture(t);f.packages([root]);f.write('host-registration',{enabled:true,packageRoot:root,cwd:f.loc.home});
 const entered=deferred(),release=deferred();
 f.runtime.activate=async()=>{entered.resolve();await release.promise;};
 f.runtime.deactivate=async()=>{f.calls.push(['deactivate']);if(failure)throw failure;return {};};
 const supervising=f.load('src/supervisor.mjs').supervise();
 await entered.promise;
 f.write('host-registration',{enabled:false,packageRoot:root,cwd:f.loc.home}); // the host's disable, recorded before it signals
 f.signals.emit('SIGTERM');release.resolve();
 if(failure)await assert.rejects(supervising,error=>error===failure);else await supervising;
 const record=JSON.parse(fs.readFileSync(path.join(f.loc.stateDir,'supervisor-stop.json'),'utf8'));
 assert.equal(record.pid,4000);assert.equal(record.ok,expected.ok);assert.equal(record.code,expected.code);assert.match(record.at,/^\d{4}-\d\d-\d\dT/);
 assert.doesNotMatch(JSON.stringify(record),/private detail/);assert.equal(f.calls.filter(c=>c[0]==='deactivate').length,1);
});
// A delete of old releases that an activation started runs in the supervisor's process, in the background. A stop must not
// share the disk with it, and a supervisor that ends must not stay alive until it is done (bin/cli.mjs calls process.exit
// only when `supervise` returns; one that throws would otherwise wait for the deletion).
test('a supervisor that is asked to stop ends the deletion of old releases at the signal, before it stops the daemon',async t=>{
 const f=fixture(t);f.packages([root]);f.write('host-registration',{enabled:true,packageRoot:root,cwd:f.loc.home});
 const entered=deferred(),release=deferred();
 f.runtime.activate=async()=>{entered.resolve();await release.promise;};
 f.runtime.abortPruning=()=>{f.calls.push(['abortPruning']);};
 const supervising=f.load('src/supervisor.mjs').supervise();
 await entered.promise;
 f.write('host-registration',{enabled:false,packageRoot:root,cwd:f.loc.home});
 f.signals.emit('SIGTERM');
 assert.deepEqual(f.calls.map(c=>c[0]),['abortPruning'],'at the signal itself, while an activation is still running');
 release.resolve();await supervising;
 const order=f.calls.map(c=>c[0]);
 assert.equal(order.filter(name=>name==='deactivate').length,1);assert.ok(order.lastIndexOf('abortPruning')<order.indexOf('deactivate'),'and again before the daemon is stopped: '+order);
});
for(const [name,failure] of [['finishes','none'],['fails',new Error('the stop failed')]])
test(`a supervisor that ends because it is disabled has ended the deletion of old releases when its stop of the daemon ${name}`,async t=>{
 const f=fixture(t);f.packages([root]);f.write('host-registration',{enabled:false,packageRoot:root,cwd:f.loc.home});
 f.runtime.abortPruning=()=>{f.calls.push(['abortPruning']);};
 f.runtime.deactivate=async()=>{f.calls.push(['deactivate']);if(failure!=='none')throw failure;return {};};
 if(failure==='none')await f.load('src/supervisor.mjs').supervise();else await assert.rejects(f.load('src/supervisor.mjs').supervise(),error=>error===failure);
 const order=f.calls.map(c=>c[0]);
 assert.deepEqual(order,['deactivate','abortPruning'],'the supervisor stops its own work however it ends: '+order);
});
test('a stop that completed with an unconfirmed terminal cleanup says so next to the disabled phase',async t=>{
 const f=fixture(t);f.packages([root]);f.owned();
 f.runtime.deactivate=async()=>{f.calls.push(['deactivate']);return {warnings:[{code:'TERMINAL_CLEANUP_NOT_CONFIRMED',at:'2026-11-25T00:00:00.000Z'}]};};
 // host-api.mjs runs in its own vm realm: compare by value.
 assert.deepEqual(JSON.parse(JSON.stringify(await f.load('src/host-api.mjs').lifecycle({action:'disable'}))),{phase:'disabled',warnings:['TERMINAL_CLEANUP_NOT_CONFIRMED']});
 f.runtime.deactivate=async()=>{f.calls.push(['deactivate']);return {warnings:[]};};
 assert.deepEqual(JSON.parse(JSON.stringify(await f.load('src/host-api.mjs').lifecycle({action:'disable'}))),{phase:'disabled'});
});

test('host status opens each target\'s official app and reports no bundled web client', async t => {
  const f = fixture(t);
  const host = f.load('src/host-api.mjs');
  for (const [target, url] of [[undefined, 'https://app.paseo.sh/'], ['paseo', 'https://app.paseo.sh/'], ['woowtech', 'https://smart.woowtech.io/'], ['apporo', 'https://smart.apporo.ai/']]) {
    if (target) f.write('preferences', { target });
    const status = await host.status();
    assert.equal(status.openUrl, url, String(target));
    assert.equal('webClient' in status, false);
    assert.equal(typeof host.web, 'undefined');
  }
});

// An in-place upgrade keeps the package root. The supervisor still runs the code it started with, and
// would start that version's own managed release when the daemon exits.
const PLUGIN_VERSION = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
function supervisorRecord(f) { return JSON.parse(fs.readFileSync(path.join(f.loc.stateDir, 'supervisor.json'), 'utf8')); }
for (const recorded of [undefined, '0.1.23'])
test(`restore replaces a same-root supervisor recorded ${recorded ? 'as ' + recorded : 'without a version (0.1.23 and earlier)'}`, async t => {
  const f = fixture(t);
  f.packages([root]);
  f.write('host-registration', { enabled: true, packageRoot: root, cwd: f.loc.home });
  const old = f.owned();
  if (recorded) f.write('supervisor', { ...supervisorRecord(f), version: recorded });
  assert.equal((await f.load('src/host-api.mjs').restore()).phase, 'starting');
  assert.deepEqual(f.calls.filter(c => c[0] === 'signal'), [['signal', old, 'SIGTERM']]);
  assert.equal(f.processes.has(old), false);
  const record = supervisorRecord(f);
  assert.equal(record.version, PLUGIN_VERSION); assert.notEqual(record.pid, old); assert.equal(f.processes.has(record.pid), true);
  assert.equal(f.calls.some(c => c[0] === 'deactivate'), false, 'replacing the supervisor is not a user disable');
});

test('restore keeps a same-root supervisor of this version, and never signals a recorded PID it cannot verify', async t => {
  const f = fixture(t);
  f.packages([root]);
  f.write('host-registration', { enabled: true, packageRoot: root, cwd: f.loc.home });
  const current = f.owned();
  f.write('supervisor', { ...supervisorRecord(f), version: PLUGIN_VERSION });
  const supervisor = f.load('src/supervisor.mjs');
  const kept = await supervisor.startSupervisor();
  assert.equal(kept.running, true); assert.equal(kept.pid, current);
  assert.equal(f.calls.some(c => c[0] === 'signal' || c[0] === 'spawn'), false);
  // A version-less record whose PID now belongs to another process: not ours to stop, so only a new one starts.
  const reused = f.owned({ identity: 'reused', recordedIdentity: 'original' });
  const started = await supervisor.startSupervisor();
  assert.equal(f.calls.some(c => c[0] === 'signal'), false);
  assert.equal(f.processes.has(reused), true); assert.notEqual(started.pid, reused);
  assert.equal(supervisorRecord(f).version, PLUGIN_VERSION);
});

test('#29: a 0.11.2-era host that never enabled Paseo stays off through the upgrade boot until an explicit enable', async t => {
  const f = fixture(t);
  f.packages([root]);
  // What Agent Connect 0.1.15 leaves on a host whose owner never turned Paseo on.
  f.write('host-registration', { enabled: true, packageRoot: root, cwd: f.loc.home });
  f.write('state', { version: 1, phase: 'disabled', desiredEnabled: false, installedVersion: '0.11.2' });
  const supervisor = f.load('src/supervisor.mjs');
  assert.equal(supervisor.packageEnabled(f.loc), false, 'a supervisor that starts first reads the off');
  const result = await postinstallCli(f);
  assert.equal(result.errors, '');
  assert.equal(JSON.parse(result.output).lifecycle.phase, 'disabled');
  assert.equal(f.calls.some(row => row[0] === 'activate' || row[0] === 'spawn'), false, 'nothing switched Paseo on');
  const carried = JSON.parse(fs.readFileSync(path.join(f.loc.stateDir, 'host-registration.json')));
  assert.deepEqual([carried.enabled, carried.legacyOffResolved], [false, true], 'the off now lives in the registration');
  const host = f.load('src/host-api.mjs');
  const enabled = await host.lifecycle({ action: 'enable', packages: enabledPackages });
  assert.equal(enabled.phase, 'starting');
  assert.equal(f.calls.filter(row => row[0] === 'spawn').length, 1);
  const registration = JSON.parse(fs.readFileSync(path.join(f.loc.stateDir, 'host-registration.json')));
  assert.deepEqual([registration.enabled, registration.legacyOffResolved], [true, true], 'an explicit enable replaces the legacy off');
  assert.equal(supervisor.packageEnabled(f.loc), true, 'so the supervisor it started keeps running before activation updates the state');
});

test('#29: an enabled 0.11.2-era host, and an off recorded by a newer release, start on boot as before', async t => {
  for (const state of [
    { version: 1, phase: 'running', desiredEnabled: true, installedVersion: '0.11.2' },
    { version: 1, phase: 'disabled', desiredEnabled: false, installedVersion: '0.17.5' },
  ]) {
    const f = fixture(t);
    f.packages([root]);
    f.write('host-registration', { enabled: true, packageRoot: root, cwd: f.loc.home });
    f.write('state', state);
    const result = await postinstallCli(f);
    assert.equal(result.errors, '', JSON.stringify(state));
    assert.equal(f.calls.filter(row => row[0] === 'activate').length, 1, JSON.stringify(state));
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.loc.stateDir, 'host-registration.json'))).enabled, true, JSON.stringify(state));
  }
});

test('#29: an explicit enable on a 0.11.2-era host that never booted this release starts it and resolves the old off', async t => {
  const f = fixture(t);
  f.packages([root]);
  f.write('host-registration', { enabled: true, packageRoot: root, cwd: f.loc.home });
  f.write('state', { version: 1, phase: 'disabled', desiredEnabled: false, installedVersion: '0.11.2' });
  const host = f.load('src/host-api.mjs');
  const enabled = await host.lifecycle({ action: 'enable', packages: enabledPackages });
  assert.equal(enabled.phase, 'starting');
  assert.equal(f.calls.filter(row => row[0] === 'spawn').length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.loc.stateDir, 'host-registration.json'))).legacyOffResolved, true);
  assert.equal(f.load('src/supervisor.mjs').packageEnabled(f.loc), true);
  // A later boot keeps the resolution: the old state no longer decides anything.
  await host.restore();
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.loc.stateDir, 'host-registration.json'))).enabled, true);
});
