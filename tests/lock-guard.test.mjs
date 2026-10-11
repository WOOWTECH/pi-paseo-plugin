import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readRecord } from '../src/onboarding.mjs';
import { processIdentity } from '../src/state.mjs';

const linux = { skip: process.platform !== 'linux', timeout: 15000 };
const stateUrl = new URL('../src/state.mjs', import.meta.url).href;
const onboardingUrl = new URL('../src/onboarding.mjs', import.meta.url).href;
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-paseo-lock-guard-'));
  const env = { PATH: '/usr/bin:/bin', HOME: path.join(dir, 'home'), PI_CODING_AGENT_DIR: path.join(dir, 'agent'), PI_PASEO_STATE_DIR: path.join(dir, 'state'), PI_PASEO_RUNTIME_DIR: path.join(dir, 'runtime') };
  for (const key of ['HOME', 'PI_CODING_AGENT_DIR', 'PI_PASEO_STATE_DIR']) fs.mkdirSync(env[key], { mode: 0o700 });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, env };
}
async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Lock test barrier timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
function worker(t, source, args, env) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, ...args], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  const exited = once(child, 'exit').then(([code, signal]) => ({ code, signal, errors }));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  return { child, exited };
}

// Pause one reclaimer immediately before its destructive syscall. A second
// process must contend for the OS guard rather than inspect the old lock and
// remove the first process's replacement. The barriers also catch the old code
// deterministically: its second process enters while the first is still paused.
const reclaimerSource = [
  "import fs from 'node:fs';",
  "import cp from 'node:child_process';",
  "import { syncBuiltinESMExports } from 'node:module';",
  'import { withLock } from ' + JSON.stringify(onboardingUrl) + ';',
  'import { withRuntimeLock, updateState } from ' + JSON.stringify(stateUrl) + ';',
  'const [kind, lock, prefix, pause] = process.argv.slice(1);',
  "const mark = suffix => fs.writeFileSync(prefix + suffix, 'ready');",
  "const syncWait = file => { while (!fs.existsSync(file)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); };",
  "const asyncWait = async file => { while (!fs.existsSync(file)) await new Promise(resolve => setTimeout(resolve, 5)); };",
  'const originalSpawn = cp.spawnSync;',
  "cp.spawnSync = function(...args) { const result = originalSpawn(...args); if (result.status === 73) mark('.contended'); return result; };",
  'syncBuiltinESMExports();',
  "const deletion = kind === 'directory' ? 'rmSync' : 'unlinkSync';",
  'const originalDelete = fs[deletion]; let paused = false;',
  "fs[deletion] = function(file, ...args) { if (file === lock && pause === 'yes' && !paused) { paused = true; mark('.inspected'); syncWait(prefix + '.proceed'); } return originalDelete(file, ...args); };",
  "mark('.started');",
  "if (kind === 'state') {",
  '  const originalRename = fs.renameSync;',
  "  fs.renameSync = function(a, b) { if (b.endsWith('/state.json')) { mark('.entered'); syncWait(prefix + '.finish'); } return originalRename(a, b); };",
  "  updateState({ [prefix.endsWith('/a') ? 'first' : 'second']: true });",
  "} else {",
  "  const body = async () => { mark('.entered'); await asyncWait(prefix + '.finish'); };",
  "  if (kind === 'directory') await withLock(lock, body); else await withRuntimeLock(body);",
  '}',
].join('\n');

for (const kind of ['directory', 'runtime', 'state']) {
  test('concurrent stale ' + kind + ' reapers retain one live owner', linux, async t => {
    const { dir, env } = fixture(t);
    const lock = path.join(env.PI_PASEO_STATE_DIR, kind === 'directory' ? 'operation.lock' : kind + '.lock');
    const oldOwner = JSON.stringify({ pid: 99999999, identity: 'dead', token: 'abandoned' });
    if (kind === 'directory') { fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'owner.json'), oldOwner); }
    else fs.writeFileSync(lock, oldOwner);
    const a = path.join(dir, 'a'), b = path.join(dir, 'b');
    const first = worker(t, reclaimerSource, [kind, lock, a, 'yes'], env);
    await waitFor(() => fs.existsSync(a + '.inspected'));
    const second = worker(t, reclaimerSource, [kind, lock, b, 'no'], env);
    await waitFor(() => fs.existsSync(b + '.entered') || fs.existsSync(b + '.contended'));
    const enteredBeforeReclamation = fs.existsSync(b + '.entered');
    fs.writeFileSync(a + '.proceed', 'go');
    await waitFor(() => fs.existsSync(a + '.entered'));
    const owner = readRecord(kind === 'directory' ? path.join(lock, 'owner.json') : lock);
    assert.ok(processIdentity(owner.pid));
    // The OS guard protects the transition, not the user's operation body.
    const guard = lock + '.guard';
    let guardAvailable = false;
    if (fs.existsSync(guard)) {
      // The second process can briefly hold the transition guard while checking
      // the live logical owner. Wait for that check instead of sampling its race.
      await waitFor(() => {
        const fd = fs.openSync(guard, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
        try { guardAvailable = spawnSync('/usr/bin/flock', ['-x', '-n', '-E', '73', '3'], { stdio: ['ignore', 'ignore', 'ignore', fd] }).status === 0; }
        finally { fs.closeSync(fd); }
        return guardAvailable;
      });
    }
    fs.writeFileSync(a + '.finish', 'done');
    assert.equal((await first.exited).code, 0);
    await waitFor(() => fs.existsSync(b + '.entered'));
    fs.writeFileSync(b + '.finish', 'done');
    assert.equal((await second.exited).code, 0);
    assert.equal(enteredBeforeReclamation, false, 'second reclaimer entered before the paused first transition finished');
    assert.equal(guardAvailable, true, 'guard must be released before the operation callback');
    assert.equal(fs.existsSync(lock), false);
    if (kind === 'state') {
      const state = JSON.parse(fs.readFileSync(path.join(env.PI_PASEO_STATE_DIR, 'state.json'), 'utf8'));
      assert.equal(state.first, true);
      assert.equal(state.second, true, 'serialized state updates must preserve both patches');
    }
  });

  test('SIGKILL during a stale ' + kind + ' transition releases its OS guard', linux, async t => {
    const { dir, env } = fixture(t);
    const lock = path.join(env.PI_PASEO_STATE_DIR, kind === 'directory' ? 'operation.lock' : kind + '.lock');
    const oldOwner = JSON.stringify({ pid: 99999999, identity: 'dead', token: 'abandoned' });
    if (kind === 'directory') { fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'owner.json'), oldOwner); }
    else fs.writeFileSync(lock, oldOwner);
    const a = path.join(dir, 'a'), b = path.join(dir, 'b');
    const first = worker(t, reclaimerSource, [kind, lock, a, 'yes'], env);
    await waitFor(() => fs.existsSync(a + '.inspected'));
    first.child.kill('SIGKILL');
    assert.equal((await first.exited).signal, 'SIGKILL');
    const second = worker(t, reclaimerSource, [kind, lock, b, 'no'], env);
    await waitFor(() => fs.existsSync(b + '.entered'));
    fs.writeFileSync(b + '.finish', 'done');
    const result = await second.exited;
    assert.equal(result.code, 0, result.errors);
    assert.equal(fs.existsSync(lock), false);
  });
}

const failureImports = [
  "import assert from 'node:assert/strict';",
  "import fs from 'node:fs';",
  "import path from 'node:path';",
  "import {spawnSync} from 'node:child_process';",
  'import { withLock } from ' + JSON.stringify(onboardingUrl) + ';',
  'import { withRuntimeLock, updateState, withLockTransition, processIdentity } from ' + JSON.stringify(stateUrl) + ';',
  'const [dir] = process.argv.slice(1);',
  "const stateDir = process.env.PI_PASEO_STATE_DIR;",
  "const fail = () => assert.fail('operation must not execute');",
  "const code = expected => error => error.code === expected && error.message === expected;",
  "function guardReleased(file) {",
  "  const guard = file + '.guard';",
  "  assert.equal(fs.readdirSync('/proc/self/fd').some(name => { try { return fs.readlinkSync('/proc/self/fd/' + name) === guard; } catch { return false; } }), false, 'guard descriptor leaked');",
  "  const fd = fs.openSync(guard, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);",
  "  try { assert.equal(spawnSync('/usr/bin/flock', ['-x', '-n', '-E', '73', '3'], {stdio:['ignore','ignore','ignore',fd]}).status, 0, 'guard OS lock leaked'); } finally { fs.closeSync(fd); }",
  "  assert.equal(fs.statSync(guard).mode & 0o777, 0o600);",
  '}',
].join('\n');
async function failureCase(t, body) {
  const { dir, env } = fixture(t);
  const child = worker(t, failureImports + '\n' + body, [dir], env);
  const result = await child.exited;
  assert.equal(result.code, 0, result.errors);
}

test('missing flock fails closed for directory, runtime and state locks', linux, t => failureCase(t, `
  const bin = path.join(dir, 'empty-bin'); fs.mkdirSync(bin); process.env.PATH = bin;
  const directory = path.join(stateDir, 'operation.lock');
  await assert.rejects(withLock(directory, fail), code('LOCK_GUARD_UNAVAILABLE'));
  await assert.rejects(withRuntimeLock(fail), code('LOCK_GUARD_UNAVAILABLE'));
  assert.throws(() => updateState({first:true}), code('LOCK_GUARD_UNAVAILABLE'));
  for (const file of [directory, path.join(stateDir,'runtime.lock'), path.join(stateDir,'state.lock')]) {
    assert.equal(fs.existsSync(file), false); guardReleased(file);
  }
`));

for (const failure of ['exit', 'signal', 'timeout']) {
  test('flock ' + failure + ' fails closed without process or descriptor leaks', linux, t => failureCase(t, `
    const bin = path.join(dir, 'bin'); fs.mkdirSync(bin); process.env.PATH = bin;
    const pidFile = path.join(dir, 'helper.pid');
    const script = [
      '#!' + process.execPath,
      "const fs=require('node:fs'); const cp=require('node:child_process');",
      "fs.writeFileSync(" + JSON.stringify(pidFile) + ",String(process.pid));",
      ${JSON.stringify(failure === 'timeout' ? "if(cp.spawnSync('/usr/bin/flock',['-x','-n','3'],{stdio:['ignore','ignore','ignore',3]}).status!==0)process.exit(21);" : "process.stderr.write('fixture-private-output');")},
      ${JSON.stringify(failure === 'exit' ? "process.exit(19);" : failure === 'signal' ? "process.kill(process.pid,'SIGKILL');" : "setInterval(()=>{},1000);")},
    ];
    fs.writeFileSync(path.join(bin,'flock'), script.join('\\n'), {mode:0o700});
    const file = path.join(stateDir,'runtime.lock');
    const started = Date.now();
    ${failure === 'timeout'
      ? "assert.throws(()=>withLockTransition(file,fail,{timeoutMs:800}),code('LOCK_GUARD_TIMEOUT'));"
      : "await assert.rejects(withRuntimeLock(fail,{timeoutMs:800}),code('LOCK_GUARD_FAILED'));"}
    assert.ok(Date.now()-started<2000, 'helper failure must be bounded');
    assert.equal(processIdentity(Number(fs.readFileSync(pidFile,'utf8'))), null, 'helper process was not reaped');
    assert.equal(fs.existsSync(file),false); guardReleased(file);
    process.env.PATH='/usr/bin:/bin';
    assert.equal(await withRuntimeLock(()=>42),42); guardReleased(file);
  `));
}

for (const kind of ['directory', 'runtime', 'state']) {
  test('expired ' + kind + ' deadline reports busy after a flock helper timeout', linux, t => failureCase(t, `
    const bin=path.join(dir,'deadline-bin'); fs.mkdirSync(bin); process.env.PATH=bin;
    // This helper execs Node directly and hangs; it never forks children.
    fs.writeFileSync(path.join(bin,'flock'),'#!'+process.execPath+'\\nsetInterval(()=>{},1000);\\n',{mode:0o700});
    const cp=await import('node:child_process');
    const {syncBuiltinESMExports}=await import('node:module');
    const originalSpawn=cp.default.spawnSync, originalNow=Date.now;
    const start=1000000, deadline=start+3000;
    let clockCalls=0, timedOut=false, helperPid, helperCalls=0, callbackCalls=0;
    // Pin a 10 ms remaining budget without depending on CI scheduling. The real
    // spawnSync timeout still runs; its return advances the enclosing clock.
    Date.now=()=>clockCalls++===0?start:timedOut?deadline:deadline-10;
    cp.default.spawnSync=function(command,args,options) {
      if(command!=='flock')return originalSpawn(command,args,options);
      helperCalls++; assert.equal(options.timeout,10);
      const result=originalSpawn(command,args,options);
      assert.equal(result.error?.code,'ETIMEDOUT'); assert.ok(result.pid>1);
      helperPid=result.pid; timedOut=true; return result;
    };
    syncBuiltinESMExports();
    const body=()=>{callbackCalls++;};
    const file=path.join(stateDir,'${kind === 'directory' ? 'operation' : kind}.lock');
    const expected='${kind === 'directory' ? 'LOCK_BUSY' : kind === 'runtime' ? 'RUNTIME_BUSY' : 'STATE_BUSY'}';
    try {
      ${kind === 'state'
        ? "assert.throws(()=>updateState({deadlineProbe:true}),error=>error.code===expected);"
        : `await assert.rejects(${kind === 'directory' ? 'withLock(file,body,{timeoutMs:3000})' : 'withRuntimeLock(body,{timeoutMs:3000})'},error=>error.code===expected);`}
    } finally {
      Date.now=originalNow; cp.default.spawnSync=originalSpawn; syncBuiltinESMExports();
    }
    assert.equal(helperCalls,1); assert.equal(callbackCalls,0);
    assert.equal(fs.existsSync(file),false,'protected acquisition ran after timeout');
    assert.equal(fs.existsSync(path.join(stateDir,'state.json')),false,'state was written after timeout');
    assert.equal(processIdentity(helperPid),null,'timed-out helper was not reaped');
    guardReleased(file);
  `));
}

test('helper timeout before an enclosing deadline remains a guard failure', linux, t => failureCase(t, `
  const bin=path.join(dir,'early-timeout-bin'); fs.mkdirSync(bin); process.env.PATH=bin;
  fs.writeFileSync(path.join(bin,'flock'),'#!'+process.execPath+'\\nsetInterval(()=>{},1000);\\n',{mode:0o700});
  const file=path.join(stateDir,'early.lock');
  assert.throws(()=>withLockTransition(file,fail,{timeoutMs:10,deadline:Date.now()+60000}),code('LOCK_GUARD_TIMEOUT'));
  assert.equal(fs.existsSync(file),false); guardReleased(file);
`));

test('guard symlinks, including a link introduced at open, never touch their target', linux, t => failureCase(t, `
  const target=path.join(dir,'external'); fs.writeFileSync(target,'unchanged',{mode:0o644});
  const file=path.join(stateDir,'operation.lock'), guard=file+'.guard';
  fs.symlinkSync(target,guard);
  await assert.rejects(withLock(file,fail),code('UNSAFE_SYMLINK'));
  assert.equal(fs.readFileSync(target,'utf8'),'unchanged');
  assert.equal(fs.statSync(target).mode&0o777,0o644);
  fs.unlinkSync(guard);
  const original=fs.openSync;
  fs.openSync=function(name,...args){if(name===guard&&!fs.existsSync(guard))fs.symlinkSync(target,guard);return original(name,...args);};
  await assert.rejects(withLock(file,fail),code('UNSAFE_SYMLINK'));
  fs.openSync=original;
  assert.equal(fs.readFileSync(target,'utf8'),'unchanged');
  assert.equal(fs.statSync(target).mode&0o777,0o644);
  assert.equal(fs.existsSync(file),false);
`));

test('unsupported platforms fail closed rather than using PID-only reclamation', linux, t => failureCase(t, `
  for(const platform of ['darwin','win32']) {
    Object.defineProperty(process,'platform',{value:platform});
    await assert.rejects(withLock(path.join(stateDir,'operation.lock'),fail),code('LOCK_GUARD_UNSUPPORTED'));
    await assert.rejects(withRuntimeLock(fail),code('LOCK_GUARD_UNSUPPORTED'));
    assert.throws(()=>updateState({first:true}),code('LOCK_GUARD_UNSUPPORTED'));
  }
  assert.deepEqual(fs.readdirSync(stateDir),[]);
`));

test('guard contention respects timeouts and AbortSignal without stealing the guard', linux, t => failureCase(t, `
  for(const kind of ['directory','runtime']) {
    const file=path.join(stateDir,kind==='directory'?'operation.lock':'runtime.lock');
    const fd=fs.openSync(file+'.guard',fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_NOFOLLOW,0o600);
    try {
      assert.equal(spawnSync('/usr/bin/flock',['-x','-n','3'],{stdio:['ignore','ignore','ignore',fd]}).status,0);
      const acquire=options=>kind==='directory'?withLock(file,fail,options):withRuntimeLock(fail,options);
      const started=Date.now();
      await assert.rejects(acquire({timeoutMs:80}),error=>error.code===(kind==='directory'?'LOCK_BUSY':'RUNTIME_BUSY'));
      assert.ok(Date.now()-started<1000);
      const controller=new AbortController();
      const waiting=acquire({timeoutMs:5000,signal:controller.signal});
      const timer=setTimeout(()=>controller.abort(new Error('fixture-private-abort-reason')),20);
      try {await assert.rejects(waiting,code('LOCK_ABORTED'));} finally {clearTimeout(timer);}
      assert.equal(fs.existsSync(file),false);
    } finally {fs.closeSync(fd);}
    guardReleased(file);
  }
`));

test('cancelling a wait for a live logical owner preserves that owner', linux, t => failureCase(t, `
  for(const kind of ['directory','runtime']) {
    const file=path.join(stateDir,kind==='directory'?'operation.lock':'runtime.lock');
    const acquire=(fn,options)=>kind==='directory'?withLock(file,fn,options):withRuntimeLock(fn,options);
    await acquire(async()=>{
      const ownerFile=kind==='directory'?path.join(file,'owner.json'):file;
      const owner=fs.readFileSync(ownerFile,'utf8');
      const controller=new AbortController();const pending=acquire(fail,{signal:controller.signal});controller.abort();
      await assert.rejects(pending,code('LOCK_ABORTED'));
      assert.equal(fs.readFileSync(ownerFile,'utf8'),owner);
    });
    assert.equal(fs.existsSync(file),false);guardReleased(file);
    const controller=new AbortController();controller.abort();
    await assert.rejects(acquire(fail,{signal:controller.signal}),code('LOCK_ABORTED'));
    assert.equal(await acquire(()=>42),42);
  }
`));

test('failed owner publication and failed operation bodies leave reusable locks', linux, t => failureCase(t, `
  const original=fs.fsyncSync;
  fs.fsyncSync=()=>{throw Object.assign(new Error('fixture failure'),{code:'EIO'});};
  const directory=path.join(stateDir,'operation.lock');
  await assert.rejects(withLock(directory,fail),code('LOCK_GUARD_FAILED'));
  await assert.rejects(withRuntimeLock(fail),code('LOCK_GUARD_FAILED'));
  fs.fsyncSync=original;
  for(const file of [directory,path.join(stateDir,'runtime.lock')]){assert.equal(fs.existsSync(file),false);guardReleased(file);}
  await assert.rejects(withLock(directory,()=>{throw new Error('fixture body failure');}),/fixture body failure/);
  await assert.rejects(withRuntimeLock(()=>{throw new Error('fixture body failure');}),/fixture body failure/);
  assert.equal(await withLock(directory,()=>42),42);
  assert.equal(await withRuntimeLock(()=>42),42);
  for(const file of [directory,path.join(stateDir,'runtime.lock')]){assert.equal(fs.existsSync(file),false);guardReleased(file);}
`));
