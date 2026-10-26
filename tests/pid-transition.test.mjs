import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {withPidTransition} from '../src/pid-transition.mjs';
import {patchPidLockSource,applyPidLockPatch,pidLockPatchReady,PID_LOCK_COPIES,ORIGINAL_PID_LOCK_SHA256,PATCHED_PID_LOCK_SHA256} from '../src/pid-lock-patch.mjs';
import {runtimeDirectory,markRuntimeReady,runtimeReady,previousRuntimeDirectory} from '../src/runtime-layout.mjs';
import {seedPidFiles} from './helpers/runtime-pid-files.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const original=fs.readFileSync(new URL('./fixtures/paseo-0.11.2/pid-lock.js',import.meta.url),'utf8');
function home(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'paseo-transition-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function runtime(t){const loc={runtimeDir:home(t)};seedPidFiles(loc);const root=runtimeDirectory(loc),cli=path.join(root,'node_modules/@getpaseo/cli');fs.mkdirSync(cli,{recursive:true});fs.writeFileSync(path.join(cli,'package.json'),JSON.stringify({version:'0.11.2'}));return{loc,root};}

test('frozen official writer bytes patch deterministically and idempotently',()=>{
 assert.equal(sha(original),ORIGINAL_PID_LOCK_SHA256);
 const patched=patchPidLockSource(original);assert.equal(sha(patched),PATCHED_PID_LOCK_SHA256);
 assert.equal(patchPidLockSource(patched),patched);
 assert.throws(()=>patchPidLockSource(original+'\n'),{code:'PID_LOCK_SOURCE_MISMATCH'});
});
test('unknown second official copy aborts before either copy/helper is modified',t=>{
 const {root}=runtime(t),first=path.join(root,'node_modules/@getpaseo/server',PID_LOCK_COPIES[0]),second=path.join(root,'node_modules/@getpaseo/server',PID_LOCK_COPIES[1]);
 fs.appendFileSync(path.join(second,'pid-lock.js'),'\n');
 assert.throws(()=>applyPidLockPatch(root),{code:'PID_LOCK_SOURCE_MISMATCH'});
 assert.equal(fs.readFileSync(path.join(first,'pid-lock.js'),'utf8'),original);
 assert.equal(fs.existsSync(path.join(first,'pi-paseo-pid-transition.mjs')),false);
});
test('readiness requires receipt and patched bytes of BOTH official copies and helpers',t=>{
 const {loc,root}=runtime(t);assert.equal(runtimeReady(loc),false);markRuntimeReady(loc);assert.equal(runtimeReady(loc),true);
 for(const relative of PID_LOCK_COPIES){
  const dir=path.join(root,'node_modules/@getpaseo/server',relative);
  for(const name of ['pid-lock.js','pi-paseo-pid-transition.mjs']){
   const file=path.join(dir,name),bytes=fs.readFileSync(file);fs.appendFileSync(file,'\n');assert.equal(pidLockPatchReady(root),false);assert.equal(runtimeReady(loc),false);fs.writeFileSync(file,bytes);
  }
 }
 assert.equal(runtimeReady(loc),true);
 const file=path.join(root,'node_modules/@getpaseo/server',PID_LOCK_COPIES[0],'pid-lock.js');
 const before=fs.statSync(file);markRuntimeReady(loc);assert.equal(fs.statSync(file).mtimeMs,before.mtimeMs);
});
test('async guard remains locked across awaited callback and releases after throw',async t=>{
 const dir=home(t),guard=path.join(dir,'.pi-paseo-pid-transition.guard');
 await assert.rejects(withPidTransition(dir,async()=>{
  await Promise.resolve();
  await assert.rejects(withPidTransition(dir,()=>assert.fail('guard released before await'),{timeoutMs:30}),{code:'DAEMON_TRANSITION_BUSY'});
  throw Object.assign(new Error('fixture'),{code:'FIXTURE'});
 }),{code:'FIXTURE'});
 const ino=fs.statSync(guard).ino;assert.equal(fs.statSync(guard).mode&0o777,0o600);
 assert.equal(await withPidTransition(dir,async()=>{await Promise.resolve();return 'released';}),'released');assert.equal(fs.statSync(guard).ino,ino);
});
for(const [label,mutate]of [
 ['public directory',dir=>fs.chmodSync(dir,0o755)],
 ['public guard',dir=>fs.writeFileSync(path.join(dir,'.pi-paseo-pid-transition.guard'),'keep',{mode:0o644})],
 ['hardlinked guard',dir=>{const file=path.join(dir,'.pi-paseo-pid-transition.guard');fs.writeFileSync(file,'keep',{mode:0o600});fs.linkSync(file,file+'.link');}],
 ['symlink guard',dir=>{const file=path.join(dir,'.pi-paseo-pid-transition.guard');fs.writeFileSync(file+'.target','keep',{mode:0o600});fs.symlinkSync(file+'.target',file);}],
])test(label+' rejects without executing callback',async t=>{const dir=home(t);mutate(dir);await assert.rejects(withPidTransition(dir,()=>assert.fail('unsafe guard entered')));});
test('official release/refresh missing home semantics do not create a directory',async t=>{
 const dir=path.join(home(t),'missing');assert.equal(await withPidTransition(dir,()=>true),true);assert.equal(fs.existsSync(dir),false);
});

test('supported r2 fallback requires exact receipt, package versions, writer bytes and safe path',t=>{
 const {loc,root}=runtime(t);markRuntimeReady(loc);seedPidFiles(loc);
 const old=root.replace('-r3-','-r2-'),receipt=JSON.parse(fs.readFileSync(path.join(root,'.pi-paseo-runtime.json')));receipt.revision=path.basename(old);delete receipt.pidLockPatchId;
 fs.writeFileSync(path.join(root,'.pi-paseo-runtime.json'),JSON.stringify(receipt));fs.renameSync(root,old);
 assert.equal(previousRuntimeDirectory(loc),old);
 for(const relative of ['.pi-paseo-runtime.json','node_modules/@getpaseo/cli/package.json','node_modules/@getpaseo/server/package.json',...PID_LOCK_COPIES.map(p=>'node_modules/@getpaseo/server/'+p+'/pid-lock.js')]){
  const file=path.join(old,relative),bytes=fs.readFileSync(file);fs.writeFileSync(file,'{}');assert.equal(previousRuntimeDirectory(loc),null,relative);fs.writeFileSync(file,bytes);
 }
 fs.renameSync(old,old+'.target');fs.symlinkSync(old+'.target',old);assert.equal(previousRuntimeDirectory(loc),null);
});
