#!/usr/bin/env node
// A separate, credential-free candidate instance. Never registers with an installed Pi Web.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import {assertSafePath,privateDirectory,atomicJson,withRuntimeLock} from '../src/state.mjs';
const packageRoot=fileURLToPath(new URL('../',import.meta.url));
const version=JSON.parse(fs.readFileSync(path.join(packageRoot,'package.json'))).version;
const [action,rawRoot,value,...extra]=process.argv.slice(2);
const fail=code=>{throw Object.assign(new Error(code),{code});};
const freePort=()=>new Promise((resolve,reject)=>{
 const server=net.createServer();server.once('error',reject);
 server.listen(0,'127.0.0.1',()=>{const {port}=server.address();server.close(()=>resolve(port));});
});
try {
 if(process.platform!=='linux')fail('CANDIDATE_LINUX_ONLY');
 if(!['prepare','start','stop','status','target','pair'].includes(action)||!rawRoot||!path.isAbsolute(rawRoot)||extra.length)fail('CANDIDATE_USAGE');
 if(!version.includes('-rc.'))fail('CANDIDATE_REQUIRES_PRERELEASE');
 if(action==='target'&&!['paseo','woowtech','apporo'].includes(value))fail('CANDIDATE_TARGET_REQUIRED');
 if(action==='pair'&&value!=='--reveal')fail('CANDIDATE_PRIVATE_PAIR_REQUIRES_REVEAL');
 if(!['pair','target'].includes(action)&&value!==undefined)fail('CANDIDATE_USAGE');
 const root=path.resolve(rawRoot),marker=path.join(root,'.agent-connect-candidate.json');
 assertSafePath(marker);
 let record;
 if(fs.existsSync(marker)){
  record=JSON.parse(fs.readFileSync(marker));
  if(record.kind!=='agent-connect-isolated-candidate'||record.root!==root||record.packageVersion!==version||!Number.isInteger(record.port)||record.port<1024||record.port>65535)fail('CANDIDATE_MARKER_MISMATCH');
 }else{
  if(action!=='prepare')fail('CANDIDATE_PREPARE_REQUIRED');
  if(fs.existsSync(root)&&fs.readdirSync(root).length)fail('CANDIDATE_DIRECTORY_NOT_EMPTY');
  privateDirectory(root);
  record={kind:'agent-connect-isolated-candidate',root,packageVersion:version,port:await freePort(),createdAt:new Date().toISOString()};
  atomicJson(marker,record);
 }
 for(const name of ['home','agent','state','runtime','bin','tmp','npm-cache'])privateDirectory(path.join(root,name));
 // Do not discover host credentials, provider CLIs, ambient launch overrides, or a global npm config.
 for(const name of ['claude','codex','pi']){
  const file=path.join(root,'bin',name);assertSafePath(file);
  if(!fs.existsSync(file))fs.writeFileSync(file,'#!/bin/sh\nexit 1\n',{mode:0o700});
 }
 const env={PATH:[path.join(root,'bin'),path.dirname(process.execPath),'/usr/local/bin','/usr/bin','/bin'].join(path.delimiter),HOME:path.join(root,'home'),
  PI_CODING_AGENT_DIR:path.join(root,'agent'),PI_AGENT_DATA_DIR:path.join(root,'agent'),PI_PASEO_STATE_DIR:path.join(root,'state'),PI_PASEO_RUNTIME_DIR:path.join(root,'runtime'),PI_PASEO_PORT:String(record.port),
  TMPDIR:path.join(root,'tmp'),CODEX_HOME:path.join(root,'home','.codex'),PI_PASEO_SKIP_POSTINSTALL:'1',PI_PASEO_DISCOVERY_ONLY:'1',NO_COLOR:'1',
  npm_config_cache:path.join(root,'npm-cache'),npm_config_userconfig:path.join(root,'home','.npmrc'),npm_config_globalconfig:path.join(root,'home','.npmrc-global'),LANG:'C.UTF-8'};
 for(const key of Object.keys(process.env))delete process.env[key];Object.assign(process.env,env);
 const runtime=await import('../src/runtime.mjs'),layout=await import('../src/runtime-layout.mjs');
 const {connectionPreferences}=await import('../src/connection-targets.mjs');
 const loc=runtime.locations();
 if(action==='prepare'){
  await withRuntimeLock(async()=>{
   if(layout.runtimeReady(loc))return;
   const release=layout.prepareRuntimeManifest(loc);
   const {runProcess,findExecutable}=await import('../src/process.mjs');
   const npm=findExecutable('npm');if(!npm)fail('NPM_UNAVAILABLE');
   await runProcess(npm,['ci','--prefix',release,'--omit=dev','--no-audit','--no-fund'],{env:process.env,timeoutMs:300000});
   layout.markRuntimeReady(loc);
   if(!layout.runtimeReady(loc))fail('CANDIDATE_RUNTIME_NOT_READY');
  },{timeoutMs:360000});
 }else if(action==='start'){
  const result=await runtime.activate();
  if(result.phase!=='running'||!result.daemon?.reachable)fail('CANDIDATE_NOT_RUNNING');
 }else if(action==='stop')await runtime.deactivate();
 else if(action==='target'){
  if((await runtime.status()).daemon.running)fail('CANDIDATE_STOP_BEFORE_TARGET');
  await runtime.saveConnectionSettings({target:value});
 }else if(action==='pair'){
  const result=await runtime.pair();
  // The sole command allowed to expose an offer, only after an explicit --reveal.
  process.stdout.write(JSON.stringify({target:result.target,url:result.url})+'\n');
 }
 if(action!=='pair'){
  const status=await runtime.status(),preferences=connectionPreferences(loc);
  process.stdout.write(JSON.stringify({candidateVersion:version,runtimeVersion:layout.PASEO_VERSION,runtimeRevision:layout.RUNTIME_REVISION,
   root,runtimePrepared:layout.runtimeReady(loc),phase:status.phase,
   daemon:{running:status.daemon.running,reachable:status.daemon.reachable,owned:status.daemon.owned,pid:status.daemon.pid},
   activeTarget:status.daemon.running?status.state?.activeTarget||'paseo':null,savedTarget:preferences.target,configurationPending:status.state?.configurationPending===true,
   providers:'disabled-in-isolated-candidate',diagnosticCode:status.diagnosticCode})+'\n');
 }
}catch(error){
 process.stderr.write(JSON.stringify({passed:false,code:/^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code||'')?error.code:'CANDIDATE_FAILED'})+'\n');
 process.exitCode=1;
}
