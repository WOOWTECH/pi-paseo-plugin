#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {runtimeDirectory,markRuntimeReady} from '../src/runtime-layout.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sharedRuntime=process.env.PI_PASEO_TEST_RUNTIME;
if(!sharedRuntime||!fs.existsSync(path.join(sharedRuntime,'node_modules/@getpaseo/cli/package.json'))){console.error(JSON.stringify({passed:false,code:'TEST_RUNTIME_REQUIRED'}));process.exit(1);}
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'pi-paseo-recovery-'));
const home=path.join(temp,'home'),agentDir=path.join(temp,'agent'),stateDir=path.join(temp,'state'),runtimeDir=path.join(temp,'runtime');
for(const d of [home,agentDir,stateDir,runtimeDir])fs.mkdirSync(d,{mode:0o700});
const release=runtimeDirectory({runtimeDir});fs.mkdirSync(release,{recursive:true,mode:0o700});
fs.symlinkSync(path.join(path.resolve(sharedRuntime),'node_modules'),path.join(release,'node_modules'),'dir');
markRuntimeReady({runtimeDir});
Object.assign(process.env,{HOME:home,PI_CODING_AGENT_DIR:agentDir,PI_AGENT_DATA_DIR:agentDir,PI_PASEO_STATE_DIR:stateDir,PI_PASEO_RUNTIME_DIR:runtimeDir,PI_PASEO_PORT:'33869'});
delete process.env.CODEX_HOME;delete process.env.PI_WEB_PASSWORD;delete process.env.PASEO_HOME;
fs.writeFileSync(path.join(agentDir,'settings.json'),JSON.stringify({packages:[root]}),{mode:0o600});
const runtime=await import('../src/runtime.mjs');const host=await import('../src/host-api.mjs');
const hooks={createOnboarding:async()=> 'isolated-onboarding'};
const waitFor=async(fn,ms=120000)=>{const until=Date.now()+ms;do{const result=await fn();if(result)return result;await delay(500);}while(Date.now()<until);throw new Error('Recovery timeout');};
let cleanup=false;
try {
 await host.lifecycle({action:'enable',cwd:home},hooks);
 const first=await waitFor(async()=>{const s=await runtime.status();return s.daemon.reachable?s:null;});
 const pid=first.daemon.pid;
 // This is a newly created daemon in our temporary private HOME; verify before fault injection.
 if(!first.daemon.owned||!fs.readFileSync(`/proc/${pid}/environ`,'utf8').split('\0').includes(`PASEO_HOME=${path.join(stateDir,'daemon')}`))throw new Error('Unowned test process');
 const start=performance.now();process.kill(pid,'SIGTERM');
 const recovered=await waitFor(async()=>{const s=await runtime.status();return s.daemon.reachable&&s.daemon.pid!==pid?s:null;});
 console.log(JSON.stringify({check:'daemon_failure_recovery',passed:true,recoveryMs:Math.round(performance.now()-start),onboardingReused:(await host.status()).onboardingSessionId==='isolated-onboarding'}));
 await host.lifecycle({action:'disable'},hooks);await host.restore(hooks);await delay(16000);
 const stopped=await runtime.status();if(stopped.enabled||stopped.daemon.running)throw new Error('Manual pause was lost');
 console.log(JSON.stringify({check:'manual_stop_and_restore',passed:true,observationMs:16000}));
 await host.lifecycle({action:'enable',cwd:home},hooks);await waitFor(async()=> (await runtime.status()).daemon.reachable);
 const resumed=await host.status();if(resumed.onboardingSessionId!=='isolated-onboarding')throw new Error('Duplicate onboarding');
 console.log(JSON.stringify({check:'reenable_existing_onboarding',passed:true}));
} catch {console.error(JSON.stringify({passed:false,code:'RECOVERY_VERIFICATION_FAILED'}));process.exitCode=1;}
finally {
 try {await host.lifecycle({action:'disable'});cleanup=!(await runtime.status()).daemon.running;}catch{}
 if(cleanup)fs.rmSync(temp,{recursive:true,force:true});
 else {console.error(JSON.stringify({passed:false,code:'TEST_CLEANUP_INCOMPLETE',directory:temp}));process.exitCode=1;}
}
