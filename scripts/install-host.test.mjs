import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { installHost, readAdapter, runCommand, PI_WEB_BASE, PI_WEB_REPOSITORY, PI_WEB_VERSION } from '../bin/install-host.mjs';

const sha = data => createHash('sha256').update(data).digest('hex');
function write(file, content, mode) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content, mode ? { mode } : undefined); }
function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  assert.equal(result.status, 0, 'fixture git command failed'); return result.stdout.trim();
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-paseo installer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), source = path.join(root, 'upstream'), pkg = path.join(root, 'plugin');
  fs.mkdirSync(home); fs.mkdirSync(source);
  write(path.join(source, '.gitignore'), 'node_modules/\n.next/\n');
  write(path.join(source, 'package.json'), JSON.stringify({ name: '@agegr/pi-web', version: PI_WEB_VERSION, bin: { 'pi-web': 'bin/pi-web.js' } }));
  write(path.join(source, 'package-lock.json'), '{"lockfileVersion":3}\n');
  write(path.join(source, 'bin/pi-web.js'), '#!/usr/bin/env node\nconsole.log(JSON.stringify({launcher:"adapter",args:process.argv.slice(2),home:process.env.HOME,providerDir:process.env.PI_CODING_AGENT_DIR}));\n', 0o755);
  write(path.join(source, 'adapter.txt'), 'base\n');
  git(source, 'init', '--quiet'); git(source, 'add', '.');
  git(source, '-c', 'user.name=Installer Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'base');
  const localBase = git(source, 'rev-parse', 'HEAD');
  write(path.join(source, 'adapter.txt'), 'paseo adapter\n');
  const patch = git(source, 'diff', '--binary') + '\n';
  git(source, 'checkout', '--', 'adapter.txt');
  const meta = { schemaVersion: 1, repository: PI_WEB_REPOSITORY, baseCommit: PI_WEB_BASE, piWebVersion: PI_WEB_VERSION, patchSha256: sha(patch) };
  write(path.join(pkg, 'host/adapter.patch'), patch);
  write(path.join(pkg, 'host/adapter-meta.json'), JSON.stringify(meta));
  const native = path.join(root, 'native/pi-web');
  write(native, '#!/usr/bin/env node\nconsole.log(JSON.stringify({launcher:"native",args:process.argv.slice(2)}));\n', 0o755);
  const calls = [];
  let failBuild = false, buildDelay = 0;
  const env = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: path.join(home, 'agent'), PI_AGENT_DATA_DIR: path.join(home, 'agent'), PATH: path.dirname(native) + path.delimiter + process.env.PATH };
  const runner = async (command, args, options = {}) => {
    calls.push({ command, args: [...args], cwd: options.cwd, nodeEnv: options.env?.NODE_ENV, production: options.env?.npm_config_production, home: options.env?.HOME, buildCpuTotal: options.env?.CIRCLE_NODE_TOTAL });
    if (command === 'npm') {
      if (args[0] === 'ci') write(path.join(options.cwd, 'node_modules/next/dist/bin/next'), '// fixture next\n');
      else {
        await delay(buildDelay);
        if (failBuild) throw new Error('fixture build failure');
        write(path.join(options.cwd, '.next/BUILD_ID'), 'fixture-production-build\n');
      }
      return '';
    }
    const adjusted = [...args];
    if (args[0] === 'fetch') {
      assert.equal(args.at(-1), PI_WEB_BASE);
      adjusted[adjusted.indexOf('origin')] = source; adjusted[adjusted.length - 1] = localBase;
    }
    if (args[0] === 'checkout' && args.at(-1) === PI_WEB_BASE) adjusted[adjusted.length - 1] = localBase;
    const output = await runCommand(command, adjusted, { ...options, env });
    if (args[0] === 'rev-parse' && args[1] === 'HEAD' && output === localBase) return PI_WEB_BASE;
    return output;
  };
  const options = { home, env, packageRoot: pkg, run: runner, sharedHostPath: path.join(home, 'absent/host.json') };
  const managed = path.join(home, '.local/share/pi-paseo');
  return { root, home, source, pkg, native, calls, meta, options, managed, setFailure(value) { failBuild = value; }, setDelay(value) { buildDelay = value; } };
}

test('metadata rejects wrong base, version, schema and patch hash before any command', async t => {
  const f = fixture(t);
  for (const change of [{ baseCommit: 'a'.repeat(40) }, { piWebVersion: '0.10.1' }, { schemaVersion: 2 }, { patchSha256: 'a'.repeat(64) }, { repository: 'https://example.invalid/pi-web' }]) {
    write(path.join(f.pkg, 'host/adapter-meta.json'), JSON.stringify({ ...f.meta, ...change }));
    await assert.rejects(installHost(f.options), { code: 'ADAPTER_METADATA_MISMATCH' });
  }
  assert.equal(f.calls.length, 0);
});

test('Paseo delegates to the installed Omnigent coordinator when both plugins are present', async t => {
  const f = fixture(t), omniRoot = path.join(f.root, 'omnigent');
  write(path.join(omniRoot, 'package.json'), JSON.stringify({ name: '@woowtech/pi-omnigent-plugin', version: '0.3.1' }));
  write(path.join(omniRoot, 'bin/install-ui.mjs'), 'export async function installUi(options) { return { delegated: true, home: options.home, packageRoot: options.packageRoot, overlayPackageRoot: options.overlayPackageRoot }; }\n');
  const result = await installHost({ ...f.options, omnigentPackageRoot: omniRoot });
  assert.equal(result.delegated, true);
  assert.equal(result.home, f.home);
  assert.equal(result.packageRoot, omniRoot);
  assert.equal(result.overlayPackageRoot, f.pkg);
  assert.equal(f.calls.length, 0);
});

test('Paseo refuses to delegate through a package with the wrong identity', async t => {
  const f = fixture(t), omniRoot = path.join(f.root, 'other-plugin');
  write(path.join(omniRoot, 'package.json'), JSON.stringify({ name: '@example/untrusted-plugin' }));
  await assert.rejects(installHost({ ...f.options, omnigentPackageRoot: omniRoot }), { code: 'OMNIGENT_COORDINATOR_INVALID' });
  assert.equal(f.calls.length, 0);
});

test('pinned fetch builds with dev dependencies; rerun reuses; wrapper preserves args, environment and fallback', async t => {
  const f = fixture(t), first = await installHost(f.options);
  assert.equal(first.restarted, false); assert.equal(first.restartRequired, true);
  assert.equal(first.pendingRestart, path.join(f.managed, 'pi-web/bin/pi-web.js'));
  assert.equal(first.pathUpdateRequired, true);
  assert.equal(first.launcherDirectory, path.join(f.home, '.local/bin'));
  assert.equal(first.routing.previousNative, f.native);
  assert.deepEqual(f.calls.find(c => c.args[0] === 'fetch').args, ['fetch', '--quiet', '--depth=1', 'origin', PI_WEB_BASE]);
  assert.deepEqual(f.calls.find(c => c.args[0] === 'remote').args, ['remote', 'add', 'origin', PI_WEB_REPOSITORY]);
  const ci = f.calls.find(c => c.command === 'npm' && c.args[0] === 'ci');
  assert.ok(ci.args.includes('--include=dev')); assert.equal(ci.nodeEnv, 'development'); assert.equal(ci.production, 'false');
  assert.equal(f.calls.find(c => c.command === 'npm' && c.args[0] === 'run').nodeEnv, 'production');
  assert.equal(f.calls.find(c => c.command === 'npm' && c.args[0] === 'run').buildCpuTotal, '3');
  assert.equal(fs.readFileSync(path.join(first.adapterRoot, 'adapter.txt'), 'utf8'), 'paseo adapter\n');
  const count = f.calls.length, next = await installHost(f.options);
  assert.equal(next.status, 'already-installed'); assert.equal(next.releaseRoot, first.releaseRoot);
  assert.equal(f.calls.slice(count).filter(c => c.command === 'npm' || c.args[0] === 'fetch').length, 0);
  const onPath = await installHost({ ...f.options, env: { ...f.options.env, PATH: first.launcherDirectory + path.delimiter + f.options.env.PATH } });
  assert.equal(onPath.pathUpdateRequired, false);
  const output = JSON.parse(await runCommand(process.execPath, [next.routing.launcher, '--port', '30141', 'argument with spaces'], { env: f.options.env }));
  assert.equal(output.launcher, 'adapter'); assert.deepEqual(output.args, ['--port', '30141', 'argument with spaces']);
  assert.equal(output.home, f.home); assert.equal(output.providerDir, f.options.env.PI_CODING_AGENT_DIR);
  fs.unlinkSync(first.adapterRoot);
  const fallback = JSON.parse(await runCommand(process.execPath, [next.routing.launcher, '--help'], { env: f.options.env }));
  assert.deepEqual(fallback, { launcher: 'native', args: ['--help'] });
});

test('shared-runtime updates only realWeb and its original backup; keeps user launcher bytes', async t => {
  const f = fixture(t), shim = path.join(f.home, '.local/bin/pi-web'), metadata = path.join(f.home, 'shared-runtime/host.json');
  const source = '#!/usr/bin/env node\n// omnigent -> shared-runtime\n';
  write(shim, source, 0o755);
  const old = { realWeb: f.native, shim, root: '/preserved/shared-runtime', installedAt: 'preserved', setting: { tools: ['existing-provider'] } };
  write(metadata, JSON.stringify(old), 0o640);
  const result = await installHost({ ...f.options, sharedHostPath: metadata });
  assert.equal(result.routing.status, 'shared-runtime');
  assert.deepEqual(JSON.parse(fs.readFileSync(metadata)), { ...old, realWeb: result.pendingRestart, realWebBeforePiPaseo: f.native });
  assert.equal(fs.readFileSync(shim, 'utf8'), source); assert.equal(fs.statSync(metadata).mode & 0o777, 0o640);
  await installHost({ ...f.options, sharedHostPath: metadata });
  assert.equal(JSON.parse(fs.readFileSync(metadata)).realWebBeforePiPaseo, f.native);
});

test('failed build retains previous release and routing; a retry completes cleanly', async t => {
  const f = fixture(t), first = await installHost(f.options), shim = fs.readFileSync(first.routing.launcher, 'utf8');
  // A changed adapter requires a fresh release while the old release remains usable.
  write(path.join(f.pkg, 'host/adapter.patch'), fs.readFileSync(path.join(f.pkg, 'host/adapter.patch'), 'utf8') + '\n');
  const meta = { ...f.meta, patchSha256: sha(fs.readFileSync(path.join(f.pkg, 'host/adapter.patch'))) };
  write(path.join(f.pkg, 'host/adapter-meta.json'), JSON.stringify(meta)); f.setFailure(true);
  await assert.rejects(installHost(f.options));
  assert.equal(fs.realpathSync(first.adapterRoot), first.releaseRoot);
  assert.equal(fs.readFileSync(first.routing.launcher, 'utf8'), shim);
  assert.equal(fs.readdirSync(path.join(f.managed, 'pi-web-releases')).filter(n => n.startsWith('.build-')).length, 0);
  f.setFailure(false); const next = await installHost(f.options);
  assert.notEqual(next.releaseRoot, first.releaseRoot); assert.ok(fs.existsSync(first.releaseRoot));
});

test('known Omnigent launcher chains through its metadata without replacing the launcher', async t => {
  const f = fixture(t), shim = path.join(f.home, '.local/bin/pi-web');
  const metadata = path.join(f.options.env.PI_CODING_AGENT_DIR, 'omnigent-plugin/host.json');
  const launcher = '#!/usr/bin/env node\n// pi-omnigent-plugin web launcher\n';
  write(shim, launcher, 0o755);
  const original = { version: 1, realWeb: f.native, shim, mode: 'path-wrapper', installedAt: 'preserved' };
  write(metadata, JSON.stringify(original));
  const result = await installHost(f.options);
  assert.equal(result.routing.status, 'omnigent');
  assert.deepEqual(JSON.parse(fs.readFileSync(metadata)), { ...original, realWeb: result.pendingRestart, realWebBeforePiPaseo: f.native });
  assert.equal(fs.readFileSync(shim, 'utf8'), launcher);
  await installHost(f.options);
  assert.equal(JSON.parse(fs.readFileSync(metadata)).realWebBeforePiPaseo, f.native);
});

test('unmatched Omnigent metadata leaves a foreign launcher intact', async t => {
  const f = fixture(t), shim = path.join(f.home, '.local/bin/pi-web');
  const metadata = path.join(f.options.env.PI_CODING_AGENT_DIR, 'omnigent-plugin/host.json');
  const launcher = '#!/bin/sh\nexec existing-web "$@"\n';
  write(shim, launcher, 0o755);
  const original = JSON.stringify({ version: 1, realWeb: f.native, shim, mode: 'path-wrapper' });
  write(metadata, original);
  const result = await installHost(f.options);
  assert.equal(result.routing.status, 'manual-routing-required');
  assert.equal(fs.readFileSync(shim, 'utf8'), launcher);
  assert.equal(fs.readFileSync(metadata, 'utf8'), original);
});

test('unknown existing launcher stays intact and reports a concrete manual route', async t => {
  const f = fixture(t), shim = path.join(f.home, '.local/bin/pi-web');
  const source = '#!/bin/sh\nexec /existing/wrapper "$@"\n'; write(shim, source, 0o755);
  const result = await installHost(f.options);
  assert.equal(result.routing.status, 'manual-routing-required'); assert.ok(fs.existsSync(result.pendingRestart));
  assert.equal(fs.readFileSync(shim, 'utf8'), source);
});

test('parallel installs serialize publication and build exactly once', async t => {
  const f = fixture(t); f.setDelay(150);
  const results = await Promise.all([installHost(f.options), installHost(f.options)]);
  assert.deepEqual(results.map(r => r.status).sort(), ['already-installed', 'installed']);
  assert.equal(f.calls.filter(c => c.command === 'npm' && c.args[0] === 'ci').length, 1);
  assert.equal(results[0].releaseRoot, results[1].releaseRoot);
});

test('explicit matching prebuiltRoot copies its build without fetch or npm', async t => {
  const f = fixture(t);
  git(f.source, 'apply', path.join(f.pkg, 'host/adapter.patch'));
  write(path.join(f.source, '.next/BUILD_ID'), 'existing-production-build\n');
  write(path.join(f.source, 'node_modules/next/dist/bin/next'), '// fixture next\n');
  const original = fs.readFileSync(path.join(f.source, 'adapter.txt'), 'utf8');
  const result = await installHost({ ...f.options, prebuiltRoot: f.source });
  assert.equal(f.calls.filter(c => c.command === 'npm' || c.args[0] === 'fetch').length, 0);
  assert.equal(fs.readFileSync(path.join(result.adapterRoot, '.next/BUILD_ID'), 'utf8'), 'existing-production-build\n');
  assert.equal(fs.readFileSync(path.join(f.source, 'adapter.txt'), 'utf8'), original);
  assert.equal(JSON.parse(fs.readFileSync(path.join(result.adapterRoot, '.pi-paseo-install.json'))).prebuilt, true);
});

test('prebuilt source drift fails before routing or publication', async t => {
  const f = fixture(t); git(f.source, 'apply', path.join(f.pkg, 'host/adapter.patch'));
  write(path.join(f.source, '.next/BUILD_ID'), 'existing-production-build\n');
  write(path.join(f.source, 'node_modules/next/dist/bin/next'), '// fixture next\n');
  write(path.join(f.source, 'bin/pi-web.js'), '// unrelated changes\n');
  await assert.rejects(installHost({ ...f.options, prebuiltRoot: f.source }), { code: 'PREBUILT_SOURCE_MISMATCH' });
  assert.equal(fs.existsSync(path.join(f.managed, 'pi-web')), false);
  assert.equal(fs.existsSync(path.join(f.home, '.local/bin/pi-web')), false);
});

test('unmanaged adapter directory and linked storage are preserved', async t => {
  const f = fixture(t);
  const destination = path.join(f.managed, 'pi-web'); write(path.join(destination, 'user-data'), 'keep');
  await assert.rejects(installHost(f.options), { code: 'UNMANAGED_ADAPTER_PATH' });
  assert.equal(fs.readFileSync(path.join(destination, 'user-data'), 'utf8'), 'keep');
  fs.rmSync(path.join(f.home, '.local'), { recursive: true });
  fs.symlinkSync(f.source, path.join(f.home, '.local'), 'dir');
  await assert.rejects(installHost(f.options), { code: 'UNSAFE_INSTALL_PATH' });
  assert.equal(f.calls.length, 0);
});

test('child failure never includes stderr or external credentials', async () => {
  await assert.rejects(runCommand(process.execPath, ['-e', 'process.stderr.write("credential-sentinel");process.exit(7)']), error => {
    assert.equal(error.code, 'COMMAND_FAILED'); assert.ok(!String(error).includes('credential-sentinel')); return true;
  });
});

async function boundedChild(t, source, options) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-paseo-child-'));
  const pids = path.join(root, 'pids');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let watchdog;
  const result = runCommand(process.execPath, ['-e', source, pids], {
    env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: root, PI_AGENT_DATA_DIR: root }, ...options,
  }).then(() => 'RESOLVED', error => error.code);
  try {
    const code = await Promise.race([result, new Promise(resolve => { watchdog = setTimeout(() => resolve('HUNG'), 1800); })]);
    if ((options.assertReaped ?? process.platform === 'linux') && code !== 'HUNG') {
      await delay(150);
      for (const pid of fs.readFileSync(pids, 'utf8').trim().split('\n').map(Number)) {
        let args = '';
        try { args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        assert.equal(args.split('\0').includes(pids), false, 'fixture subprocess is automatically terminated');
      }
    }
    return code;
  } finally {
    clearTimeout(watchdog);
    const children = fs.existsSync(pids) ? fs.readFileSync(pids, 'utf8').trim().split('\n').map(Number) : [];
    for (const pid of children) {
      try {
        if (process.platform === 'linux' && !fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').includes(pids)) continue;
        process.kill(pid, 'SIGKILL');
      } catch (error) { if (!['ESRCH', 'ENOENT'].includes(error.code)) throw error; }
    }
    await result;
    assert.equal(children.length, options.expectedProcesses ?? 1, 'fixture subprocesses reached their real call paths');
  }
}

test('timeout forcibly reaps a real subprocess that ignores SIGTERM', async t => {
  const code = await boundedChild(t, `require('fs').writeFileSync(process.argv[1], String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`, { timeoutMs: 300, killGraceMs: 80 });
  assert.equal(code, 'COMMAND_TIMEOUT');
});

test('timeout reaps descendants holding command output open after their parent exits', async t => {
  const descendant = `require('fs').appendFileSync(process.argv[1],String(process.pid)+'\\n');process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`;
  const code = await boundedChild(t, `const fs=require('fs');fs.writeFileSync(process.argv[1],String(process.pid)+'\\n');require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)},process.argv[1]],{stdio:['ignore',process.stdout,process.stderr]});setInterval(()=>{},1000)`, { timeoutMs: 300, killGraceMs: 80, expectedProcesses: 2 });
  assert.equal(code, 'COMMAND_TIMEOUT');
});

test('timeout also reaps descendants that close inherited output pipes', async t => {
  const descendant = `require('fs').appendFileSync(process.argv[1],String(process.pid)+'\\n');process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`;
  const code = await boundedChild(t, `require('fs').writeFileSync(process.argv[1],String(process.pid)+'\\n');require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)},process.argv[1]],{stdio:'ignore'});setInterval(()=>{},1000)`, { timeoutMs: 300, killGraceMs: 80, expectedProcesses: 2, assertReaped: process.platform === 'linux' });
  assert.equal(code, 'COMMAND_TIMEOUT');
});

for (const pipes of ['ignore', 'inherit']) test(`successful command cleans up workers with ${pipes} output`, async t => {
  const descendant = `require('fs').appendFileSync(process.argv[1],String(process.pid)+'\\n');process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`;
  const stdio = pipes === 'ignore' ? "'ignore'" : "['ignore',process.stdout,process.stderr]";
  const source = `const fs=require('fs');fs.writeFileSync(process.argv[1],String(process.pid)+'\\n');const child=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)},process.argv[1]],{stdio:${stdio}});child.unref();setInterval(()=>{if(fs.readFileSync(process.argv[1],'utf8').trim().split('\\n').length===2)process.exit(0)},10)`;
  assert.equal(await boundedChild(t, source, { timeoutMs: 1000, killGraceMs: 80, expectedProcesses: 2 }), 'RESOLVED');
});

test('a worker escaping into another session cannot keep the command wait open', async t => {
  const descendant = `require('fs').appendFileSync(process.argv[1],String(process.pid)+'\\n');process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`;
  const source = `require('fs').writeFileSync(process.argv[1],String(process.pid)+'\\n');require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)},process.argv[1]],{detached:true,stdio:['ignore',process.stdout,process.stderr]});setInterval(()=>{},1000)`;
  // Explicitly outside process-group containment; the fixture cleans up this
  // deliberate escape. This asserts bounded waiting, not automatic reaping.
  assert.equal(await boundedChild(t, source, { timeoutMs: 300, killGraceMs: 80, expectedProcesses: 2, assertReaped: false }), 'COMMAND_TIMEOUT');
});

test('stale lock from an exited unreaped owner is recovered', { skip: process.platform !== 'linux' }, async t => {
  if (spawnSync('python3', ['--version']).status !== 0) { t.skip('Python is needed to hold a fixture zombie'); return; }
  const f = fixture(t);
  const owner = spawn('python3', ['-u', '-c', `import os,sys,time
pid=os.fork()
if pid==0: os._exit(0)
while open('/proc/%d/stat'%pid).read().split(') ')[1].split()[0]!='Z': time.sleep(0.01)
print(pid,flush=True)
sys.stdin.readline()
os.waitpid(pid,0)
`], { env: f.options.env, stdio: ['pipe', 'pipe', 'ignore'] });
  const exited = new Promise(resolve => owner.once('close', resolve));
  try {
    const pid = Number(await new Promise((resolve, reject) => { owner.stdout.once('data', value => resolve(String(value))); owner.once('error', reject); }));
    const fields = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
    assert.equal(fields[0], 'Z');
    const lock = path.join(f.managed, '.install-host.lock');
    write(lock, JSON.stringify({ pid, identity: fields[19], token: 'fixture-zombie-owner' }));
    fs.utimesSync(lock, new Date(0), new Date(0));
    assert.equal((await installHost({ ...f.options, lockTimeoutMs: 200 })).status, 'installed');
  } finally { owner.stdin.end('\n'); await exited; }
});

test('output overflow terminates a real command before its long timeout', async t => {
  const code = await boundedChild(t, `require('fs').writeFileSync(process.argv[1],String(process.pid));process.on('SIGTERM',()=>{});process.stdout.write('x'.repeat(5*1024*1024));setInterval(()=>{},1000)`, { timeoutMs: 10000, killGraceMs: 80 });
  assert.equal(code, 'COMMAND_OUTPUT_LIMIT');
});

test('output cap counts UTF-8 bytes rather than JavaScript characters', async t => {
  const code = await boundedChild(t, `require('fs').writeFileSync(process.argv[1],String(process.pid));process.stdout.write('€'.repeat(2*1024*1024),()=>process.exit(0))`, { timeoutMs: 10000, killGraceMs: 80 });
  assert.equal(code, 'COMMAND_OUTPUT_LIMIT');
});

test('stale malformed lock with a live PID but no ownership token is recoverable', async t => {
  const f = fixture(t), lock = path.join(f.managed, '.install-host.lock');
  write(lock, JSON.stringify({ pid: process.pid }));
  fs.utimesSync(lock, new Date(0), new Date(0));
  const result = await installHost({ ...f.options, lockTimeoutMs: 200 });
  assert.equal(result.status, 'installed');
  assert.equal(fs.existsSync(lock), false);
});

test('a lock disappearing during owner inspection retries instead of aborting', async t => {
  const f = fixture(t), lock = path.join(f.managed, '.install-host.lock');
  write(lock, '{}');
  const original = fs.openSync;
  let raced = false;
  fs.openSync = function(file, flags, ...args) {
    if (file === lock && flags === 'wx' && !raced) {
      raced = true;
      fs.unlinkSync(lock);
      throw Object.assign(new Error('Concurrent lock removal'), { code: 'EEXIST' });
    }
    return original.call(this, file, flags, ...args);
  };
  try {
    assert.equal((await installHost(f.options)).status, 'installed');
  } finally { fs.openSync = original; }
  assert.equal(raced, true);
});

function changePatch(f) {
  const patch = fs.readFileSync(path.join(f.pkg, 'host/adapter.patch'), 'utf8') + '\n';
  write(path.join(f.pkg, 'host/adapter.patch'), patch);
  write(path.join(f.pkg, 'host/adapter-meta.json'), JSON.stringify({ ...f.meta, patchSha256: sha(patch) }));
}

test('routing failure after build rolls back the active release and leaves a retry possible', async t => {
  const f = fixture(t), first = await installHost(f.options);
  const record = fs.readFileSync(path.join(f.managed, 'host-install.json'), 'utf8');
  const launcher = fs.readFileSync(first.routing.launcher, 'utf8');
  changePatch(f);
  const metadata = path.join(f.home, 'shared/host.json');
  write(metadata, JSON.stringify({ realWeb: 'invalid-relative-route' }));
  await assert.rejects(installHost({ ...f.options, sharedHostPath: metadata }), { code: 'SHARED_ROUTING_INVALID' });
  assert.equal(fs.realpathSync(first.adapterRoot), first.releaseRoot);
  assert.equal(fs.readFileSync(first.routing.launcher, 'utf8'), launcher);
  assert.equal(fs.readFileSync(path.join(f.managed, 'host-install.json'), 'utf8'), record);
  assert.deepEqual(fs.readdirSync(path.join(f.managed, 'pi-web-releases')), [path.basename(first.releaseRoot)]);
  assert.equal((await installHost(f.options)).status, 'installed');
});

test('first install routing receipt failure rolls back wrapper and release publication', async t => {
  const f = fixture(t), routing = path.join(f.managed, 'host-routing.json');
  const original = fs.renameSync;
  fs.renameSync = function(from, to) {
    if (to === routing) throw Object.assign(new Error('Receipt storage failure'), { code: 'EIO' });
    return original.call(this, from, to);
  };
  try { await assert.rejects(installHost(f.options), { code: 'EIO' }); }
  finally { fs.renameSync = original; }
  assert.equal(fs.existsSync(path.join(f.home, '.local/bin/pi-web')), false);
  assert.equal(fs.existsSync(path.join(f.managed, 'pi-web')), false);
  assert.deepEqual(fs.readdirSync(path.join(f.managed, 'pi-web-releases')), []);
  assert.equal((await installHost(f.options)).routing.status, 'user-wrapper');
});

test('final receipt failure restores shared routing bytes and prior release', async t => {
  const f = fixture(t), metadata = path.join(f.home, 'shared/host.json');
  write(metadata, JSON.stringify({ realWeb: f.native, shim: path.join(f.home, '.local/bin/pi-web') }), 0o640);
  const first = await installHost({ ...f.options, sharedHostPath: metadata });
  write(metadata, JSON.stringify({ realWeb: f.native, shim: path.join(f.home, '.local/bin/pi-web') }), 0o640);
  const before = fs.readFileSync(metadata, 'utf8');
  changePatch(f);
  const receipt = path.join(f.managed, 'host-install.json');
  fs.unlinkSync(receipt);
  fs.symlinkSync(path.join(f.root, 'external-receipt'), receipt);
  await assert.rejects(installHost({ ...f.options, sharedHostPath: metadata }), { code: 'UNSAFE_METADATA_PATH' });
  assert.equal(fs.realpathSync(first.adapterRoot), first.releaseRoot);
  assert.equal(fs.readFileSync(metadata, 'utf8'), before);
  assert.equal(fs.statSync(metadata).mode & 0o777, 0o640);
});

test('prebuilt dependency symlinks are copied without retaining a mutable source link', async t => {
  const f = fixture(t);
  git(f.source, 'apply', path.join(f.pkg, 'host/adapter.patch'));
  write(path.join(f.source, '.next/BUILD_ID'), 'existing-production-build\n');
  const modules = path.join(f.root, 'mutable-modules');
  write(path.join(modules, 'next/dist/bin/next'), '// original next\n');
  write(path.join(f.source, '.git/info/exclude'), 'node_modules\n');
  fs.symlinkSync(modules, path.join(f.source, 'node_modules'), 'dir');
  const result = await installHost({ ...f.options, prebuiltRoot: f.source });
  write(path.join(modules, 'next/dist/bin/next'), '// mutated next\n');
  assert.equal(fs.readFileSync(path.join(result.releaseRoot, 'node_modules/next/dist/bin/next'), 'utf8'), '// original next\n');
});

test('interrupting the real installer command runner reaps its subprocess and returns a safe code', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-paseo-interrupt-')), pids = path.join(root, 'pids');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const module = new URL('../bin/install-host.mjs', import.meta.url).href;
  const command = `require('fs').writeFileSync(process.argv[1],String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`;
  const script = `import {runCommand} from ${JSON.stringify(module)};try{await runCommand(process.execPath,['-e',${JSON.stringify(command)},process.argv[1]],{killGraceMs:80})}catch(error){console.log(error.code)}`;
  const worker = spawn(process.execPath, ['--input-type=module', '-e', script, pids], {
    env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: root, PI_AGENT_DATA_DIR: root }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', watchdog;
  worker.stdout.on('data', chunk => { output += chunk; });
  worker.stderr.on('data', () => {});
  const exited = new Promise(resolve => { worker.on('close', () => resolve(output.trim())); worker.on('error', () => resolve('SPAWN_FAILED')); });
  try {
    const readyBy = Date.now() + 1800;
    while (!fs.existsSync(pids) && Date.now() < readyBy) await delay(10);
    assert.equal(fs.existsSync(pids), true, 'real subprocess started');
    worker.kill('SIGTERM');
    const code = await Promise.race([exited, new Promise(resolve => { watchdog = setTimeout(() => resolve('HUNG'), 1800); })]);
    assert.equal(code, 'COMMAND_INTERRUPTED');
  } finally {
    clearTimeout(watchdog);
    worker.kill('SIGKILL');
    if (fs.existsSync(pids)) try { process.kill(Number(fs.readFileSync(pids, 'utf8')), 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    await exited;
  }
});

test('a concurrently created launcher is preserved and the new release is rolled back', async t => {
  const f = fixture(t), shim = path.join(f.home, '.local/bin/pi-web');
  const original = fs.openSync, foreign = '#!/bin/sh\n# concurrent user launcher\n';
  let created = false;
  fs.openSync = function(file, flags, ...args) {
    if (String(file).startsWith(shim + '.') && flags === 'wx' && !created) {
      created = true;
      write(shim, foreign, 0o755);
    }
    return original.call(this, file, flags, ...args);
  };
  try { await assert.rejects(installHost(f.options), { code: 'ROUTING_CHANGED_RETRY' }); }
  finally { fs.openSync = original; }
  assert.equal(created, true);
  assert.equal(fs.readFileSync(shim, 'utf8'), foreign);
  assert.equal(fs.existsSync(path.join(f.managed, 'pi-web')), false);
  assert.deepEqual(fs.readdirSync(path.join(f.managed, 'pi-web-releases')), []);
});

test('live lock owners are preserved while truncated stale locks are recoverable', async t => {
  const f = fixture(t), lock = path.join(f.managed, '.install-host.lock');
  write(lock, JSON.stringify({ pid: process.pid, identity: null, token: 'valid-live-owner' }));
  fs.utimesSync(lock, new Date(0), new Date(0));
  await assert.rejects(installHost({ ...f.options, lockTimeoutMs: 100 }), { code: 'HOST_INSTALL_BUSY' });
  assert.equal(JSON.parse(fs.readFileSync(lock)).token, 'valid-live-owner');
  for (const malformed of ['', '{', 'null']) {
    write(lock, malformed); fs.utimesSync(lock, new Date(0), new Date(0));
    assert.ok(['installed', 'already-installed'].includes((await installHost({ ...f.options, lockTimeoutMs: 100 })).status));
  }
});

test('kernel guard serializes cooperative processes and releases on owner death', { skip: process.platform !== 'linux' }, async t => {
  const f = fixture(t), marker = path.join(f.root, 'guard-held');
  fs.mkdirSync(f.managed, { recursive: true });
  const guard = path.join(f.managed, '.install-host.guard');
  const owner = spawn('flock', ['--exclusive', guard, process.execPath, '-e', `require('fs').writeFileSync(process.argv[1],'ready');setInterval(()=>{},1000)`, marker], {
    detached: true, env: f.options.env, stdio: 'ignore',
  });
  const exited = new Promise(resolve => owner.once('close', resolve));
  try {
    const deadline = Date.now() + 2500;
    while (!fs.existsSync(marker) && Date.now() < deadline) await delay(10);
    assert.equal(fs.existsSync(marker), true, 'another process holds the OS lock');
    await assert.rejects(installHost({ ...f.options, lockTimeoutMs: 100 }), { code: 'HOST_INSTALL_BUSY' });
    assert.equal(f.calls.length, 0);
  } finally {
    try { process.kill(-owner.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    await exited;
  }
  assert.equal((await installHost(f.options)).status, 'installed');
  assert.ok(fs.statSync(guard).isFile(), 'guard inode remains permanent');
});

for (const edited of [false, true]) test(`publication killed after wrapper ${edited ? 'preserves later user edits' : 'resumes its own receipt'}`, async t => {
  const f = fixture(t);
  const localBase = git(f.source, 'rev-parse', 'HEAD');
  const module = new URL('../bin/install-host.mjs', import.meta.url).href;
  const config = { home: f.home, source: f.source, pkg: f.pkg, localBase, sharedHostPath: f.options.sharedHostPath };
  const script = `
import fs from 'node:fs';import path from 'node:path';
import {installHost,runCommand,PI_WEB_BASE} from ${JSON.stringify(module)};
const f=JSON.parse(process.argv[1]);
function write(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,value);}
async function run(command,args,options={}){
  if(command==='npm'){write(path.join(options.cwd,args[0]==='ci'?'node_modules/next/dist/bin/next':'.next/BUILD_ID'),'fixture-build');return '';}
  const adjusted=[...args];
  if(args[0]==='fetch'){adjusted[adjusted.indexOf('origin')]=f.source;adjusted[adjusted.length-1]=f.localBase;}
  if(args[0]==='checkout'&&args.at(-1)===PI_WEB_BASE)adjusted[adjusted.length-1]=f.localBase;
  const value=await runCommand(command,adjusted,{...options,env:process.env});
  return args[0]==='rev-parse'&&value===f.localBase?PI_WEB_BASE:value;
}
const rename=fs.renameSync;
fs.renameSync=function(from,to){const value=rename.call(this,from,to);if(to===path.join(f.home,'.local/bin/pi-web'))process.kill(process.pid,'SIGKILL');return value;};
await installHost({home:f.home,packageRoot:f.pkg,sharedHostPath:f.sharedHostPath,run});
`;
  const worker = spawn(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(config)], { env: f.options.env, stdio: 'ignore' });
  let watchdog;
  const termination = await new Promise(resolve => {
    watchdog = setTimeout(() => worker.kill('SIGKILL'), 5000);
    worker.once('close', (code, signal) => { clearTimeout(watchdog); resolve({ code, signal }); });
  });
  assert.deepEqual(termination, { code: null, signal: 'SIGKILL' });
  const shim = path.join(f.home, '.local/bin/pi-web'), receipt = path.join(f.managed, 'host-routing.json');
  assert.ok(fs.existsSync(shim));
  assert.equal(fs.existsSync(receipt), false, 'the real kill interrupted publication');
  if (edited) fs.appendFileSync(shim, '\n// user edit after interruption\n');
  const before = fs.readFileSync(shim, 'utf8');
  fs.utimesSync(path.join(f.managed, '.install-host.lock'), new Date(0), new Date(0));
  const retry = await installHost(f.options);
  assert.equal(retry.routing.status, edited ? 'manual-routing-required' : 'user-wrapper');
  assert.equal(fs.readFileSync(shim, 'utf8'), before);
  assert.equal(fs.existsSync(receipt), !edited);
  assert.equal(retry.reused, true);
});

test('shared routing edits detected before replacement are preserved during rollback', async t => {
  const f = fixture(t), first = await installHost(f.options);
  changePatch(f);
  const metadata = path.join(f.home, 'shared/host.json');
  write(metadata, JSON.stringify({ realWeb: f.native, setting: 'original' }));
  const foreign = JSON.stringify({ realWeb: f.native, setting: 'concurrent-user-edit' });
  const open = fs.openSync;
  let edited = false;
  fs.openSync = function(file, flags, ...args) {
    if (String(file).startsWith(metadata + '.') && flags === 'wx' && !edited) { edited = true; write(metadata, foreign); }
    return open.call(this, file, flags, ...args);
  };
  try { await assert.rejects(installHost({ ...f.options, sharedHostPath: metadata }), { code: 'ROUTING_CHANGED_RETRY' }); }
  finally { fs.openSync = open; }
  assert.equal(edited, true);
  assert.equal(fs.readFileSync(metadata, 'utf8'), foreign);
  assert.equal(fs.realpathSync(first.adapterRoot), first.releaseRoot);
});

test('host repairs the SDK shrinkwrapped dependency after npm ci and before build', async t => {
  const f = fixture(t);
  let checkedBeforeBuild = false;
  const run = async (command, args, options) => {
    if (command === 'npm' && args[0] === 'run') {
      const target = path.join(options.cwd, 'node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion');
      assert.equal(JSON.parse(fs.readFileSync(path.join(target, 'package.json'))).version, '5.0.12');
      assert.equal(fs.readFileSync(path.join(target, 'index.cjs'), 'utf8'), 'module.exports=()=>["fixed"];\n');
      assert.equal(JSON.parse(fs.readFileSync(path.join(options.cwd, 'node_modules/@earendil-works/pi-coding-agent/node_modules/undici/package.json'))).version, '8.12.3');
      checkedBeforeBuild = true;
    }
    const result = await f.options.run(command, args, options);
    if (command === 'npm' && args[0] === 'ci') {
      const modules = path.join(options.cwd, 'node_modules'), sdk = path.join(modules, '@earendil-works/pi-coding-agent');
      write(path.join(sdk, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.0.0' }));
      write(path.join(sdk, 'node_modules/minimatch/package.json'), JSON.stringify({ name: 'minimatch', main: 'index.cjs' }));
      write(path.join(sdk, 'node_modules/minimatch/index.cjs'), 'module.exports={};\n');
      write(path.join(sdk, 'node_modules/brace-expansion/package.json'), JSON.stringify({ name: 'brace-expansion', version: '5.0.9' }));
      write(path.join(modules, 'brace-expansion/package.json'), JSON.stringify({ name: 'brace-expansion', version: '5.0.12' }));
      write(path.join(modules, 'brace-expansion/index.cjs'), 'module.exports=()=>["fixed"];\n');
      write(path.join(sdk, 'node_modules/undici/package.json'), JSON.stringify({ name: 'undici', version: '8.10.2' }));
      write(path.join(modules, 'undici/package.json'), JSON.stringify({ name: 'undici', version: '8.12.3' }));
    }
    return result;
  };
  const result = await installHost({ ...f.options, run });
  assert.equal(checkedBeforeBuild, true);
  assert.equal(result.status, 'installed');
});
