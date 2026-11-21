// Actual macOS lifecycle, with a fresh private HOME and all model providers
// disabled by explicitly unavailable fixture launchers. No provider turns/auth.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
assert.equal(process.platform,'darwin','This check must run on an actual macOS runner');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'paseo-macos-startup-'));
const home=path.join(root,'home'),agent=path.join(root,'agent'),state=path.join(root,'state'),runtime=path.join(root,'runtime'),bin=path.join(root,'unavailable-providers');
for(const dir of [home,agent,state,bin])fs.mkdirSync(dir,{recursive:true,mode:0o700});
for(const provider of ['claude','codex','pi'])fs.writeFileSync(path.join(bin,provider),'#!/bin/sh\nexit 1\n',{mode:0o700});
Object.assign(process.env,{HOME:home,PI_CODING_AGENT_DIR:agent,PI_AGENT_DATA_DIR:agent,PI_PASEO_STATE_DIR:state,PI_PASEO_RUNTIME_DIR:runtime,PATH:bin+path.delimiter+path.dirname(process.execPath)+path.delimiter+process.env.PATH,PI_PASEO_SKIP_POSTINSTALL:'1'});
const service=await import('../src/runtime.mjs');
const evidence={platform:process.platform,arch:process.arch,node:process.versions.node,realDaemon:true,providerTurns:0,credentialFilesCreated:0};
let stopped=false;
try{
 await service.saveConnectionSettings({name:'Agent Connect macOS CI',target:'woowtech'});
 const first=await service.activate();
 assert.equal(first.phase,'running');assert.equal(first.daemon.running,true);assert.equal(first.daemon.reachable,true);assert.ok(first.providers.every(p=>p.enabled===false));
 const identity=fs.readFileSync(path.join(state,'daemon/server-id'),'utf8');
 const keyHash=createHash('sha256').update(fs.readFileSync(path.join(state,'daemon/daemon-keypair.json'))).digest('hex');
 const firstStop=await service.deactivate();assert.equal(firstStop.daemon.running,false);stopped=true;
 const second=await service.activate();stopped=false;
 assert.equal(second.phase,'running');assert.equal(second.daemon.reachable,true);
 assert.equal(fs.readFileSync(path.join(state,'daemon/server-id'),'utf8'),identity);
 assert.equal(createHash('sha256').update(fs.readFileSync(path.join(state,'daemon/daemon-keypair.json'))).digest('hex'),keyHash);
 assert.ok(fs.existsSync(path.join(state,'runtime.lock.guard.sqlite')));
 assert.ok(fs.existsSync(path.join(state,'state.lock.guard.sqlite')));
 Object.assign(evidence,{firstStart:true,firstStop:true,restart:true,identityPreserved:true,sqliteTransitionGuards:true});
}finally{
 try{const result=await service.deactivate();stopped=result.daemon.running===false;}catch{stopped=false;}
 evidence.finalStop=stopped;
 if(process.env.MACOS_EVIDENCE_DIR){fs.mkdirSync(process.env.MACOS_EVIDENCE_DIR,{recursive:true});fs.writeFileSync(path.join(process.env.MACOS_EVIDENCE_DIR,'runtime.json'),JSON.stringify(evidence,null,2)+'\n',{mode:0o600});}
 if(stopped)fs.rmSync(root,{recursive:true,force:true});
}
assert.equal(stopped,true,'owned macOS daemon must stop before fixture removal');
console.log(JSON.stringify(evidence));
