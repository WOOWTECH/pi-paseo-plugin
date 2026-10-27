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

function fixture(t) {
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
    activate: async () => { calls.push(['activate']); return {}; },
    deactivate: async () => { calls.push(['deactivate']); return {}; },
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
    vm.runInNewContext(`(function(require,module,exports){${code}\n})`, { process: fakeProcess, URL, setTimeout: (fn, ms) => setTimeout(fn, ms >= 15000 ? 1 : ms), clearTimeout, console }, { filename: absolute })(localRequire, module, module.exports);
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

test('supervisor rechecks shutdown after status and does not activate or create onboarding', async t => {
  const f = fixture(t);
  f.packages([root]);
  const entered = deferred(), release = deferred();
  f.runtime.status = async () => { entered.resolve(); return release.promise; };
  const supervising = f.load('src/supervisor.mjs').supervise({ fallbackOnboarding: true });
  await entered.promise;
  f.signals.emit('SIGTERM');
  release.resolve({ daemon: { running: false } });
  await supervising;
  assert.equal(f.calls.some(c => c[0] === 'activate'), false);
  assert.equal(fs.existsSync(path.join(f.loc.stateDir, 'onboarding.json')), false);
  assert.equal(f.signals.listenerCount('SIGTERM'), 0);
  assert.equal(f.signals.listenerCount('SIGINT'), 0);
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
  f.signals.emit('SIGTERM');
  assert.equal(f.calls.some(c => c[0] === 'deactivate'), false);
  release.resolve();
  await supervising;
  assert.deepEqual(f.calls.map(c => c[0]), ['activate-finished', 'deactivate']);
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
