import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureOnboarding, createViaLocalWeb, onboardingStatus, withLock, writeRecord, readRecord } from '../src/onboarding.mjs';
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
async function webFixture(t, handler) {
  const server = http.createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const result = await handler(req.url, text ? JSON.parse(text) : null);
    res.writeHead(result.status || 200, { 'Content-Type': 'application/json', ...(result.headers || {}) });
    res.end(JSON.stringify(result.body || {}));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  process.env.PI_WEB_PORT = String(server.address().port);
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
}

test('recycled PID cannot keep an abandoned onboarding lock alive', async t => {
  const { loc } = fixture(t);
  const lock = path.join(loc.stateDir, 'onboarding.lock');
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, identity: processIdentity(process.pid) + '-previous', token: 'abandoned' }));
  stale(lock);
  assert.equal(await withLock(lock, () => 42, { timeoutMs: 20 }), 42);
});

test('old interrupted directory acquisition recovers but fresh acquisition stays protected', async t => {
  const { loc } = fixture(t);
  const lock = path.join(loc.stateDir, 'onboarding.lock');
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'owner.json'), '{');
  await assert.rejects(withLock(lock, () => assert.fail('fresh lock was stolen'), { timeoutMs: 20 }), /already running/);
  stale(lock);
  assert.equal(await withLock(lock, () => 42, { timeoutMs: 20 }), 42);
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
  assert.equal(await withRuntimeLock(() => 42, { timeoutMs: 20 }), 42);
  updateState({ phase: 'ready' });
  assert.equal(readState().phase, 'ready');
});

test('fresh empty runtime lock is not stolen', async t => {
  const { loc } = fixture(t);
  const file = path.join(loc.stateDir, 'runtime.lock');
  fs.writeFileSync(file, '');
  await assert.rejects(withRuntimeLock(() => assert.fail('fresh lock was stolen'), { timeoutMs: 20 }), error => error.code === 'RUNTIME_BUSY');
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

test('state and onboarding writes refuse a symlink ancestor and leave its target untouched', async t => {
  const { dir, loc } = fixture(t);
  const link = path.join(dir, 'link');
  fs.symlinkSync(loc.home, link, 'dir');
  const stateDir = path.join(link, 'state');
  process.env.PI_PASEO_STATE_DIR = stateDir;
  assert.throws(() => updateState({ phase: 'ready' }), error => error.code === 'UNSAFE_SYMLINK');
  await assert.rejects(ensureOnboarding(() => 'session', { ...loc, stateDir }), error => error.code === 'UNSAFE_SYMLINK');
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
  await assert.rejects(withRuntimeLock(() => assert.fail('unsafe acquisition'), { timeoutMs: 20 }), error => error.code === 'UNSAFE_SYMLINK');
  assert.equal(fs.lstatSync(file).isSymbolicLink(), true);
  assert.equal(JSON.parse(fs.readFileSync(target)).token, 'external');
});

for (const failedType of ['set_session_name', 'prompt']) {
  test('local onboarding persists the confirmed session before a failing ' + failedType, async t => {
    const { loc } = fixture(t);
    let creations = 0;
    const remembered = [];
    await webFixture(t, async (route, body) => {
      if (route === '/api/agent/new') { creations++; return { body: { sessionId: 'confirmed-session' } }; }
      if (body.type === failedType) {
        remembered.push(onboardingStatus(loc).sessionId);
        return { status: 503 };
      }
      return { body: {} };
    });
    await assert.rejects(ensureOnboarding((prompt, remember) => createViaLocalWeb(prompt, loc, remember), loc));
    assert.deepEqual(remembered, ['confirmed-session'], 'confirmed session must be durable before follow-up requests');
    const record = onboardingStatus(loc);
    assert.equal(record.sessionId, 'confirmed-session');
    assert.equal(record.creation, 'created');
    assert.equal((await ensureOnboarding(() => assert.fail('duplicate'), loc)).sessionId, 'confirmed-session');
    assert.equal(creations, 1);
  });
}

test('failed local login is retryable because no creation request was issued', async t => {
  const { loc } = fixture(t);
  let loginReady = false, creations = 0;
  process.env.PI_WEB_PASSWORD = 'fixture-only-password';
  await webFixture(t, async route => {
    if (route === '/api/web-auth') return loginReady ? { headers: { 'Set-Cookie': 'fixture=authenticated; HttpOnly' } } : { status: 503 };
    if (route === '/api/agent/new') { creations++; return { body: { sessionId: 'after-login' } }; }
    return {};
  });
  const create = (prompt, remember) => createViaLocalWeb(prompt, loc, remember);
  await assert.rejects(ensureOnboarding(create, loc));
  assert.equal(creations, 0);
  assert.equal(onboardingStatus(loc).creation, 'retryable');
  loginReady = true;
  assert.equal((await ensureOnboarding(create, loc)).sessionId, 'after-login');
  assert.equal(creations, 1);
});

test('an uncertain local creation response remains pending and is never retried blindly', async t => {
  const { loc } = fixture(t);
  let calls = 0;
  await webFixture(t, async route => {
    if (route === '/api/agent/new') { calls++; return { body: {} }; }
    return {};
  });
  const create = (prompt, remember) => createViaLocalWeb(prompt, loc, remember);
  await assert.rejects(ensureOnboarding(create, loc));
  await assert.rejects(ensureOnboarding(create, loc), /reconciliation/);
  assert.equal(onboardingStatus(loc).creation, 'pending');
  assert.equal(calls, 1);
});


test('SIGKILL after onboarding checkpoint recovers the same session through the real creation path', { timeout: 10000 }, async t => {
  const { loc } = fixture(t);
  const moduleFile = fileURLToPath(new URL('../src/onboarding.mjs', import.meta.url));
  const source = [
    "import fs from 'node:fs';",
    "import { ensureOnboarding } from " + JSON.stringify(moduleFile) + ";",
    "setInterval(() => {}, 1000);",
    "await ensureOnboarding(async (_prompt, remember) => { remember('checkpointed-session'); fs.writeSync(1, 'ready'); await new Promise(() => {}); });",
  ].join('\n');
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { cwd: loc.home, env: { ...process.env }, stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const output = await once(child.stdout, 'data');
  assert.equal(String(output[0]), 'ready');
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  const record = await ensureOnboarding(() => assert.fail('duplicate creation after crash'), loc);
  assert.equal(record.sessionId, 'checkpointed-session');
  assert.equal(record.creation, 'created');
  assert.equal(fs.existsSync(path.join(loc.stateDir, 'onboarding.lock')), false);
});
