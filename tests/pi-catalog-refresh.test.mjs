import {seedPidFiles} from './helpers/runtime-pid-files.mjs';
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

// The Paseo daemon builds its Pi model list from Pi's models.json and settings.json and keeps it until a
// refresh_providers_snapshot request or a restart. This fake keeps the same cache: list_provider_models answers
// from the list taken at the last (re)build.
const STARTED=Date.parse('2026-11-10T08:00:00.000Z');
const LITELLM=[{id:'litellm/qwen3-coder',label:'qwen3-coder',isDefault:true}];
function fixture(t) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pi-paseo-pi-catalog-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const loc={home:dir,agentDir:path.join(dir,'agent'),stateDir:dir,runtimeDir:path.join(dir,'runtime'),paseoHome:path.join(dir,'daemon'),port:6769};
 const pkg=path.join(runtimeLayout.runtimeDirectory(loc),'node_modules/@getpaseo/cli');fs.mkdirSync(pkg,{recursive:true});fs.mkdirSync(loc.paseoHome);fs.mkdirSync(loc.agentDir);
 fs.writeFileSync(path.join(pkg,'package.json'),'{"version":"0.11.2"}');
 seedPidFiles(loc);runtimeLayout.markRuntimeReady(loc);
 fs.writeFileSync(path.join(loc.paseoHome,'.pi-paseo-owner.json'),JSON.stringify({installationId:'fixture',home:loc.paseoHome}));
 let state={installationId:'fixture',phase:'running',desiredEnabled:true},running=true,failRefresh=false,failState=false;
 const instance={pid:5000,uid:1000,startedAt:new Date(STARTED).toISOString()};
 let truth=[{id:'openai-codex/gpt-6.1-sol',label:'gpt-6.1-sol',isDefault:true}],cache=truth;
 const calls={connect:0,refresh:[],list:0};
 const client={
  listProviderModels:async provider=>{calls.list++;return {provider,models:cache,error:null};},
  getProvidersSnapshot:async()=>({entries:[{provider:'pi',status:'ready',enabled:true}]}),
  refreshProvidersSnapshot:async options=>{calls.refresh.push(options);if(failRefresh)throw new RuntimeError('DAEMON_UNREACHABLE');cache=truth;return {acknowledged:true};},
  close:async()=>{},
 };
 const source=new URL('../src/runtime.mjs',import.meta.url);const code=ts.transpileModule(fs.readFileSync(source,'utf8'),{fileName:source.pathname+'.ts',compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
 const require=createRequire(import.meta.url),module={exports:{}};
 const localRequire=spec=>{
  if(spec==='./state.mjs')return {locations:()=>loc,readState:()=>state,updateState:x=>{if(failState)throw new RuntimeError('STATE_BUSY');return state={...state,...x};},RuntimeError,processIdentity:pid=>pid===5000?'birth':null};
  if(spec==='./single-flight.mjs')return {singleFlight,daemonStatusWindow:createReadWindow()};
  if(spec==='./runtime-layout.mjs')return runtimeLayout;
  if(spec==='./acceptance-agent.mjs')return {usingAcceptanceAgent};
  if(spec.endsWith('/daemon-instance.js'))return {readDaemonInstance:async()=>running?instance:null};
  if(spec.endsWith('/dist/utils/client.js'))return {connectToDaemon:async()=>{calls.connect++;return client;}};
  if(spec.startsWith('./'))return {};
  return require(spec);
 };
 vm.runInNewContext(`(function(require,module,exports){${code}\n})`,{process:{platform:'fixture',getuid:()=>1000,versions:process.versions,env:{}},setTimeout,clearTimeout})(localRequire,module,module.exports);
 const write=(name,at)=>{const file=path.join(loc.agentDir,name);fs.writeFileSync(file,JSON.stringify({at}));fs.utimesSync(file,new Date(at),new Date(at));};
 return {runtime:module.exports,calls,write,
  // What Pi lists from its files from now on, e.g. after LiteLLM is written to models.json a minute after the start.
  configure:(models,at=STARTED+60_000)=>{truth=models;write('models.json',at);},
  restart:at=>{instance.startedAt=new Date(at).toISOString();cache=truth;},
  stop:()=>{running=false;},failRefresh:()=>{failRefresh=true;},failState:()=>{failState=true;},state:()=>state};
}

test('a Pi provider configured after the daemon started reaches its list with one refresh',async t=>{
 const f=fixture(t);
 f.configure(LITELLM);
 assert.equal(await f.runtime.refreshPiCatalogIfChanged(),true);
 assert.equal(JSON.stringify(f.calls.refresh),'[{"providers":["pi"]}]'); // only Pi
 assert.equal(await f.runtime.refreshPiCatalogIfChanged(),false); // nothing changed since: no second refresh
 assert.deepEqual((await f.runtime.listModels('pi')).models.map(m=>m.id),['litellm/qwen3-coder']);
 assert.equal(f.calls.refresh.length,1);
});

test('files older than the daemon need no refresh; a later edit of either file gets one',async t=>{
 const f=fixture(t);
 f.write('models.json',STARTED-60_000);f.write('settings.json',STARTED-60_000);
 assert.equal(await f.runtime.refreshPiCatalogIfChanged(),false);
 assert.equal(await f.runtime.refreshPiCatalogIfChanged(),false);
 assert.equal(f.calls.refresh.length,0);
 assert.equal(f.calls.connect,0);
 f.write('settings.json',STARTED+120_000); // e.g. a new default model
 assert.equal(await f.runtime.refreshPiCatalogIfChanged(),true);
 assert.equal(await f.runtime.refreshPiCatalogIfChanged(),false);
 assert.equal(f.calls.refresh.length,1);
});

test('a daemon that started after the edit already built its list from the current files',async t=>{
 const f=fixture(t);
 f.configure(LITELLM);
 f.restart(STARTED+120_000);
 assert.equal(await f.runtime.refreshPiCatalogIfChanged(),false);
 assert.equal(f.calls.refresh.length,0);
});

test('a refresh that fails is not repeated every poll, only after the next change',async t=>{
 const f=fixture(t);
 f.failRefresh();f.configure(LITELLM);
 assert.equal(await f.runtime.refreshPiCatalogIfChanged(),false);
 assert.equal(await f.runtime.refreshPiCatalogIfChanged(),false);
 assert.equal(f.calls.refresh.length,1);
 f.write('models.json',STARTED+180_000);
 assert.equal(await f.runtime.refreshPiCatalogIfChanged(),false);
 assert.equal(f.calls.refresh.length,2);
});

test('models pi refreshes a stale list before reading it, so a provider configured later is listed',async t=>{
 const f=fixture(t);
 f.configure(LITELLM);
 const catalog=await f.runtime.listModels('pi');
 assert.deepEqual(catalog.models.map(m=>m.id),['litellm/qwen3-coder']);
 assert.equal(JSON.stringify(f.calls.refresh),'[{"providers":["pi"]}]');
});

test('without a running daemon nothing is asked or recorded',async t=>{
 const f=fixture(t);
 f.stop();f.configure(LITELLM);
 assert.equal(await f.runtime.refreshPiCatalogIfChanged(),false);
 assert.equal(f.calls.connect,0);
 assert.equal(f.state().piCatalog,undefined);
});

test('a state write that fails leaves models pi answering, without a refresh it could not record',async t=>{
 const f=fixture(t);
 f.failState();f.configure(LITELLM);
 assert.equal(await f.runtime.refreshPiCatalogIfChanged(),false);
 assert.deepEqual((await f.runtime.listModels('pi')).models.map(m=>m.id),['openai-codex/gpt-6.1-sol']);
 assert.equal(f.calls.refresh.length,0);
});
