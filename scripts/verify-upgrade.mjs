#!/usr/bin/env node
// Opt-in smoke of the real upgrade, with real Paseo daemons. NOT part of CI: it downloads two runtimes (about
// 1.3 GB), starts real daemons and takes minutes.
//
//   PI_PASEO_UPGRADE_SMOKE=1 node scripts/verify-upgrade.mjs [all|upgrade|legacy|fresh]
//
// Skipped (exit 0) unless PI_PASEO_UPGRADE_SMOKE=1, and on anything but Linux. It needs git with the old plugin's
// commit (PI_PASEO_UPGRADE_OLD_REF, default bf563b8 = Agent Connect rc.2 / Paseo 0.17.5-r2; `legacy` pins 23026e2 = 0.1.26 / 0.17.4-r2), tar, npm and
// access to the npm registry. Everything lives in one temporary directory (isolated HOME, plugin state, runtime
// directory and PATH with provider commands that fail, so no provider is installed or started); the directory and
// every process that points into it, terminal workers included, are removed at the end. Nothing of this user's
// own Paseo or Agent Connect is read or written. The daemons contact their relay (relay.paseo.sh) as any
// installation does, with throwaway identities.
//
// upgrade  Agent Connect rc.2 installs 0.17.5-r2 and starts its daemon. This tree upgrades it to r3, checks
//          RESTART_REQUIRED and old-release control, then the rc.2 code starts the same home back on r2.
// legacy   preserve the 0.1.26 / 0.17.4-r2 upgrade path as a separate smoke.
// fresh    this tree on an empty host: install, start, ownership, pairing shape, branded handshake, a terminal
//          worker. Then a host whose ps stops working while that terminal is open: the stop completes with
//          TERMINAL_CLEANUP_NOT_CONFIRMED as a warning and nothing is signaled (the terminal worker is still
//          running); a start without a usable ps works and the daemon reports what it could not close; once ps
//          works again, the next start's own cleanup closes the orphan. And a ps that runs but exits non-zero
//          before the terminal opens: upstream does not record the terminal, the stop passes without the warning.
//
// It prints only facts that are not secret (never an offer, a key, a server id or an environment value).
// SIGINT, SIGTERM, SIGHUP and SIGQUIT (a second one too) end the running phase and let the cleanup run first, and so does
// a terminal that closes while output is flowing (the failed writes to it are ignored); only SIGKILL of the orchestrator
// leaves the temporary directory (pi-paseo-upgrade-smoke-*) and its processes behind.
// The phases (--phase) are internal: they refuse to run unless this script started them.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {createRequire,register} from 'node:module';
import {execFileSync,spawn,spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

const repoRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const self=fileURLToPath(import.meta.url);
const DEFAULT_OLD_REF='bf563b8171ba64b38bfb117d57619ec814052714';
const LEGACY_OLD_REF='23026e2442403ddee8df9f764ded6ea1a75b121e';
const OLD_REF=process.env.PI_PASEO_UPGRADE_OLD_REF||DEFAULT_OLD_REF,DEFAULT_OLD=!process.env.PI_PASEO_UPGRADE_OLD_REF;
// A commit, tag or branch name: it is passed to git archive, so it may not start like an option.
const OLD_REF_VALID=/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,99}$/.test(OLD_REF);
const OLD_VERSION='0.1.27-rc.2',OLD_REVISION='0.17.5-r2-8664f2c3f8f5',OLD_PASEO='0.17.5',NEW_PASEO='0.17.5';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const fileSha=file=>fs.existsSync(file)?sha(fs.readFileSync(file)):null;
const readJson=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const log=(step,data={})=>console.log(JSON.stringify({step,...data}));
function check(condition,message){if(!condition)throw new Error('CHECK_FAILED: '+message);}
function alive(pid){try{process.kill(pid,0);return true;}catch{return false;}}
async function waitGone(pids,ms=30000){const until=Date.now()+ms;while(pids.some(alive)&&Date.now()<until)await delay(200);return pids.filter(alive);}
function revisionOf(pid){try{return fs.readFileSync(`/proc/${pid}/environ`,'utf8').split('\0').find(entry=>entry.startsWith('PI_PASEO_RUNTIME_REVISION='))?.slice(26)||null;}catch{return null;}}
/** Processes of this user whose environment or command line points into `dir`: supervisor, daemon, terminal workers, shells. */
function processesUnder(dir,{exclude=[]}={}) {
 const found=[];
 for(const name of fs.readdirSync('/proc')){
  if(!/^\d+$/.test(name))continue;const pid=Number(name);if(exclude.includes(pid)||pid===process.pid)continue;
  try {
   if(fs.statSync('/proc/'+name).uid!==process.getuid())continue;
   const env=fs.readFileSync(`/proc/${name}/environ`,'utf8').split('\0'),args=fs.readFileSync(`/proc/${name}/cmdline`,'utf8').split('\0');
   if(env.some(entry=>(entry.startsWith('PASEO_HOME=')||entry.startsWith('HOME='))&&entry.includes(dir))||args.some(arg=>arg.includes(dir)))
    found.push({pid,title:args[0].startsWith('/')?path.basename(args[0]):args[0],script:args.slice(1).find(arg=>/\.m?js$/.test(arg))?.split('/').slice(-2).join('/')||null,revision:revisionOf(pid)});
  } catch { /* gone, or not ours */ }
 }
 return found;
}
const terminalWorkers=dir=>processesUnder(dir).filter(row=>row.script?.endsWith('terminal-worker.mjs'));
/** The shape of a pairing URL, not its content. */
function offerShape(url,{serverIdFile,appUrl,relayEndpoint}) {
 const parsed=new URL(url),offer=JSON.parse(Buffer.from(parsed.hash.slice(7),'base64url').toString('utf8'));
 return {origin:parsed.origin,originMatches:parsed.origin===appUrl,pathname:parsed.pathname,hashIsOffer:/^#offer=[A-Za-z0-9_-]+$/.test(parsed.hash),keys:Object.keys(offer).sort(),v:offer.v,
  relayEndpointMatches:offer.relay?.endpoint===relayEndpoint,relayUseTls:offer.relay?.useTls,serverIdMatchesHome:offer.serverId===fs.readFileSync(serverIdFile,'utf8').trim(),
  daemonKeyPresent:typeof offer.daemonPublicKeyB64==='string'&&offer.daemonPublicKeyB64.length>20};
}
/** A raw hello to the local daemon; returns the server_info payload (callers print only fields that are safe). */
async function rawServerInfo(releaseRoot,listen) {
 const {WebSocket}=createRequire(path.join(releaseRoot,'node_modules/@getpaseo/server/package.json'))('ws');
 return new Promise((resolve,reject)=>{
  const ws=new WebSocket(`ws://${listen}/ws`),timer=setTimeout(()=>{ws.terminate();reject(new Error('SERVER_INFO_TIMEOUT'));},15000);
  ws.on('open',()=>ws.send(JSON.stringify({type:'hello',clientId:'agent-connect-upgrade-smoke-'+process.pid,clientType:'cli',protocolVersion:1,appVersion:'0.10.1'})));
  ws.on('message',data=>{let message;try{message=JSON.parse(String(data));}catch{return;}
   const payload=message?.type==='session'?message.message?.payload:null;
   if(message?.message?.type==='status'&&payload?.status==='server_info'){clearTimeout(timer);ws.close();resolve(payload);}});
  ws.on('error',error=>{clearTimeout(timer);reject(error);});
  ws.on('close',(code,reason)=>{clearTimeout(timer);reject(new Error('CLOSED '+code+' '+String(reason)));});
 });
}
const loadIn=root=>rel=>import(pathToFileURL(path.join(root,rel)).href);

// ---------------------------------------------------------------------------------------------------------------
// Phases: each runs in its own process with the isolated environment of its scenario.
// ---------------------------------------------------------------------------------------------------------------

/** Agent Connect 0.1.26 installs its 0.17.4-r2 runtime as its installer does, starts the daemon and leaves data behind. */
async function phaseOld(oldRoot,factsFile) {
 const load=loadIn(oldRoot),state=await load('src/state.mjs'),layout=await load('src/runtime-layout.mjs'),runtime=await load('src/runtime.mjs');
 const version=readJson(path.join(oldRoot,'package.json')).version;
 check(!DEFAULT_OLD||(version===OLD_VERSION&&layout.RUNTIME_REVISION===OLD_REVISION),`old plugin ${version} ${layout.RUNTIME_REVISION}`);
 const loc=state.locations(),started=Date.now();
 const first=await runtime.activate();
 check(first.phase==='running'&&first.daemon.reachable===true,'old daemon running: '+first.phase+' '+first.diagnosticCode);
 const pid=first.daemon.pid,release=path.join(loc.runtimeDir,'releases',layout.RUNTIME_REVISION);
 check(revisionOf(pid)===layout.RUNTIME_REVISION&&(!DEFAULT_OLD||first.version===OLD_PASEO),'old daemon runs its own release');
 log('old.activated',{pluginVersion:version,revision:layout.RUNTIME_REVISION,paseoVersion:first.version,phase:first.phase,reachable:first.daemon.reachable,activateMs:Date.now()-started});
 // Data the upgrade must keep: a workspace, a pairing record, the daemon identity.
 const project=path.join(loc.home,'smoke-project');fs.mkdirSync(project,{recursive:true});
 const {connectToDaemon}=await import(pathToFileURL(path.join(release,'node_modules/@getpaseo/cli/dist/utils/client.js')).href);
 const client=await connectToDaemon({target:{kind:'instance',home:loc.paseoHome},timeout:10000});
 let workspaceId,tasksEntry;
 try {
  workspaceId=(await client.createWorkspace({source:{kind:'directory',path:project}})).workspace?.id;
  if(['0.17.4','0.17.5'].includes(first.version))tasksEntry=await client.invokePluginRpc('better-paseo','tasks.dismiss-error',{agentId:'owned-upgrade-fixture',error:'isolated upgrade fixture'});
 }finally{await client.close().catch(()=>{});}
 check(typeof workspaceId==='string'&&workspaceId.length>0,'workspace created on the old daemon');
 const pairing=await runtime.pair();check(new URL(pairing.url).origin==='https://app.paseo.sh','old pairing origin');
 const facts={oldPid:pid,oldRoot:release,oldRevision:layout.RUNTIME_REVISION,oldPaseo:first.version,workspaceId,tasksEntry,configSha:fileSha(path.join(loc.paseoHome,'config.json')),serverIdSha:fileSha(path.join(loc.paseoHome,'server-id')),keypairSha:fileSha(path.join(loc.paseoHome,'daemon-keypair.json')),
  pairingSha:fileSha(path.join(loc.stateDir,'pairing.private.json')),installationId:state.readState().installationId};
 check(facts.serverIdSha&&facts.keypairSha&&facts.pairingSha,'identity files and pairing record exist');
 fs.writeFileSync(factsFile,JSON.stringify(facts),{mode:0o600});
 log('old.data',{workspaceCreated:true,pairingRecorded:true,identityFiles:true,tasksRpcPersisted:!!tasksEntry});
}

// Records which release supplied each upstream module that this tree's runtime.mjs imports.
const HOOKS=`import fs from 'node:fs';let file;export function initialize(data){file=data.file;}
export async function resolve(specifier,context,next){const result=await next(specifier,context);
 if(file&&context.parentURL?.endsWith('/src/runtime.mjs')&&result.url.includes('/node_modules/@getpaseo/')){const [release,rest]=decodeURI(result.url.replace('file://','')).split('/node_modules/@getpaseo/');
  fs.appendFileSync(file,JSON.stringify({release:release.split('/').pop(),module:rest})+'\\n');}
 return result;}`;

/** This tree with a running 0.11.2 daemon (upgrade) or on an empty host (fresh). */
async function phaseNew(mode,factsFile) {
 const moduleLog=path.join(path.dirname(process.env.PI_PASEO_STATE_DIR),'modules.log');
 register('data:text/javascript;base64,'+Buffer.from(HOOKS).toString('base64'),{parentURL:import.meta.url,data:{file:moduleLog}});
 const marker=step=>fs.appendFileSync(moduleLog,JSON.stringify({step})+'\n');
 try {await phaseNewSteps(mode,factsFile,marker,moduleLog);} finally {fs.rmSync(moduleLog,{force:true});}
}
async function phaseNewSteps(mode,factsFile,marker,moduleLog) {
 const load=loadIn(repoRoot),state=await load('src/state.mjs'),layout=await load('src/runtime-layout.mjs'),runtime=await load('src/runtime.mjs'),{healthReport}=await load('src/health.mjs');
 const packageVersion=readJson(path.join(repoRoot,'package.json')).version;
 check(layout.PASEO_VERSION===NEW_PASEO,'this tree runs Paseo '+layout.PASEO_VERSION);
 const loc=state.locations(),facts=mode==='upgrade'?readJson(factsFile):null,current=layout.runtimeDirectory(loc),releases=path.join(loc.runtimeDir,'releases');
 const releaseNames=()=>fs.existsSync(releases)?fs.readdirSync(releases).sort():[];
 if(facts){
  check(alive(facts.oldPid)&&revisionOf(facts.oldPid)===facts.oldRevision,'the old daemon is running before the upgrade');
  // A throwaway older release with a valid receipt: pruning may remove it only behind a healthy start from this release.
  const ancient='0.10.0-r1-0123456789ab',root=path.join(releases,ancient);
  fs.mkdirSync(root,{recursive:true,mode:0o700});fs.writeFileSync(path.join(root,'.pi-paseo-runtime.json'),JSON.stringify({revision:ancient,lockSha256:ancient.slice(-12)+'0'.repeat(52)}));
  facts.ancient=ancient;
  const proofBefore=fs.readFileSync(path.join(loc.stateDir,'daemon-instance.private.json'));
  marker('activate-upgrade');
  const installStarted=Date.now(),pending=await runtime.activate();
  check(pending.phase==='restart_required'&&pending.diagnosticCode==='RESTART_REQUIRED','upgrade activation phase '+pending.phase+' '+pending.diagnosticCode);
  check(pending.daemon.reachable===true&&pending.daemon.pid===facts.oldPid&&alive(facts.oldPid),'the old daemon is left running and reachable');
  check(layout.runtimeReady(loc)&&pending.version===NEW_PASEO&&pending.daemon.version===facts.oldPaseo,'0.17.5 is installed, the old release still serves');
  check(fs.readFileSync(path.join(loc.stateDir,'daemon-instance.private.json')).equals(proofBefore),'no proof is minted for the old daemon');
  check(releaseNames().includes(ancient),'no pruning while the old daemon serves');
  log('new.activate-with-old-daemon',{pluginVersion:packageVersion,phase:pending.phase,diagnosticCode:pending.diagnosticCode,samePid:true,installedVersion:pending.version,servingVersion:pending.daemon.version,activateMs:Date.now()-installStarted,releases:releaseNames()});
  marker('status-with-old-daemon');
  const snapshot=await runtime.status();check(snapshot.daemon.running&&snapshot.daemon.reachable&&snapshot.daemon.owned&&snapshot.daemon.version===facts.oldPaseo,'status of the old daemon');
  marker('deactivate-old');
  const stopped=await runtime.deactivate();
  check(stopped.enabled===false&&stopped.daemon.running===false&&stopped.phase==='disabled'&&stopped.warnings.length===0,'explicit stop of the old daemon');
  check((await waitGone([facts.oldPid])).length===0&&!fs.existsSync(path.join(loc.paseoHome,'paseo.pid')),'the old supervisor exited and released the PID lock');
  log('new.deactivate-old',{stopped:true,oldSupervisorGone:true,pidFileReleased:true});
 }
 marker('activate-new');
 const started=Date.now(),running=await runtime.activate();
 // The old releases are deleted after the activation, without its lock: wait for that before looking at them.
 await runtime.pruneSettled();
 check(running.phase==='running'&&running.daemon.reachable===true&&running.diagnosticCode===null,'0.17.5 daemon running: '+running.phase+' '+running.diagnosticCode);
 const pid=running.daemon.pid;check(!facts||pid!==facts.oldPid,'a new supervisor');
 check(revisionOf(pid)===layout.RUNTIME_REVISION&&running.daemon.version===NEW_PASEO&&running.version===NEW_PASEO,'the daemon runs this release');
 log('new.activated',{mode,pluginVersion:packageVersion,phase:running.phase,reachable:running.daemon.reachable,owned:running.daemon.owned,diagnosticCode:running.diagnosticCode,servingVersion:running.daemon.version,daemonRevision:revisionOf(pid),
  supervisorTitle:fs.readFileSync(`/proc/${pid}/cmdline`,'utf8').split('\0')[0],relayEnabled:running.daemon.relayEnabled,warnings:running.warnings.map(row=>row.code),activateMs:Date.now()-started});
 // Ownership: the PID lock written by the patched 0.17.4 writer, the private birth proof.
 const pidFile=path.join(loc.paseoHome,'paseo.pid'),proofFile=path.join(loc.stateDir,'daemon-instance.private.json');
 const lock=readJson(pidFile),proof=readJson(proofFile),stat=fs.readFileSync(`/proc/${pid}/stat`,'utf8'),startTicks=stat.slice(stat.lastIndexOf(')')+2).split(' ')[19];
 check(lock.pid===pid&&lock.heartbeat===true&&lock.piPaseoProtocol==='linux-flock-v1'&&lock.uid===process.getuid(),'PID lock written by the patched writer');
 check((fs.statSync(proofFile).mode&0o777)===0o600&&proof.lock.pid===pid&&proof.process.startTicks===startTicks&&proof.installationId===state.readState().installationId,'private birth proof');
 log('new.ownership',{pidLockProtocol:lock.piPaseoProtocol,proofMode:'600',proofMatchesPidAndBirth:true,listenLoopback:/^127\.0\.0\.1:\d+$/.test(lock.listen),privateHome:(fs.statSync(loc.paseoHome).mode&0o777)===0o700});
 const release=current,{connectToDaemon}=await import(pathToFileURL(path.join(release,'node_modules/@getpaseo/cli/dist/utils/client.js')).href);
 const client=await connectToDaemon({target:{kind:'instance',home:loc.paseoHome},timeout:10000});
 let workspaceId=facts?.workspaceId;
 try {
  check(client.getLastServerInfoMessage().version===NEW_PASEO,'the client sees daemon 0.17.5');
  if(facts) {
   check(fileSha(path.join(loc.paseoHome,'server-id'))===facts.serverIdSha,'server id preserved');
   check(fileSha(path.join(loc.paseoHome,'daemon-keypair.json'))===facts.keypairSha,'daemon keypair preserved');
   check(fileSha(path.join(loc.stateDir,'pairing.private.json'))===facts.pairingSha&&state.readState().installationId===facts.installationId,'pairing record and installation preserved');
   check((await client.fetchWorkspaces({page:{limit:200}})).entries.some(entry=>entry.id===facts.workspaceId),'the old workspace is listed by the new runtime');
   check(fs.existsSync(path.join(loc.paseoHome,'config.json')),'config kept');
   if(facts.tasksEntry){
    const tasks=await client.invokePluginRpc('better-paseo','tasks.error-dismissals',{});
    check(JSON.stringify(tasks.entries)===JSON.stringify([facts.tasksEntry]),'Tasks record preserved across version upgrade');
    check(fileSha(path.join(loc.paseoHome,'config.json'))===facts.configSha,'version-only upgrade preserves configuration bytes');
    log('new.tasks-and-config',{tasksRpcReadable:true,recordPreserved:true,configUnchanged:true});
   }
   check(fs.existsSync(path.join(facts.oldRoot,'.pi-paseo-runtime.json'))&&layout.previousRuntimeDirectory(loc)===facts.oldRoot,'the old release directory is kept and still verifies');
   check(!releaseNames().includes(facts.ancient)&&releaseNames().includes(path.basename(facts.oldRoot))&&releaseNames().includes(layout.RUNTIME_REVISION),'only the throwaway release was pruned: '+JSON.stringify({releases:releaseNames(),lastPrune:state.readState().lastPrune}));
   check(!processesUnder(path.dirname(loc.stateDir)).some(row=>row.revision===facts.oldRevision),'the old release is not running any more');
   const prune=state.readState().lastPrune;check(prune&&prune.removed.join()===facts.ancient&&prune.kept.includes(path.basename(facts.oldRoot)),'lastPrune names what was removed and kept');
   log('new.data-preserved',{serverId:true,daemonKeypair:true,pairingRecord:true,installationId:true,oldWorkspaceListed:true,oldReleaseKeptVerified:true,pruned:prune.removed,kept:prune.kept,releases:releaseNames()});
  }
  if(!workspaceId) {
   const project=path.join(loc.home,'smoke-project');fs.mkdirSync(project,{recursive:true});
   workspaceId=(await client.createWorkspace({source:{kind:'directory',path:project}})).workspace?.id;
  }
  // A terminal worker lives outside the supervisor's tree; ownership checks must not mistake it for a daemon.
  const created=await client.createTerminal(path.join(loc.home,'smoke-project'),'agent-connect-smoke',undefined,{workspaceId});
  check(created?.terminal?.id,'terminal created: '+String(created?.error).slice(0,200));
  let workers=[];for(let i=0;i<50&&!workers.length;i++){workers=terminalWorkers(loc.home);if(!workers.length)await delay(200);}
  check(workers.length>0,'a terminal worker process exists');
 } finally {await client.close().catch(()=>{});}
 const supervisors=processesUnder(loc.home).filter(row=>row.title==='Paseo Supervisor'||row.script?.endsWith('scripts/supervisor-entrypoint.js'));
 const withWorker=await runtime.status();
 check(withWorker.daemon.running&&withWorker.daemon.reachable&&withWorker.daemon.owned&&withWorker.daemon.pid===pid&&withWorker.diagnosticCode===null&&withWorker.warnings.length===0,'status unchanged with a terminal worker');
 check(await runtime.daemonRunning()&&supervisors.length===1&&supervisors[0].pid===pid,'the supervisor poll and the supervisor scan see only the real supervisor');
 log('new.terminal-worker',{workers:terminalWorkers(loc.home).length,supervisorMatches:supervisors.length,statusOwned:true,diagnosticCode:withWorker.diagnosticCode,daemonTerminalCleanupUnconfirmed:withWorker.daemon.terminalCleanupUnconfirmed});
 // The pairing offer for the selected target: shape only.
 const pairing=await runtime.pair();
 log('new.pairing',offerShape(pairing.url,{serverIdFile:path.join(loc.paseoHome,'server-id'),appUrl:'https://app.paseo.sh',relayEndpoint:'relay.paseo.sh:443'}));
 const info=await rawServerInfo(release,lock.listen);
 check(JSON.stringify(info.brand)===JSON.stringify({id:'paseo',name:'Paseo'}),'server_info brand');
 check(info.features?.tailscale===true,'0.17.5 advertises Devices Tailscale RPC');
 log('new.server-info',{brand:info.brand,version:info.version,protocolVersion:info.protocolVersion,relayProtectedSecurity:info.features?.relayProtectedSecurity===true,daemonStatusRpc:info.features?.daemonStatusRpc===true});
 // The README's way to find a setting that 0.17.4 cannot load: `daemon config get` of the release's own CLI reads the
 // file through the same path as the daemon and names each failing setting. A throwaway home, never the live one.
 const cli=path.join(release,'node_modules/@getpaseo/cli/bin/paseo'),probe=fs.mkdtempSync(path.join(path.dirname(loc.stateDir),'config-probe-'));
 fs.writeFileSync(path.join(probe,'config.json'),JSON.stringify({version:1,agents:{idleRuntimeCleanup:'sometimes'}}));
 const rejected=spawnSync(process.execPath,[cli,'daemon','config','get','--home',probe],{encoding:'utf8',env:{...process.env,NO_COLOR:'1'}});
 check(rejected.status!==0&&(rejected.stdout+rejected.stderr).includes('agents.idleRuntimeCleanup'),'daemon config get names the setting that cannot be loaded');
 const readable=spawnSync(process.execPath,[cli,'daemon','config','get','daemon.usage.enabled','--home',loc.paseoHome],{encoding:'utf8',env:{...process.env,NO_COLOR:'1'}});
 check(readable.status===0,'daemon config get reads the managed home');
 fs.rmSync(probe,{recursive:true,force:true});
 log('new.config-get',{namesFailingSetting:true,readsManagedHome:true});
 if(facts) {
  // Which release supplied upstream modules while the old daemon served: only 0.11.2's, besides the check of the config the next start writes.
  const steps={};let step='prepare';
  for(const line of fs.readFileSync(moduleLog,'utf8').trim().split('\n')){const row=JSON.parse(line);if(row.step){step=row.step;continue;}(steps[step]??=[]).push(row);}
  for(const name of ['activate-upgrade','status-with-old-daemon'])
   check((steps[name]||[]).every(row=>row.release===facts.oldRevision||row.module.endsWith('/server/config.js')&&row.release===layout.RUNTIME_REVISION),'modules loaded in '+name+' belong to the daemon\'s own release');
  check((steps['deactivate-old']||[]).filter(row=>row.release===facts.oldRevision).length>0,'the old daemon was stopped through its own release');
  log('new.module-routing',{activateUpgrade:(steps['activate-upgrade']||[]).map(row=>row.release===facts.oldRevision?'old':'new'+':'+row.module.split('/').pop()),statusWithOldDaemon:(steps['status-with-old-daemon']||[]).map(row=>row.release===facts.oldRevision?'old':'new')});
 }
 if(mode==='fresh') await failingPs(runtime,state,load,loc,healthReport,{release,workspaceId});
 marker('deactivate-final');
 const done=await runtime.deactivate();
 check(done.daemon.running===false&&done.phase==='disabled'&&done.warnings.length===0,'final stop is clean: '+JSON.stringify(done.warnings));
 check((await waitGone([pid])).length===0&&terminalWorkers(loc.home).length===0,'the supervisor and every terminal worker are gone');
 log('new.stopped',{remaining:processesUnder(path.dirname(loc.stateDir)).map(row=>row.title)});
}

/** Return the same isolated home to its supported previous runtime; no settings or identity backup is restored over it. */
async function phaseRollback(oldRoot,factsFile) {
 const facts=readJson(factsFile);
 if(!['0.17.4','0.17.5'].includes(facts.oldPaseo)){log('rollback.skipped',{reason:'unsupported rollback version'});return;}
 const load=loadIn(oldRoot),state=await load('src/state.mjs'),runtime=await load('src/runtime.mjs');
 const loc=state.locations();
 if(facts.oldPaseo==='0.17.4')check(!readJson(path.join(loc.paseoHome,'config.json')).daemon.listen.includes(','),'restore single-listener config before a 0.17.4 rollback');
 const started=await runtime.activate();
 check(started.phase==='running'&&started.daemon.reachable&&started.daemon.version===facts.oldPaseo,'old daemon starts on the preserved home');
 const {connectToDaemon}=await import(pathToFileURL(path.join(facts.oldRoot,'node_modules/@getpaseo/cli/dist/utils/client.js')).href);
 const client=await connectToDaemon({target:{kind:'instance',home:loc.paseoHome},timeout:10000});
 try {
  check(fileSha(path.join(loc.paseoHome,'server-id'))===facts.serverIdSha&&fileSha(path.join(loc.paseoHome,'daemon-keypair.json'))===facts.keypairSha,'rollback identity preserved');
  check(fileSha(path.join(loc.stateDir,'pairing.private.json'))!==null&&state.readState().installationId===facts.installationId,'rollback pairing and installation preserved');
  check((await client.fetchWorkspaces({page:{limit:200}})).entries.some(entry=>entry.id===facts.workspaceId),'rollback workspace listed');
  const tasks=await client.invokePluginRpc('better-paseo','tasks.error-dismissals',{});
  check(JSON.stringify(tasks.entries)===JSON.stringify([facts.tasksEntry]),'rollback Tasks record readable');
  check(fileSha(path.join(loc.paseoHome,'config.json'))===facts.configSha,'rollback config unchanged');
  log('rollback.preserved',{paseoVersion:started.daemon.version,serverId:true,keypair:true,workspace:true,tasks:true,configUnchanged:true});
 }finally {await client.close().catch(()=>{});await runtime.deactivate();}
 check((await waitGone([started.daemon.pid])).length===0,'rollback daemon stopped');
}

/** A host whose ps stops working while a terminal is open. The shim ps in PATH (see the scenario setup) delegates to
 * the real one until the flag file exists, and then fails like a ps that does not know the arguments: the process
 * table cannot be read, so Paseo can identify no terminal process and signals none. */
async function failingPs(runtime,state,load,loc,healthReport,{release,workspaceId}) {
 const flag=process.env.PI_PASEO_SMOKE_PS_FLAG;check(flag,'the ps shim flag');
 const [worker]=terminalWorkers(loc.home);check(worker,'a terminal worker to leave open');
 const pidFile=path.join(loc.paseoHome,'paseo.pid'),before=await runtime.status();
 const closingRecords=()=>fs.readdirSync(path.join(loc.paseoHome,'terminal-worker')).filter(name=>/^closing-[A-Za-z0-9-]+\.json$/.test(name)).length;
 const stopWithoutPs=async label=>{
  const pid=(await runtime.status()).daemon.pid,stopped=await runtime.deactivate(),warnings=stopped.warnings.map(row=>row.code);
  check(stopped.phase==='disabled'&&stopped.enabled===false&&stopped.daemon.running===false,label+': the stop completed: '+stopped.phase);
  check(warnings.includes('TERMINAL_CLEANUP_NOT_CONFIRMED'),label+': with a terminal cleanup warning: '+warnings);
  check((await waitGone([pid],5000)).length===0&&!fs.existsSync(pidFile),label+': the supervisor is gone and the PID lock released');
  check(alive(worker.pid),label+': nothing was signaled, the terminal worker is still running');
  check(closingRecords()>0&&state.readState().terminalCleanup?.code==='TERMINAL_CLEANUP_NOT_CONFIRMED',label+': upstream kept its closing record and the plugin recorded the warning');
  return warnings;
 };
 fs.writeFileSync(flag,'');
 try {
  const diagnosis=await runtime.diagnose(),codes=diagnosis.warnings.map(row=>row.code);
  check(codes.includes('PS_INCOMPATIBLE'),'diagnose warns that ps cannot be used: '+codes);
  const health=healthReport(diagnosis);check(health.warnings.includes('PS_INCOMPATIBLE')&&!health.codes.includes('PS_INCOMPATIBLE'),'health lists it as a warning, not a blocker');
  const stopWarnings=await stopWithoutPs('stop');
  log('fresh.ps-failure',{phase:'disabled',warnings:stopWarnings,diagnosticWarnings:codes,healthWarnings:health.warnings,supervisorGone:true,pidLockReleased:true,terminalWorkerStillRunning:true,closingRecords:closingRecords()});
  // Started again while ps is still broken: the daemon cannot close the terminal either and says so itself.
  const running=await runtime.activate(),runningCodes=running.warnings.map(row=>row.code);
  check(running.phase==='running'&&running.daemon.reachable===true&&running.diagnosticCode===null,'a start without a usable ps still works: '+running.phase);
  check(running.daemon.terminalCleanupUnconfirmed>0&&runningCodes.includes('TERMINAL_CLEANUP_NOT_CONFIRMED')&&runningCodes.includes('PS_INCOMPATIBLE'),'the running daemon reports what it could not close: '+runningCodes);
  check(state.readState().terminalCleanup===null&&alive(worker.pid)&&closingRecords()>0,'the stop-time record gives way to the daemon\'s own report; the worker is still there');
  log('fresh.ps-restart',{phase:running.phase,reachable:true,warnings:runningCodes,daemonReportsUnconfirmed:running.daemon.terminalCleanupUnconfirmed>0,terminalWorkerStillRunning:true});
  check((await stopWithoutPs('second stop')).includes('TERMINAL_CLEANUP_NOT_CONFIRMED'),'a second stop is the same completed stop with the same warning');
 } finally {fs.rmSync(flag,{force:true});}
 // ps works again: this start retries the cleanup and closes the orphaned worker itself.
 const again=await runtime.activate();
 check(again.phase==='running'&&again.daemon.reachable===true&&again.warnings.length===0&&again.daemon.terminalCleanupUnconfirmed===0,'the next start is clean: '+again.phase+' '+again.warnings.map(row=>row.code));
 check((await waitGone([worker.pid],30000)).length===0&&closingRecords()===0,'the new daemon closed the orphaned terminal worker and retired its record');
 check(state.readState().terminalCleanup===null&&before.daemon.pid!==again.daemon.pid,'the warning is cleared');
 log('fresh.ps-recovered',{phase:again.phase,warnings:again.warnings.length,orphanClosedByNextStart:true});
 // The other way to break ps: it runs, and exits non-zero for upstream's arguments, before the terminal is opened.
 // Upstream reads that as "no such process" and does not record the terminal at all: the stop has nothing to confirm
 // and passes without the cleanup warning. Only the host check says anything.
 fs.writeFileSync(flag,'');
 try {
  const diagnosis=await runtime.diagnose();
  check(diagnosis.warnings.some(row=>row.code==='PS_INCOMPATIBLE'),'the host check warns');
  const {connectToDaemon}=await import(pathToFileURL(path.join(release,'node_modules/@getpaseo/cli/dist/utils/client.js')).href);
  const client=await connectToDaemon({target:{kind:'instance',home:loc.paseoHome},timeout:10000});
  try {
   const created=await client.createTerminal(path.join(loc.home,'smoke-project'),'agent-connect-smoke-2',undefined,{workspaceId});
   check(created?.terminal?.id,'a terminal opened while ps exits non-zero: '+String(created?.error).slice(0,200));
  } finally {await client.close().catch(()=>{});}
  let workers=[];for(let i=0;i<50&&!workers.length;i++){workers=terminalWorkers(loc.home);if(!workers.length)await delay(200);}
  check(workers.length>0,'a terminal worker is running');
  const record=readJson(path.join(loc.paseoHome,'terminal-worker',workers[0].pid+'.json'));
  check(Array.isArray(record.terminals)&&record.terminals.length===0,'the terminal is not in the worker record');
  const stopped=await runtime.deactivate(),codes=stopped.warnings.map(row=>row.code);
  check(stopped.phase==='disabled'&&!codes.includes('TERMINAL_CLEANUP_NOT_CONFIRMED'),'the stop passes without the cleanup warning: '+codes);
  check((await waitGone([workers[0].pid],10000)).length===0&&closingRecords()===0,'the worker closed its own terminal and left no closing record');
  log('fresh.ps-exit-status',{hostCheckWarns:true,terminalRecorded:false,stopPhase:stopped.phase,cleanupWarning:false,workerClosed:true,closingRecords:closingRecords()});
 } finally {fs.rmSync(flag,{force:true});}
 // Back to a running daemon for the final stop.
 const last=await runtime.activate();
 check(last.phase==='running'&&last.daemon.reachable===true,'started again: '+last.phase);
}

// ---------------------------------------------------------------------------------------------------------------
// The orchestrator.
// ---------------------------------------------------------------------------------------------------------------
function freePort() {
 return new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const {port}=server.address();server.close(()=>resolve(port));});});
}
function scenarioEnvironment(base,root,port,token,oldRef) {
 const env={...process.env};
 for(const key of Object.keys(env))if(/^(PASEO_|PI_PASEO_|PI_WEB_PASSWORD|CODEX_HOME|OMNIGENT_|ANTHROPIC_|OPENAI_|CLAUDE_)/.test(key))delete env[key];
 // Provider commands that fail: no provider is installed or started. A ps that delegates to the real one until the flag exists.
 const providers=path.join(root,'unavailable-providers'),shim=path.join(root,'ps-shim'),flag=path.join(root,'ps-broken');
 fs.mkdirSync(providers,{recursive:true,mode:0o700});fs.mkdirSync(shim,{recursive:true,mode:0o700});
 for(const name of ['claude','codex','pi'])fs.writeFileSync(path.join(providers,name),'#!/bin/sh\nexit 1\n',{mode:0o700});
 const realPs=execFileSync('sh',['-c','command -v ps']).toString().trim();check(realPs,'a ps on this host');
 fs.writeFileSync(path.join(shim,'ps'),`#!/bin/sh\nif [ -e ${JSON.stringify(flag)} ]; then echo "ps: unrecognized option" >&2; exit 1; fi\nexec ${JSON.stringify(realPs)} "$@"\n`,{mode:0o700});
 return {...env,HOME:path.join(root,'home'),PI_CODING_AGENT_DIR:path.join(root,'agent'),PI_AGENT_DATA_DIR:path.join(root,'agent'),PI_PASEO_STATE_DIR:path.join(root,'state'),PI_PASEO_RUNTIME_DIR:path.join(root,'runtime'),
  PI_PASEO_PORT:String(port),PI_PASEO_SKIP_POSTINSTALL:'1',PI_PASEO_SMOKE_PS_FLAG:flag,npm_config_cache:path.join(base,'npm-cache'),NO_COLOR:'1',
  // Added after the filter above, so the phases get them: the opt-in, the secret that proves this script started them,
  // and a custom old ref (without it a phase assumes the default and fails on any other).
  PI_PASEO_UPGRADE_SMOKE:'1',PI_PASEO_UPGRADE_SMOKE_TOKEN:token,...(oldRef===DEFAULT_OLD_REF?{}:{PI_PASEO_UPGRADE_OLD_REF:oldRef}),
  PATH:[shim,providers,path.dirname(process.execPath),env.PATH||''].join(path.delimiter)};
}
function prepareScenario(base,name) {
 const root=path.join(base,name);
 for(const dir of ['home','agent','state'])fs.mkdirSync(path.join(root,dir),{recursive:true,mode:0o700});
 return root;
}
let running=null,interrupted=false;
// Any of these ends the running phase, and the cleanup in orchestrate() then runs as for any failure. They stay
// handled for the whole run: a second Ctrl-C must not end this process before that cleanup, or detached daemons and
// about 1.3 GB stay behind.
const interrupt=()=>{interrupted=true;running?.kill('SIGKILL');};
function handleInterrupts() {
 for(const signal of ['SIGINT','SIGTERM','SIGHUP','SIGQUIT'])process.on(signal,interrupt);
 // A terminal that closes makes the next write to it fail (EIO; EPIPE on a closed pipe) while the phase's output is still
 // being forwarded. A stream 'error' nobody listens to is an uncaught exception, and it would end this process before the
 // cleanup ran. The output is a report: losing it is not a reason to leave daemons and a temporary directory behind.
 for(const stream of [process.stdout,process.stderr])stream.on('error',()=>{});
}
function runPhase(args,env,{timeoutMs=1500000}={}) {
 return new Promise(resolve=>{
  if(interrupted){resolve({code:130,err:'INTERRUPTED'});return;}
  const child=running=spawn(process.execPath,[self,'--phase',token,...args],{env,stdio:['ignore','pipe','pipe']});let err='';
  child.stdout.on('data',data=>process.stdout.write(data));child.stderr.on('data',data=>{err=(err+data).slice(-3000);});
  const timer=setTimeout(()=>{err+='\nPHASE_TIMEOUT';child.kill('SIGKILL');},timeoutMs);
  child.on('close',code=>{clearTimeout(timer);running=null;resolve({code,err:interrupted?err+'\nINTERRUPTED':err});});
 });
}
const token=randomBytes(16).toString('hex');
async function orchestrate(which) {
 handleInterrupts();
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'pi-paseo-upgrade-smoke-')),strays={};let failed=false,ok=false;
 const sweep=(dir,label)=>{const left=processesUnder(dir);for(const row of left)try{process.kill(row.pid,'SIGKILL');}catch{}strays[label]=left.map(row=>row.script||row.title);return left.length;};
 const fail=(label,result)=>{failed=true;console.error(JSON.stringify({passed:false,phase:label,exit:result.code,detail:result.err.trim().split('\n').slice(-12).join('\n')}));};
 const runUpgrade=async(label,oldRef)=>{
  const root=prepareScenario(base,label),oldRoot=path.join(base,label+'-plugin-old'),env=scenarioEnvironment(base,root,await freePort(),token,oldRef);fs.mkdirSync(oldRoot);
  execFileSync('sh',['-c','git -C "$1" archive "$2" | tar -x -C "$3"','sh',repoRoot,oldRef,oldRoot]);
  const old=await runPhase(['old',oldRoot,path.join(root,'facts.json')],env);
  if(old.code!==0)fail(label+' old plugin',old);
  else {
   const next=await runPhase(['upgrade',path.join(root,'facts.json')],env);
   if(next.code!==0)fail(label+' upgrade',next);
   else {const rollback=await runPhase(['rollback',oldRoot,path.join(root,'facts.json')],env);if(rollback.code!==0)fail(label+' rollback',rollback);}
  }
  if(sweep(root,label))failed=true;
 };
 try {
  if(['all','upgrade'].includes(which))await runUpgrade('upgrade',OLD_REF);
  if(['all','legacy'].includes(which)&&!failed)await runUpgrade('legacy',LEGACY_OLD_REF);
  if(['all','fresh'].includes(which)&&!failed) {
   const root=prepareScenario(base,'fresh'),result=await runPhase(['fresh'],scenarioEnvironment(base,root,await freePort(),token,DEFAULT_OLD_REF));
   if(result.code!==0)fail('fresh',result);
   if(sweep(root,'fresh'))failed=true;
  }
  ok=!failed;
 } catch(error) {failed=true;console.error(JSON.stringify({passed:false,code:String(error?.message||error).slice(0,300)}));}
 finally {
  const left=processesUnder(base);for(const row of left)try{process.kill(row.pid,'SIGKILL');}catch{}
  await waitGone(left.map(row=>row.pid),5000);
  const remaining=processesUnder(base).length;
  if(!remaining)fs.rmSync(base,{recursive:true,force:true});
  console.log(JSON.stringify({step:'cleanup',sweptStrayProcesses:strays,remainingProcesses:remaining,temporaryDirectoryRemoved:!fs.existsSync(base),passed:ok&&!remaining}));
  process.exitCode=ok&&!remaining?0:1;
 }
}

const [first,...rest]=process.argv.slice(2);
if(first==='--phase') {
 // Internal. Without the secret that only the orchestrator knows, the opt-in and the isolated directories it made,
 // a phase would run activate() on whatever environment the caller happens to have.
 const [secret,name,...args]=rest,isolated=path.resolve(process.env.PI_PASEO_STATE_DIR||'/').split(path.sep).some(part=>part.startsWith('pi-paseo-upgrade-smoke-'));
 if(process.env.PI_PASEO_UPGRADE_SMOKE!=='1'||!/^[0-9a-f]{32}$/.test(secret||'')||process.env.PI_PASEO_UPGRADE_SMOKE_TOKEN!==secret||!isolated) {
  console.error(JSON.stringify({passed:false,code:'PHASE_NOT_STARTED_BY_THE_SMOKE',message:'Run PI_PASEO_UPGRADE_SMOKE=1 node scripts/verify-upgrade.mjs'}));process.exitCode=2;
 } else try {
  if(name==='old')await phaseOld(args[0],args[1]);
  else if(name==='upgrade')await phaseNew('upgrade',args[0]);
  else if(name==='rollback')await phaseRollback(args[0],args[1]);
  else if(name==='fresh')await phaseNew('fresh');
  else throw new Error('unknown phase');
 } catch(error) {console.error(String(error?.stack||error).slice(0,2500));process.exitCode=1;}
} else if(process.env.PI_PASEO_UPGRADE_SMOKE!=='1') {
 console.log(JSON.stringify({skipped:true,reason:'opt-in: set PI_PASEO_UPGRADE_SMOKE=1 (it downloads two Paseo runtimes and starts real daemons)'}));
} else if(process.platform!=='linux') {
 console.log(JSON.stringify({skipped:true,reason:'Linux only'}));
} else {
 const which=first||'all';
 if(!['all','upgrade','legacy','fresh'].includes(which)){console.error(JSON.stringify({passed:false,code:'USAGE',message:'node scripts/verify-upgrade.mjs [all|upgrade|legacy|fresh]'}));process.exitCode=2;}
 else {
  try {
   if(!OLD_REF_VALID)throw new Error('PI_PASEO_UPGRADE_OLD_REF');
   execFileSync('git',['-C',repoRoot,'cat-file','-e',OLD_REF+'^{commit}'],{stdio:'ignore'});
   execFileSync('tar',['--version'],{stdio:'ignore'});
  } catch {console.error(JSON.stringify({passed:false,code:'OLD_PLUGIN_UNAVAILABLE',message:`git history with ${OLD_REF} (Agent Connect ${OLD_VERSION}) and tar are required`}));process.exitCode=2;}
  if(!process.exitCode)await orchestrate(which);
 }
}
