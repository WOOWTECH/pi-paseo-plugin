import {seedPidFiles} from './helpers/runtime-pid-files.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { privateDirectory, RuntimeError } from '../src/state.mjs';
import { PROVIDER_PACKAGES, providersPrefix, resolveProviderLaunchers, configureProviders } from '../src/provider-launchers.mjs';
import {singleFlight,createReadWindow} from '../src/single-flight.mjs';
import * as runtimeLayout from '../src/runtime-layout.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-paseo-launchers-'));
  const loc = { home: path.join(dir, 'home'), agentDir: path.join(dir, 'agent') };
  const mount = path.join(dir, 'mounted'); fs.mkdirSync(mount, { recursive: true });
  const env = { PATH: mount, HOME: loc.home, CODEX_HOME: path.join(dir, 'codex-account'), PI_AGENT_DATA_DIR: path.join(dir, 'pi-account') };
  const commands = new Map(), versions = new Map(), failures = new Map(), calls = [];
  const prefix = path.join(loc.home, '.local/share/pi-paseo/providers');
  let installFailure, installedVersion;
  function launcher(file, version) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'fixture launcher', { mode: 0o755 }); versions.set(file, version); return file;
  }
  function mounted(provider, version = PROVIDER_PACKAGES[provider].version) {
    const command = launcher(path.join(mount, provider), version); commands.set(provider, command); return command;
  }
  const npm = path.join(mount, 'npm'); commands.set('npm', npm);
  function discover(name) {
    if (commands.has(name)) return commands.get(name);
    if (path.isAbsolute(name) && fs.existsSync(name)) return name;
    return null;
  }
  async function run(command, args, options) {
    calls.push({ command, args, options });
    assert.equal(options.env.HOME, loc.home);
    assert.equal(options.env.PI_CODING_AGENT_DIR, loc.agentDir);
    assert.equal(options.env.CODEX_HOME, env.CODEX_HOME);
    assert.equal(options.env.PI_AGENT_DATA_DIR, env.PI_AGENT_DATA_DIR);
    if (command === npm) {
      assert.equal(args[0], 'install');
      if (installFailure) throw installFailure;
      const provider = Object.keys(PROVIDER_PACKAGES).find(p => args.includes(PROVIDER_PACKAGES[p].name + '@' + PROVIDER_PACKAGES[p].version));
      assert.ok(provider, 'install must use one of the three fixed package versions');
      launcher(path.join(prefix, 'node_modules/.bin', provider), installedVersion || PROVIDER_PACKAGES[provider].version);
      return 'private installer output';
    }
    assert.deepEqual(args, ['--version']);
    if (failures.has(command)) throw failures.get(command);
    assert.ok(versions.has(command), 'only fixture launchers may be probed');
    return `fixture-cli ${versions.get(command)}\n`;
  }
  const resolve = options => resolveProviderLaunchers(loc, { env, discover, run, ...options });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { loc, env, commands, versions, failures, calls, prefix, npm, mounted, launcher, resolve, run, discover,
    failInstall(error) { installFailure = error; }, installVersion(version) { installedVersion = version; } };
}

test('valid mounted commands stay in place without any private installation or version replacement', async t => {
  const f = fixture(t);
  const mounted = { claude: f.mounted('claude', '2.1.111'), codex: f.mounted('codex', '0.161.0'), pi: f.mounted('pi') };
  const launchers = await f.resolve({ installMissing: true });
  for (const provider of Object.keys(mounted)) {
    assert.equal(launchers[provider].command, mounted[provider]);
    assert.equal(launchers[provider].startup, 'ready');
    assert.equal(fs.readFileSync(mounted[provider], 'utf8'), 'fixture launcher');
  }
  assert.equal(f.calls.some(c => c.command === f.npm), false);
  assert.equal(fs.existsSync(f.prefix), false);
});

test('only missing Claude and Codex install into the private prefix using fixed official packages', async t => {
  const f = fixture(t); const pi = f.mounted('pi');
  f.env.PI_WEB_PASSWORD='web-password-sentinel';
  const launchers = await f.resolve({ installMissing: true });
  const installs = f.calls.filter(c => c.command === f.npm);
  assert.equal(installs.length, 2);
  for (const [index, provider] of ['claude', 'codex'].entries()) {
    assert.ok(installs[index].args.includes(PROVIDER_PACKAGES[provider].name + '@' + PROVIDER_PACKAGES[provider].version));
    assert.equal(installs[index].args[installs[index].args.indexOf('--prefix') + 1], f.prefix);
    assert.ok(installs[index].args.includes('--registry=https://registry.npmjs.org'));
    assert.ok(installs[index].args.includes('--include=optional'));
    assert.equal(installs[index].args.includes('-g'), false);
    assert.equal(launchers[provider].command, path.join(f.prefix, 'node_modules/.bin', provider));
    assert.equal(launchers[provider].version, PROVIDER_PACKAGES[provider].version);
    assert.equal(launchers[provider].startup, 'ready');
  }
  assert.equal(launchers.pi.command, pi);
  assert.equal(fs.statSync(f.prefix).mode & 0o777, 0o700);
  assert.equal(providersPrefix(f.loc), f.prefix);
  const before = installs.length;
  await f.resolve({ installMissing: true });
  assert.equal(f.calls.filter(c => c.command === f.npm).length, before, 'valid private binaries must be reused after restart');
});

test('missing Pi installs the pinned package without altering mounted Claude or Codex', async t => {
  const f = fixture(t); f.mounted('claude'); f.mounted('codex');
  const launchers = await f.resolve({ installMissing: true });
  const installs = f.calls.filter(c => c.command === f.npm);
  assert.equal(installs.length, 1);
  assert.ok(installs[0].args.includes('@earendil-works/pi-coding-agent@1.0.0'));
  assert.equal(launchers.pi.startup, 'ready');
  assert.equal(launchers.pi.command, path.join(f.prefix, 'node_modules/.bin/pi'));
});

test('a broken mounted launcher is reported safely and never replaced with an npm copy', async t => {
  const f = fixture(t); const claude = f.mounted('claude'); f.mounted('codex'); f.mounted('pi');
  f.failures.set(claude, Object.assign(new Error('PRIVATE_SUBPROCESS_OUTPUT'), { code: 'COMMAND_FAILED', stderr: 'PRIVATE_SUBPROCESS_OUTPUT' }));
  const launchers = await f.resolve({ installMissing: true });
  assert.equal(launchers.claude.command, claude);
  assert.equal(launchers.claude.startup, 'COMMAND_FAILED');
  assert.equal(launchers.claude.version, null);
  assert.equal(f.calls.some(c => c.command === f.npm), false);
  assert.equal(JSON.stringify(launchers).includes('PRIVATE_SUBPROCESS_OUTPUT'), false);
});

test('invalid mounted version output also prevents a silent private replacement', async t => {
  const f = fixture(t); f.mounted('claude', 'PRIVATE_OUTPUT_WITH_NO_VERSION'); f.mounted('codex'); f.mounted('pi');
  const launchers = await f.resolve({ installMissing: true });
  assert.equal(launchers.claude.startup, 'invalid');
  assert.equal(f.calls.some(c => c.command === f.npm), false);
  assert.equal(JSON.stringify(launchers).includes('PRIVATE_OUTPUT'), false);
});

test('diagnostic discovery never installs missing CLIs or creates a private prefix', async t => {
  const f = fixture(t); f.mounted('pi');
  const launchers = await f.resolve();
  assert.equal(launchers.claude.startup, 'missing');
  assert.equal(launchers.codex.startup, 'missing');
  assert.equal(f.calls.some(c => c.command === f.npm), false);
  assert.equal(fs.existsSync(f.prefix), false);
});

test('offline installation failure reports a fixed category without npm output or arbitrary error codes', async t => {
  const f = fixture(t); f.mounted('codex'); f.mounted('pi');
  f.failInstall(Object.assign(new Error('PRIVATE_NPM_AUTH_OUTPUT'), { code: 'PRIVATE_NPM_AUTH_CODE', stdout: 'PRIVATE_NPM_AUTH_OUTPUT', stderr: 'PRIVATE_NPM_AUTH_OUTPUT' }));
  const launchers = await f.resolve({ installMissing: true });
  assert.equal(launchers.claude.startup, 'PROVIDER_INSTALL_FAILED');
  assert.equal(launchers.claude.command, null);
  assert.equal(f.calls.filter(c => c.command === f.npm).length, 1);
  assert.equal(JSON.stringify(launchers).includes('PRIVATE_NPM_AUTH'), false);
});

test('unavailable npm reports an installation blocker without running another command', async t => {
  const f = fixture(t); f.commands.delete('npm'); f.mounted('codex'); f.mounted('pi');
  const launchers = await f.resolve({ installMissing: true });
  assert.equal(launchers.claude.startup, 'NPM_UNAVAILABLE');
  assert.equal(f.calls.some(c => c.command === f.npm), false);
  assert.equal(fs.existsSync(f.prefix), false);
});

test('an installed CLI must report the requested fixed version before becoming ready', async t => {
  const f = fixture(t); f.mounted('codex'); f.mounted('pi'); f.installVersion('9.9.9');
  const launchers = await f.resolve({ installMissing: true });
  assert.equal(launchers.claude.startup, 'PROVIDER_VERSION_MISMATCH');
  assert.equal(launchers.claude.version, '9.9.9');
});

test('non-executable files and dangling mounted symlinks are broken launchers, not absent CLIs', async t => {
  for (const dangling of [false, true]) {
    const f = fixture(t); const claude = path.join(f.env.PATH, 'claude');
    if (dangling) fs.symlinkSync(path.join(f.env.PATH, 'missing-target'), claude);
    else fs.writeFileSync(claude, 'mounted but not executable', { mode: 0o600 });
    const launchers = await f.resolve({ discover: undefined, installMissing: true, run: async (command, args) => {
      assert.equal(command, claude); assert.deepEqual(args, ['--version']);
      throw Object.assign(new Error('PRIVATE_LAUNCH_OUTPUT'), { code: 'COMMAND_UNAVAILABLE' });
    } });
    assert.equal(launchers.claude.command, claude);
    assert.equal(launchers.claude.startup, 'COMMAND_UNAVAILABLE');
    assert.equal(fs.lstatSync(claude).isSymbolicLink(), dangling);
    assert.equal(fs.existsSync(f.prefix), false);
  }
});

test('Paseo provider configuration binds absolute binaries and reuses account directories', async t => {
  const f = fixture(t); const claude = f.mounted('claude'); f.mounted('pi');
  const launchers = await f.resolve();
  const configured = configureProviders({ claude: { command: ['old-command'], custom: 'keep', env: { CUSTOM_SETTING: 'keep' } } }, launchers, f.loc, f.env);
  assert.deepEqual(configured.claude.command, [claude]);
  assert.equal(configured.claude.custom, 'keep');
  assert.equal(configured.claude.env.CUSTOM_SETTING, 'keep');
  for (const provider of ['claude', 'pi']) {
    assert.equal(path.isAbsolute(configured[provider].command[0]), true);
    assert.equal(configured[provider].env.HOME, f.loc.home);
    assert.equal(configured[provider].env.PI_CODING_AGENT_DIR, f.loc.agentDir);
    assert.equal(configured[provider].env.PI_AGENT_DATA_DIR, f.env.PI_AGENT_DATA_DIR);
  }
  assert.equal(configured.codex.enabled, false);
});


test('runtime applies new private commands with the official reload API and reports RESTART_REQUIRED safely', async t => {
  const f = fixture(t); const pi = f.mounted('pi');
  f.env.PI_WEB_PASSWORD='web-password-sentinel';
  Object.assign(f.loc, { stateDir: path.join(f.loc.home, 'state'), runtimeDir: path.join(f.loc.home, 'runtime'), port: 6769 });
  f.loc.paseoHome = path.join(f.loc.stateDir, 'daemon');
  fs.mkdirSync(f.loc.paseoHome, { recursive: true });
  const cliRoot = path.join(runtimeLayout.runtimeDirectory(f.loc), 'node_modules/@getpaseo/cli');
  const ui = path.join(runtimeLayout.runtimeDirectory(f.loc), 'node_modules/@getpaseo/server/dist/server/web-ui/index.html');
  fs.mkdirSync(cliRoot, { recursive: true }); fs.mkdirSync(path.dirname(ui), { recursive: true });
  fs.writeFileSync(path.join(cliRoot, 'package.json'), JSON.stringify({ version: '0.11.2' })); fs.writeFileSync(ui, 'fixture UI');
  seedPidFiles(f.loc);runtimeLayout.markRuntimeReady(f.loc);
  let state = { installationId: 'owned-fixture', desiredEnabled: true, phase: 'running' };
  fs.writeFileSync(path.join(f.loc.paseoHome, '.pi-paseo-owner.json'), JSON.stringify({ installationId: state.installationId, home: f.loc.paseoHome }));
  const configFile = path.join(f.loc.paseoHome, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ agents: { providers: { pi: { env: { CUSTOM_SETTING: 'keep' } } } } }));
  const flags = [], runtimeCommands = [];
  const instance = { pid: 5000, uid: 1234, startedAt: 'fixture-start', listen: '127.0.0.1:6769' };
  let reloadResult = { appliedPaths: ['agents.providers'], restartRequiredPaths: [], overrideControlledPaths: [] }, reloadFailure, reloadCalls = 0;
  let liveProviders = [];
  const client = {
    getDaemonStatus: async () => ({ pid: 5001, providers: liveProviders, relay: { enabled: true } }),
    getProvidersSnapshot: async () => ({ entries: liveProviders }), close: async () => {},
    reloadDaemonConfig: async () => {
      reloadCalls++;
      if (reloadFailure) throw reloadFailure;
      if (reloadResult.appliedPaths.includes('agents.providers')) {
        const saved = JSON.parse(fs.readFileSync(configFile, 'utf8'));
        liveProviders = Object.entries(saved.agents.providers).map(([provider, cfg]) => ({ provider, available: cfg.enabled, enabled: cfg.enabled }));
      }
      return reloadResult;
    },
  };
  const sourceFile = fileURLToPath(new URL('../src/runtime.mjs', import.meta.url));
  const code = ts.transpileModule(fs.readFileSync(sourceFile, 'utf8'), { fileName: sourceFile + '.ts', compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const module = { exports: {} }, require = createRequire(import.meta.url);
  const localRequire = spec => {
    if (spec === './state.mjs') return {
      locations: () => f.loc, readState: () => state, updateState: patch => (state = { ...state, ...patch, updatedAt:String(Number(state.updatedAt||0)+1) }),
      privateDirectory, RuntimeError, withRuntimeLock: fn => fn(), processIdentity: pid => pid === instance.pid ? 'fixture-process' : null,
    };
    if (spec === './process.mjs') return {
      findExecutable: f.discover,
      runProcess: async (command, args, options) => {
        runtimeCommands.push({ command, args });
        // This fixture has a running daemon. Only the installed Paseo version check is allowed.
        assert.equal(command, '/fixture/node');
        assert.deepEqual(Array.from(args), [path.join(cliRoot, 'bin/paseo'), '--version']);
        assert.equal(options.env.HOME, f.loc.home);
        assert.equal(options.env.PI_WEB_PASSWORD,undefined);
        return '0.11.2';
      },
    };
    if (spec === './provider-launchers.mjs') return {
      configureProviders,
      resolveProviderLaunchers: (loc, options) => { flags.push(options.installMissing); return resolveProviderLaunchers(loc, { ...options, discover: f.discover, run: f.run }); },
    };
    if (spec === './provider-reply.mjs') return { providerReplyError: () => assert.fail('no provider conversations') };
    if (spec === './chat-result.mjs') return {};
    if (spec === './single-flight.mjs') return {singleFlight,daemonStatusWindow:createReadWindow()};
    if (spec === './runtime-layout.mjs') return runtimeLayout;
    // This test models a non-Linux provider reload; Linux birth/transition
    // behavior is exercised with the actual identity module in daemon-identity.
    if (spec === './daemon-identity.mjs') return { observeOwnedInstance: async () => null, rememberOwnedInstance: async () => {}, recoverStaleInstance: () => assert.fail('no recovery on healthy provider reload') };
    if (spec === './web-client.mjs') return { ensureWebClient: async () => {} };
    if (spec === './acceptance-agent.mjs' || spec === './acceptance-workspace.mjs') return {};
    if (spec.endsWith('/daemon-instance.js')) return { readDaemonInstance: async () => instance, stopDaemonInstance: () => assert.fail('no daemon stop') };
    if (spec.endsWith('/dist/utils/client.js')) return { connectToDaemon: async () => client };
    if (spec.endsWith('/config.js')) return { savePersistedConfig: (_home, config) => fs.writeFileSync(configFile, JSON.stringify(config)) };
    if (spec === 'node:net') return { createServer: () => assert.fail('no live sockets') };
    return require(spec);
  };
  const fakeProcess = { env: f.env, execPath: '/fixture/node', platform: 'fixture', getuid: () => 1234, versions: process.versions };
  vm.runInNewContext(`(function(require,module,exports){${code}\n})`, { process: fakeProcess, setTimeout, clearTimeout }, { filename: sourceFile })(localRequire, module, module.exports);
  const runtime = module.exports;
  const diagnostic = await runtime.diagnose();
  assert.equal(diagnostic.providers.find(p => p.provider === 'claude').launcher.startup, 'missing');
  assert.equal(f.calls.some(c => c.command === f.npm), false);
  assert.equal(fs.existsSync(f.prefix), false);
  assert.equal((await runtime.activate()).daemon.running, true);
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.deepEqual(flags, [false, true]);
  assert.equal(f.calls.filter(c => c.command === f.npm).length, 2);
  assert.deepEqual(config.agents.providers.claude.command, [path.join(f.prefix, 'node_modules/.bin/claude')]);
  assert.deepEqual(config.agents.providers.codex.command, [path.join(f.prefix, 'node_modules/.bin/codex')]);
  assert.deepEqual(config.agents.providers.pi.command, [pi]);
  assert.equal(config.agents.providers.pi.env.CUSTOM_SETTING, 'keep');
  assert.equal(config.agents.providers.claude.env.HOME, f.loc.home);
  assert.equal(fs.statSync(configFile).mode & 0o777, 0o600);
  assert.equal(state.providerLaunchers.claude.startup, 'ready');
  assert.equal(runtimeCommands.length, 1);
  assert.equal(reloadCalls, 1);
  assert.equal((await runtime.status()).providers.find(p => p.provider === 'claude').status, 'ready');
  assert.equal(state.providerReloadPending, null);
  // Empty appliedPaths is valid once this daemon has already applied the commands.
  reloadResult = { appliedPaths: [], restartRequiredPaths: [], overrideControlledPaths: [] };
  await runtime.activate();
  assert.equal(state.phase, 'running');
  // Missing SDK support, explicit restart requirements, provider overrides, and unknown
  // receipts cannot turn a persisted config update into false activation success.
  for (const mode of ['unsupported', 'restart', 'override', 'missing-receipt']) {
    if (mode === 'unsupported') delete client.reloadDaemonConfig;
    else {
      client.reloadDaemonConfig = async () => {
        reloadCalls++;
        return mode === 'restart' ? { appliedPaths: [], restartRequiredPaths: ['daemon.listen'], overrideControlledPaths: [] }
          : mode === 'override' ? { appliedPaths: [], restartRequiredPaths: [], overrideControlledPaths: ['agents.providers'] } : null;
      };
    }
    await assert.rejects(runtime.activate(), error => error.code === 'RESTART_REQUIRED');
    assert.equal(state.phase, 'restart_required');
    assert.equal(state.lastError.code, 'RESTART_REQUIRED');
    assert.equal((await runtime.status()).diagnosticCode, 'RESTART_REQUIRED');
  }
  client.reloadDaemonConfig = async () => { throw new Error('PRIVATE_RELOAD_OUTPUT'); };
  await assert.rejects(runtime.activate(), error => error.code === 'RESTART_REQUIRED' && !JSON.stringify(error).includes('PRIVATE_RELOAD_OUTPUT'));
  // An empty receipt on the same daemon must not clear the outstanding command change.
  client.reloadDaemonConfig = async () => ({ appliedPaths: [], restartRequiredPaths: [], overrideControlledPaths: [] });
  await assert.rejects(runtime.activate(), error => error.code === 'RESTART_REQUIRED');
  // Normal daemon replacement loads the persisted commands and clears the old pending receipt.
  instance.pid++; instance.startedAt = 'fixture-restarted';
  await runtime.activate();
  assert.equal(state.providerReloadPending, null);
  assert.equal(state.phase, 'running');
  assert.equal(f.calls.filter(c => c.command === f.npm).length, 2);
});


test('an existing broken private launcher is retained and arbitrary probe errors stay private', async t => {
  const f = fixture(t); f.mounted('codex'); f.mounted('pi');
  const command = f.launcher(path.join(f.prefix, 'node_modules/.bin/claude'), '2.1.270');
  f.failures.set(command, Object.assign(new Error('PRIVATE_PROBE_OUTPUT'), { code: 'PRIVATE_PROBE_CODE', stderr: 'PRIVATE_PROBE_OUTPUT' }));
  const launchers = await f.resolve({ installMissing: true });
  assert.equal(launchers.claude.command, command);
  assert.equal(launchers.claude.startup, 'PROVIDER_LAUNCH_FAILED');
  assert.equal(f.calls.some(c => c.command === f.npm), false);
  assert.equal(JSON.stringify(launchers).includes('PRIVATE_PROBE'), false);
  assert.equal(fs.readFileSync(command, 'utf8'), 'fixture launcher');
});
