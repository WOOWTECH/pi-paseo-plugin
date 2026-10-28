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

// The Paseo daemon answers list_provider_models from a cached provider snapshot that is only rebuilt on an explicit
// refresh_providers_snapshot request or a daemon restart. This fake keeps the same cache semantics.
function fixture(t,{truth,errors={}}) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pi-paseo-models-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const loc={home:dir,agentDir:dir,stateDir:dir,runtimeDir:path.join(dir,'runtime'),paseoHome:path.join(dir,'daemon'),port:6769};
 const pkg=path.join(runtimeLayout.runtimeDirectory(loc),'node_modules/@getpaseo/cli');fs.mkdirSync(pkg,{recursive:true});fs.mkdirSync(loc.paseoHome);
 fs.writeFileSync(path.join(pkg,'package.json'),'{"version":"0.11.2"}');
 seedPidFiles(loc);runtimeLayout.markRuntimeReady(loc);
 fs.writeFileSync(path.join(loc.paseoHome,'.pi-paseo-owner.json'),JSON.stringify({installationId:'fixture',home:loc.paseoHome}));
 let state={installationId:'fixture',phase:'running',desiredEnabled:true};const instance={pid:5000,uid:1000,startedAt:'fixture'};
 const cache=Object.fromEntries(Object.entries(truth).map(([provider,models])=>[provider,[]])); // snapshot taken before login
 const calls={refresh:[],list:0};
 const client={
  listProviderModels:async provider=>{calls.list++;return errors[provider]?{provider,error:errors[provider]}:{provider,models:cache[provider],error:null};},
  getProvidersSnapshot:async()=>({entries:Object.keys(truth).map(provider=>({provider,status:'ready',enabled:true}))}),
  refreshProvidersSnapshot:async options=>{calls.refresh.push(options);for(const provider of options.providers)cache[provider]=truth[provider];return {acknowledged:true};},
  close:async()=>{},
 };
 const source=new URL('../src/runtime.mjs',import.meta.url);const code=ts.transpileModule(fs.readFileSync(source,'utf8'),{fileName:source.pathname+'.ts',compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
 const require=createRequire(import.meta.url),module={exports:{}};
 const localRequire=spec=>{
  if(spec==='./state.mjs')return {locations:()=>loc,readState:()=>state,updateState:x=>(state={...state,...x}),RuntimeError,processIdentity:pid=>pid===5000?'birth':null};
  if(spec==='./single-flight.mjs')return {singleFlight,daemonStatusWindow:createReadWindow()};
  if(spec==='./runtime-layout.mjs')return runtimeLayout;
  if(spec==='./acceptance-agent.mjs')return {usingAcceptanceAgent};
  if(spec.endsWith('/daemon-instance.js'))return {readDaemonInstance:async()=>instance};
  if(spec.endsWith('/dist/utils/client.js'))return {connectToDaemon:async()=>client};
  if(spec.startsWith('./'))return {};
  return require(spec);
 };
 vm.runInNewContext(`(function(require,module,exports){${code}\n})`,{process:{platform:'fixture',getuid:()=>1000,versions:process.versions,env:{}},setTimeout,clearTimeout})(localRequire,module,module.exports);
 return {runtime:module.exports,calls,client};
}

const PI_MODELS=[{id:'openai-codex/gpt-6.1-sol',label:'gpt-6.1-sol',isDefault:true},{id:'openai-codex/gpt-6-luna',label:'gpt-6-luna'}];

test('a catalog cached before login is refreshed once and then returns the models',async t=>{
 const f=fixture(t,{truth:{pi:PI_MODELS}});
 const catalog=await f.runtime.listModels('pi');
 assert.deepEqual(catalog.models.map(m=>m.id),['openai-codex/gpt-6.1-sol','openai-codex/gpt-6-luna']);
 assert.equal(catalog.models.find(m=>m.id==='openai-codex/gpt-6.1-sol').isDefault,true);
 assert.equal(JSON.stringify(f.calls.refresh),'[{"providers":["pi"]}]'); // only the provider that was asked for
 assert.equal(f.calls.list,2);
});

test('a catalog that already has models is returned without a refresh',async t=>{
 const f=fixture(t,{truth:{claude:[{id:'claude-opus-5-5',label:'Opus 5.5'}]}});
 await f.runtime.listModels('claude'); // first read: stale empty cache -> refreshed
 f.calls.refresh.length=0;f.calls.list=0;
 const catalog=await f.runtime.listModels('claude');
 assert.deepEqual(catalog.models.map(m=>m.id),['claude-opus-5-5']);
 assert.deepEqual(f.calls.refresh,[]);assert.equal(f.calls.list,1);
});

test('a provider that is still empty after the refresh is read once more and never retried in a loop',async t=>{
 const f=fixture(t,{truth:{pi:[]}}); // not logged in: the daemon genuinely has no models
 const catalog=await f.runtime.listModels('pi');
 assert.deepEqual(catalog.models,[]);
 assert.equal(f.calls.refresh.length,1);assert.equal(f.calls.list,2);
});

test('a failing refresh keeps the first answer instead of failing the models request',async t=>{
 const f=fixture(t,{truth:{pi:PI_MODELS}});
 const original=f.client.refreshProvidersSnapshot;
 f.client.refreshProvidersSnapshot=async options=>{f.calls.refresh.push(options);throw new Error('refresh timed out');};
 const catalog=await f.runtime.listModels('pi');
 assert.deepEqual(catalog.models,[]);assert.equal(f.calls.refresh.length,1);
 assert.equal(typeof original,'function');
});

test('a provider error is reported as unavailable and does not trigger a refresh',async t=>{
 const f=fixture(t,{truth:{pi:PI_MODELS},errors:{pi:'Provider pi is not available'}});
 await assert.rejects(f.runtime.listModels('pi'),e=>e.code==='PROVIDER_MODELS_UNAVAILABLE');
 assert.deepEqual(f.calls.refresh,[]);
});
