import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {withPidTransition} from '../src/pid-transition.mjs';
import {patchPidLockSource,applyPidLockPatch,pidLockPatchReady,PID_LOCK_COPIES,ORIGINAL_PID_LOCK_SHA256,PATCHED_PID_LOCK_SHA256,PID_LOCK_PATCH_ID,PID_LOCK_0112} from '../src/pid-lock-patch.mjs';
import {runtimeDirectory,markRuntimeReady,runtimeReady,previousRuntimeDirectory,priorRuntimeDirectory,priorRuntimeVersion,PRIOR_RUNTIME_REVISIONS,PASEO_VERSION,RUNTIME_REVISION} from '../src/runtime-layout.mjs';
import {BRAND_SERVER_PATH} from '../src/brand-identity-patch.mjs';
import {SMART_TASKS_REGISTRY_PATH,SMART_TASKS_DIRECTORY,SMART_TASKS_PATCH_ID,SMART_TASKS_PROVENANCE_SHA256} from '../src/smart-tasks-patch.mjs';
import {seedPidFiles,seedPriorRelease,LOCK_0112,LOCK_0112_HONO,TASKS_0174_R2,TASKS_0175_R2} from './helpers/runtime-pid-files.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const original=fs.readFileSync(new URL('./fixtures/paseo-'+PASEO_VERSION+'/pid-lock.js',import.meta.url),'utf8');
const original0112=fs.readFileSync(new URL('./fixtures/paseo-0.11.2/pid-lock.js',import.meta.url),'utf8');
function home(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'paseo-transition-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function runtime(t){const loc={runtimeDir:home(t)};seedPidFiles(loc);const root=runtimeDirectory(loc),cli=path.join(root,'node_modules/@getpaseo/cli');fs.mkdirSync(cli,{recursive:true});fs.writeFileSync(path.join(cli,'package.json'),JSON.stringify({version:PASEO_VERSION}));return{loc,root};}

test('frozen official writer bytes patch deterministically and idempotently',()=>{
 assert.equal(sha(original),ORIGINAL_PID_LOCK_SHA256);
 const patched=patchPidLockSource(original);assert.equal(sha(patched),PATCHED_PID_LOCK_SHA256);
 assert.equal(patchPidLockSource(patched),patched);
 assert.throws(()=>patchPidLockSource(original+'\n'),{code:'PID_LOCK_SOURCE_MISMATCH'});
 assert.match(RUNTIME_REVISION,/^0\.17\.5-r3-8664f2c3f8f5$/);
});
test('the 0.11.2 writer is never patched for this release; its frozen constants still describe r3/r4',()=>{
 assert.throws(()=>patchPidLockSource(original0112),{code:'PID_LOCK_SOURCE_MISMATCH'});
 assert.equal(sha(original0112),PID_LOCK_0112.original);
 const patched=patchPidLockSource(original0112,PID_LOCK_0112);assert.equal(sha(patched),PID_LOCK_0112.patched);
 // Releases r3/r4 recorded this ID; the shared transition helper has not changed since.
 const helper=fs.readFileSync(new URL('../src/pid-transition.mjs',import.meta.url));
 assert.equal(sha(helper),PID_LOCK_0112.helperSha256);
 assert.equal(sha(Buffer.concat([helper,Buffer.from(PID_LOCK_0112.patched)])),PID_LOCK_0112.patchId);
 assert.notEqual(PID_LOCK_0112.patchId,PID_LOCK_PATCH_ID);
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
test('current runtime readiness rejects a missing or changed Smart Tasks patch receipt and bytes',t=>{
 const {loc,root}=runtime(t);markRuntimeReady(loc);assert.equal(runtimeReady(loc),true);
 const receiptFile=path.join(root,'.pi-paseo-runtime.json'),receipt=JSON.parse(fs.readFileSync(receiptFile));
 delete receipt.smartTasksPatchId;fs.writeFileSync(receiptFile,JSON.stringify(receipt));assert.equal(runtimeReady(loc),false);
 receipt.smartTasksPatchId=SMART_TASKS_PATCH_ID;fs.writeFileSync(receiptFile,JSON.stringify(receipt));assert.equal(runtimeReady(loc),true);
 const registry=path.join(root,SMART_TASKS_REGISTRY_PATH),bytes=fs.readFileSync(registry);fs.appendFileSync(registry,'\n');
 assert.equal(runtimeReady(loc),false);fs.writeFileSync(registry,bytes);assert.equal(runtimeReady(loc),true);
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

// Every 0.11.2 release an earlier Agent Connect shipped: r4 is what 0.1.18-0.1.23 run.
const SHIPPED=[['r4',LOCK_0112_HONO],['r3',LOCK_0112_HONO],['r3',LOCK_0112],['r2',LOCK_0112]];
test('the prior revisions include frozen 0.17.4-r2/r1 and every shipped 0.11.2 release, newest first',()=>{
 assert.deepEqual(PRIOR_RUNTIME_REVISIONS,['0.17.5-r2-8664f2c3f8f5','0.17.5-r1-8664f2c3f8f5','0.17.4-r2-a651f42711da','0.17.4-r1-a651f42711da',...SHIPPED.map(([generation,sha])=>`0.11.2-${generation}-${sha.slice(0,12)}`)]);
});

test('the exact 0.17.5-r2 a61 payload stays frozen for control, rollback, and tamper refusal',t=>{
 const {loc}=runtime(t),old=seedPriorRelease(loc,{version:'0.17.5',generation:'r2'}),revision=path.basename(old);
 assert.equal(revision,'0.17.5-r2-8664f2c3f8f5');
 assert.equal(priorRuntimeDirectory(loc,revision),old);assert.equal(priorRuntimeVersion(loc,revision),'0.17.5');
 assert.equal(previousRuntimeDirectory(loc),old);
 const receiptFile=path.join(old,'.pi-paseo-runtime.json'),receipt=JSON.parse(fs.readFileSync(receiptFile));
 assert.equal(receipt.smartTasksPatchId,TASKS_0175_R2.patchId);
 const provenance=path.join(old,SMART_TASKS_DIRECTORY,'provenance.json');
 assert.equal(sha(fs.readFileSync(provenance)),TASKS_0175_R2.provenanceSha256);
 const payload=path.join(old,SMART_TASKS_DIRECTORY,'index.client.ts'),bytes=fs.readFileSync(payload);
 assert.equal(sha(bytes),'6346c9876b38dfb3d072e08cf48b2652d96f14ef5bd19cf9958d106e04ffe0cb');
 fs.appendFileSync(payload,'tampered');assert.equal(priorRuntimeDirectory(loc,revision),null,'changed old payload is refused');
 fs.writeFileSync(payload,bytes);assert.equal(priorRuntimeDirectory(loc,revision),old,'restored old payload verifies');
 assert.notEqual(SMART_TASKS_PROVENANCE_SHA256,TASKS_0175_R2.provenanceSha256);
 fs.writeFileSync(receiptFile,JSON.stringify({...receipt,smartTasksPatchId:SMART_TASKS_PATCH_ID}));
 assert.equal(priorRuntimeDirectory(loc,revision),null,'the r3 patch receipt cannot authorize the frozen r2 payload');
});

test('the exact r1 0.17.4 release stays verifiable for offline control without Smart Tasks',t=>{
 const {loc}=runtime(t),old=seedPriorRelease(loc,{generation:'r1'});
 assert.equal(path.basename(old),'0.17.4-r1-a651f42711da');
 assert.equal(previousRuntimeDirectory(loc),old);assert.equal(priorRuntimeDirectory(loc,path.basename(old)),old);
 assert.equal(priorRuntimeVersion(loc,path.basename(old)),'0.17.4');
 const receiptFile=path.join(old,'.pi-paseo-runtime.json'),receipt=JSON.parse(fs.readFileSync(receiptFile));
 fs.writeFileSync(receiptFile,JSON.stringify({...receipt,lockSha256:'0'.repeat(64)}));
 assert.equal(priorRuntimeDirectory(loc,path.basename(old)),null,'the revision prefix cannot authorize a different full lock hash');
});
test('the exact 0.17.4-r2 Tasks release is verified for offline control and damaged Tasks bytes are refused',t=>{
 const {loc}=runtime(t),old=seedPriorRelease(loc,{version:'0.17.4',generation:'r2'}),revision=path.basename(old);
 assert.equal(revision,'0.17.4-r2-a651f42711da');
 assert.equal(priorRuntimeDirectory(loc,revision),old);assert.equal(priorRuntimeVersion(loc,revision),'0.17.4');
 const files=[path.join(old,SMART_TASKS_REGISTRY_PATH),path.join(old,SMART_TASKS_DIRECTORY,'index.client.ts')];
 const receipt=JSON.parse(fs.readFileSync(path.join(old,'.pi-paseo-runtime.json')));
 assert.equal(receipt.smartTasksPatchId,TASKS_0174_R2.patchId);
 assert.equal(sha(fs.readFileSync(files[0])),TASKS_0174_R2.registrySha256,'the deployed registry matches the frozen r2 descriptor');
 assert.equal(sha(fs.readFileSync(path.join(old,SMART_TASKS_DIRECTORY,'provenance.json'))),TASKS_0174_R2.provenanceSha256,'the deployed Tasks payload matches the frozen r2 descriptor');
 for(const file of files){
  const bytes=fs.readFileSync(file);fs.appendFileSync(file,'tampered');
  assert.equal(priorRuntimeDirectory(loc,revision),null,file+' must fail the frozen r2 Tasks verification');
  fs.writeFileSync(file,bytes);
  assert.equal(priorRuntimeDirectory(loc,revision),old,file+' restoration returns the exact verified release');
 }
});
for(const [generation,lockSha256] of SHIPPED)
test(`0.11.2-${generation}-${lockSha256.slice(0,12)} supports verified offline control beside the 0.17.4 release`,t=>{
 const {loc}=runtime(t);markRuntimeReady(loc);assert.equal(runtimeReady(loc),true);
 const old=seedPriorRelease(loc,{generation,lockSha256});
 assert.equal(previousRuntimeDirectory(loc),old);assert.equal(priorRuntimeDirectory(loc,path.basename(old)),old);
 const patched=generation!=='r2';
 const branded=generation==='r4'?[BRAND_SERVER_PATH,path.join(path.dirname(BRAND_SERVER_PATH),'pi-paseo-brand-identity.mjs')]:[];
 const files=['.pi-paseo-runtime.json','node_modules/@getpaseo/cli/package.json','node_modules/@getpaseo/server/package.json',...PID_LOCK_COPIES.flatMap(p=>['pid-lock.js',...(patched?['pi-paseo-pid-transition.mjs']:[])].map(n=>'node_modules/@getpaseo/server/'+p+'/'+n)),...branded];
 for(const relative of files){
  const file=path.join(old,relative),bytes=fs.readFileSync(file);fs.writeFileSync(file,'{}');assert.equal(previousRuntimeDirectory(loc),null,relative);fs.writeFileSync(file,bytes);
 }
 assert.equal(previousRuntimeDirectory(loc),old);
 const unknown=old.replace(lockSha256.slice(0,12),'000000000000');fs.renameSync(old,unknown);assert.equal(previousRuntimeDirectory(loc),null);
 fs.symlinkSync(unknown,old);assert.equal(previousRuntimeDirectory(loc),null);
 fs.unlinkSync(old);fs.renameSync(unknown,old+'.target');fs.symlinkSync(old+'.target',old);assert.equal(previousRuntimeDirectory(loc),null);
});
test('prior releases are verified with the frozen 0.11.2 writer, never this release\'s patch',t=>{
 const {loc}=runtime(t);markRuntimeReady(loc);
 const old=seedPriorRelease(loc,{generation:'r4'});assert.equal(previousRuntimeDirectory(loc),old);
 const receiptFile=path.join(old,'.pi-paseo-runtime.json'),receipt=JSON.parse(fs.readFileSync(receiptFile));
 fs.writeFileSync(receiptFile,JSON.stringify({...receipt,pidLockPatchId:PID_LOCK_PATCH_ID}));assert.equal(previousRuntimeDirectory(loc),null);
 fs.writeFileSync(receiptFile,JSON.stringify(receipt));
 // 0.17.4 writers patched for this release do not qualify an old release either.
 for(const copy of PID_LOCK_COPIES)fs.writeFileSync(path.join(old,'node_modules/@getpaseo/server',copy,'pid-lock.js'),patchPidLockSource(original));
 assert.equal(previousRuntimeDirectory(loc),null);
 const r2=seedPriorRelease(loc,{generation:'r2'});
 for(const copy of PID_LOCK_COPIES)fs.writeFileSync(path.join(r2,'node_modules/@getpaseo/server',copy,'pid-lock.js'),original);
 assert.equal(previousRuntimeDirectory(loc),null);
});
test('only the exact release a running daemon names qualifies for its control',t=>{
 const {loc}=runtime(t);
 const r4=seedPriorRelease(loc,{generation:'r4'}),r3=seedPriorRelease(loc,{generation:'r3',lockSha256:LOCK_0112});
 assert.equal(previousRuntimeDirectory(loc),r4);assert.equal(previousRuntimeDirectory(loc,{unrecordedOnly:true}),r3);
 assert.equal(priorRuntimeDirectory(loc,path.basename(r3)),r3);assert.equal(priorRuntimeDirectory(loc,path.basename(r4)),r4);
 for(const revision of ['0.11.2-r9-unknown','0.11.2-r1-b60170bb6826','0.11.2-r2-4cf9d40940bf',RUNTIME_REVISION,'0.17.5-r1-000000000000',undefined])assert.equal(priorRuntimeDirectory(loc,revision),null,String(revision));
 // An unverifiable copy of the named release is not replaced by another verified release.
 fs.writeFileSync(path.join(r3,'.pi-paseo-runtime.json'),'{}');assert.equal(priorRuntimeDirectory(loc,path.basename(r3)),null);assert.equal(previousRuntimeDirectory(loc,{unrecordedOnly:true}),null);
});

test('0.17.5-r1 stays independently verifiable after preparing the new builtin generation',t=>{
 const {loc,root}=runtime(t),old=seedPriorRelease(loc,{version:'0.17.5',generation:'r1'}),revision=path.basename(old);
 assert.equal(revision,'0.17.5-r1-8664f2c3f8f5');
 const oldClient=path.join(old,SMART_TASKS_DIRECTORY,'index.client.ts'),bytes=fs.readFileSync(oldClient);
 assert.equal(priorRuntimeDirectory(loc,revision),old);assert.equal(priorRuntimeVersion(loc,revision),'0.17.5');
 markRuntimeReady(loc);assert.equal(runtimeReady(loc),true);assert.notEqual(root,old);
 assert.deepEqual(fs.readFileSync(oldClient),bytes,'preparing r2 cannot overwrite r1');
 assert.equal(previousRuntimeDirectory(loc),old);
 fs.appendFileSync(oldClient,'tampered');assert.equal(priorRuntimeDirectory(loc,revision),null);
 fs.writeFileSync(oldClient,bytes);assert.equal(priorRuntimeDirectory(loc,revision),old);
 const receiptFile=path.join(old,'.pi-paseo-runtime.json'),receipt=JSON.parse(fs.readFileSync(receiptFile));
 fs.writeFileSync(receiptFile,JSON.stringify({...receipt,smartTasksPatchId:SMART_TASKS_PATCH_ID}));
 assert.equal(priorRuntimeDirectory(loc,revision),null,'new payload receipt cannot authorize old runtime');
});
