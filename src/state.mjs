import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export class RuntimeError extends Error {
  constructor(code, message = code) { super(message); this.name = 'RuntimeError'; this.code = code; }
}
export function locations() {
  const home = path.resolve(process.env.HOME || os.homedir());
  const agentDir = path.resolve(process.env.PI_CODING_AGENT_DIR || process.env.PI_AGENT_DATA_DIR || (fs.existsSync('/data/pi-agent') ? '/data/pi-agent' : path.join(home, '.pi/agent')));
  const stateDir = path.resolve(process.env.PI_PASEO_STATE_DIR || path.join(agentDir, 'pi-paseo'));
  let savedPort;
  try { savedPort = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8')).port; } catch {}
  const port = Number(savedPort || process.env.PI_PASEO_PORT || 6769);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new RuntimeError('INVALID_PORT');
  return { home, agentDir, stateDir, paseoHome: path.join(stateDir, 'daemon'), runtimeDir: path.resolve(process.env.PI_PASEO_RUNTIME_DIR || path.join(home, '.local/share/pi-paseo/runtime')), port };
}
export function privateDirectory(dir) {
  if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) throw new RuntimeError('UNSAFE_SYMLINK');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.chmodSync(dir, 0o700);
}
export function atomicJson(file, value) {
  privateDirectory(path.dirname(file));
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new RuntimeError('UNSAFE_SYMLINK');
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file); fs.chmodSync(file, 0o600);
  } finally { try { fs.unlinkSync(temp); } catch {} }
}
const forbiddenKey = /^(password|apiKey|token|accessToken|refreshToken|secret|pairingUrl|connectionUri|qr|credentials)$/i;
function assertPublic(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenKey.test(key)) throw new RuntimeError('STATE_SECRET_FIELD');
    assertPublic(child);
  }
}
export function readState() {
  const file = path.join(locations().stateDir, 'state.json');
  try {
    if (fs.lstatSync(file).isSymbolicLink()) throw new RuntimeError('UNSAFE_SYMLINK');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RuntimeError('STATE_CORRUPT');
    assertPublic(value); return value;
  } catch (error) { if (error.code === 'ENOENT') return {}; if (error instanceof RuntimeError) throw error; throw new RuntimeError('STATE_CORRUPT'); }
}
export function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    }
    return `alive:${pid}`;
  } catch { return null; }
}
function acquire(file) {
  const token = randomUUID();
  try {
    const fd = fs.openSync(file, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, identity: processIdentity(process.pid), token, createdAt: new Date().toISOString() })); } finally { fs.closeSync(fd); }
    return () => {
      try { if (JSON.parse(fs.readFileSync(file, 'utf8')).token === token) fs.unlinkSync(file); } catch {}
    };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    try {
      const owner = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (owner.identity && processIdentity(owner.pid) === owner.identity) return null;
      const before = fs.statSync(file);
      const again = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (again.token === owner.token && fs.statSync(file).ino === before.ino) fs.unlinkSync(file);
    } catch (failure) {
      // A newly opened file can still be empty until its owner writes. Never remove that live acquisition.
      if (failure.code !== 'ENOENT') return null;
    }
    return null;
  }
}
export function updateState(patch) {
  assertPublic(patch); const dir = locations().stateDir; privateDirectory(dir);
  const file = path.join(dir, 'state.lock'); const deadline = Date.now() + 3000; let release;
  while (!(release = acquire(file))) {
    if (Date.now() >= deadline) throw new RuntimeError('STATE_BUSY');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  try {
    const current = readState();
    const updated = { version: 1, installationId: randomUUID(), ...current, ...patch, updatedAt: new Date().toISOString() };
    atomicJson(path.join(dir, 'state.json'), updated); return updated;
  } finally { release(); }
}
export async function withRuntimeLock(fn, { timeoutMs = 300000 } = {}) {
  const dir = locations().stateDir; privateDirectory(dir); const file = path.join(dir, 'runtime.lock');
  const deadline = Date.now() + timeoutMs; let release;
  while (!(release = acquire(file))) { if (Date.now() >= deadline) throw new RuntimeError('RUNTIME_BUSY'); await delay(100); }
  try { return await fn(); } finally { release(); }
}
