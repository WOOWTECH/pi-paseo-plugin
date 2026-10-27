import {seedPidFiles} from './helpers/runtime-pid-files.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import {spawnSync,spawn} from 'node:child_process';
import {once} from 'node:events';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import ts from 'typescript';
import * as state from '../src/state.mjs';
import * as layout from '../src/runtime-layout.mjs';
import {singleFlight,createReadWindow} from '../src/single-flight.mjs';
const require=createRequire(import.meta.url);
let identityModule={};
try {identityModule=await import('../src/daemon-identity.mjs');}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}

function fixture(t) {
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
 fs.mkdirSync(cli,{recursive:true});fs.writeFileSync(path.join(cli,'package.json'),JSON.stringify({version:'0.11.2'}));
 fs.mkdirSync(path.join(server,'dist/server/web-ui'),{recursive:true});fs.writeFileSync(path.join(server,'dist/server/web-ui/index.html'),'fixture');seedPidFiles(loc);layout.markRuntimeReady(loc);
 const pidFile=path.join(loc.paseoHome,'paseo.pid'),proofFile=path.join(loc.stateDir,'daemon-instance.private.json');
 const bootId='11111111-1111-1111-1111-111111111111',processes=new Map();let nextPid=900000,starts=0,stops=0,allowStop=false;
 function publish(mode=0o644){const pid=++nextPid;const birth={bootId,startTicks:String(pid),uid:process.getuid()};processes.set(pid,{...birth,role:'owned',home:loc.paseoHome});const lock={pid,startedAt:new Date().toISOString(),uid:process.getuid(),bootId,heartbeat:true,piPaseoProtocol:'linux-flock-v1',listen:'127.0.0.1:27669',hostname:'fixture'};fs.writeFileSync(pidFile,JSON.stringify(lock),{mode});return lock;}
 const initial=publish();const initialBytes=fs.readFileSync(pidFile);
 fs.writeFileSync(path.join(loc.paseoHome,'config.json'),JSON.stringify({custom:'preserve',auth:{fixture:'retain'}}),{mode:0o600});
 fs.writeFileSync(path.join(loc.paseoHome,'agents.db'),'retain-data',{mode:0o600});
 fs.writeFileSync(path.join(loc.stateDir,'pairing.private.json'),'retain-pairing',{mode:0o600});
 const verifyProc=()=>{for(const [pid,p]of processes)if(p.role==='owned'&&p.home===loc.paseoHome)throw new state.RuntimeError('DAEMON_ALREADY_RUNNING');};
 const identity=identityModule.createDaemonIdentity?.({readBirth:pid=>{const p=processes.get(pid);if(p?.unreadable)throw new state.RuntimeError('DAEMON_IDENTITY_UNVERIFIABLE');return p?{bootId:p.bootId,startTicks:p.startTicks,uid:p.uid}:null;},assertNoSupervisor:verifyProc});
 const fakeFs={...fs,readFileSync(file,...args){const m=/^\/proc\/(\d+)\/(cmdline|environ)$/.exec(String(file));if(m){const p=processes.get(Number(m[1]));if(!p)throw Object.assign(new Error('gone'),{code:'ENOENT'});return m[2]==='cmdline'?(p.role==='owned'?'Paseo Supervisor\0':'foreign-fixture\0'):`PASEO_HOME=${p.home}\0PI_PASEO_RUNTIME_REVISION=${p.revision||layout.RUNTIME_REVISION}\0`;}return fs.readFileSync(file,...args);},realpathSync(file,...args){if(/^\/proc\/\d+\/exe$/.test(String(file)))return fs.realpathSync(process.execPath);return fs.realpathSync(file,...args);}};
 const loadInstance=()=>fs.existsSync(pidFile)?JSON.parse(fs.readFileSync(pidFile)):null;
 const client={reloadDaemonConfig:async()=>({appliedPaths:['agents.providers'],restartRequiredPaths:[],overrideControlledPaths:[]}),getDaemonStatus:async()=>({pid:loadInstance().pid+1,providers:[],relay:{enabled:true}}),close:async()=>{}};
 const source=new URL('../src/runtime.mjs',import.meta.url);
 const code=ts.transpileModule(fs.readFileSync(source,'utf8'),{fileName:source.pathname+'.ts',compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
 const module={exports:{}};
 const localRequire=spec=>{
  if(spec==='node:fs')return fakeFs;
  if(spec==='./state.mjs')return {...state,processIdentity:pid=>processes.get(pid)?.startTicks??state.processIdentity(pid)};
  if(spec==='./daemon-identity.mjs')return identity;
  if(spec==='./runtime-layout.mjs')return layout;
  if(spec==='./single-flight.mjs')return {singleFlight,daemonStatusWindow:createReadWindow()};
  if(spec==='./web-client.mjs')return {ensureWebClient:async()=>({ready:true}),webClientStatus:()=>({ready:true}),managedPairUrl:()=>'/paseo-web/welcome#fixture'};
  if(spec==='./provider-launchers.mjs')return {resolveProviderLaunchers:async()=>({}),configureProviders:previous=>previous||{}};
  if(spec==='./process.mjs')return {findExecutable:()=>assert.fail('No npm install'),runProcess:async(_cmd,args)=>{if(args.length===2&&args[1]==='--version')return '0.11.2';if(args.includes('pair'))return JSON.stringify({url:'https://app.paseo.sh/#fixture',relayEnabled:true});assert.ok(args.includes('start'));starts++;publish();return '{}';}};
  if(spec.endsWith('/daemon-instance.js'))return {readDaemonInstance:async()=>loadInstance(),stopDaemonInstance:async(_home,{instance})=>{assert.equal(allowStop,true,'No foreign signal');assert.equal(processes.get(instance.pid)?.role,'owned');stops++;processes.delete(instance.pid);fs.unlinkSync(pidFile);}};
  if(spec.endsWith('/dist/utils/client.js'))return {connectToDaemon:async()=>client};
  if(spec.endsWith('/server/config.js'))return {savePersistedConfig:(_home,config)=>fs.writeFileSync(path.join(loc.paseoHome,'config.json'),JSON.stringify(config))};
  if(spec.startsWith('./'))return {};
  return require(spec);
 };
 vm.runInNewContext(`(function(require,module,exports){${code}\n})`,{process,URL,setTimeout,clearTimeout,console})(localRequire,module,module.exports);
 return{loc,initial,initialBytes,pidFile,proofFile,installation,processes,runtime:module.exports,identity,starts:()=>starts,stops:()=>stops,r2({prepared=false}={}){const oldRoot=root.replace('-r3-','-r2-');fs.cpSync(root,oldRoot,{recursive:true,verbatimSymlinks:true});for(const copy of ['dist/server/server','dist/src/server'])fs.copyFileSync(new URL('./fixtures/paseo-0.11.2/pid-lock.js',import.meta.url),path.join(oldRoot,'node_modules/@getpaseo/server',copy,'pid-lock.js'));const receipt=JSON.parse(fs.readFileSync(path.join(oldRoot,'.pi-paseo-runtime.json')));receipt.revision=layout.RUNTIME_REVISION.replace('-r3-','-r2-');delete receipt.pidLockPatchId;fs.writeFileSync(path.join(oldRoot,'.pi-paseo-runtime.json'),JSON.stringify(receipt));processes.get(initial.pid).revision=receipt.revision;const lock=JSON.parse(fs.readFileSync(pidFile));delete lock.piPaseoProtocol;fs.writeFileSync(pidFile,JSON.stringify(lock));allowStop=true;if(!prepared)fs.rmSync(root,{recursive:true});return oldRoot;},reuse(){const p=processes.get(initial.pid);p.startTicks+='9';p.role='foreign';},keep(){assert.equal(state.readState().installationId,installation);assert.equal(state.readState().onboardingSessionId,'keep-session');assert.equal(fs.readFileSync(path.join(loc.paseoHome,'agents.db'),'utf8'),'retain-data');assert.equal(fs.readFileSync(path.join(loc.stateDir,'pairing.private.json'),'utf8'),'retain-pairing');assert.equal(JSON.parse(fs.readFileSync(path.join(loc.paseoHome,'config.json'))).auth.fixture,'retain');}};
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
 const result=await f.runtime.pair();assert.equal(result.url,'/paseo-web/welcome#fixture');assert.deepEqual(fs.readFileSync(f.proofFile),proof);assert.equal(f.starts(),0);
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


test('upgrade before r3 installation: trusted r2 remains visible and normal deactivate stops the owned daemon',async t=>{
 const f=fixture(t);f.r2();assert.equal(fs.existsSync(layout.runtimeDirectory(f.loc)),false);
 const snapshot=await f.runtime.status();assert.equal(snapshot.installed,true);assert.equal(snapshot.daemon.running,true);assert.equal(snapshot.daemon.reachable,true);assert.equal(snapshot.diagnosticCode,'RESTART_REQUIRED');
 const result=await f.runtime.deactivate();assert.equal(result.enabled,false);assert.equal(result.daemon.running,false);assert.equal(f.stops(),1);assert.equal(f.starts(),0);assert.equal(fs.existsSync(f.pidFile),false);assert.equal(fs.existsSync(f.proofFile),false);assert.equal(fs.existsSync(layout.runtimeDirectory(f.loc)),false);f.keep();
});
test('r2 fallback still verifies ownership before stop and never clears foreign legacy PID',async t=>{
 const f=fixture(t);f.r2();f.reuse();const before=fs.readFileSync(f.pidFile);
 assert.equal((await f.runtime.status()).diagnosticCode,'DAEMON_NOT_OWNED');await assert.rejects(f.runtime.deactivate(),{code:'DAEMON_NOT_OWNED'});
 assert.equal(f.stops(),0);assert.equal(f.starts(),0);assert.deepEqual(fs.readFileSync(f.pidFile),before);assert.equal(fs.existsSync(f.proofFile),false);
});
test('prepared r3 with healthy r2 still requires explicit restart and cannot mint a proof',async t=>{
 const f=fixture(t);f.r2({prepared:true});const before=fs.readFileSync(f.pidFile);
 const result=await f.runtime.activate();assert.equal(result.phase,'restart_required');assert.equal(result.daemon.reachable,true);assert.equal(result.diagnosticCode,'RESTART_REQUIRED');
 assert.equal(f.stops(),0);assert.equal(f.starts(),0);assert.deepEqual(fs.readFileSync(f.pidFile),before);assert.equal(fs.existsSync(f.proofFile),false);
});
