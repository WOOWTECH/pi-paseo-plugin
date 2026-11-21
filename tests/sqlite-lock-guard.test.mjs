import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { withSqliteLockTransition, withLockTransition, updateState, readState, withRuntimeLock } from '../src/state.mjs';
import { withLock } from '../src/onboarding.mjs';
const stateUrl = new URL('../src/state.mjs', import.meta.url).href;
const mac = { skip: process.platform !== 'darwin', timeout: 15000 };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate) { const until=Date.now()+5000; while(!predicate()){if(Date.now()>=until)throw new Error('test barrier timeout');await pause(5);} }
function fixture(t) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'paseo-sqlite-'));fs.chmodSync(root,0o700);
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return {root,file:path.join(root,'operation.lock')};
}
const holder = `import fs from 'node:fs';import {withSqliteLockTransition} from ${JSON.stringify(stateUrl)};
const [file,ready,release]=process.argv.slice(1);withSqliteLockTransition(file,()=>{fs.writeFileSync(ready,'ready');while(!fs.existsSync(release))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);});`;
async function hold(t,file) {
 const ready=file+'.ready',release=file+'.release';
 const child=spawn(process.execPath,['--input-type=module','-e',holder,file,ready,release],{stdio:['ignore','ignore','pipe']});
 let errors='';child.stderr.on('data',b=>errors+=b);const ended=once(child,'exit').then(([code,signal])=>({code,signal,errors}));
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await ended;});
 await waitFor(()=>fs.existsSync(ready));return {child,ended,release};
}

test('SQLite guard excludes another process, then retains its private stable inode',async t=>{
 const {file}=fixture(t),h=await hold(t,file),guard=file+'.guard.sqlite',before=fs.statSync(guard);
 assert.equal(withSqliteLockTransition(file,()=>assert.fail('contended callback')),null);
 fs.writeFileSync(h.release,'go');const result=await h.ended;assert.equal(result.code,0,result.errors);
 assert.equal(withSqliteLockTransition(file,()=>42),42);
 const after=fs.statSync(guard);assert.equal(after.ino,before.ino);assert.equal(after.dev,before.dev);assert.equal(after.mode&0o777,0o600);
});
test('SIGKILL releases the SQLite OS guard without removing or replacing its inode',async t=>{
 const {file}=fixture(t),h=await hold(t,file),before=fs.statSync(file+'.guard.sqlite');h.child.kill('SIGKILL');assert.equal((await h.ended).signal,'SIGKILL');
 assert.equal(withSqliteLockTransition(file,()=>true),true);assert.equal(fs.statSync(file+'.guard.sqlite').ino,before.ino);
});
test('a nested connection cannot release its outer connection OS lock',t=>{
 const {file}=fixture(t);
 withSqliteLockTransition(file,()=>{
  assert.equal(withSqliteLockTransition(file,()=>assert.fail('nested lock')),null);
  const source=`import {withSqliteLockTransition} from ${JSON.stringify(stateUrl)};process.exit(withSqliteLockTransition(process.argv[1],()=>true)===null?0:17);`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',source,file],{encoding:'utf8',timeout:5000});assert.equal(result.status,0,result.stderr);
 });assert.equal(withSqliteLockTransition(file,()=>true),true);
});
test('callback exceptions release the SQLite guard and preserve the original error',t=>{
 const {file}=fixture(t),failure=new Error('fixture');assert.throws(()=>withSqliteLockTransition(file,()=>{throw failure;}),e=>e===failure);assert.equal(withSqliteLockTransition(file,()=>true),true);
});
for(const kind of ['symlink','hardlink','public-mode'])test('SQLite guard rejects '+kind+' without touching its target',t=>{
 const {root,file}=fixture(t),target=path.join(root,'user-file'),guard=file+'.guard.sqlite';fs.writeFileSync(target,'untouched',{mode:0o644});
 if(kind==='symlink')fs.symlinkSync(target,guard);else if(kind==='hardlink')fs.linkSync(target,guard);else fs.writeFileSync(guard,'',{mode:0o644});
 assert.throws(()=>withSqliteLockTransition(file,()=>assert.fail('unsafe callback')),e=>['UNSAFE_LOCK','UNSAFE_SYMLINK'].includes(e.code));
 assert.equal(fs.readFileSync(target,'utf8'),'untouched');assert.equal(fs.statSync(target).mode&0o777,0o644);
});
test('a link introduced during exclusive guard creation is rejected before SQLite opens it',t=>{
 const {root,file}=fixture(t),target=path.join(root,'target'),guard=file+'.guard.sqlite';fs.writeFileSync(target,'untouched');
 const original=fs.openSync;fs.openSync=function(name,...args){if(name===guard&&!fs.existsSync(guard))fs.symlinkSync(target,guard);return original(name,...args);};
 try{assert.throws(()=>withSqliteLockTransition(file,()=>assert.fail('unsafe callback')),{code:'UNSAFE_SYMLINK'});}finally{fs.openSync=original;}
 assert.equal(fs.readFileSync(target,'utf8'),'untouched');
});
test('a replaced inode after SQLite opens is rejected before the transition executes',t=>{
 const {file}=fixture(t),guard=file+'.guard.sqlite';const sqlite=createRequire(import.meta.url)('node:sqlite'),original=sqlite.DatabaseSync;
 sqlite.DatabaseSync=class extends original{constructor(name,options){super(name,options);fs.renameSync(name,name+'.old');fs.writeFileSync(name,'',{mode:0o600});}};
 try{assert.throws(()=>withSqliteLockTransition(file,()=>assert.fail('replaced callback')),{code:'UNSAFE_LOCK'});}finally{sqlite.DatabaseSync=original;}
 assert.equal(fs.existsSync(guard+'.old'),true);
});
test('aborted or expired acquisition does not execute a protected transition',t=>{
 const {file}=fixture(t),controller=new AbortController();controller.abort();
 assert.throws(()=>withSqliteLockTransition(file,()=>assert.fail('aborted'),{signal:controller.signal}),{code:'LOCK_ABORTED'});
 assert.equal(withSqliteLockTransition(file,()=>assert.fail('expired'),{deadline:Date.now()-1}),null);
 assert.equal(withSqliteLockTransition(file,()=>true),true);
});
test('actual macOS state, onboarding and runtime locks preserve state and reclaim only dead owners',mac,async t=>{
 const {root}=fixture(t),keys=['HOME','PI_CODING_AGENT_DIR','PI_PASEO_STATE_DIR','PI_PASEO_RUNTIME_DIR'],old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 Object.assign(process.env,{HOME:root,PI_CODING_AGENT_DIR:root,PI_PASEO_STATE_DIR:root,PI_PASEO_RUNTIME_DIR:path.join(root,'runtime')});
 try{
  assert.equal(withLockTransition(path.join(root,'direct.lock'),()=>true),true);assert.ok(fs.existsSync(path.join(root,'direct.lock.guard.sqlite')));
  updateState({first:true});updateState({second:true});assert.equal(readState().first,true);assert.equal(readState().second,true);
  fs.writeFileSync(path.join(root,'runtime.lock'),JSON.stringify({pid:99999999,identity:'dead',token:'old'}));
  assert.equal(await withRuntimeLock(()=>42),42);
  const lock=path.join(root,'onboarding.lock');fs.mkdirSync(lock);fs.writeFileSync(path.join(lock,'owner.json'),JSON.stringify({pid:99999999,identity:'dead',token:'old'}));assert.equal(await withLock(lock,()=>42),42);
  const order=[];await Promise.all([withRuntimeLock(async()=>{order.push('a');await pause(40);order.push('a-done');}),withRuntimeLock(()=>order.push('b'))]);assert.deepEqual(order,['a','a-done','b']);
 }finally{for(const k of keys)old[k]===undefined?delete process.env[k]:process.env[k]=old[k];}
});
test('actual macOS runtime waits remain bounded and abortable under OS guard contention',mac,async t=>{
 const {root}=fixture(t),old=process.env.PI_PASEO_STATE_DIR;process.env.PI_PASEO_STATE_DIR=root;
 try{
  await hold(t,path.join(root,'runtime.lock'));
  await assert.rejects(withRuntimeLock(()=>assert.fail('busy callback'),{timeoutMs:70}),{code:'RUNTIME_BUSY'});
  const controller=new AbortController(),pending=withRuntimeLock(()=>assert.fail('abort callback'),{signal:controller.signal});setTimeout(()=>controller.abort(),20);await assert.rejects(pending,{code:'LOCK_ABORTED'});
 }finally{old===undefined?delete process.env.PI_PASEO_STATE_DIR:process.env.PI_PASEO_STATE_DIR=old;}
});
