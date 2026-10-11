import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function write(file, content, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode });
}
function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-paseo-bootstrap-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const home = path.join(temporary, 'home'), source = path.join(temporary, 'source');
  const state = path.join(home, 'state'), commands = path.join(temporary, 'commands');
  fs.mkdirSync(home); fs.mkdirSync(source); fs.mkdirSync(state);
  const env = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: state, PI_AGENT_DATA_DIR: state,
    PI_PASEO_SKIP_POSTINSTALL: '0', PI_PASEO_REPOSITORY: 'https://github.com/WOOWTECH/pi-paseo-plugin.git',
    PATH: commands + path.delimiter + process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    BOOTSTRAP_LOG: path.join(temporary, 'events'), BOOTSTRAP_STATE: state };
  delete env.PI_PASEO_REF;
  write(path.join(commands, 'pi'), `#!${process.execPath}\nrequire('fs').appendFileSync(process.env.BOOTSTRAP_LOG,'register\\n');\n`, 0o755);
  write(path.join(commands, 'npm'), `#!${process.execPath}\nconst fs=require('fs'),path=require('path');fs.appendFileSync(process.env.BOOTSTRAP_LOG,'npm-ci\\n');if(process.env.BOOTSTRAP_FAIL_NPM==='1')process.exit(9);fs.mkdirSync('node_modules',{recursive:true});fs.writeFileSync('node_modules/fixture-dependency','prepared');\n`, 0o755);
  write(path.join(source, '.gitignore'), 'node_modules/\n');
  write(path.join(source, 'package.json'), JSON.stringify({ name: '@woowtech/pi-paseo', version: '0.1.0', type: 'module' }));
  write(path.join(source, 'package-lock.json'), '{"lockfileVersion":3}\n');
  for (const file of ['bin/cli.mjs', 'bin/repair-sdk-dependency.mjs', 'src/host-api.mjs', 'src/onboarding.mjs', 'src/state.mjs']) write(path.join(source, file), fs.readFileSync(path.join(root, file)));
  write(path.join(source, 'bin/install-host.mjs'), `import fs from 'node:fs';export async function installHost(){fs.appendFileSync(process.env.BOOTSTRAP_LOG,'host-install\\n');return {restartRequired:true}};if(process.argv[1]?.endsWith('install-host.mjs'))await installHost();\n`);
  write(path.join(source, 'src/runtime.mjs'), `import fs from 'node:fs';export const locations=()=>({home:process.env.HOME,stateDir:process.env.BOOTSTRAP_STATE});export async function activate(){fs.appendFileSync(process.env.BOOTSTRAP_LOG,'activate\\n')}export async function deactivate(){fs.appendFileSync(process.env.BOOTSTRAP_LOG,'deactivate\\n')}export async function status(){return {daemon:{running:false}}}\n`);
  write(path.join(source, 'src/health.mjs'), 'export async function healthReport(){return {healthy:true}}\n');
  write(path.join(source, 'src/supervisor.mjs'), `import fs from 'node:fs';export async function startSupervisor(){fs.appendFileSync(process.env.BOOTSTRAP_LOG,'supervisor-start\\n');return {running:true}}export async function stopSupervisor(){fs.appendFileSync(process.env.BOOTSTRAP_LOG,'supervisor-stop\\n')}export function packageEnabled(){return true}export async function supervise(){}\n`);
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: source, env, encoding: 'utf8' });
    assert.equal(result.status, 0, 'fixture git command failed');
    return result.stdout.trim();
  };
  git('init', '--quiet'); git('add', '.');
  git('-c', 'user.name=Bootstrap Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture');
  env.PI_PASEO_REF = git('rev-parse', 'HEAD');
  const installed = path.join(home, '.local/share/pi-paseo/plugin-sources', env.PI_PASEO_REF);
  const run = overrides => spawnSync('bash', [path.join(root, 'scripts/install.sh'), '--source', source], {
    cwd: home, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 10000,
  });
  const start = overrides => spawn('bash', [path.join(root, 'scripts/install.sh'), '--source', source], {
    cwd: home, env: { ...env, ...overrides }, detached: true, stdio: 'ignore',
  });
  const events = () => fs.existsSync(env.BOOTSTRAP_LOG) ? fs.readFileSync(env.BOOTSTRAP_LOG, 'utf8').trim().split('\n') : [];
  return { source, state, installed, run, start, events, commands, home };
}

test('real bootstrap and CLI preserve an existing manual stop', t => {
  const f = fixture(t);
  write(path.join(f.state, 'host-registration.json'), JSON.stringify({ enabled: false }));
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.state, 'host-registration.json'))).enabled, false);
  assert.equal(f.events().includes('activate'), false);
  assert.equal(f.events().includes('supervisor-start'), false);
});

test('first bootstrap prepares runtime using pinned committed source bytes', t => {
  const f = fixture(t);
  write(path.join(f.source, 'package.json'), '{"name":"dirty-worktree"}');
  assert.equal(f.run().status, 0);
  assert.equal(f.events().includes('activate'), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.installed, 'package.json'))).name, '@woowtech/pi-paseo');
});

test('repeat bootstrap reuses immutable dependencies at the registered source path', t => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
  const dependency = path.join(f.installed, 'node_modules/fixture-dependency');
  write(dependency, 'currently-used');
  assert.equal(f.run().status, 0);
  assert.equal(fs.readFileSync(dependency, 'utf8'), 'currently-used');
  assert.equal(f.events().filter(event => event === 'npm-ci').length, 1);
});

test('dependency installation failure never publishes or registers an incomplete source', t => {
  const f = fixture(t), result = f.run({ BOOTSTRAP_FAIL_NPM: '1' });
  assert.equal(result.status, 1);
  assert.equal(fs.existsSync(f.installed), false);
  assert.equal(f.events().includes('register'), false);
  assert.equal(f.run().status, 0);
});

function workerFixture(t, f, success = false) {
  const pids = path.join(f.state, 'npm-pids'), npm = path.join(f.commands, 'npm');
  const child = `require('fs').appendFileSync(process.argv[1],String(process.pid)+'\\n');process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`;
  write(npm, `#!${process.execPath}
const fs=require('fs');
fs.writeFileSync(${JSON.stringify(pids)},String(process.pid)+'\\n');
fs.mkdirSync('node_modules',{recursive:true});fs.writeFileSync('node_modules/fixture-dependency','prepared');
const child=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(child)},${JSON.stringify(pids)}],{stdio:'ignore'});
process.stderr.write('credential-sentinel');
${success ? `child.unref();setInterval(()=>{if(fs.readFileSync(${JSON.stringify(pids)},'utf8').trim().split('\\n').length===2)process.exit(0)},10);` : "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);"}
`, 0o755);
  const live = pid => {
    try { const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0'); return args.includes(pids) || args.includes(npm); }
    catch (error) { if (error.code !== 'ENOENT') throw error; return false; }
  };
  let knownPids = [];
  const processes = () => {
    if (fs.existsSync(pids)) knownPids = fs.readFileSync(pids, 'utf8').trim().split('\n').map(Number);
    return knownPids;
  };
  t.after(() => { for (const pid of processes()) if (live(pid)) try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } });
  const assertReaped = () => {
    const children = processes();
    assert.equal(children.length, 2, 'npm and its real worker reached the call site');
    for (const pid of children) assert.equal(live(pid), false, 'bootstrap reaped its fixture workers');
  };
  return { pids, processes, live, assertReaped };
}

test('bootstrap timeout reaps hanging npm workers before source publication', { skip: process.platform !== 'linux' }, t => {
  const f = fixture(t), workers = workerFixture(t, f);
  const result = f.run({ PI_PASEO_BOOTSTRAP_TIMEOUT_MS: '700', PI_PASEO_COMMAND_KILL_GRACE_MS: '80' });
  assert.equal(result.status, 1);
  assert.ok(!result.stderr.includes('credential-sentinel'));
  workers.assertReaped();
  assert.equal(fs.existsSync(f.installed), false);
  assert.equal(f.events().includes('register'), false);
  assert.deepEqual(fs.readdirSync(path.dirname(f.installed)).filter(name => name.startsWith('.bootstrap-')), []);
});

test('successful bootstrap npm also cleans up background workers', { skip: process.platform !== 'linux' }, t => {
  const f = fixture(t), workers = workerFixture(t, f, true);
  const result = f.run({ PI_PASEO_COMMAND_KILL_GRACE_MS: '80' });
  assert.equal(result.status, 0);
  workers.assertReaped();
  assert.equal(fs.readFileSync(path.join(f.installed, 'node_modules/fixture-dependency'), 'utf8'), 'prepared');
});

test('signalling the bootstrap PID forwards interruption and reaps npm workers', { skip: process.platform !== 'linux' }, async t => {
  const f = fixture(t), workers = workerFixture(t, f);
  const bootstrap = f.start({ PI_PASEO_COMMAND_KILL_GRACE_MS: '80' });
  const exited = new Promise(resolve => bootstrap.once('close', (code, signal) => resolve({ code, signal })));
  let watchdog;
  try {
    const deadline = Date.now() + 5000;
    while (workers.processes().length !== 2 && Date.now() < deadline) await delay(10);
    assert.equal(workers.processes().length, 2);
    bootstrap.kill('SIGTERM');
    const result = await Promise.race([exited, new Promise(resolve => { watchdog = setTimeout(() => resolve({ hung: true }), 2500); })]);
    assert.deepEqual(result, { code: 130, signal: null });
    workers.assertReaped();
    assert.equal(fs.existsSync(f.installed), false);
  } finally {
    clearTimeout(watchdog);
    try { process.kill(-bootstrap.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    for (const pid of workers.processes()) if (workers.live(pid)) process.kill(pid, 'SIGKILL');
    await exited;
  }
});
