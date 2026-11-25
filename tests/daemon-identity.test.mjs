import * as connectionTargets from '../src/connection-targets.mjs';
import * as onboarding from '../src/onboarding.mjs';
import {seedPidFiles,seedPriorRelease,LOCK_0112} from './helpers/runtime-pid-files.mjs';
import {loadPersistedConfig} from './helpers/paseo-config.mjs';
import {createUpstreamStop,DaemonInstanceError,TerminalCleanupNotConfirmedError} from './helpers/upstream-stop.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import {spawnSync,spawn} from 'node:child_process';
import {once} from 'node:events';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import ts from 'typescript';
import * as state from '../src/state.mjs';
import * as layout from '../src/runtime-layout.mjs';
import * as lifecycleTimeouts from '../src/lifecycle-timeouts.mjs';
import {healthReport} from '../src/health.mjs';
import {singleFlight,createReadWindow} from '../src/single-flight.mjs';
const require=createRequire(import.meta.url);
// The real persisted-config modules (read path, normalization, strict schema) of both releases.
const config0174=await loadPersistedConfig(layout.PASEO_VERSION),config0112=await loadPersistedConfig(layout.LEGACY_PASEO_VERSION);
// A config.json as 0.11.2 accepted it. 0.17.4's schema rejects these speech shapes as written; only its
// read path folds them (providers.openai into the OpenAI speech site, missing providers to local).
const LEGACY_CONFIG={version:1,daemon:{appendSystemPrompt:'retain'},providers:{openai:{apiKey:'fixture-not-a-key',stt:{baseUrl:'https://stt.invalid'}}},
 features:{dictation:{stt:{provider:'openai',language:'zh'}},voiceMode:{stt:{language:'zh'},tts:{provider:'local',voice:'alloy',speakerId:1}}}};
let identityModule={};
try {identityModule=await import('../src/daemon-identity.mjs');}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}

function fixture(t, { platform = process.platform } = {}) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pi-paseo-birth-'));
 const keys=['HOME','PI_CODING_AGENT_DIR','PI_PASEO_STATE_DIR','PI_PASEO_RUNTIME_DIR'];
 const saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 Object.assign(process.env,{HOME:path.join(dir,'home'),PI_CODING_AGENT_DIR:path.join(dir,'agent'),PI_PASEO_STATE_DIR:path.join(dir,'state'),PI_PASEO_RUNTIME_DIR:path.join(dir,'runtime')});
 t.after(()=>{for(const[k,v]of Object.entries(saved))v===undefined?delete process.env[k]:process.env[k]=v;fs.rmSync(dir,{recursive:true,force:true});});
 const loc=state.locations();for(const p of [loc.home,loc.agentDir,loc.stateDir,loc.paseoHome])state.privateDirectory(p);
 state.updateState({desiredEnabled:true,phase:'running',onboardingSessionId:'keep-session',settings:{displayName:'keep-name'}});
 const installation=state.readState().installationId;
 state.atomicJson(path.join(loc.paseoHome,'.pi-paseo-owner.json'),{installationId:installation,home:loc.paseoHome});
 const root=layout.runtimeDirectory(loc),cli=path.join(root,'node_modules/@getpaseo/cli'),server=path.join(root,'node_modules/@getpaseo/server');
 fs.mkdirSync(cli,{recursive:true});fs.writeFileSync(path.join(cli,'package.json'),JSON.stringify({version:layout.PASEO_VERSION}));
 fs.mkdirSync(path.join(server,'dist/server/web-ui'),{recursive:true});fs.writeFileSync(path.join(server,'dist/server/web-ui/index.html'),'fixture');seedPidFiles(loc);layout.markRuntimeReady(loc);
 const pidFile=path.join(loc.paseoHome,'paseo.pid'),proofFile=path.join(loc.stateDir,'daemon-instance.private.json');
 const bootId='11111111-1111-1111-1111-111111111111',processes=new Map(),selfPid=899999;let nextPid=900000,starts=0,stops=0,allowStop=false,protectedOffers=false,emptyPidReads=0;const hooks={};
 // Which release supplied each upstream module or CLI call: <runtimeDir>/releases/<revision>.
 const releaseOf=file=>String(fileURLToPath(new URL(String(file),'file:///'))).split('/node_modules/@getpaseo/')[0];
 const used={modules:[],cli:[],stoppedVia:null};
 // Stops follow what Paseo 0.17.4 does (tests/helpers/upstream-stop.mjs): a fake clock, the PID lock released before
 // the terminal cleanup, upstream's error classes. `stopScenario` says how the next stop goes; every signal is recorded.
 const clock={now:1_000_000},signalsSent=[],pluginSignals=[];let scenario={},processTableResult={checked:false},removal=null;
 function publish(mode=0o644){const pid=++nextPid;const birth={bootId,startTicks:String(pid),uid:process.getuid()};processes.set(pid,{...birth,role:'owned',home:loc.paseoHome});const lock={pid,startedAt:new Date().toISOString(),uid:process.getuid(),bootId,heartbeat:true,piPaseoProtocol:'linux-flock-v1',listen:'127.0.0.1:27669',hostname:'fixture'};fs.writeFileSync(pidFile,JSON.stringify(lock),{mode});return lock;}
 const initial=publish();const initialBytes=fs.readFileSync(pidFile);
 fs.writeFileSync(path.join(loc.paseoHome,'config.json'),JSON.stringify(LEGACY_CONFIG),{mode:0o600});
 fs.writeFileSync(path.join(loc.paseoHome,'agents.db'),'retain-data',{mode:0o600});
 fs.writeFileSync(path.join(loc.stateDir,'pairing.private.json'),'retain-pairing',{mode:0o600});
 const verifyProc=()=>{for(const [pid,p]of processes)if(p.role==='owned'&&p.home===loc.paseoHome)throw new state.RuntimeError('DAEMON_ALREADY_RUNNING');};
 const identity=identityModule.createDaemonIdentity?.({platform,readBirth:pid=>{const p=processes.get(pid);if(p?.unreadable)throw new state.RuntimeError('DAEMON_IDENTITY_UNVERIFIABLE');return p?{bootId:p.bootId,startTicks:p.startTicks,uid:p.uid}:null;},assertNoSupervisor:verifyProc});
 // A virtual /proc: the fake processes are all there is, and nothing falls back to the host's own /proc, so no result
 // depends on what happens to run on the machine. A test that needs another process adds one (`f.process`).
 const missing=()=>Object.assign(new Error('gone'),{code:'ENOENT'});
 const fakeFs={...fs,
  readFileSync(file,...args){
   const m=/^\/proc\/(\d+)\/(cmdline|environ|status|stat)$/.exec(String(file));
   if(m){
    const p=processes.get(Number(m[1]));if(!p)throw missing();
    const uid=p.uid??process.getuid();
    switch(m[2]){
     case 'cmdline':return p.role==='owned'?'Paseo Supervisor\0':'foreign-fixture\0';
     case 'status':return `Name:\tfixture\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`;
     case 'stat':return `${m[1]} (fixture) S ${p.ppid??1} 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${p.startTicks} 0 0 0\n`;
     case 'environ':
      if(p.environUnreadable)throw Object.assign(new Error('denied'),{code:'EACCES'});
      return `PASEO_HOME=${p.home}\0${p.noRevision?'':`PI_PASEO_RUNTIME_REVISION=${p.revision||layout.RUNTIME_REVISION}\0`}${p.noConnectionProfile?'':'PI_PASEO_CONNECTION_PROFILE_VERSION=1\0'}`;
    }
    throw missing();
   }
   // updatePidLock truncates before it writes: a reader can meet the empty file.
   if(String(file)===pidFile&&emptyPidReads>0){emptyPidReads--;return '';}
   return fs.readFileSync(file,...args);
  },
  readdirSync(dir,...args){return String(dir)==='/proc'?[...processes.keys()].map(String):fs.readdirSync(dir,...args);},
  realpathSync(file,...args){if(/^\/proc\/\d+\/exe$/.test(String(file)))return fs.realpathSync(process.execPath);return fs.realpathSync(file,...args);},
  // The deletion of pruned releases, slowed or broken by a test (`f.removal`).
  promises:{...fs.promises,rm:(...args)=>removal?removal(...args):fs.promises.rm(...args)}};
 const loadInstance=()=>fs.existsSync(pidFile)?JSON.parse(fs.readFileSync(pidFile)):null;
 const upstream=createUpstreamStop({clock,scenario:()=>scenario,readLock:loadInstance,
  ownerRunning:lock=>!!(processes.has(lock.pid)||state.processIdentity(lock.pid)),
  sameLock:(a,b)=>a.pid===b.pid&&a.startedAt===b.startedAt,
  deliver:(pid,signal)=>{assert.equal(allowStop,true,'No foreign signal');assert.equal(processes.get(pid)?.role,'owned');signalsSent.push([pid,signal]);stops++;},
  exit:pid=>{processes.delete(pid);},
  releaseLock:lock=>{const current=loadInstance();if(current&&current.pid===lock.pid&&current.startedAt===lock.startedAt)fs.unlinkSync(pidFile);}});
 let reloads=0,reloadResult={appliedPaths:['agents.providers'],restartRequiredPaths:[],overrideControlledPaths:[]},daemonStatusExtra={};
 const client={reloadDaemonConfig:async()=>{reloads++;return reloadResult;},getDaemonStatus:async()=>({pid:loadInstance().pid+1,providers:[],relay:{enabled:true},...daemonStatusExtra}),close:async()=>{}};
 const source=new URL('../src/runtime.mjs',import.meta.url);
 const code=ts.transpileModule(fs.readFileSync(source,'utf8'),{fileName:source.pathname+'.ts',compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
 const module={exports:{}};
 const localRequire=spec=>{
  if(spec==='./connection-targets.mjs')return connectionTargets;
  if(spec==='./onboarding.mjs')return onboarding;

  if(spec==='node:fs')return fakeFs;
  if(spec==='./state.mjs')return {...state,processIdentity:pid=>processes.get(pid)?.startTicks??state.processIdentity(pid)};
  if(spec==='./daemon-identity.mjs')return identity;
  if(spec==='./runtime-layout.mjs')return layout;
  if(spec==='./lifecycle-timeouts.mjs')return lifecycleTimeouts;
  if(spec==='./host-checks.mjs')return {checkProcessTable:async()=>processTableResult};
  if(spec==='./single-flight.mjs')return {singleFlight,daemonStatusWindow:createReadWindow()};
  if(spec==='./provider-launchers.mjs')return {resolveProviderLaunchers:async()=>({}),configureProviders:previous=>previous||{}};
  if(spec==='./process.mjs')return {findExecutable:()=>assert.fail('No npm install'),runProcess:async(_cmd,args,options)=>{if(args.length===2&&args[1]==='--version'){assert.equal(releaseOf(args[0]),root);return layout.PASEO_VERSION;}used.cli.push({release:releaseOf(args[0]),command:args.slice(4).join(' ')});if(args.includes('pair')){const target=connectionTargets.connectionTarget(connectionTargets.connectionPreferences(loc).target);const hash='#offer='+Buffer.from(JSON.stringify({v:2,serverId:'srv_fixture12345',daemonPublicKeyB64:'public-key',relay:{endpoint:target.relayEndpoint,useTls:true},...(protectedOffers?{minimumSecurityMode:'protected'}:{})})).toString('base64url');return JSON.stringify({url:target.appUrl+'/'+hash,relayEnabled:true});}assert.ok(args.includes('start'));starts++;publish();return '{}';}};
  if(/\/node_modules\/@getpaseo\//.test(spec))used.modules.push({release:releaseOf(spec),module:spec.slice(spec.lastIndexOf('/')+1)});
  if(spec.endsWith('/daemon-instance.js'))return {readDaemonInstance:async()=>{const lock=loadInstance();hooks.read?.();return lock&&(processes.has(lock.pid)||state.processIdentity(lock.pid))?lock:null;},stopDaemonInstance:(home,options)=>{used.stoppedVia=releaseOf(spec);return upstream.stopDaemonInstance(home,options);}};
  if(spec.endsWith('/dist/utils/client.js'))return {connectToDaemon:async()=>client};
  if(spec.endsWith('/server/config.js'))return releaseOf(spec)===root?config0174:config0112;
  if(spec.startsWith('./'))return {};
  return require(spec);
 };
 vm.runInNewContext(`(function(require,module,exports){${code}\n})`,{process:{...process,platform,pid:selfPid,kill:(pid,signal)=>{pluginSignals.push([pid,signal]);throw Object.assign(new Error('The plugin signals no process'),{code:'EPERM'});}},URL,setTimeout,clearTimeout,console})(localRequire,module,module.exports);
 return{loc,initial,initialBytes,pidFile,proofFile,installation,processes,runtime:module.exports,identity,starts:()=>starts,stops:()=>stops,reloads:()=>reloads,setReload:r=>{reloadResult=r;},permitStop:()=>{allowStop=true;},protectedOffers:value=>{protectedOffers=value;},emptyPidReads:count=>{emptyPidReads=count;},hooks,used,clock,signalsSent,pluginSignals,upstream,stopScenario:value=>{scenario=value;},publish,daemonStatus:value=>{daemonStatusExtra=value;},processTable:value=>{processTableResult=value;},
 /** Another live process of this user in the virtual /proc: a daemon of another home by default. Returns its pid. */
 process(extra={}){const pid=++nextPid;processes.set(pid,{bootId,startTicks:String(pid),uid:process.getuid(),role:'foreign',home:'/elsewhere/daemon',...extra});return pid;},
 /** The runtime's own process (pid selfPid) and a parent of it, with what their environment says. */
 self(extra={},parentExtra={}){processes.set(selfPid,{bootId,startTicks:String(selfPid),uid:process.getuid(),role:'foreign',ppid:selfPid-1,...extra});processes.set(selfPid-1,{bootId,startTicks:String(selfPid-1),uid:process.getuid(),role:'foreign',...parentExtra});},
 /** Replaces how the runtime deletes (fs.promises.rm): a test makes it slow or broken. */
 removal:fn=>{removal=fn;},
 // The running daemon comes from a 0.11.2 release an earlier Agent Connect installed. Prepared:
 // the 0.17.4 release is installed beside it, as after an upgrade's first activation.
 prior({generation='r4',prepared=false}={}){const oldRoot=seedPriorRelease(loc,{generation});const revision=path.basename(oldRoot);processes.get(initial.pid).revision=revision;if(generation==='r4')state.updateState({daemonPid:initial.pid,daemonStartedAt:initial.startedAt,daemonRuntimeRevision:revision});if(generation==='r2'){const lock=JSON.parse(fs.readFileSync(pidFile));delete lock.piPaseoProtocol;fs.writeFileSync(pidFile,JSON.stringify(lock));}allowStop=true;if(!prepared)fs.rmSync(root,{recursive:true});used.modules.length=0;used.cli.length=0;return oldRoot;},reuse(){const p=processes.get(initial.pid);p.startTicks+='9';p.role='foreign';},keep(){assert.equal(state.readState().installationId,installation);assert.equal(state.readState().onboardingSessionId,'keep-session');assert.equal(fs.readFileSync(path.join(loc.paseoHome,'agents.db'),'utf8'),'retain-data');assert.equal(fs.readFileSync(path.join(loc.stateDir,'pairing.private.json'),'utf8'),'retain-pairing');const config=JSON.parse(fs.readFileSync(path.join(loc.paseoHome,'config.json')));assert.equal(config.daemon.appendSystemPrompt,'retain');assert.equal(config.features.dictation.stt.language,'zh');}};
}

test('healthy adoption records private birth proof with official0644 PID file; status stays read-only',async t=>{
 const f=fixture(t);assert.equal((await f.runtime.status()).daemon.reachable,true);assert.equal(fs.existsSync(f.proofFile),false);
 assert.equal((await f.runtime.activate()).daemon.reachable,true);
 assert.equal(fs.statSync(f.proofFile).mode&0o777,0o600);
 const proof=JSON.parse(fs.readFileSync(f.proofFile));assert.equal(proof.installationId,f.installation);assert.equal(proof.lock.pid,f.initial.pid);assert.equal(proof.process.startTicks,String(f.initial.pid));assert.equal(f.starts(),0);f.keep();
});

test('healthy registered daemon then same-kernel PID reuse recovers once without signaling foreign process',async t=>{
 const f=fixture(t);await f.runtime.activate();assert.equal(fs.existsSync(f.proofFile),true);
 f.reuse();const before=fs.readFileSync(f.pidFile);const s=await f.runtime.status();assert.equal(s.diagnosticCode,'DAEMON_NOT_OWNED');assert.deepEqual(fs.readFileSync(f.pidFile),before);
 assert.equal((await f.runtime.activate()).daemon.reachable,true);assert.equal(f.starts(),1);assert.equal(f.processes.get(f.initial.pid).role,'foreign');
 const proof=JSON.parse(fs.readFileSync(f.proofFile));assert.notEqual(proof.lock.pid,f.initial.pid);
 await f.runtime.activate();assert.equal(f.starts(),1);f.keep();
});

test('legacy foreign PID without trusted proof remains rejected and unchanged',async t=>{
 const f=fixture(t);f.reuse();await assert.rejects(f.runtime.activate(),{code:'DAEMON_NOT_OWNED'});assert.equal(f.starts(),0);assert.deepEqual(fs.readFileSync(f.pidFile),f.initialBytes);assert.equal(fs.existsSync(f.proofFile),false);f.keep();
});

function officialModule(f,copy='dist/src/server') {
 return pathToFileURL(path.join(layout.runtimeDirectory(f.loc),'node_modules/@getpaseo/server',copy,'pid-lock.js')).href;
}
function writerWhileLocked(f,copy,operation='acquirePidLock') {
 const args={acquirePidLock:[f.loc.paseoHome,'127.0.0.1:1'],refreshPidLock:[f.loc.paseoHome,{ownerPid:f.initial.pid}],updatePidLock:[f.loc.paseoHome,{listen:'127.0.0.1:2'},{ownerPid:f.initial.pid}],releasePidLock:[f.loc.paseoHome,{ownerPid:f.initial.pid}]}[operation];
 const script=`const m=await import(${JSON.stringify(officialModule(f,copy))});console.log('entered');const timer=setTimeout(()=>{console.log('blocked');process.exit(75)},150);await m[${JSON.stringify(operation)}](...${JSON.stringify(args)});clearTimeout(timer);console.log('wrote');`;
 const result=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:5000,env:{PATH:process.env.PATH,HOME:f.loc.home}});
 assert.equal(result.status,75,result.stderr+result.stdout);assert.match(result.stdout,/entered\nblocked/);
}

test('A/B official writers cannot publish between final check and quarantine under shared transition',async t=>{
 const f=fixture(t);await f.runtime.activate();f.reuse();
 const rename=fs.renameSync;let observed=false;
 t.mock.method(fs,'renameSync',(from,to)=>{
  if(from===f.pidFile&&String(to).includes('.paseo.pid.stale-')){
   observed=true;const before=fs.readFileSync(f.pidFile);
   // Both exact official copies, not a fake writer. Without the transition
   // wrapper A clears this fake/dead PID and writes a new inode before rename.
   writerWhileLocked(f,'dist/src/server');writerWhileLocked(f,'dist/server/server');
   assert.deepEqual(fs.readFileSync(f.pidFile),before);
  }
  return rename(from,to);
 });
 assert.equal((await f.runtime.activate()).daemon.reachable,true);
 assert.equal(observed,true);assert.equal(f.starts(),1);
 const stale=fs.readdirSync(f.loc.paseoHome).filter(n=>n.startsWith('.paseo.pid.stale-'));
 assert.equal(stale.length,1);assert.equal(JSON.parse(fs.readFileSync(path.join(f.loc.paseoHome,stale[0]))).pid,f.initial.pid);
});

test('all four official writer exports in BOTH module copies share the same guard',async t=>{
 const f=fixture(t);const {withPidTransition}=await import('../src/pid-transition.mjs');
 await withPidTransition(f.loc.paseoHome,async()=>{
  const before=fs.readFileSync(f.pidFile);
  for(const copy of ['dist/server/server','dist/src/server'])for(const operation of ['acquirePidLock','refreshPidLock','updatePidLock','releasePidLock'])writerWhileLocked(f,copy,operation);
  assert.deepEqual(fs.readFileSync(f.pidFile),before);
 });
 const m=await import(officialModule(f));await m.acquirePidLock(f.loc.paseoHome,'127.0.0.1:1');
 const live=await m.getPidLockInfo(f.loc.paseoHome);assert.equal(live.pid,process.pid);assert.equal(live.piPaseoProtocol,'linux-flock-v1');
 await m.updatePidLock(f.loc.paseoHome,{listen:'127.0.0.1:2'});await m.refreshPidLock(f.loc.paseoHome);
 await m.releasePidLock(f.loc.paseoHome,{ownerPid:process.pid,startedAt:live.startedAt});assert.equal(fs.existsSync(f.pidFile),false);
});

test('official owner A wins transition first: plugin leaves its new inode and live process intact',async t=>{
 const f=fixture(t);await f.runtime.activate();f.reuse();
 const script=`const m=await import(${JSON.stringify(officialModule(f))});await m.acquirePidLock(${JSON.stringify(f.loc.paseoHome)},'127.0.0.1:1');console.log('ready');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));`;
 const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH,HOME:f.loc.home}});
 try {
  assert.match(String((await once(child.stdout,'data'))[0]),/ready/);
  const before=fs.readFileSync(f.pidFile),inode=fs.statSync(f.pidFile).ino;
  await assert.rejects(f.runtime.activate(),{code:'DAEMON_NOT_OWNED'});
  assert.deepEqual(fs.readFileSync(f.pidFile),before);assert.equal(fs.statSync(f.pidFile).ino,inode);assert.equal(child.exitCode,null);assert.equal(f.starts(),0);
 }finally{const ended=once(child,'exit');child.stdin.end();await ended;}
});

for(const [name,change]of [
 ['same incarnation despite foreign argv',f=>{f.processes.get(f.initial.pid).role='foreign';}],
 ['proof installation mismatch',f=>{const p=JSON.parse(fs.readFileSync(f.proofFile));p.installationId='other';fs.writeFileSync(f.proofFile,JSON.stringify(p));f.reuse();}],
 ['proof home mismatch',f=>{const p=JSON.parse(fs.readFileSync(f.proofFile));p.home+='-other';fs.writeFileSync(f.proofFile,JSON.stringify(p));f.reuse();}],
 ['lock startedAt mismatch',f=>{const p=JSON.parse(fs.readFileSync(f.pidFile));p.startedAt+='-changed';fs.writeFileSync(f.pidFile,JSON.stringify(p));f.reuse();}],
 ['new inode with identical lock bytes',f=>{fs.renameSync(f.pidFile,f.pidFile+'.old');fs.writeFileSync(f.pidFile,f.initialBytes,{mode:0o644});f.reuse();}],
 ['old uncooperative writer marker',f=>{const p=JSON.parse(fs.readFileSync(f.pidFile));delete p.piPaseoProtocol;fs.writeFileSync(f.pidFile,JSON.stringify(p));f.reuse();}],
 ['wrong-UID birth proof',f=>{const p=JSON.parse(fs.readFileSync(f.proofFile));p.process.uid++;fs.writeFileSync(f.proofFile,JSON.stringify(p));f.reuse();}],
 ['inaccessible process identity',f=>{f.reuse();f.processes.get(f.initial.pid).unreadable=true;}],
 ['another live supervisor for same home',f=>{f.reuse();f.processes.set(900100,{role:'owned',home:f.loc.paseoHome});}],
 ['world-writable official PID file',f=>{fs.chmodSync(f.pidFile,0o666);f.reuse();}],
 ['public proof file',f=>{fs.chmodSync(f.proofFile,0o644);f.reuse();}],
 ['hardlinked official PID file',f=>{fs.linkSync(f.pidFile,f.pidFile+'.link');f.reuse();}],
 ['PID symlink',f=>{fs.renameSync(f.pidFile,f.pidFile+'.target');fs.symlinkSync(f.pidFile+'.target',f.pidFile);f.reuse();}],
 ['proof symlink',f=>{fs.renameSync(f.proofFile,f.proofFile+'.target');fs.symlinkSync(f.proofFile+'.target',f.proofFile);f.reuse();}],
])test(name+' fails closed without moving foreign files',async t=>{
 const f=fixture(t);await f.runtime.activate();change(f);const before=fs.readFileSync(f.pidFile),proof=fs.readFileSync(f.proofFile);
 await assert.rejects(f.runtime.activate());assert.deepEqual(fs.readFileSync(f.pidFile),before);assert.deepEqual(fs.readFileSync(f.proofFile),proof);assert.equal(f.starts(),0);f.keep();
});

test('status cannot recover or enable a disabled installation',async t=>{
 const f=fixture(t);await f.runtime.activate();f.reuse();state.updateState({desiredEnabled:false,phase:'disabled'});
 const before=fs.readFileSync(f.pidFile);const snapshot=await f.runtime.status();assert.equal(snapshot.enabled,false);assert.deepEqual(fs.readFileSync(f.pidFile),before);assert.equal(f.starts(),0);
});

test('pair uses reachable daemon and preserves proof without entering lifecycle recovery',async t=>{
 const f=fixture(t);await f.runtime.activate();const proof=fs.readFileSync(f.proofFile);
 const result=await f.runtime.pair();assert.match(result.url,/^https:\/\/app\.paseo\.sh\/#offer=/);assert.equal(result.target,'paseo');assert.deepEqual(fs.readFileSync(f.proofFile),proof);assert.equal(f.starts(),0);
});

const RELEASE='a'.repeat(64),STAGE='.stage-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
test('activation removes the bundled web copy that 0.1.9-0.1.22 downloaded and keeps private state',async t=>{
 const f=fixture(t),web=path.join(f.loc.stateDir,'web-client'),retired=path.join(web,RELEASE);
 fs.mkdirSync(path.join(retired,'_expo/static'),{recursive:true});fs.writeFileSync(path.join(retired,'index.html'),'retired');fs.writeFileSync(path.join(retired,'_expo/static/app.js'),'retired');
 fs.mkdirSync(path.join(web,STAGE,'content'),{recursive:true});fs.writeFileSync(path.join(web,STAGE,'client.tar.gz'),'partial');
 await f.runtime.activate();
 assert.equal(fs.existsSync(web),false);
 assert.equal(fs.readFileSync(path.join(f.loc.stateDir,'pairing.private.json'),'utf8'),'retain-pairing');
 assert.equal(fs.readFileSync(path.join(f.loc.paseoHome,'agents.db'),'utf8'),'retain-data');
});

test('only the entries the bundled client created are removed from web-client',async t=>{
 const f=fixture(t),web=path.join(f.loc.stateDir,'web-client');
 fs.mkdirSync(path.join(web,RELEASE),{recursive:true});fs.writeFileSync(path.join(web,RELEASE,'index.html'),'retired');
 fs.writeFileSync(path.join(web,'notes.txt'),'unrelated');fs.mkdirSync(path.join(web,'b'.repeat(63)));
 await f.runtime.activate();
 assert.equal(fs.existsSync(path.join(web,RELEASE)),false);
 assert.equal(fs.readFileSync(path.join(web,'notes.txt'),'utf8'),'unrelated');
 assert.equal(fs.statSync(path.join(web,'b'.repeat(63))).isDirectory(),true);
});

test('a symlinked web-client is left in place',async t=>{
 const f=fixture(t),outside=fs.mkdtempSync(path.join(os.tmpdir(),'pi-paseo-web-outside-'));
 t.after(()=>fs.rmSync(outside,{recursive:true,force:true}));
 fs.mkdirSync(path.join(outside,RELEASE));fs.writeFileSync(path.join(outside,RELEASE,'keep.txt'),'keep');fs.symlinkSync(outside,path.join(f.loc.stateDir,'web-client'));
 await f.runtime.activate();
 assert.equal(fs.lstatSync(path.join(f.loc.stateDir,'web-client')).isSymbolicLink(),true);
 assert.equal(fs.readFileSync(path.join(outside,RELEASE,'keep.txt'),'utf8'),'keep');
});

test('a symlink inside the retired copy is removed without touching its target',async t=>{
 const f=fixture(t),outside=fs.mkdtempSync(path.join(os.tmpdir(),'pi-paseo-web-outside-')),retired=path.join(f.loc.stateDir,'web-client',RELEASE);
 t.after(()=>fs.rmSync(outside,{recursive:true,force:true}));
 fs.writeFileSync(path.join(outside,'keep.txt'),'keep');fs.mkdirSync(retired,{recursive:true});fs.symlinkSync(outside,path.join(retired,'assets'));
 await f.runtime.activate();
 assert.equal(fs.existsSync(path.join(f.loc.stateDir,'web-client')),false);
 assert.equal(fs.readFileSync(path.join(outside,'keep.txt'),'utf8'),'keep');
});

test('a retired copy that cannot be removed does not block activation',{skip:process.getuid?.()===0&&'root bypasses directory permissions'},async t=>{
 const f=fixture(t),locked=path.join(f.loc.stateDir,'web-client',RELEASE,'locked');
 fs.mkdirSync(locked,{recursive:true});fs.writeFileSync(path.join(locked,'file'),'retired');fs.chmodSync(locked,0o500);
 // Restore inside the test: the fixture's own cleanup hook runs first and needs to delete the tree.
 try {
  await f.runtime.activate();
  assert.equal(fs.readFileSync(path.join(locked,'file'),'utf8'),'retired');
  const result=await f.runtime.pair();assert.match(result.url,/^https:\/\/app\.paseo\.sh\/#offer=/);
 } finally { fs.chmodSync(locked,0o700); }
});

for(const copy of ['dist/server/server','dist/src/server'])test('unpatched runtime '+copy+' refuses reclaim even with old valid proof',async t=>{
 const f=fixture(t);await f.runtime.activate();f.reuse();
 const file=path.join(layout.runtimeDirectory(f.loc),'node_modules/@getpaseo/server',copy,'pid-lock.js');fs.appendFileSync(file,'\n');
 const before=fs.readFileSync(f.pidFile);
 await assert.rejects(state.withRuntimeLock(()=>f.identity.recoverStaleInstance(f.loc,f.initial)),{code:'DAEMON_TRANSITION_UNVERIFIED'});
 assert.deepEqual(fs.readFileSync(f.pidFile),before);assert.equal(f.starts(),0);
});

test('real Linux birth inspection and default scanner reject another live same-home supervisor',async t=>{
 const f=fixture(t);const current=identityModule.readLinuxBirth(process.pid);assert.equal(current.uid,process.getuid());assert.match(current.startTicks,/^\d+$/);
 const child=spawn(process.execPath,['-e',"process.title='Paseo Supervisor';process.stdout.write('ready');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));"],{stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH,PASEO_HOME:f.loc.paseoHome}});
 try{await once(child.stdout,'data');assert.throws(()=>identityModule.assertNoHomeSupervisor(f.loc),{code:'DAEMON_ALREADY_RUNNING'});}
 finally{const ended=once(child,'exit');child.stdin.end();await ended;}
 assert.equal(identityModule.readLinuxBirth(child.pid),null);
});


for(const generation of ['r4','r2']){
test(`upgrade before 0.17.4 installation: trusted 0.11.2 ${generation} remains visible and normal deactivate stops the owned daemon`,async t=>{
 const f=fixture(t);const old=f.prior({generation});assert.equal(fs.existsSync(layout.runtimeDirectory(f.loc)),false);
 const snapshot=await f.runtime.status();assert.equal(snapshot.installed,true);assert.equal(snapshot.daemon.running,true);assert.equal(snapshot.daemon.reachable,true);assert.equal(snapshot.diagnosticCode,'RESTART_REQUIRED');
 const result=await f.runtime.deactivate();assert.equal(result.enabled,false);assert.equal(result.daemon.running,false);assert.equal(f.stops(),1);assert.equal(f.starts(),0);assert.equal(f.used.stoppedVia,old);assert.equal(fs.existsSync(f.pidFile),false);assert.equal(fs.existsSync(f.proofFile),false);assert.equal(fs.existsSync(layout.runtimeDirectory(f.loc)),false);f.keep();
});
test(`0.11.2 ${generation} fallback still verifies ownership before stop and never clears foreign legacy PID`,async t=>{
 const f=fixture(t);f.prior({generation});f.reuse();const before=fs.readFileSync(f.pidFile);
 assert.equal((await f.runtime.status()).diagnosticCode,'DAEMON_NOT_OWNED');await assert.rejects(f.runtime.deactivate(),{code:'DAEMON_NOT_OWNED'});
 assert.equal(f.stops(),0);assert.equal(f.starts(),0);assert.deepEqual(fs.readFileSync(f.pidFile),before);assert.equal(fs.existsSync(f.proofFile),false);
});
test(`prepared 0.17.4 with a healthy 0.11.2 ${generation} daemon requires an explicit restart, cannot mint a proof, and keeps using the daemon's own release`,async t=>{
 const f=fixture(t);const old=f.prior({generation,prepared:true});const before=fs.readFileSync(f.pidFile),config=fs.readFileSync(path.join(f.loc.paseoHome,'config.json'));
 const result=await f.runtime.activate();assert.equal(result.phase,'restart_required');assert.equal(result.daemon.reachable,true);assert.equal(result.diagnosticCode,'RESTART_REQUIRED');
 assert.equal(f.stops(),0);assert.equal(f.starts(),0);assert.deepEqual(fs.readFileSync(f.pidFile),before);assert.equal(fs.existsSync(f.proofFile),false);
 // Reading, verifying and querying the old daemon never loaded a 0.17.4 module. Only the check of the
 // config the next start will write did, and it wrote nothing.
 assert.ok(f.used.modules.length>0);assert.deepEqual(f.used.modules.filter(m=>m.release!==old).map(m=>m.module),['config.js']);
 assert.deepEqual(fs.readFileSync(path.join(f.loc.paseoHome,'config.json')),config);
 const pairing=await f.runtime.pair();assert.match(pairing.url,/^https:\/\/app\.paseo\.sh\/#offer=/);
 assert.deepEqual(f.used.cli.map(c=>c.release),[old]);assert.equal(f.starts(),0);
});
}
test('an explicit stop and start moves a healthy 0.11.2-r4 daemon to 0.17.4 on the same home, keeps data and the old release',async t=>{
 const f=fixture(t);const old=f.prior({generation:'r4',prepared:true});
 const configFile=path.join(f.loc.paseoHome,'config.json');
 assert.equal((await f.runtime.activate()).phase,'restart_required');assert.equal(f.stops(),0);assert.equal(f.starts(),0);
 f.permitStop();const stopped=await f.runtime.deactivate();
 assert.equal(stopped.daemon.running,false);assert.equal(f.stops(),1);assert.equal(f.used.stoppedVia,old,'the old daemon is stopped by its own release');
 f.used.modules.length=0;
 const result=await f.runtime.activate();
 assert.equal(result.phase,'running');assert.equal(result.daemon.reachable,true);assert.equal(result.diagnosticCode,null);assert.equal(f.starts(),1);
 const root=layout.runtimeDirectory(f.loc);
 assert.deepEqual(f.used.cli.filter(c=>c.command.startsWith('daemon start')).map(c=>c.release),[root],'0.17.4 starts the new daemon');
 assert.deepEqual(f.used.modules.filter(m=>m.release!==root),[],'no old module touches the new daemon');
 assert.equal(state.readState().daemonRuntimeRevision,layout.RUNTIME_REVISION);
 assert.equal(fs.statSync(f.proofFile).mode&0o777,0o600);assert.notEqual(JSON.parse(fs.readFileSync(f.proofFile)).lock.pid,f.initial.pid);
 assert.equal(JSON.parse(fs.readFileSync(configFile)).daemon.listen,'127.0.0.1:'+state.readState().port);
 f.keep();
 // The 0.11.2 release stays verified for a rollback and is never started.
 assert.equal(layout.previousRuntimeDirectory(f.loc),old);assert.equal(JSON.parse(fs.readFileSync(path.join(old,'.pi-paseo-runtime.json'))).revision,path.basename(old));
 assert.equal((await f.runtime.status()).diagnosticCode,null);await f.runtime.activate();assert.equal(f.starts(),1);
});
test('the start after an upgrade loads 0.11.2 speech shapes through 0.17.4 read-path normalization and keeps the other settings',async t=>{
 const f=fixture(t);f.prior({generation:'r4',prepared:true});
 const configFile=path.join(f.loc.paseoHome,'config.json');
 // What 0.11.2 loaded, and what 0.17.4's strict schema rejects when the file is merged without that read path.
 assert.deepEqual(config0112.readPersistedConfig(f.loc.paseoHome).providers,LEGACY_CONFIG.providers);
 assert.equal(config0174.PersistedConfigSchema.safeParse(LEGACY_CONFIG).success,false);
 assert.equal((await f.runtime.activate()).phase,'restart_required');
 f.permitStop();await f.runtime.deactivate();
 assert.equal((await f.runtime.activate()).phase,'running');assert.equal(f.starts(),1);
 const saved=JSON.parse(fs.readFileSync(configFile));
 assert.equal(config0174.PersistedConfigSchema.safeParse(saved).success,true);
 assert.equal(saved.providers?.openai,undefined);
 assert.deepEqual(saved.features.dictation.stt,{provider:'openai',apiKey:'fixture-not-a-key',baseUrl:'https://stt.invalid',language:'zh'});
 assert.deepEqual(saved.features.voiceMode,{stt:{provider:'local',language:'zh'},tts:{provider:'local',speakerId:1}});
 assert.equal(saved.daemon.appendSystemPrompt,'retain');
 // The rollback caveat in the README: 0.11.2 does not load the key 0.17.4 folded into the dictation site.
 assert.throws(()=>config0112.readPersistedConfig(f.loc.paseoHome),/Invalid config/);
 f.keep();
});
test('while a 0.11.2 daemon serves, a config the 0.17.4 start cannot load is reported instead of RESTART_REQUIRED',async t=>{
 const f=fixture(t);f.prior({generation:'r4',prepared:true});
 const configFile=path.join(f.loc.paseoHome,'config.json');
 // Edited after the old daemon loaded it. Stopping now would leave Paseo down, the supervisor retrying.
 fs.writeFileSync(configFile,JSON.stringify({...LEGACY_CONFIG,features:{dictation:{stt:{provider:'whisper',language:'zh'}}}}),{mode:0o600});
 const before=fs.readFileSync(configFile);
 await assert.rejects(f.runtime.activate(),{code:'CONFIG_INCOMPATIBLE'});
 const reported=await f.runtime.status();
 assert.equal(reported.phase,'error');assert.equal(reported.diagnosticCode,'CONFIG_INCOMPATIBLE');assert.equal(reported.daemon.reachable,true);
 assert.equal(f.stops(),0);assert.equal(f.starts(),0);assert.deepEqual(fs.readFileSync(configFile),before);
 fs.writeFileSync(configFile,'{"version":1,',{mode:0o600});
 await assert.rejects(f.runtime.activate(),{code:'CONFIG_CORRUPT'});assert.equal((await f.runtime.status()).diagnosticCode,'CONFIG_CORRUPT');
 // Once corrected, the usual restart request comes back.
 fs.writeFileSync(configFile,JSON.stringify(LEGACY_CONFIG),{mode:0o600});
 const pending=await f.runtime.activate();assert.equal(pending.phase,'restart_required');assert.equal(pending.diagnosticCode,'RESTART_REQUIRED');
 assert.equal(f.stops(),0);assert.equal(f.starts(),0);f.keep();
});
test('while a 0.11.2 daemon serves, the collaboration switch writes config.json through 0.11.2 for that daemon to reload',async t=>{
 const f=fixture(t);const old=f.prior({generation:'r4',prepared:true});
 const saved=await f.runtime.saveConnectionSettings({agentCollaboration:true});
 assert.equal(saved.agentCollaborationApplied,'applied');
 const config=JSON.parse(fs.readFileSync(path.join(f.loc.paseoHome,'config.json')));
 assert.deepEqual(config.daemon.mcp,{enabled:true,injectIntoAgents:true});
 assert.deepEqual(config.providers,LEGACY_CONFIG.providers,'0.11.2 keeps its own shapes; the 0.17.4 start folds them later');
 assert.deepEqual(f.used.modules.filter(m=>m.module==='config.js').map(m=>m.release),[old]);
 assert.equal(f.stops(),0);assert.equal(f.starts(),0);f.keep();
});
for(const [name,change] of [
 ['a newer release',f=>{f.processes.get(f.initial.pid).revision='0.17.5-r1-000000000000';}],
 ['an unsupported 0.11.2-r1 release',f=>{f.processes.get(f.initial.pid).revision='0.11.2-r1-b60170bb6826';}],
 ['no recorded release (Linux)',f=>{f.processes.get(f.initial.pid).noRevision=true;}],
 ['a shipped release whose directory no longer verifies',f=>{const old=f.prior({generation:'r4',prepared:true});fs.writeFileSync(path.join(old,'.pi-paseo-runtime.json'),'{}');}],
])test(`a daemon started by ${name} is refused with DAEMON_RELEASE_UNAVAILABLE, never controlled through 0.17.4`,async t=>{
 const f=fixture(t);change(f);f.permitStop();f.used.modules.length=0;const before=fs.readFileSync(f.pidFile);
 const reported=await f.runtime.status();
 assert.equal(reported.diagnosticCode,'DAEMON_RELEASE_UNAVAILABLE');assert.equal(reported.daemon.running,true);assert.equal(reported.daemon.pid,f.initial.pid);assert.equal(reported.daemon.reachable,false);
 assert.equal(await f.runtime.daemonRunning(),true,'the supervisor sees a running daemon, not one to start');
 await assert.rejects(f.runtime.activate(),{code:'DAEMON_RELEASE_UNAVAILABLE'});
 await assert.rejects(f.runtime.deactivate(),{code:'DAEMON_RELEASE_UNAVAILABLE'});
 await assert.rejects(f.runtime.pair(),{code:'DAEMON_UNREACHABLE'});
 assert.deepEqual(f.used.modules,[],'no release module read, queried or stopped it');assert.deepEqual(f.used.cli,[]);
 assert.equal(f.stops(),0);assert.equal(f.starts(),0);assert.deepEqual(fs.readFileSync(f.pidFile),before);
});
test('a PID lock read while upstream rewrites it is read again: the 0.11.2 daemon keeps its own release',async t=>{
 const f=fixture(t);const old=f.prior({generation:'r4',prepared:true});
 f.emptyPidReads(3);
 const reported=await f.runtime.status();
 assert.equal(reported.diagnosticCode,'RESTART_REQUIRED');assert.equal(reported.daemon.reachable,true);
 assert.deepEqual(f.used.modules.map(m=>m.release),f.used.modules.map(()=>old));assert.ok(f.used.modules.length>0);
 // The serving release, not only the installed one, is reported.
 assert.equal(reported.version,layout.PASEO_VERSION);assert.equal(reported.daemon.version,layout.LEGACY_PASEO_VERSION);
});
test('one operation reads and stops the daemon through the same release',async t=>{
 const f=fixture(t);const old=f.prior({generation:'r4',prepared:true});
 // After the instance is read, the environment would name this release: the stop must not switch releases.
 f.hooks.read=()=>{f.processes.get(f.initial.pid).revision=layout.RUNTIME_REVISION;};
 await f.runtime.deactivate();assert.equal(f.used.stoppedVia,old);assert.equal(f.stops(),1);
 f.hooks.read=undefined;assert.equal((await f.runtime.activate()).daemon.version,layout.PASEO_VERSION);f.keep();
});
test('darwin: a daemon that 0.1.4-0.1.17 started without recording its release is controlled by an r3/r2 release, never r4 or 0.17.4',async t=>{
 const f=fixture(t,{platform:'darwin'});const r3=f.prior({generation:'r3',prepared:true});seedPriorRelease(f.loc,{generation:'r4'});
 state.updateState({daemonPid:f.initial.pid,daemonStartedAt:f.initial.startedAt,daemonRuntimeRevision:null});
 const hidden=r3+'.hidden';fs.renameSync(r3,hidden);
 assert.equal((await f.runtime.status()).diagnosticCode,'DAEMON_RELEASE_UNAVAILABLE','r4 recorded its revision, so it did not start this daemon');
 fs.renameSync(hidden,r3);f.used.modules.length=0;
 const reported=await f.runtime.status();assert.equal(reported.diagnosticCode,'RESTART_REQUIRED');assert.equal(reported.daemon.reachable,true);
 assert.deepEqual([...new Set(f.used.modules.map(m=>m.release))],[r3]);
 await f.runtime.deactivate();assert.equal(f.used.stoppedVia,r3);
 assert.equal((await f.runtime.activate()).phase,'running');assert.equal(state.readState().daemonRuntimeRevision,layout.RUNTIME_REVISION);
 assert.equal(fs.existsSync(f.proofFile),false,'darwin keeps no Linux birth proof');f.keep();
});
test('darwin: a stale 0.11.2-r4 PID record never starts the old release',async t=>{
 const f=fixture(t,{platform:'darwin'});const old=f.prior({generation:'r4',prepared:true});
 f.processes.delete(f.initial.pid); // died without releasing paseo.pid; state still records it
 const result=await f.runtime.activate();assert.equal(result.phase,'running');assert.equal(f.starts(),1);
 const root=layout.runtimeDirectory(f.loc);
 assert.deepEqual(f.used.cli.map(c=>c.release),[root]);
 assert.deepEqual(f.used.modules.filter(m=>m.module==='config.js').map(m=>m.release),[root]);
 assert.equal(state.readState().daemonRuntimeRevision,layout.RUNTIME_REVISION);assert.equal(layout.previousRuntimeDirectory(f.loc),old);f.keep();
});
test('darwin: a 0.11.2-r4 daemon recorded by the earlier release is controlled and stopped by that release',async t=>{
 const f=fixture(t,{platform:'darwin'});const old=f.prior({generation:'r4',prepared:true});
 const pending=await f.runtime.activate();assert.equal(pending.phase,'restart_required');assert.equal(pending.daemon.reachable,true);
 // 0.17.4 only checked the config its next start writes.
 assert.deepEqual(f.used.modules.filter(m=>m.release!==old).map(m=>m.module),['config.js']);
 await f.runtime.deactivate();assert.equal(f.used.stoppedVia,old);
 await f.runtime.activate();assert.equal(f.starts(),1);assert.equal(state.readState().daemonRuntimeRevision,layout.RUNTIME_REVISION);
 assert.equal((await f.runtime.status()).diagnosticCode,null);f.keep();
});


test('changing a running target defers all daemon mutation until an explicit stop and start', async t => {
 const f=fixture(t);await f.runtime.activate();
 const configFile=path.join(f.loc.paseoHome,'config.json');
 const original=fs.readFileSync(configFile),pid=fs.readFileSync(f.pidFile);
 await f.runtime.saveConnectionSettings({target:'woowtech'});
 const pending=await f.runtime.activate();
 assert.equal(pending.phase,'restart_required');
 assert.equal(state.readState().configurationPending,true);
 assert.deepEqual(fs.readFileSync(configFile),original);
 assert.deepEqual(fs.readFileSync(f.pidFile),pid);
 assert.equal(f.starts(),0);assert.equal(f.stops(),0);
 await assert.rejects(f.runtime.pair(),{code:'CONFIGURATION_PENDING'});
 f.permitStop();await f.runtime.deactivate();await f.runtime.activate();
 assert.equal(f.starts(),1);assert.equal(f.stops(),1);
 assert.equal(state.readState().configurationPending,false);
 assert.equal(state.readState().activeTarget,'woowtech');
 const configured=JSON.parse(fs.readFileSync(configFile));
 assert.equal(configured.app.baseUrl,'https://smart.woowtech.io');
 assert.equal(configured.daemon.relay.endpoint,'relay.woowtech.io:443');
 const pairing=await f.runtime.pair();
 assert.equal(pairing.target,'woowtech');
 assert.match(pairing.url,/^https:\/\/smart\.woowtech\.io\/#offer=/);
 assert.equal(fs.readFileSync(path.join(f.loc.paseoHome,'agents.db'),'utf8'),'retain-data');
});

test('protected relay security stays the Paseo clients\' choice, is off after a Smart target start, and its offers are refused there', async t => {
 const f=fixture(t);await f.runtime.activate();
 const configFile=path.join(f.loc.paseoHome,'config.json'),pairing=path.join(f.loc.stateDir,'pairing.private.json');
 // An official Paseo client turned it on while Paseo was the target: activation keeps that choice.
 const edited=JSON.parse(fs.readFileSync(configFile));edited.daemon.relay.requireProtectedSecurity=true;fs.writeFileSync(configFile,JSON.stringify(edited),{mode:0o600});
 await f.runtime.activate();assert.equal(JSON.parse(fs.readFileSync(configFile)).daemon.relay.requireProtectedSecurity,true);
 f.protectedOffers(true);assert.match((await f.runtime.pair()).url,/^https:\/\/app\.paseo\.sh\/#offer=/);
 await f.runtime.saveConnectionSettings({target:'woowtech'});f.permitStop();await f.runtime.deactivate();await f.runtime.activate();
 assert.equal(JSON.parse(fs.readFileSync(configFile)).daemon.relay.requireProtectedSecurity,false);
 // Turned on again while the daemon serves the Smart target: no link the app cannot use is handed out.
 await assert.rejects(f.runtime.pair(),{code:'PAIRING_SECURITY_UNSUPPORTED'});assert.equal(fs.existsSync(pairing),false);
 f.protectedOffers(false);assert.match((await f.runtime.pair()).url,/^https:\/\/smart\.woowtech\.io\/#offer=/);
});

test('an older running process without the pinned connection environment requires restart without being stopped', async t => {
 const f=fixture(t);f.processes.get(f.initial.pid).noConnectionProfile=true;
 const result=await f.runtime.activate();
 assert.equal(result.phase,'restart_required');
 assert.equal(result.diagnosticCode,'RESTART_REQUIRED');
 assert.equal(f.starts(),0);assert.equal(f.stops(),0);
 assert.equal(fs.existsSync(f.proofFile),false);
});

for(const platform of ['darwin','win32'])test(platform+' keeps an older daemon pending until explicit stop/start records the new revision',async t=>{
 const f=fixture(t,{platform});
 const pending=await f.runtime.activate();assert.equal(pending.phase,'restart_required');assert.equal(pending.diagnosticCode,'RESTART_REQUIRED');assert.equal(f.starts(),0);assert.equal(f.stops(),0);
 f.permitStop();await f.runtime.deactivate();await f.runtime.activate();
 assert.equal(f.starts(),1);assert.equal(state.readState().daemonRuntimeRevision,layout.RUNTIME_REVISION);
 assert.equal((await f.runtime.status()).diagnosticCode,null);
 await f.runtime.activate();assert.equal(f.starts(),1);
});

// Upstream Paseo writes paseo.pid with open(path,'wx') and no mode: under Ubuntu's umask 002 it is
// 0664. Measured on an Ubuntu host: DAEMON_IDENTITY_UNSAFE on every retry until the file was 0600.
test('umask 002: a group-writable official PID file in the private home is adopted, then recovered',async t=>{
 const f=fixture(t);fs.chmodSync(f.pidFile,0o664);
 assert.equal((await f.runtime.activate()).daemon.reachable,true);assert.equal(f.starts(),0);
 assert.equal(fs.statSync(f.proofFile).mode&0o777,0o600);
 // Stale-PID recovery re-reads the file and its quarantine copy under the same rule.
 f.reuse();fs.chmodSync(f.pidFile,0o664);
 assert.equal((await f.runtime.activate()).daemon.reachable,true);assert.equal(f.starts(),1);
 // Recovery keeps the quarantined 0664 PID file as evidence, as it does for 0644.
 const stale=fs.readdirSync(f.loc.paseoHome).filter(n=>n.startsWith('.paseo.pid.stale-'));
 assert.equal(stale.length,1);assert.equal(JSON.parse(fs.readFileSync(path.join(f.loc.paseoHome,stale[0]))).pid,f.initial.pid);f.keep();
});

test('group write is accepted only inside a verified private home; other write never',async t=>{
 const f=fixture(t);await f.runtime.activate();
 fs.chmodSync(f.pidFile,0o664);fs.chmodSync(f.loc.paseoHome,0o750);
 // Paseo's own config writer re-applies 0700 to its home whenever activation writes config.json, so the
 // identity check is probed where it decides alone (stale-PID recovery also runs it before any write).
 await assert.rejects(state.withRuntimeLock(()=>f.identity.observeOwnedInstance(f.loc,f.initial,()=>{})),{code:'DAEMON_IDENTITY_UNSAFE'});
 fs.chmodSync(f.loc.paseoHome,0o700);fs.chmodSync(f.pidFile,0o662);
 await assert.rejects(f.runtime.activate(),{code:'DAEMON_IDENTITY_UNSAFE'});
 fs.chmodSync(f.pidFile,0o664);assert.equal((await f.runtime.activate()).daemon.reachable,true);
 assert.equal(f.starts(),0);f.keep();
});

test('agent collaboration defaults off and reloads the running daemon without a restart', async t => {
 const f=fixture(t);await f.runtime.activate();
 const configFile=path.join(f.loc.paseoHome,'config.json');
 const mcp=()=>JSON.parse(fs.readFileSync(configFile)).daemon.mcp;
 assert.deepEqual(mcp(),{enabled:true,injectIntoAgents:false});
 assert.equal(f.runtime.agentCollaborationEnabled(),false);
 const pid=fs.readFileSync(f.pidFile),reloads=f.reloads();
 const on=await f.runtime.saveConnectionSettings({agentCollaboration:true});
 assert.equal(on.agentCollaboration,true);assert.equal(on.agentCollaborationApplied,'applied');
 assert.deepEqual(mcp(),{enabled:true,injectIntoAgents:true});
 assert.equal(fs.statSync(configFile).mode&0o777,0o600);
 assert.equal(f.reloads(),reloads+1,'one live reload');
 assert.deepEqual(fs.readFileSync(f.pidFile),pid);assert.equal(f.starts(),0);assert.equal(f.stops(),0);
 assert.notEqual(state.readState().configurationPending,true,'collaboration is not a pending target change');
 assert.equal(JSON.parse(fs.readFileSync(configFile)).daemon.appendSystemPrompt,'retain');
 await f.runtime.activate();assert.deepEqual(mcp(),{enabled:true,injectIntoAgents:true},'activation keeps the saved choice');
 const before=f.reloads();
 assert.equal((await f.runtime.saveConnectionSettings({agentCollaboration:true})).agentCollaborationApplied,'unchanged');
 assert.equal(f.reloads(),before);
 assert.equal((await f.runtime.saveConnectionSettings({agentCollaboration:false})).agentCollaborationApplied,'applied');
 assert.deepEqual(mcp(),{enabled:true,injectIntoAgents:false});
 await f.runtime.saveConnectionSettings({name:'Renamed'});
 assert.deepEqual(mcp(),{enabled:true,injectIntoAgents:false},'other saves leave it alone');
 f.keep();
});

test('a Paseo client turning collaboration on is what Pi Web shows, keeps, and can turn off', async t => {
 const f=fixture(t);await f.runtime.activate();
 const configFile=path.join(f.loc.paseoHome,'config.json');
 const config=JSON.parse(fs.readFileSync(configFile));
 // A Paseo client host setting patches the same key in the daemon config.
 config.daemon.mcp.injectIntoAgents=true;fs.writeFileSync(configFile,JSON.stringify(config),{mode:0o600});
 assert.equal(f.runtime.agentCollaborationEnabled(),true,'status reports the daemon value, not the old preference');
 await f.runtime.activate();
 assert.equal(JSON.parse(fs.readFileSync(configFile)).daemon.mcp.injectIntoAgents,true,'activation does not overwrite the client choice');
 const reloads=f.reloads();
 const off=await f.runtime.saveConnectionSettings({agentCollaboration:false});
 assert.equal(off.agentCollaborationApplied,'applied','compared with the daemon config, so it is not "unchanged"');
 assert.equal(off.agentCollaboration,false);
 assert.equal(JSON.parse(fs.readFileSync(configFile)).daemon.mcp.injectIntoAgents,false);
 assert.equal(f.reloads(),reloads+1);
});

test('a daemon home this installation does not own is never written for collaboration', async t => {
 const f=fixture(t);await f.runtime.activate();
 const configFile=path.join(f.loc.paseoHome,'config.json'),before=fs.readFileSync(configFile);
 const marker=path.join(f.loc.paseoHome,'.pi-paseo-owner.json'),owner=JSON.parse(fs.readFileSync(marker));
 fs.writeFileSync(marker,JSON.stringify({...owner,installationId:'someone-else'}));
 const reloads=f.reloads();
 const saved=await f.runtime.saveConnectionSettings({agentCollaboration:true});
 assert.equal(saved.agentCollaborationApplied,'next-start');
 assert.deepEqual(fs.readFileSync(configFile),before);
 assert.equal(f.reloads(),reloads);
 assert.equal(f.runtime.agentCollaborationEnabled(),true,'only the waiting choice is reported for a foreign home');
});

test('a daemon that cannot take the collaboration setting live asks for a restart', async t => {
 const f=fixture(t);await f.runtime.activate();
 f.setReload({appliedPaths:[],restartRequiredPaths:['daemon.mcp'],overrideControlledPaths:[]});
 const saved=await f.runtime.saveConnectionSettings({agentCollaboration:true});
 assert.equal(saved.agentCollaborationApplied,'restart-required');
 assert.equal(state.readState().phase,'restart_required');
 assert.equal(JSON.parse(fs.readFileSync(path.join(f.loc.paseoHome,'config.json'))).daemon.mcp.injectIntoAgents,true,'written for the next start');
 assert.equal(f.starts(),0);assert.equal(f.stops(),0);
 f.setReload({appliedPaths:[],restartRequiredPaths:[],overrideControlledPaths:['daemon.mcp.injectIntoAgents']});
 assert.equal((await f.runtime.saveConnectionSettings({agentCollaboration:false})).agentCollaborationApplied,'restart-required');
 await assert.rejects(f.runtime.saveConnectionSettings({agentCollaboration:'yes'}),{code:'INVALID_SETTING'});
 assert.equal(JSON.parse(fs.readFileSync(path.join(f.loc.paseoHome,'config.json'))).daemon.mcp.injectIntoAgents,false);
});

// ---- Stopping: what Paseo 0.17.4's stopDaemonInstance does (modeled in tests/helpers/upstream-stop.mjs) ----
// It stops the supervisor, releases the PID lock, and only then closes terminal workers in the caller's process.
const TERMINAL_CODE='TERMINAL_CLEANUP_NOT_CONFIRMED';
// The runtime runs in its own vm realm: compare its arrays and objects by value.
const plain=value=>JSON.parse(JSON.stringify(value));
const {DAEMON_STOP_TIMEOUT_MS,SUPERVISOR_STOP_TIMEOUT_MS,TERMINAL_CLEANUP_BUDGET_MS}=lifecycleTimeouts;
const unfinishedStop=(f,{recorded=false}={})=>{
 assert.notEqual(state.readState().phase,'disabled','a failed stop leaves the phase alone');
 assert.equal(!!state.readState().terminalCleanup,recorded);assert.deepEqual(f.pluginSignals,[],'the plugin signals no process');
};

test('a stop whose terminal cleanup cannot be confirmed has stopped the daemon: warning recorded, phase disabled',async t=>{
 const f=fixture(t);f.stopScenario({records:['noPs']});f.permitStop();
 // Processes that are not this daemon's supervisor: another home's, and a terminal worker's leftover. None may be signaled.
 f.processes.set(900500,{role:'foreign',home:'/elsewhere/daemon',startTicks:'900500',bootId:'11111111-1111-1111-1111-111111111111',uid:process.getuid()});
 f.processes.set(900501,{role:'owned',home:'/elsewhere/daemon',startTicks:'900501',bootId:'11111111-1111-1111-1111-111111111111',uid:process.getuid()});
 const result=await f.runtime.deactivate();
 assert.equal(f.processes.has(900500)&&f.processes.has(900501),true,'unrelated processes are untouched');
 assert.equal(result.phase,'disabled');assert.equal(result.enabled,false);assert.equal(result.daemon.running,false);
 assert.equal(f.processes.has(f.initial.pid),false,'the supervisor is gone');assert.equal(fs.existsSync(f.pidFile),false,'the PID lock is released');
 // Upstream's order: the lock is released before the cleanup that failed.
 assert.deepEqual(f.upstream.events.map(row=>row.event),['sigterm','supervisor-exit','lock-released','terminal-cleanup']);
 assert.deepEqual(plain(result.warnings).map(row=>row.code),[TERMINAL_CODE]);assert.match(result.warnings[0].at,/^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
 assert.equal(state.readState().phase,'disabled');assert.equal(state.readState().terminalCleanup.code,TERMINAL_CODE);
 assert.equal(state.readState().daemonPid,null);assert.equal(result.diagnosticCode,null,'a warning is not a diagnostic error');
 assert.deepEqual(f.signalsSent,[[f.initial.pid,'SIGTERM']]);assert.deepEqual(f.pluginSignals,[]);
 const health=healthReport(result);assert.deepEqual(health.warnings,[TERMINAL_CODE]);assert.equal(health.codes.includes(TERMINAL_CODE),false);
 assert.equal(f.upstream.closing.length,1,'upstream keeps its closing record for the next stop or start');
 f.keep();
 // Another stop with nothing running reports nothing new and keeps the record.
 assert.deepEqual(plain((await f.runtime.deactivate()).warnings).map(row=>row.code),[TERMINAL_CODE]);
});

for(const [name,scenario,remains]of [
 ['the supervisor is still running',f=>({records:['noPs'],leaveSupervisor:true}),f=>assert.equal(f.processes.has(f.initial.pid),true)],
 ['another daemon now holds the PID lock',f=>({records:['noPs'],afterRelease:()=>f.publish()}),f=>assert.notEqual(JSON.parse(fs.readFileSync(f.pidFile)).pid,f.initial.pid)],
 ['a PID lock file is still there',f=>({records:['noPs'],afterRelease:()=>fs.writeFileSync(f.pidFile,JSON.stringify({pid:900999,startedAt:'stale',uid:process.getuid()}))}),f=>assert.equal(JSON.parse(fs.readFileSync(f.pidFile)).pid,900999)],
])
test(`an unconfirmed terminal cleanup stays an error when ${name}`,async t=>{
 const f=fixture(t);f.stopScenario(scenario(f));f.permitStop();
 await assert.rejects(f.runtime.deactivate(),{code:TERMINAL_CODE});
 unfinishedStop(f);remains(f);assert.equal(f.signalsSent.length,1);
});

test('a supervisor that never exits fails at the stop budget: STOP_NOT_CONFIRMED, one SIGTERM, nothing killed',async t=>{
 const f=fixture(t);f.stopScenario({supervisorHangs:true});f.permitStop();const start=f.clock.now;
 await assert.rejects(f.runtime.deactivate(),{code:'STOP_NOT_CONFIRMED'});
 assert.equal(f.clock.now-start,DAEMON_STOP_TIMEOUT_MS);
 unfinishedStop(f);assert.equal(f.processes.has(f.initial.pid),true);assert.equal(fs.existsSync(f.pidFile),true);
 assert.deepEqual(f.signalsSent,[[f.initial.pid,'SIGTERM']]);assert.deepEqual(f.upstream.events.map(row=>row.event),['sigterm']);
});

test('a slow daemon worker and two unresponsive terminal workers stop inside the budget, without a warning',async t=>{
 const f=fixture(t);f.stopScenario({workerShutdownMs:60000,records:['unresponsive','unresponsive']});f.permitStop();const start=f.clock.now;
 const result=await f.runtime.deactivate();
 const elapsed=f.clock.now-start;
 // 10 s of worker grace (the supervisor kills the worker's tree after that) and 13 s for each terminal worker record.
 assert.ok(elapsed>=10000+2*13000,'the scenario is the worst case a daemon can have: '+elapsed);assert.ok(elapsed<=DAEMON_STOP_TIMEOUT_MS,'within the budget: '+elapsed);
 assert.equal(result.phase,'disabled');assert.deepEqual(plain(result.warnings),[]);assert.equal(state.readState().terminalCleanup,null);
 assert.deepEqual(f.signalsSent,[[f.initial.pid,'SIGTERM']]);assert.deepEqual(f.pluginSignals,[]);
});

test('more unresponsive terminal worker records than a daemon runs overrun the budget: a bounded failure that leaves the supervisor alone',async t=>{
 const f=fixture(t);f.stopScenario({workerShutdownMs:60000,records:['unresponsive','unresponsive','unresponsive']});f.permitStop();const start=f.clock.now;
 await assert.rejects(f.runtime.deactivate(),{code:'STOP_NOT_CONFIRMED'});
 assert.equal(f.clock.now-start,DAEMON_STOP_TIMEOUT_MS);unfinishedStop(f);assert.equal(f.processes.has(f.initial.pid),true);
});

test('the stop budgets cover upstream\'s worst case with its own constants, and the old 20 s did not',()=>{
 const worker=10000,record=13000,workers=2;
 assert.equal(lifecycleTimeouts.WORKER_GRACE_MS,worker);assert.equal(lifecycleTimeouts.TERMINAL_RECORD_CLEANUP_MS,record);assert.equal(lifecycleTimeouts.TERMINAL_WORKER_LIMIT,workers);
 const supervisorExit=worker+workers*record;
 assert.ok(DAEMON_STOP_TIMEOUT_MS>supervisorExit,'the wait for the supervisor');assert.ok(20000<supervisorExit,'the previous budget was too short');
 // The plugin supervisor stops the daemon and then runs upstream's second cleanup before it exits.
 assert.ok(SUPERVISOR_STOP_TIMEOUT_MS>=DAEMON_STOP_TIMEOUT_MS+TERMINAL_CLEANUP_BUDGET_MS);
});

test('starting again clears the stop-time warning, and a running daemon is warned about only what it reports',async t=>{
 const f=fixture(t);f.stopScenario({records:['noPs']});f.permitStop();await f.runtime.deactivate();
 assert.equal(state.readState().terminalCleanup.code,TERMINAL_CODE);
 const started=await f.runtime.activate();
 assert.equal(started.phase,'running');assert.equal(state.readState().terminalCleanup,null);assert.deepEqual(plain(started.warnings),[]);assert.equal(started.daemon.terminalCleanupUnconfirmed,0);
 f.daemonStatus({terminalCleanupUnconfirmed:[{pid:700000,role:'terminal program',reason:'inspection failed',detail:'spawn ps ENOENT'}]});state.updateState({observed:1});
 const warned=await f.runtime.status();
 assert.deepEqual(plain(warned.warnings).map(row=>row.code),[TERMINAL_CODE]);assert.equal(warned.daemon.terminalCleanupUnconfirmed,1);
 assert.equal(warned.diagnosticCode,null);assert.equal(healthReport({...warned,providers:[]}).codes.includes(TERMINAL_CODE),false);
});

test('a ps that cannot serve terminal cleanup is a warning on every start and diagnosis, never a blocker',async t=>{
 const f=fixture(t);
 // Not checked (any platform but Linux): nothing is recorded.
 assert.deepEqual(plain((await f.runtime.activate()).warnings),[]);assert.equal(state.readState().processTable,undefined);
 f.processTable({checked:true,ok:false,code:'PS_UNAVAILABLE'});
 const warned=await f.runtime.activate();
 assert.equal(warned.phase,'running');assert.equal(warned.daemon.reachable,true,'Paseo starts and runs');assert.equal(warned.diagnosticCode,null);
 assert.deepEqual(plain(warned.warnings).map(row=>row.code),['PS_UNAVAILABLE']);assert.match(warned.warnings[0].at,/^\d{4}-\d\d-\d\dT/);
 assert.equal(state.readState().processTable.code,'PS_UNAVAILABLE');
 const health=healthReport({...warned,providers:[]});assert.deepEqual(health.warnings,['PS_UNAVAILABLE']);assert.equal(health.codes.includes('PS_UNAVAILABLE'),false);
 // The same host with both a stop that left terminals open and a bad ps: two warnings, each once.
 f.stopScenario({records:['noPs']});f.permitStop();
 assert.deepEqual(plain(await f.runtime.deactivate()).warnings.map(row=>row.code).sort(),['PS_UNAVAILABLE',TERMINAL_CODE]);
 // procps is installed: the next check clears it.
 f.processTable({checked:true,ok:true});
 const fixed=await f.runtime.activate();assert.deepEqual(plain(fixed.warnings),[]);assert.equal(state.readState().processTable.ok,true);
});

// ---- Pruning old releases behind a healthy start from this release ----
const R4='0.11.2-r4-4cf9d40940bf',R3A='0.11.2-r3-4cf9d40940bf',R3B='0.11.2-r3-6d8dbe515479',R2='0.11.2-r2-6d8dbe515479';
const releaseNames=f=>fs.readdirSync(path.join(f.loc.runtimeDir,'releases')).sort();
const tombs=f=>releaseNames(f).filter(name=>name.startsWith('.pruning-'));
function seedOlder(f,generations=['r4','r3a','r3b','r2']) {
 const seeds={r4:{generation:'r4'},r3a:{generation:'r3'},r3b:{generation:'r3',lockSha256:LOCK_0112},r2:{generation:'r2'}};
 for(const generation of generations)seedPriorRelease(f.loc,seeds[generation]);
}
// The deletion of what was claimed runs after the activation, without its lock: tests wait for it to end.
const activated=async f=>{const result=await f.runtime.activate();await f.runtime.pruneSettled();return result;};
const after=(ms,value)=>new Promise(resolve=>{setTimeout(()=>resolve(value),ms).unref();});

test('a healthy start from this release removes the older releases nothing needs, and records names only',async t=>{
 const f=fixture(t);seedOlder(f);
 fs.mkdirSync(path.join(f.loc.runtimeDir,'node_modules/@getpaseo/cli'),{recursive:true});fs.writeFileSync(path.join(f.loc.runtimeDir,'node_modules/@getpaseo/cli/package.json'),'{"version":"0.11.2"}');
 assert.deepEqual(releaseNames(f),[R2,R3A,R3B,R4,layout.RUNTIME_REVISION].sort());
 const result=await activated(f);
 assert.equal(result.phase,'running');assert.equal(result.daemon.reachable,true);assert.equal(f.starts(),0,'the healthy daemon was adopted, not restarted');
 assert.deepEqual(releaseNames(f),[R4,layout.RUNTIME_REVISION].sort(),'this release and the newest earlier one remain');
 const prune=plain(state.readState().lastPrune);
 assert.deepEqual(Object.keys(prune).sort(),['at','failed','kept','removed']);assert.deepEqual([...prune.removed].sort(),[R2,R3A,R3B].sort());assert.deepEqual(prune.kept,[layout.RUNTIME_REVISION,R4]);assert.deepEqual(prune.failed,[]);
 assert.doesNotMatch(JSON.stringify(prune),/\/|home|runtime-pid/,'names only: no path');
 assert.ok(fs.existsSync(path.join(f.loc.runtimeDir,'node_modules/@getpaseo/cli/package.json')),'the legacy control copy is not a release');
 assert.equal(layout.previousRuntimeDirectory(f.loc),path.join(f.loc.runtimeDir,'releases',R4),'the rollback release still verifies');
 // Nothing left to remove: the next activation neither removes nor rewrites the record.
 await activated(f);assert.deepEqual(plain(state.readState().lastPrune),prune);assert.deepEqual(releaseNames(f),[R4,layout.RUNTIME_REVISION].sort());
 f.keep();
});

test('nothing is pruned while an older daemon serves; the release it needs for control stays until the upgrade is done',async t=>{
 const f=fixture(t);seedOlder(f,['r3a','r2']);const old=f.prior({generation:'r4',prepared:true});
 const all=releaseNames(f);
 assert.equal((await activated(f)).phase,'restart_required');
 assert.deepEqual(releaseNames(f),all);assert.equal(state.readState().lastPrune,undefined);
 f.permitStop();await f.runtime.deactivate();assert.deepEqual(releaseNames(f),all,'a stop prunes nothing');
 const started=await activated(f);
 assert.equal(started.phase,'running');assert.equal(f.starts(),1);
 assert.deepEqual(releaseNames(f),[R4,layout.RUNTIME_REVISION].sort());assert.equal(layout.previousRuntimeDirectory(f.loc),old);
 assert.deepEqual(plain(state.readState().lastPrune.removed).sort(),[R2,R3A].sort());
});

test('a release that a live process pins stays, whichever home it serves; a process of this home that pins none stops the pruning',async t=>{
 const f=fixture(t);seedOlder(f,['r4','r3a','r2']);
 f.process({revision:R3A});
 await activated(f);
 assert.deepEqual(releaseNames(f),[R3A,R4,layout.RUNTIME_REVISION].sort(),'another home\'s daemon still runs 0.11.2-r3');assert.deepEqual(plain(state.readState().lastPrune.removed),[R2]);
 // A process of this very home that says nothing about its release: what it runs cannot be told, so nothing goes.
 seedOlder(f,['r2']);
 const stray=f.process({home:f.loc.paseoHome,noRevision:true,noConnectionProfile:true});
 await activated(f);
 assert.equal(state.readState().lastPrune.skipped,'RELEASE_IN_USE_UNKNOWN');assert.ok(releaseNames(f).includes(R2));
 f.processes.delete(stray);
 await activated(f);assert.equal(releaseNames(f).includes(R2),false,'once it is gone the pruning resumes');
});

test('the scan fails closed: a process of this user whose environment cannot be read stops the pruning, one of another user does not',async t=>{
 const f=fixture(t);seedOlder(f,['r4','r3a','r2']);
 // Another user's process: its owner is read from /proc/<pid>/status, and it is not ours to wonder about.
 f.process({uid:process.getuid()+1,environUnreadable:true});
 // A non-dumpable process of ours looks like this: /proc/<pid> is root's, the environment is denied to us.
 const sealed=f.process({environUnreadable:true});
 await activated(f);
 assert.equal(state.readState().lastPrune.skipped,'RELEASE_IN_USE_UNKNOWN');assert.deepEqual(plain(state.readState().lastPrune.removed),[]);
 assert.deepEqual(releaseNames(f),[R2,R3A,R4,layout.RUNTIME_REVISION].sort(),'nothing was touched');
 f.processes.delete(sealed);
 await activated(f);assert.deepEqual(releaseNames(f),[R4,layout.RUNTIME_REVISION].sort(),'the other user\'s process never mattered');
});

test('this process and its parent are not daemons: an ambient PASEO_HOME in their environment stops nothing',async t=>{
 const f=fixture(t);seedOlder(f,['r4','r3a','r2']);
 const ambient={home:f.loc.paseoHome,noRevision:true,noConnectionProfile:true};
 f.self(ambient,ambient);
 await activated(f);
 assert.deepEqual(releaseNames(f),[R4,layout.RUNTIME_REVISION].sort());assert.deepEqual(plain(state.readState().lastPrune.removed).sort(),[R2,R3A].sort());
 // Any other process with that environment does count.
 seedOlder(f,['r2']);f.process(ambient);
 await activated(f);assert.equal(state.readState().lastPrune.skipped,'RELEASE_IN_USE_UNKNOWN');
});

test('a release newer than this one is never pruned (a downgrade leaves one, and the next upgrade needs it again)',async t=>{
 const f=fixture(t);seedOlder(f,['r4']);
 const newer='0.99.0-r1-bbbbbbbbbbbb',root=path.join(f.loc.runtimeDir,'releases',newer);
 fs.mkdirSync(root);fs.writeFileSync(path.join(root,'.pi-paseo-runtime.json'),JSON.stringify({revision:newer,lockSha256:newer.slice(-12)+'0'.repeat(52)}));
 const before=releaseNames(f);
 await activated(f);
 assert.deepEqual(releaseNames(f),before);assert.equal(state.readState().lastPrune,undefined,'nothing to do is not recorded');
});

test('deleting old releases takes no lock: pairing and settings go through while it runs, and its outcome is recorded after',async t=>{
 const f=fixture(t);seedOlder(f);
 let began,release;const started=new Promise(resolve=>{began=resolve;}),gate=new Promise(resolve=>{release=resolve;});
 // A slow disk: every deletion waits here.
 f.removal(async(target,options)=>{began();await gate;return fs.promises.rm(target,options);});
 const result=await Promise.race([f.runtime.activate(),after(10000,'waited for the deletion')]);
 assert.notEqual(result,'waited for the deletion','the activation does not wait for the deletion');
 assert.equal(result.phase,'running');
 await started;
 // Claimed in one step: three tombs, no release among them any more; the rollback release is untouched.
 assert.equal(tombs(f).length,3);assert.deepEqual(releaseNames(f).filter(name=>!name.startsWith('.pruning-')),[R4,layout.RUNTIME_REVISION].sort());
 assert.equal(layout.previousRuntimeDirectory(f.loc),path.join(f.loc.runtimeDir,'releases',R4));
 assert.equal(state.readState().lastPrune,undefined,'the outcome is not recorded before the deletion ends');
 // Both take the runtime lock and give up on it after 30 seconds (RUNTIME_BUSY): they must not have to wait for the deletion.
 const quick=await Promise.race([Promise.all([f.runtime.pair(),f.runtime.saveConnectionSettings({name:'while deleting'})]).then(()=>'done'),after(5000,'blocked')]);
 assert.equal(quick,'done','pair and saveConnectionSettings are not blocked by a slow deletion');
 assert.equal((await f.runtime.status()).phase,'running');
 // Another activation meanwhile leaves the tombs being deleted alone.
 assert.equal((await f.runtime.activate()).phase,'running');
 release();await f.runtime.pruneSettled();
 assert.deepEqual(releaseNames(f),[R4,layout.RUNTIME_REVISION].sort());
 const prune=plain(state.readState().lastPrune);assert.deepEqual([...prune.removed].sort(),[R2,R3A,R3B].sort());assert.deepEqual(prune.failed,[]);
});

test('a leftover of an earlier deletion is finished at the next activation, even with only this release and its rollback left',async t=>{
 const f=fixture(t);seedOlder(f,['r4']);
 const leftover='.pruning-'+R3A+'-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',root=path.join(f.loc.runtimeDir,'releases',leftover);
 fs.mkdirSync(path.join(root,'node_modules/@getpaseo/cli'),{recursive:true});fs.writeFileSync(path.join(root,'node_modules/@getpaseo/cli/package.json'),'{}');
 // Not one this code made: left alone.
 fs.mkdirSync(path.join(f.loc.runtimeDir,'releases/.pruning-custom'));
 assert.equal(releaseNames(f).length,4);
 await activated(f);
 assert.deepEqual(releaseNames(f),['.pruning-custom',R4,layout.RUNTIME_REVISION].sort());
 const prune=plain(state.readState().lastPrune);assert.deepEqual(prune.removed,[R3A]);assert.deepEqual(prune.failed,[]);assert.deepEqual(prune.kept,[layout.RUNTIME_REVISION,R4]);
 // Also while an older daemon serves and nothing else may be pruned: a leftover is no release.
 fs.mkdirSync(path.join(f.loc.runtimeDir,'releases/.pruning-'+R2+'-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4e'));
 f.process({home:f.loc.paseoHome,noRevision:true,noConnectionProfile:true});
 await activated(f);assert.equal(releaseNames(f).some(name=>name.includes(R2)),false);
});

test('a crash between the rename and the deletion leaves no half release; the next activation finishes the job',async t=>{
 const f=fixture(t);seedOlder(f,['r4','r3a','r2']);
 // What a process that dies right after the rename leaves: the release renamed, nothing deleted, nothing recorded.
 f.removal(async()=>{throw Object.assign(new Error('the process died'),{code:'EIO'});});
 const first=await activated(f);
 assert.equal(first.phase,'running');
 assert.equal(tombs(f).length,2);assert.deepEqual(releaseNames(f).filter(name=>!name.startsWith('.pruning-')),[R4,layout.RUNTIME_REVISION].sort());
 assert.deepEqual(plain(state.readState().lastPrune.failed).sort(),[R2,R3A].sort());assert.deepEqual(plain(state.readState().lastPrune.removed),[]);
 assert.equal(layout.previousRuntimeDirectory(f.loc),path.join(f.loc.runtimeDir,'releases',R4),'control is untouched');
 assert.equal((await f.runtime.status()).daemon.running,true);
 f.removal(null);
 await activated(f);
 assert.deepEqual(releaseNames(f),[R4,layout.RUNTIME_REVISION].sort());
 const prune=plain(state.readState().lastPrune);assert.deepEqual([...prune.removed].sort(),[R2,R3A].sort());assert.deepEqual(prune.failed,[]);
});

test('a pruning failure never fails an activation or a status',{skip:process.getuid?.()===0&&'permissions do not stop root'},async t=>{
 const f=fixture(t);seedOlder(f);const releases=path.join(f.loc.runtimeDir,'releases');
 fs.chmodSync(releases,0o555);
 try {
  const result=await activated(f);
  assert.equal(result.phase,'running');assert.equal(result.daemon.reachable,true);assert.equal(result.diagnosticCode,null);
  assert.deepEqual(plain(state.readState().lastPrune.failed).sort(),[R2,R3A,R3B].sort());assert.deepEqual(plain(state.readState().lastPrune.removed),[]);
  assert.equal((await f.runtime.status()).phase,'running');
 } finally {fs.chmodSync(releases,0o755);}
 assert.deepEqual(releaseNames(f),[R2,R3A,R3B,R4,layout.RUNTIME_REVISION].sort(),'every release is whole');
 await activated(f);assert.deepEqual(releaseNames(f),[R4,layout.RUNTIME_REVISION].sort(),'the next activation finishes the job');
});
