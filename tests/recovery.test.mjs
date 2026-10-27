import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withLock, writeRecord, readRecord } from '../src/onboarding.mjs';
import { withRuntimeLock, updateState, readState, processIdentity } from '../src/state.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-paseo-recovery-'));
  const loc = { home: path.join(dir, 'home'), stateDir: path.join(dir, 'state'), agentDir: path.join(dir, 'agent') };
  for (const file of Object.values(loc)) fs.mkdirSync(file, { recursive: true });
  const keys = ['HOME', 'PI_CODING_AGENT_DIR', 'PI_PASEO_STATE_DIR', 'PI_PASEO_RUNTIME_DIR', 'PI_WEB_PORT', 'PI_WEB_PASSWORD'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.HOME = loc.home;
  process.env.PI_CODING_AGENT_DIR = loc.agentDir;
  process.env.PI_PASEO_STATE_DIR = loc.stateDir;
  process.env.PI_PASEO_RUNTIME_DIR = path.join(dir, 'runtime');
  delete process.env.PI_WEB_PASSWORD;
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, loc };
}
function stale(file) {
  const time = new Date(Date.now() - 60000);
  fs.utimesSync(file, time, time);
}
test('recycled PID cannot keep an abandoned onboarding lock alive', async t => {
  const { loc } = fixture(t);
  const lock = path.join(loc.stateDir, 'onboarding.lock');
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, identity: processIdentity(process.pid) + '-previous', token: 'abandoned' }));
  stale(lock);
  assert.equal(await withLock(lock, () => 42, { timeoutMs: 2000 }), 42);
});

test('old interrupted directory acquisition recovers but fresh acquisition stays protected', async t => {
  const { loc } = fixture(t);
  const lock = path.join(loc.stateDir, 'onboarding.lock');
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'owner.json'), '{');
  await assert.rejects(withLock(lock, () => assert.fail('fresh lock was stolen'), { timeoutMs: 2000 }), /already running/);
  stale(lock);
  assert.equal(await withLock(lock, () => 42, { timeoutMs: 2000 }), 42);
});

test('releasing an operation cannot delete a replacement lock owned by another operation', async t => {
  const { loc } = fixture(t);
  const lock = path.join(loc.stateDir, 'operation.lock');
  await withLock(lock, () => {
    fs.renameSync(lock, lock + '.old');
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, identity: processIdentity(process.pid), token: 'replacement' }));
  });
  assert.equal(fs.existsSync(lock), true);
  assert.equal(readRecord(path.join(lock, 'owner.json')).token, 'replacement');
});

test('runtime and state locks recover an old empty crash record', async t => {
  const { loc } = fixture(t);
  for (const name of ['runtime.lock', 'state.lock']) {
    const file = path.join(loc.stateDir, name);
    fs.writeFileSync(file, '');
    stale(file);
  }
  assert.equal(await withRuntimeLock(() => 42, { timeoutMs: 2000 }), 42);
  updateState({ phase: 'ready' });
  assert.equal(readState().phase, 'ready');
});

test('fresh empty runtime lock is not stolen', async t => {
  const { loc } = fixture(t);
  const file = path.join(loc.stateDir, 'runtime.lock');
  fs.writeFileSync(file, '');
  await assert.rejects(withRuntimeLock(() => assert.fail('fresh lock was stolen'), { timeoutMs: 2000 }), error => error.code === 'RUNTIME_BUSY');
  assert.equal(fs.existsSync(file), true);
});

test('onboarding record operations refuse symlinked files', t => {
  const { loc } = fixture(t);
  const target = path.join(loc.home, 'external.json'), file = path.join(loc.stateDir, 'preferences.json');
  fs.writeFileSync(target, JSON.stringify({ external: true }));
  fs.symlinkSync(target, file);
  assert.throws(() => readRecord(file), error => error.code === 'UNSAFE_SYMLINK');
  assert.throws(() => writeRecord(file, { name: 'new' }), error => error.code === 'UNSAFE_SYMLINK');
  assert.equal(fs.lstatSync(file).isSymbolicLink(), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(target)), { external: true });
});

test('state and record locks refuse a symlink ancestor and leave its target untouched', async t => {
  const { dir, loc } = fixture(t);
  const link = path.join(dir, 'link');
  fs.symlinkSync(loc.home, link, 'dir');
  const stateDir = path.join(link, 'state');
  process.env.PI_PASEO_STATE_DIR = stateDir;
  assert.throws(() => updateState({ phase: 'ready' }), error => error.code === 'UNSAFE_SYMLINK');
  await assert.rejects(withLock(path.join(stateDir, 'operation.lock'), () => 42), error => error.code === 'UNSAFE_SYMLINK');
  assert.equal(fs.existsSync(path.join(loc.home, 'state')), false);
});

test('record writers tighten an existing public state directory', t => {
  const { loc } = fixture(t);
  fs.chmodSync(loc.stateDir, 0o755);
  writeRecord(path.join(loc.stateDir, 'preferences.json'), { name: 'safe' });
  assert.equal(fs.statSync(loc.stateDir).mode & 0o777, 0o700);
});

test('runtime acquisition refuses a symlinked lock without touching its target', async t => {
  const { loc } = fixture(t);
  const target = path.join(loc.home, 'external.json');
  fs.writeFileSync(target, JSON.stringify({ pid: 99999999, identity: 'dead', token: 'external' }));
  const file = path.join(loc.stateDir, 'runtime.lock');
  fs.symlinkSync(target, file);
  await assert.rejects(withRuntimeLock(() => assert.fail('unsafe acquisition'), { timeoutMs: 2000 }), error => error.code === 'UNSAFE_SYMLINK');
  assert.equal(fs.lstatSync(file).isSymbolicLink(), true);
  assert.equal(JSON.parse(fs.readFileSync(target)).token, 'external');
});
