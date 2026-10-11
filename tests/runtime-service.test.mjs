import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import {RuntimeError} from '../src/state.mjs';
import {singleFlight,createReadWindow} from '../src/single-flight.mjs';
import {usingAcceptanceAgent} from '../src/acceptance-agent.mjs';
import * as runtimeLayout from '../src/runtime-layout.mjs';

function fixture(t) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pi-paseo-service-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const loc={home:dir,agentDir:dir,stateDir:dir,runtimeDir:path.join(dir,'runtime'),paseoHome:path.join(dir,'daemon'),port:6769};
 const pkg=path.join(runtimeLayout.runtimeDirectory(loc),'node_modules/@getpaseo/cli');fs.mkdirSync(pkg,{recursive:true});fs.mkdirSync(loc.paseoHome);
 fs.writeFileSync(path.join(pkg,'package.json'),'{"version":"0.11.2"}');
 runtimeLayout.markRuntimeReady(loc);
 fs.writeFileSync(path.join(loc.paseoHome,'.pi-paseo-owner.json'),JSON.stringify({installationId:'fixture',home:loc.paseoHome}));
 let state={installationId:'fixture',phase:'running',desiredEnabled:true};let instance={pid:5000,uid:1000,startedAt:'fixture'};
 const calls={connect:0,status:0,close:0};let fail=false;
 const client={getDaemonStatus:async()=>{calls.status++;await new Promise(r=>setTimeout(r,30));if(fail)throw new RuntimeError('DAEMON_UNREACHABLE');return {pid:5001,providers:[],relay:{enabled:true}};},close:async()=>{calls.close++;}};
 const source=new URL('../src/runtime.mjs',import.meta.url);const code=ts.transpileModule(fs.readFileSync(source,'utf8'),{fileName:source.pathname+'.ts',compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
 const require=createRequire(import.meta.url),module={exports:{}};
 const localRequire=spec=>{
  if(spec==='./state.mjs')return {locations:()=>loc,readState:()=>state,updateState:x=>(state={...state,...x}),RuntimeError,processIdentity:pid=>pid===5000?'birth':null};
  if(spec==='./single-flight.mjs')return {singleFlight,daemonStatusWindow:createReadWindow()};
  if(spec==='./runtime-layout.mjs')return runtimeLayout;
  if(spec==='./acceptance-agent.mjs')return {usingAcceptanceAgent};
  if(spec.endsWith('/daemon-instance.js'))return {readDaemonInstance:async()=>instance};
  if(spec.endsWith('/dist/utils/client.js'))return {connectToDaemon:async()=>{calls.connect++;return client;}};
  if(spec.startsWith('./'))return {};
  return require(spec);
 };
 vm.runInNewContext(`(function(require,module,exports){${code}\n})`,{process:{platform:'fixture',getuid:()=>1000,versions:process.versions,env:{}},setTimeout,clearTimeout})(localRequire,module,module.exports);
 return {runtime:module.exports,calls,stop:()=>{instance=null;},fail:()=>{fail=true;}};
}

test('twenty simultaneous real status calls use one daemon request and close it once',async t=>{
 const f=fixture(t);const result=await Promise.all(Array.from({length:20},()=>f.runtime.status()));
 assert.equal(result.every(r=>r.daemon.reachable),true);
 assert.deepEqual(f.calls,{connect:1,status:1,close:1});
 await f.runtime.status();assert.equal(f.calls.status,1); // warm polling does not re-probe providers
 f.stop();const stopped=await f.runtime.status();assert.equal(stopped.daemon.running,false);assert.equal(stopped.phase,'stopped');
});

test('the probe window expires, scopes process generations and never retains failures',async()=>{
 let clock=0,reads=0;const window=createReadWindow({ttlMs:3000,maxEntries:2,now:()=>clock});
 const read=async()=>++reads;
 assert.equal((await window('pid-1',read)).value,1);
 clock=2999;assert.equal((await window('pid-1',read)).value,1);
 clock=3000;assert.equal((await window('pid-1',read)).value,2);
 assert.equal((await window('pid-2',read)).value,3);
 assert.equal((await window('pid-3',read)).value,4);
 assert.equal((await window('pid-1',read)).value,5);
 await assert.rejects(window('failed',async()=>{throw new Error('unreachable');}));
 assert.equal((await window('failed',read)).value,6);
});

test('a failed concurrent query is released; the next query checks current state again',async t=>{
 const f=fixture(t);f.fail();await Promise.all([f.runtime.status(),f.runtime.status()]);assert.equal(f.calls.status,1);
 await f.runtime.status();assert.equal(f.calls.status,2);assert.equal(f.calls.close,2);
});

test('wall-clock adjustment cannot extend the three-second provider probe window',async()=>{
 let monotonic=0,wall=100000,reads=0;
 const window=createReadWindow({now:()=>monotonic,wallNow:()=>wall});
 const read=async()=>++reads;
 assert.equal((await window('daemon',read)).checkedAt,100000);
 wall=0;monotonic=2999;assert.equal((await window('daemon',read)).value,1);
 monotonic=3000;assert.equal((await window('daemon',read)).value,2);
});

test('acceptance archives only its newly-created agent on success and keeps its transcript',async()=>{
 const archived=[],row={};const client={createAgent:async()=>({id:'owned-test-agent'}),archiveAgent:async id=>{archived.push(id);return {archivedAt:1};}};
 await usingAcceptanceAgent(client,{},row,async agent=>assert.equal(agent.id,'owned-test-agent'));
 assert.deepEqual(archived,['owned-test-agent']);assert.deepEqual(row.cleanup,{archived:true});
});

test('acceptance timeout still archives its test agent and preserves the original failure',async()=>{
 const archived=[],row={};const client={createAgent:async()=>({id:'owned-test-agent'}),archiveAgent:async id=>{archived.push(id);return {archivedAt:1};}};
 await assert.rejects(usingAcceptanceAgent(client,{},row,async()=>{throw new RuntimeError('PROVIDER_TIMEOUT');}),{code:'PROVIDER_TIMEOUT'});
 assert.deepEqual(archived,['owned-test-agent']);assert.equal(row.cleanup.archived,true);
});

test('unknown creation cannot archive an unrelated agent; cleanup failures are fixed safe metadata',async()=>{
 let archives=0;await assert.rejects(usingAcceptanceAgent({createAgent:async()=>{throw new Error('unknown');},archiveAgent:async()=>{archives++;}}, {}, {},async()=>{}));assert.equal(archives,0);
 const row={};await usingAcceptanceAgent({createAgent:async()=>({id:'test-agent'}),archiveAgent:async()=>{throw new Error('secret-sentinel');}}, {},row,async()=>{});
 assert.deepEqual(row.cleanup,{archived:false,code:'ACCEPTANCE_CLEANUP_FAILED'});assert.doesNotMatch(JSON.stringify(row),/secret-sentinel/);
});
