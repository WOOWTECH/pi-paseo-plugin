#!/usr/bin/env node
// Opt-in acceptance of the packed, standalone CLI. No existing credentials or services are used.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {pathToFileURL,fileURLToPath} from 'node:url';
const repo=fileURLToPath(new URL('../',import.meta.url));
if(process.env.PI_PASEO_CANDIDATE_SMOKE!=='1'||process.platform!=='linux'){
 console.log(JSON.stringify({skipped:true,reason:'Linux opt-in: PI_PASEO_CANDIDATE_SMOKE=1'}));
}else{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'agent-connect-candidate-smoke-'));
 const root=path.join(temp,'instance'),pkg=path.join(temp,'package'),cli=path.join(pkg,'scripts/candidate.mjs');
 const log=(step,data={})=>console.log(JSON.stringify({step,...data}));
 const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
 let stopped=false,started=false;
 async function run(action,value,expected=0){
  const args=[cli,action,root,...(value?[value]:[])];
  const result=await new Promise((resolve,reject)=>{
   const child=spawn(process.execPath,args,{cwd:temp,env:{...process.env,OPENAI_API_KEY:'candidate-isolation-sentinel'},stdio:['ignore','pipe','pipe']});
   let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
   const timer=setTimeout(()=>child.kill('SIGTERM'),420000);
   child.on('error',reject);child.on('close',code=>{clearTimeout(timer);resolve({code,out,err});});
  });
  assert.equal(result.code,expected,action+': '+result.err.slice(-300));
  return JSON.parse(expected?result.err.trim():result.out.trim());
 }
 try{
  const [packed]=JSON.parse(execFileSync('npm',['pack','--ignore-scripts','--json','--pack-destination',temp],{cwd:repo,encoding:'utf8'}));
  execFileSync('tar',['-xzf',path.join(temp,packed.filename),'-C',temp]);
  assert.equal(fs.existsSync(path.join(pkg,'node_modules')),false,'no ambient package dependency install');
  assert.equal((await run('status',undefined,1)).code,'CANDIDATE_PREPARE_REQUIRED');
  const prepared=await run('prepare');assert.equal(prepared.runtimePrepared,true);assert.equal(prepared.daemon.running,false);
  log('candidate.prepared',{fromPackedArtifact:true,daemonStarted:false,noPluginNpmInstall:true});
  let identity,workspaceId,taskEntry;
  for(const target of ['paseo','woowtech','apporo']){
   await run('target',target);
   started=true;stopped=false;
   const state=await run('start');
   assert.equal(state.activeTarget,target);assert.equal(state.runtimeVersion,'0.18.1');assert.equal(state.daemon.reachable,true);
   assert.equal((await run('target','paseo',1)).code,'CANDIDATE_STOP_BEFORE_TARGET');
   assert.equal((await run('pair',undefined,1)).code,'CANDIDATE_PRIVATE_PAIR_REQUIRES_REVEAL');
   const daemonHome=path.join(root,'state/daemon'),configFile=path.join(daemonHome,'config.json'),id=hash(path.join(daemonHome,'server-id')),key=hash(path.join(daemonHome,'daemon-keypair.json'));
   if(identity)assert.deepEqual({id,key},identity);else identity={id,key};
   const environment=fs.readFileSync(`/proc/${state.daemon.pid}/environ`,'utf8').split('\0');
   assert.equal(environment.some(v=>/^(OPENAI_|ANTHROPIC_|OMNIGENT_|PI_WEB_PASSWORD=)/.test(v)),false,'ambient credentials removed');
   const release=path.join(root,'runtime/releases',state.runtimeRevision);
   const {connectToDaemon}=await import(pathToFileURL(path.join(release,'node_modules/@getpaseo/cli/dist/utils/client.js')));
   const client=await connectToDaemon({target:{kind:'instance',home:daemonHome},timeout:10000});
   try{
    const info=client.getLastServerInfoMessage();assert.equal(info.features.tailscale,true);
    const daemonStatus=await client.getDaemonStatus({includeProviders:false});
    assert.equal(Array.isArray(daemonStatus.extraListeners),true);
    if(target==='woowtech'){
     assert.equal(JSON.parse(fs.readFileSync(configFile)).daemon.listen.includes(',127.0.0.2:'),true,'managed restart preserves extra listener');
     assert.equal(daemonStatus.extraListeners.some(listener=>listener.address.startsWith('127.0.0.2:')&&listener.state==='listening'),true,'extra listener actually binds');
    }
    if(!workspaceId){
     const project=path.join(root,'home/test-project');fs.mkdirSync(project);
     workspaceId=(await client.createWorkspace({source:{kind:'directory',path:project}})).workspace.id;
     taskEntry=await client.invokePluginRpc('better-paseo','tasks.dismiss-error',{agentId:'candidate-fixture',error:'fixture'});
    }else{
     assert.equal((await client.fetchWorkspaces({page:{limit:200}})).entries.some(e=>e.id===workspaceId),true);
     assert.deepEqual((await client.invokePluginRpc('better-paseo','tasks.error-dismissals',{})).entries,[taskEntry]);
    }
   }finally{await client.close();}
   const pair=await run('pair','--reveal');const url=new URL(pair.url);
   assert.equal(url.origin,{paseo:'https://app.paseo.sh',woowtech:'https://smart.woowtech.io',apporo:'https://smart.apporo.ai'}[target]);
   log('candidate.brand',{target,running:true,tailscaleCapability:true,tasksRpc:true,identityAndDataPreserved:true,ambientCredentialsAbsent:true,pairOrigin:url.origin});
   await run('stop');stopped=true;
   // Only this candidate's loopback config: reproduce the format Devices persists, then start via Agent Connect.
   const config=JSON.parse(fs.readFileSync(configFile)),main=config.daemon.listen.split(',')[0];
   config.daemon.listen=target==='paseo'?main+',127.0.0.2:'+main.split(':').at(-1):main;
   fs.writeFileSync(configFile,JSON.stringify(config,null,2)+'\n',{mode:0o600});
  }
  assert.equal((await run('status')).daemon.running,false);
  log('candidate.complete',{passed:true,brands:3,realAiProvidersUsed:false,liveHostsModified:false});
 }finally{
  if(started&&!stopped){try{await run('stop');stopped=true;}catch{}}
  // A failed stop keeps its isolated evidence and runtime; never sweep unrelated processes.
  if(!started||stopped){fs.rmSync(temp,{recursive:true,force:true});log('candidate.cleanup',{temporaryDirectoryRemoved:true});}
  else log('candidate.cleanup',{temporaryDirectoryRemoved:false,requiresOwnedInstanceCleanup:true});
 }
}
