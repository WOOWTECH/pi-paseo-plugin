#!/usr/bin/env node
// Exercises the exact shipped bundle against the pinned official server SDK.
// No daemon, provider, credentials, or user data are loaded.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {applySmartTasksPatch,smartTasksPatchReady,SMART_TASKS_DIRECTORY} from '../src/smart-tasks-patch.mjs';
const repo=fileURLToPath(new URL('../',import.meta.url));
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'pi-paseo-tasks-bundle-'));
const supplied=process.argv[2];
const root=supplied?path.resolve(supplied):path.join(temp,'runtime');
const oldHome=process.env.PASEO_HOME,oldFetch=globalThis.fetch;
let stop;
try{
 if(!supplied){
  fs.mkdirSync(root);for(const name of ['package.json','package-lock.json'])fs.copyFileSync(path.join(repo,'runtime',name),path.join(root,name));
  execFileSync('npm',['ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],{cwd:root,stdio:'pipe',timeout:180000});
  applySmartTasksPatch(root);
 }
 assert.equal(smartTasksPatchReady(root),true,'verified deployed builtin');
 process.env.PASEO_HOME=path.join(temp,'daemon');fs.mkdirSync(process.env.PASEO_HOME);
 const dir=path.join(root,SMART_TASKS_DIRECTORY);
 const build=JSON.parse(fs.readFileSync(path.join(dir,'builtin-build.json')));
 const {default:contribute}=await import(pathToFileURL(path.join(dir,'server/builtin.js')));
 const settings=new Map(),handlers=new Map();
 function start(){
  settings.clear();handlers.clear();
  return contribute({registerSettings(d){settings.set(d.id,d.schema);return {read:async()=>({status:'ready',revision:'missing',values:d.schema.parse({})})};},handle(contract,fn){assert.equal(handlers.has(contract.name),false);handlers.set(contract.name,{contract,fn});},addHook:()=>()=>{}});
 }
 async function call(name,input){const {contract,fn}=handlers.get(name);return contract.output.parseAsync(await fn(contract.input.parse(input)));}
 stop=start();
 assert.equal(settings.get('tasks').parse({}).enabled,true);
 assert.equal(settings.get('tasks').parse({enabled:false}).enabled,false);
 assert.equal(settings.get('presentation').parse({}).chatEnabled,false);
 assert.equal(settings.get('presentation').parse({}).autoUpdateCheck,false);
 assert.equal(settings.get('presentation').parse({chatEnabled:true,language:'zh-TW'}).chatEnabled,true);
 assert.equal(settings.get('presentation').parse({language:'zh-TW'}).language,'zh-TW');
 const {code}=await call('tasks.chunk',{id:build.tasksChunkId});
 assert.equal(createHash('sha256').update(code).digest('hex').slice(0,16),build.tasksChunkId);
 const chunk={exports:{}},sentinel=new Error('host dependency boundary');
 assert.throws(()=>new Function('require','module','exports',code)(()=>{throw sentinel;},chunk,chunk.exports),e=>e===sentinel);
 for(const name of ['TasksBoardScreen','TasksSidebarEntry','TasksSettingsPanel','BetterPaseoSettingsPage'])assert.equal(typeof chunk.exports[name],'function',name);
 const saved=await call('tasks.dismiss-error',{agentId:'owned-tasks-fixture',error:'fixture'});
 stop();stop=start();
 assert.deepEqual(await call('tasks.error-dismissals',{}),{entries:[saved]});
 let networkCalls=0;globalThis.fetch=async()=>{networkCalls++;throw new Error('unexpected network');};
 assert.deepEqual(await call('settings.update-check',{action:'check'}),{state:'local'});
 assert.deepEqual(await call('settings.open-terminal',{source:'git',latest:'e9ac5216185988ce99574b3e2f04f178020204f1'}),{status:'unsupported'});
 assert.equal(networkCalls,0);
 console.log(JSON.stringify({passed:true,officialServerVersion:JSON.parse(fs.readFileSync(path.join(root,'node_modules/@getpaseo/server/package.json'))).version,pluginVersion:build.version,tasksChunkId:build.tasksChunkId,checks:['pinned-payload','tasks-on-chat-off','explicit-preferences-kept','zh-TW','callable-chunk-exports','persistence-after-reload','self-update-disabled'],daemonStarted:false}));
}finally{
 stop?.();globalThis.fetch=oldFetch;
 oldHome===undefined?delete process.env.PASEO_HOME:process.env.PASEO_HOME=oldHome;
 fs.rmSync(temp,{recursive:true,force:true});
}
