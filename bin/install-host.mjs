#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { repairSdkDependency } from './repair-sdk-dependency.mjs';

export const PI_WEB_REPOSITORY = 'https://github.com/agegr/pi-web';
export const PI_WEB_BASE = '6fcd7d44981ab51a21d6cd6eb06d361d0e3d3068';
export const PI_WEB_VERSION = '0.10.0';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARKER = '// pi-paseo managed web launcher';
const sha = value => createHash('sha256').update(value).digest('hex');

export class HostInstallError extends Error {
  constructor(code) { super(code); this.name = 'HostInstallError'; this.code = code; }
}
const fail = code => { throw new HostInstallError(code); };
function exists(file) { try { fs.lstatSync(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function executable(file) { try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; } }
function within(parent, child) { const rel = path.relative(parent, child); return rel !== '' && !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel); }
function safeDirectory(dir, home) {
  if (!within(home, dir)) fail('HOME_PATH_REQUIRED');
  const relative = path.relative(home, dir).split(path.sep);
  let current = home;
  for (const part of relative) {
    current = path.join(current, part);
    if (exists(current)) {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail('UNSAFE_INSTALL_PATH');
    } else {
      try { fs.mkdirSync(current, { mode: 0o700 }); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const stat = fs.lstatSync(current);
        if (!stat.isDirectory() || stat.isSymbolicLink()) fail('UNSAFE_INSTALL_PATH');
      }
    }
  }
  fs.accessSync(dir, fs.constants.W_OK);
}
function atomic(file, value, mode = 0o600, expected) {
  if (exists(file) && fs.lstatSync(file).isSymbolicLink()) fail('UNSAFE_METADATA_PATH');
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temp, 'wx', mode);
    try { fs.writeFileSync(fd, value); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    // This detects edits observed before replacement, not an atomic filesystem
    // CAS. Uncooperative writers can still race this check and rename. Our own
    // installers serialize using the permanent kernel-lock file below.
    if (expected !== undefined && (expected === null ? exists(file) : !exists(file) || fs.readFileSync(file, 'utf8') !== expected)) fail('ROUTING_CHANGED_RETRY');
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
}
function json(file, value) { atomic(file, JSON.stringify(value, null, 2) + '\n'); }
function routingTransaction() {
  const changes = [];
  return {
    write(file, value, mode = 0o600, expected) {
      let previous = null;
      if (exists(file)) {
        if (!fs.lstatSync(file).isFile()) fail('UNSAFE_METADATA_PATH');
        previous = { value: fs.readFileSync(file, 'utf8'), mode: fs.statSync(file).mode & 0o777 };
      }
      atomic(file, value, mode, expected === undefined ? previous?.value ?? null : expected);
      changes.push({ file, value, previous });
    },
    rollback() {
      let failed = false;
      for (const { file, value, previous } of changes.reverse()) {
        try {
          if (!exists(file) || !fs.lstatSync(file).isFile() || fs.readFileSync(file, 'utf8') !== value) fail('ROUTING_CHANGED_RETRY');
          if (previous) atomic(file, previous.value, previous.mode, value);
          else fs.unlinkSync(file);
        } catch { failed = true; }
      }
      if (failed) fail('HOST_INSTALL_ROLLBACK_FAILED');
    },
  };
}

// Child output is deliberately drained without being logged: npm/git can echo
// credentials from external configuration or lifecycle scripts on failure.
export function runCommand(command, args, { cwd, env, timeoutMs = 900000, killGraceMs = 1000, input, lockFd } = {}) {
  return new Promise((resolve, reject) => {
    // A separate process group lets us reap npm/git descendants even when their
    // direct parent exits while they retain the inherited output pipes.
    // Ordinary npm/build workers inherit this group. A process deliberately
    // creating another session escapes it; pipe closure still bounds our wait,
    // but complete containment of such processes requires an OS supervisor.
    const stdio = [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'];
    if (lockFd !== undefined) stdio.push(lockFd);
    const child = spawn(command, args, { cwd, env, stdio, shell: false, detached: process.platform !== 'win32' });
    const output = [];
    let bytes = 0, failure = null, killTimer, finished = false, stopping = false;
    const signal = name => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, name);
        else child.kill(name);
      } catch (error) { if (error.code !== 'ESRCH') child.kill(name); }
    };
    const stop = code => {
      if (finished) return;
      if (code && !failure) failure = code;
      if (stopping) return;
      stopping = true;
      signal('SIGTERM');
      killTimer = setTimeout(() => {
        signal('SIGKILL');
        // An escaped descendant must not keep the installer's pipe open.
        child.stdout.destroy(); child.stderr.destroy();
      }, killGraceMs);
    };
    const interrupted = () => stop('COMMAND_INTERRUPTED');
    const finish = code => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); clearTimeout(killTimer);
      for (const name of ['SIGINT', 'SIGTERM']) process.off(name, interrupted);
      if (code) reject(new HostInstallError(code));
      else resolve(Buffer.concat(output, bytes).toString('utf8').trim());
    };
    child.stdout.on('data', chunk => {
      if (failure) return;
      if (bytes + chunk.length > 4 * 1024 * 1024) stop('COMMAND_OUTPUT_LIMIT');
      else { bytes += chunk.length; output.push(chunk); }
    });
    child.stderr.on('data', () => {});
    if (child.stdin) { child.stdin.on('error', () => {}); child.stdin.end(input); }
    const timer = setTimeout(() => stop('COMMAND_TIMEOUT'), timeoutMs);
    for (const name of ['SIGINT', 'SIGTERM']) process.on(name, interrupted);
    child.once('error', () => finish('COMMAND_UNAVAILABLE'));
    // Exit can precede close indefinitely when a worker retains a pipe. Clean
    // up workers even after successful parent exit; preserve its result code.
    child.once('exit', code => stop(code === 0 ? null : 'COMMAND_FAILED'));
    child.once('close', code => {
      // Closing output is not proof that the command's descendants exited.
      signal('SIGKILL');
      finish(failure || (code !== 0 ? 'COMMAND_FAILED' : null));
    });
  });
}
function processInfo(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { state: fields[0], identity: fields[19] };
  } catch { return null; }
}
function identity(pid) { return processInfo(pid)?.identity ?? null; }
async function locked(root, fn, timeoutMs) {
  if (process.platform !== 'linux') return tokenLocked(root, fn, timeoutMs);
  // Never unlink this inode. flock locks the shared open file description;
  // keeping our inherited descriptor open holds the lock after flock exits.
  // This closes stale-lock removal races between participating installers and
  // releases automatically on installer death, including zombie owners.
  const file = path.join(root, '.install-host.guard');
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600); }
  catch (error) { if (error.code === 'ELOOP') fail('UNSAFE_INSTALL_PATH'); throw error; }
  try {
    if (!fs.fstatSync(fd).isFile()) fail('UNSAFE_INSTALL_PATH');
    try {
      await runCommand('flock', ['--exclusive', '--timeout', String(Math.max(0, timeoutMs) / 1000), '3'], {
        lockFd: fd, timeoutMs: timeoutMs + 1000, killGraceMs: 100,
      });
    } catch (error) {
      if (error.code === 'COMMAND_FAILED' || error.code === 'COMMAND_TIMEOUT') fail('HOST_INSTALL_BUSY');
      if (error.code === 'COMMAND_UNAVAILABLE') fail('HOST_INSTALL_LOCK_UNAVAILABLE');
      throw error;
    }
    return await tokenLocked(root, fn, timeoutMs);
  } finally { fs.closeSync(fd); }
}
async function tokenLocked(root, fn, timeoutMs) {
  const file = path.join(root, '.install-host.lock');
  const token = randomUUID(), deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, identity: identity(process.pid), token })); } finally { fs.closeSync(fd); }
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile()) fail('UNSAFE_INSTALL_PATH');
        const original = fs.readFileSync(file, 'utf8');
        let owner;
        try { owner = JSON.parse(original); } catch {}
        let live = false;
        if (owner && Number.isInteger(owner.pid) && owner.pid > 0 && typeof owner.token === 'string' && owner.token.length > 0 &&
            (owner.identity === null || typeof owner.identity === 'string')) {
          try {
            process.kill(owner.pid, 0);
            const current = processInfo(owner.pid);
            live = !['Z', 'X'].includes(current?.state) && (!owner.identity || !current?.identity || owner.identity === current.identity);
          }
          catch (e) { live = e.code !== 'ESRCH'; }
        }
        const current = fs.lstatSync(file);
        if (!live && Date.now() - stat.mtimeMs > 30000 && current.dev === stat.dev && current.ino === stat.ino &&
            fs.readFileSync(file, 'utf8') === original) { fs.unlinkSync(file); continue; }
      } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
      if (Date.now() >= deadline) fail('HOST_INSTALL_BUSY');
      await delay(100);
    }
  }
  try { return await fn(); }
  finally { try { if (readJson(file).token === token) fs.unlinkSync(file); } catch {} }
}
export function readAdapter(packageRoot = ROOT) {
  const metaFile = path.join(packageRoot, 'host/adapter-meta.json');
  const patchFile = path.join(packageRoot, 'host/adapter.patch');
  if (!exists(metaFile) || !exists(patchFile)) fail('ADAPTER_FILES_MISSING');
  let meta;
  try { meta = readJson(metaFile); } catch { fail('ADAPTER_METADATA_INVALID'); }
  const patch = fs.readFileSync(patchFile);
  if (meta.schemaVersion !== 1 || meta.repository?.replace(/\.git$/, '').replace(/\/$/, '') !== PI_WEB_REPOSITORY ||
      meta.baseCommit !== PI_WEB_BASE || meta.piWebVersion !== PI_WEB_VERSION ||
      !/^[a-f0-9]{64}$/.test(meta.patchSha256 || '') || sha(patch) !== meta.patchSha256 || patch.length === 0) fail('ADAPTER_METADATA_MISMATCH');
  return { ...meta, patchFile, patchSha256: sha(patch) };
}
function verifyPackage(dir) {
  const pkg = readJson(path.join(dir, 'package.json'));
  if (pkg.name !== '@agegr/pi-web' || pkg.version !== PI_WEB_VERSION || pkg.bin?.['pi-web'] !== 'bin/pi-web.js') fail('PI_WEB_VERSION_MISMATCH');
  return path.join(dir, 'bin/pi-web.js');
}
function verifyBuild(dir) {
  verifyPackage(dir);
  if (!fs.readFileSync(path.join(dir, '.next/BUILD_ID'), 'utf8').trim() ||
      !fs.statSync(path.join(dir, 'node_modules/next/dist/bin/next')).isFile()) fail('BUILD_ARTIFACTS_MISSING');
}
function cached(dir, meta, key) {
  try {
    const receipt = readJson(path.join(dir, '.pi-paseo-install.json'));
    verifyBuild(dir);
    return receipt.key === key && receipt.baseCommit === meta.baseCommit && receipt.patchSha256 === meta.patchSha256 &&
      receipt.binSha256 === sha(fs.readFileSync(path.join(dir, 'bin/pi-web.js'))) &&
      receipt.lockSha256 === sha(fs.readFileSync(path.join(dir, 'package-lock.json'))) &&
      receipt.buildId === fs.readFileSync(path.join(dir, '.next/BUILD_ID'), 'utf8').trim();
  } catch { return false; }
}
async function copyPrebuilt(source, stage, run, env, meta) {
  verifyBuild(source);
  if (await run('git', ['rev-parse', 'HEAD'], { cwd: source, env }) !== PI_WEB_BASE) fail('PREBUILT_BASE_MISMATCH');
  await run('git', ['apply', '--reverse', '--check', meta.patchFile], { cwd: source, env });
  // Compare every tracked/new source file, including the lockfile, against the
  // freshly patched checkout. Reusing arbitrary .next directories is rejected.
  const files = (await run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: stage, env })).split('\0').filter(Boolean).sort();
  const actual = (await run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: source, env })).split('\0').filter(Boolean).sort();
  const present = files.filter(file => exists(path.join(stage, file)));
  if (JSON.stringify(present) !== JSON.stringify(actual.filter(file => exists(path.join(source, file))))) fail('PREBUILT_SOURCE_MISMATCH');
  for (const file of present) {
    const left = path.join(stage, file), right = path.join(source, file);
    if (fs.lstatSync(left).isSymbolicLink()) {
      if (!fs.lstatSync(right).isSymbolicLink() || fs.readlinkSync(left) !== fs.readlinkSync(right)) fail('PREBUILT_SOURCE_MISMATCH');
    } else if (!fs.lstatSync(right).isFile() || sha(fs.readFileSync(left)) !== sha(fs.readFileSync(right))) fail('PREBUILT_SOURCE_MISMATCH');
  }
  const artifacts = ['node_modules', '.next'].map(directory => ({ source: fs.realpathSync(path.join(source, directory)), destination: path.join(stage, directory) }));
  for (const artifact of artifacts) fs.cpSync(artifact.source, artifact.destination, {
    recursive: true, dereference: false, verbatimSymlinks: true,
    filter: file => file !== path.join(artifacts[1].source, 'cache') && !within(path.join(artifacts[1].source, 'cache'), file),
  });
  // Keep npm's relative .bin links functional, while remapping absolute links
  // into the copied release. External artifact links cannot be made immutable.
  function relocate(directory, artifact) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) relocate(file, artifact);
      else if (entry.isSymbolicLink()) {
        const original = path.join(artifact.source, path.relative(artifact.destination, file));
        const target = fs.realpathSync(original);
        const mapping = artifacts.find(item => target === item.source || within(item.source, target));
        if (!mapping) fail('PREBUILT_SOURCE_MISMATCH');
        const copiedTarget = path.join(mapping.destination, path.relative(mapping.source, target));
        fs.unlinkSync(file);
        fs.symlinkSync(path.relative(path.dirname(file), copiedTarget), file);
      }
    }
  }
  for (const artifact of artifacts) relocate(artifact.destination, artifact);
  verifyBuild(stage);
}
function findNative(home, root, env, explicit) {
  const shim = path.join(home, '.local/bin/pi-web');
  const candidates = explicit ? [explicit] : (env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.resolve(dir, 'pi-web'));
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate) || candidate === shim || within(root, candidate) || !executable(candidate)) continue;
    const real = fs.realpathSync(candidate);
    if (real === shim || within(root, real)) continue;
    return candidate;
  }
  return null;
}
function wrapper(nativeBin, fallback) {
  return `#!/usr/bin/env node\n${MARKER}\nimport fs from 'node:fs';\nimport {spawn} from 'node:child_process';\nconst adapter=${JSON.stringify(nativeBin)};\nconst fallback=${JSON.stringify(fallback)};\nconst ready=fs.existsSync(adapter)&&fs.existsSync(${JSON.stringify(path.resolve(nativeBin, '../../.next/BUILD_ID'))});\nconst child=ready?spawn(${JSON.stringify(process.execPath)},[adapter,...process.argv.slice(2)],{stdio:'inherit',env:process.env}):spawn(fallback,process.argv.slice(2),{stdio:'inherit',env:process.env});\nfor(const signal of ['SIGINT','SIGTERM','SIGHUP'])process.on(signal,()=>child.kill(signal));\nchild.on('error',()=>{process.stderr.write('Pi Paseo web launcher failed.\\n');process.exitCode=1;});\nchild.on('exit',(code,signal)=>{process.exitCode=code??(signal?1:0);});\n`;
}
function installRouting({ home, root, nativeBin, env, sharedHostPath, omnigentHostPath, nativeLauncher, write }) {
  const shim = path.join(home, '.local/bin/pi-web');
  let metadata = sharedHostPath && exists(sharedHostPath) ? sharedHostPath : null;
  let routingStatus = 'shared-runtime';
  if (!metadata && omnigentHostPath && exists(omnigentHostPath) && exists(shim)) {
    const launcher = fs.readFileSync(shim, 'utf8');
    if (launcher.includes('// pi-omnigent-plugin web launcher')) {
      if (fs.lstatSync(omnigentHostPath).isSymbolicLink()) fail('UNSAFE_METADATA_PATH');
      const config = readJson(omnigentHostPath);
      if (config.version === 1 && config.mode === 'path-wrapper' && config.shim === shim) {
        metadata = omnigentHostPath;
        routingStatus = 'omnigent';
      }
    }
  }
  if (metadata) {
    if (fs.lstatSync(metadata).isSymbolicLink()) fail('UNSAFE_METADATA_PATH');
    const original = fs.readFileSync(metadata, 'utf8');
    const config = JSON.parse(original);
    if (typeof config.realWeb !== 'string' || !path.isAbsolute(config.realWeb)) fail('SHARED_ROUTING_INVALID');
    if (config.realWeb !== nativeBin) {
      if (!Object.hasOwn(config, 'realWebBeforePiPaseo')) config.realWebBeforePiPaseo = config.realWeb;
      config.realWeb = nativeBin;
      write(metadata, JSON.stringify(config, null, 2) + '\n', fs.statSync(metadata).mode & 0o777, original);
    }
    return { status: routingStatus, launcher: config.shim || shim, metadata, previousNative: config.realWebBeforePiPaseo || null };
  }
  const routingFile = path.join(root, 'host-routing.json');
  const resumeFile = path.join(root, 'host-routing-resume.json');
  let record;
  if (exists(routingFile)) record = readJson(routingFile);
  const current = exists(shim) ? fs.readFileSync(shim, 'utf8') : null;
  if (exists(resumeFile)) {
    if (!fs.lstatSync(resumeFile).isFile()) fail('UNSAFE_METADATA_PATH');
    const resume = readJson(resumeFile);
    if (resume.schemaVersion === 1 && resume.launcher === shim && typeof resume.previousNative === 'string' &&
        path.isAbsolute(resume.previousNative) && /^[a-f0-9]{64}$/.test(resume.wrapperSha256 || '') &&
        current !== null && sha(current) === resume.wrapperSha256 && current.includes(MARKER)) record = resume;
  }
  if (current !== null && (!record || sha(current) !== record.wrapperSha256 || !current.includes(MARKER))) {
    return { status: 'manual-routing-required', launcher: shim, reason: 'Existing launcher preserved; chain it to pendingRestart explicitly.' };
  }
  const fallback = record?.previousNative || findNative(home, root, env, nativeLauncher || env.PI_PASEO_NATIVE_WEB);
  if (!fallback || !executable(fallback)) fail('NATIVE_PI_WEB_UNAVAILABLE');
  safeDirectory(path.dirname(shim), home);
  const source = wrapper(nativeBin, fallback);
  const receipt = JSON.stringify({ schemaVersion: 1, launcher: shim, previousNative: fallback, wrapperSha256: sha(source) }, null, 2) + '\n';
  // Persist ownership before publishing the wrapper. If killed before the
  // ordinary receipt is written, retry recognizes only these exact bytes.
  write(resumeFile, receipt);
  if (current !== source) write(shim, source, 0o755, current);
  write(routingFile, receipt);
  return { status: 'user-wrapper', launcher: shim, previousNative: fallback };
}

/** Prepare a persistent host adapter and next-start routing; never restart Pi Web. */
export async function installHost(options = {}) {
  const env = { ...process.env, ...options.env };
  const home = fs.realpathSync(path.resolve(options.home || env.HOME || os.homedir()));
  if (process.platform === 'win32') fail('POSIX_HOST_REQUIRED');
  const node = process.versions.node.split('.').map(Number);
  if (node[0] < 22 || (node[0] === 22 && (node[1] < 19 || (node[1] === 19 && node[2] < 0)))) fail('NODE_VERSION_UNSUPPORTED');
  const paseoPackageRoot = path.resolve(options.packageRoot || ROOT);
  const agentDir = env.PI_CODING_AGENT_DIR || env.PI_AGENT_DATA_DIR || path.join(home, '.pi/agent');
  const omniPackageRoot = path.resolve(options.omnigentPackageRoot || env.PI_OMNIGENT_PLUGIN_ROOT || path.join(agentDir, 'git/github.com/WOOWTECH/pi-omnigent-plugin'));
  const omniPackageFile = path.join(omniPackageRoot, 'package.json');
  if (exists(omniPackageFile)) {
    const omniPackage = readJson(omniPackageFile);
    if (omniPackage.name !== '@woowtech/pi-omnigent-plugin') fail('OMNIGENT_COORDINATOR_INVALID');
    const coordinatorFile = path.join(omniPackageRoot, 'bin/install-ui.mjs');
    if (!exists(coordinatorFile)) fail('OMNIGENT_COORDINATOR_UNAVAILABLE');
    const coordinator = await import(pathToFileURL(coordinatorFile).href);
    if (typeof coordinator.installUi !== 'function') fail('OMNIGENT_COORDINATOR_UNAVAILABLE');
    return coordinator.installUi({ ...options, home, env, packageRoot: omniPackageRoot, overlayPackageRoot: paseoPackageRoot });
  }
  const root = path.join(home, '.local/share/pi-paseo');
  const releases = path.join(root, 'pi-web-releases');
  const destination = path.join(root, 'pi-web');
  const meta = readAdapter(path.resolve(options.packageRoot || ROOT));
  safeDirectory(releases, home);
  const run = options.run || runCommand;
  const sharedHostPath = options.sharedHostPath ?? env.PI_PASEO_SHARED_HOST_METADATA ?? path.join(
    env.PI_CODING_AGENT_DIR || env.PI_AGENT_DATA_DIR || (home.startsWith('/data/pi-agent/') ? '/data/pi-agent' : path.join(home, '.pi/agent')), 'shared-runtime/host.json');
  const omnigentHostPath = options.omnigentHostPath ?? path.join(
    env.PI_CODING_AGENT_DIR || env.PI_AGENT_DATA_DIR || (home.startsWith('/data/pi-agent/') ? '/data/pi-agent' : path.join(home, '.pi/agent')), 'omnigent-plugin/host.json');
  const key = sha(JSON.stringify([PI_WEB_BASE, meta.patchSha256, process.version, process.platform, process.arch]));
  return locked(root, async () => {
    let active = null;
    if (exists(destination)) {
      if (!fs.lstatSync(destination).isSymbolicLink()) fail('UNMANAGED_ADAPTER_PATH');
      active = path.resolve(root, fs.readlinkSync(destination));
      if (!within(releases, active) || !exists(path.join(active, '.pi-paseo-install.json'))) fail('UNMANAGED_ADAPTER_PATH');
    }
    let reused = active !== null && cached(active, meta, key);
    if (reused && await run('git', ['rev-parse', 'HEAD'], { cwd: active, env }) !== PI_WEB_BASE) reused = false;
    let release = active;
    if (!reused) {
      const stage = fs.mkdtempSync(path.join(releases, '.build-'));
      try {
        if (options.prebuiltRoot) {
          const prebuilt = fs.realpathSync(path.resolve(options.prebuiltRoot));
          await run('git', ['clone', '--no-hardlinks', '--no-checkout', '--', prebuilt, stage], { env });
          await run('git', ['remote', 'set-url', 'origin', PI_WEB_REPOSITORY], { cwd: stage, env });
        } else {
          await run('git', ['init', '--quiet'], { cwd: stage, env });
          await run('git', ['remote', 'add', 'origin', PI_WEB_REPOSITORY], { cwd: stage, env });
          await run('git', ['fetch', '--quiet', '--depth=1', 'origin', PI_WEB_BASE], { cwd: stage, env });
        }
        await run('git', ['checkout', '--quiet', '--detach', PI_WEB_BASE], { cwd: stage, env });
        if (await run('git', ['rev-parse', 'HEAD'], { cwd: stage, env }) !== PI_WEB_BASE) fail('PI_WEB_BASE_MISMATCH');
        verifyPackage(stage);
        await run('git', ['apply', '--check', meta.patchFile], { cwd: stage, env });
        await run('git', ['apply', meta.patchFile], { cwd: stage, env });
        verifyPackage(stage);
        if (options.prebuiltRoot) await copyPrebuilt(fs.realpathSync(path.resolve(options.prebuiltRoot)), stage, run, env, meta);
        else {
          // Next's default counts host CPUs, which can exceed container quotas.
          const buildEnv = { ...env, HOME: home, CI: '1', CIRCLE_NODE_TOTAL: '3', NEXT_TELEMETRY_DISABLED: '1', PI_PASEO_SKIP_POSTINSTALL: '1', npm_config_production: 'false', NPM_CONFIG_PRODUCTION: 'false' };
          await run('npm', ['ci', '--include=dev', '--no-audit', '--no-fund'], { cwd: stage, env: { ...buildEnv, NODE_ENV: 'development' } });
          repairSdkDependency(stage);
          await run('npm', ['run', 'build'], { cwd: stage, env: { ...buildEnv, NODE_ENV: 'production' } });
        }
        verifyBuild(stage);
        fs.chmodSync(path.join(stage, 'bin/pi-web.js'), 0o755);
        json(path.join(stage, '.pi-paseo-install.json'), { schemaVersion: 1, key, repository: PI_WEB_REPOSITORY, baseCommit: PI_WEB_BASE, piWebVersion: PI_WEB_VERSION,
          patchSha256: meta.patchSha256, binSha256: sha(fs.readFileSync(path.join(stage, 'bin/pi-web.js'))), lockSha256: sha(fs.readFileSync(path.join(stage, 'package-lock.json'))),
          buildId: fs.readFileSync(path.join(stage, '.next/BUILD_ID'), 'utf8').trim(), prebuilt: !!options.prebuiltRoot, installedAt: new Date().toISOString() });
        release = path.join(releases, `${key}-${randomUUID()}`);
        fs.renameSync(stage, release);
      } catch (error) { fs.rmSync(stage, { recursive: true, force: true }); throw error; }
    }
    const nativeBin = path.join(destination, 'bin/pi-web.js');
    const transaction = routingTransaction();
    const previousLink = active === null ? null : fs.readlinkSync(destination);
    const nextLink = path.relative(root, release);
    let published = false;
    const publish = target => {
      const tempLink = path.join(root, `.pi-web-${randomUUID()}`);
      try { fs.symlinkSync(target, tempLink, 'dir'); fs.renameSync(tempLink, destination); }
      finally { fs.rmSync(tempLink, { force: true }); }
    };
    try {
      if (!reused) { publish(nextLink); published = true; }
      const routing = installRouting({ home, root, nativeBin, env, sharedHostPath, omnigentHostPath, nativeLauncher: options.nativeLauncher, write: transaction.write });
      const firstLauncher = (env.PATH || '').split(path.delimiter).filter(Boolean)
        .map(dir => path.resolve(dir, 'pi-web')).find(executable);
      const result = { status: reused ? 'already-installed' : 'installed', adapterRoot: destination, releaseRoot: release, baseCommit: PI_WEB_BASE, piWebVersion: PI_WEB_VERSION,
        patchSha256: meta.patchSha256, reused, routing, pendingRestart: nativeBin, restartRequired: true, restarted: false,
        launcherDirectory: path.dirname(routing.launcher), pathUpdateRequired: firstLauncher !== routing.launcher };
      transaction.write(path.join(root, 'host-install.json'), JSON.stringify(result, null, 2) + '\n');
      return result;
    } catch (error) {
      let rollbackFailed = false;
      if (published) {
        try {
          if (!exists(destination) || !fs.lstatSync(destination).isSymbolicLink() || fs.readlinkSync(destination) !== nextLink) fail('ROUTING_CHANGED_RETRY');
          if (previousLink === null) fs.unlinkSync(destination);
          else publish(previousLink);
        } catch { rollbackFailed = true; }
      }
      try { transaction.rollback(); } catch { rollbackFailed = true; }
      // If concurrent routing changes prevent recovery, keep the built release
      // available for the operator rather than deleting a potentially used path.
      if (!reused && !rollbackFailed) fs.rmSync(release, { recursive: true, force: true });
      if (rollbackFailed) fail('HOST_INSTALL_ROLLBACK_FAILED');
      throw error;
    }
  }, options.lockTimeoutMs ?? 900000);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    const index = args.indexOf('--prebuilt-root');
    if (args.some((arg, i) => arg !== '--prebuilt-root' && i !== index + 1) || (index >= 0 && !args[index + 1])) fail('INVALID_ARGUMENTS');
    console.log(JSON.stringify(await installHost(index < 0 ? {} : { prebuiltRoot: args[index + 1] }), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ error: 'HostInstallError', code: error instanceof HostInstallError ? error.code : 'HOST_INSTALL_FAILED' }));
    process.exitCode = 1;
  }
}
