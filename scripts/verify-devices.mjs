#!/usr/bin/env node
// Focused isolated verification of installed Paseo 0.18.1 Devices/Tailscale RPC.
// Usage: node scripts/verify-devices.mjs /absolute/prepared-runtime
// Only private temporary files and explicitly bound loopback sockets are used. No Tailscale CLI, provider, or host service.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';

const prepared=process.argv[2]&&path.resolve(process.argv[2]);
if(!prepared||!path.isAbsolute(prepared)){console.error('Usage: node scripts/verify-devices.mjs /absolute/prepared-runtime');process.exit(2);}
const reportPath=process.env.PI_PASEO_DEVICES_REPORT;
if(reportPath&&!path.isAbsolute(reportPath)){console.error('PI_PASEO_DEVICES_REPORT must be an absolute path');process.exit(2);}
const savedEnv={...process.env};
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'pi-paseo-devices-'));
const originalFetch=globalThis.fetch;
const checks=[];let daemonFixture,localClient,readOnlyClient,extraClient,listeners,failure;
const report={schemaVersion:1,kind:'isolated-devices-verification',preparedRuntime:prepared,officialProtocolFixture:prepared,
 result:'running',checks:[],actualDaemonRpc:[],inProcessSeams:[],realTailnetTested:false,hostTailscaleTouched:false,
 daemonFixture:'prepared-runtime createTestPaseoDaemon; fakeAgentClients; empty BuiltinPluginLoader; daemon runs in this Node process',
 processAssertion:'same orchestrator PID before and after RPC only; this is not an OS supervisor PID/restart test',supervisorPidTested:false,
 tasksPluginLoaded:false,tasksEvidence:'empty builtin plugin loader; Tasks validation is handled by separate packed/upgrade verification'};
const load=(root,rel)=>import(pathToFileURL(path.join(root,rel)).href);
async function reservePort(){const s=net.createServer();await new Promise((ok,no)=>s.listen(0,'127.0.0.1',ok).once('error',no));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function closeClient(c){if(c)await c.close().catch(()=>{});}
async function waitForServerInfo(client,label){
 const deadline=Date.now()+5000;
 while(!client.getLastServerInfoMessage()&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));
 assert.ok(client.getLastServerInfoMessage(),`${label}: server_info not received within 5 seconds`);
}
function configListen(home){return JSON.parse(fs.readFileSync(path.join(home,'config.json'),'utf8')).daemon.listen;}
async function rawServerInfo(root,url){
 const {WebSocket}=createRequire(path.join(root,'node_modules/@getpaseo/server/package.json'))('ws');
 return new Promise((resolve,reject)=>{
  const ws=new WebSocket(url),timer=setTimeout(()=>{ws.terminate();reject(new Error('server_info handshake timeout'));},5000);
  ws.once('open',()=>ws.send(JSON.stringify({type:'hello',clientId:'devices-verify-'+process.pid,clientType:'cli',protocolVersion:1,appVersion:'0.10.1'})));
  ws.on('message',raw=>{let m;try{m=JSON.parse(String(raw));}catch{return;}const payload=m?.type==='session'?m.message?.payload:null;
   if(m?.message?.type==='status'&&payload?.status==='server_info'){clearTimeout(timer);ws.close();resolve(payload);}});
  ws.once('error',e=>{clearTimeout(timer);reject(e);});
 });
}
try{
 assert.ok(fs.existsSync(path.join(prepared,'node_modules/@getpaseo/server/package.json')),'prepared runtime package missing');
 assert.equal(JSON.parse(fs.readFileSync(path.join(prepared,'node_modules/@getpaseo/server/package.json'))).version,'0.18.1');
 assert.equal(JSON.parse(fs.readFileSync(path.join(prepared,'node_modules/@getpaseo/protocol/package.json'))).version,'0.18.1');
 // Do not expose inherited Codex/Claude/OpenAI/OmniGent/Pi Agent credentials to imported runtime code.
 for(const key of Object.keys(process.env))delete process.env[key];
 if(savedEnv.PATH)process.env.PATH=savedEnv.PATH;
 const home=path.join(temp,'home'),homeRoot=path.join(temp,'paseo-home-root'),staticDir=path.join(temp,'static');
 for(const dir of [home,homeRoot,staticDir,path.join(temp,'xdg')])fs.mkdirSync(dir,{recursive:true});
 Object.assign(process.env,{HOME:home,PASEO_HOME:path.join(homeRoot,'.paseo'),XDG_CONFIG_HOME:path.join(temp,'xdg'),TMPDIR:temp,TMP:temp,TEMP:temp,PI_PASEO_CONNECTION_TARGET:'woowtech'});
 globalThis.fetch=async()=>{throw new Error('unexpected fetch/network access in isolated fixture');};
 const {createTestPaseoDaemon}=await load(prepared,'node_modules/@getpaseo/server/dist/server/server/test-utils/paseo-daemon.js');
 const {DaemonClient}=await load(prepared,'node_modules/@getpaseo/server/dist/server/server/test-utils/daemon-client.js');
 const port=await reservePort(),listen=`127.0.0.1:${port}`;
 const paseoHome=path.join(homeRoot,'.paseo');fs.mkdirSync(paseoHome,{recursive:true});
 fs.writeFileSync(path.join(paseoHome,'config.json'),JSON.stringify({version:1,daemon:{listen}},null,2)+'\n',{mode:0o600});
 report.configSeed='before daemon start: private PASEO_HOME/config.json has version 1 and selected 127.0.0.1 ephemeral listen';
 daemonFixture=await createTestPaseoDaemon({paseoHomeRoot:homeRoot,staticDir,listen:'127.0.0.1',listenPort:port,relayEnabled:false,
  daemonStatusRpcCapability:true,relayConfigCapability:true,
  getTailscaleNetwork:()=>({addresses:['127.0.0.2'],otherAddresses:new Set()}),cleanup:false});
 assert.equal(daemonFixture.config.listen,listen);
 localClient=new DaemonClient({url:`ws://${listen}/ws`,clientType:'cli',appVersion:'0.10.1',connectTimeoutMs:5000,sessionPermissions:['daemon.read','daemon.manage','workspace.read']});
 await localClient.ensureConnected({timeout:5000});
 await waitForServerInfo(localClient,'local client');
 // Read server_info from its wire envelope; the shared SDK's typed view may omit brand metadata.
 const info=await rawServerInfo(prepared,`ws://${listen}/ws`);
 report.serverInfoDiagnostic={featureKeys:Object.keys(info?.features||{}).sort(),brandId:info?.brand?.id||null,brandName:info?.brand?.name||null};
 assert.equal(info?.features?.tailscale,true,'raw server_info advertises features.tailscale');
 assert.deepEqual(info?.brand,{id:'woowtech',name:'Woowtech Smart'});
 report.actualDaemonRpc.push('raw WebSocket hello/server_info: features.tailscale and exact brand');
 const initial=await localClient.getDaemonStatus({includeProviders:false});
 assert.ok(initial&&typeof initial==='object');
 assert.ok(!('providers' in initial)||initial.providers===undefined||Array.isArray(initial.providers)&&initial.providers.length===0,'includeProviders=false has no provider list');
 report.actualDaemonRpc.push('daemon.get_status(includeProviders=false) via official shared client');
 const original=configListen(daemonFixture.paseoHome);assert.equal(original,listen);
 readOnlyClient=new DaemonClient({url:`ws://${listen}/ws`,clientType:'cli',appVersion:'0.10.1',connectTimeoutMs:5000,sessionPermissions:['daemon.read']});
 await readOnlyClient.ensureConnected({timeout:5000});
 await waitForServerInfo(readOnlyClient,'read-only client');
 assert.ok(await readOnlyClient.getDaemonStatus({includeProviders:false}),'daemon.read session can get status');
 let denied;
 try{await readOnlyClient.setTailscaleEnabled(true);}catch(error){denied=error;}
 assert.ok(denied,'daemon.read session cannot enable Tailscale');
 assert.equal(denied.code,'access_denied',`expected access_denied, got ${denied.code||denied.name}`);
 assert.equal(configListen(daemonFixture.paseoHome),original,'denied mutation leaves config unchanged');
 await closeClient(readOnlyClient);readOnlyClient=null;
 report.actualDaemonRpc.push('daemon.read-only session: status allowed; setTailscaleEnabled(true) returns access_denied; config unchanged; client closed');
 const {SessionInboundMessageSchema}=await load(prepared,'node_modules/@getpaseo/protocol/dist/messages.js');
 const legacy=SessionInboundMessageSchema.parse({type:'fetch_agent_history_request',requestId:'devices-history-fixture',sort:[{key:'created_at',direction:'desc'}],page:{limit:20}});
 assert.equal(legacy.type,'fetch_agent_history_request');
 const history=await localClient.fetchAgentHistory({sort:[{key:'created_at',direction:'desc'}],page:{limit:20}});
 assert.ok(Array.isArray(history.entries)&&history.pageInfo&&typeof history.pageInfo==='object');
 report.actualDaemonRpc.push('fetch_agent_history_request: official v0.18.1 schema validates legacy sort/page and daemon RPC responds');
 const pid=process.pid;
 const enabled=await localClient.setTailscaleEnabled(true);
 assert.equal(enabled.confirmationRequired,false);assert.equal(enabled.tailscale?.state,'on');
 assert.ok(enabled.extraListeners?.some(r=>r.address===`127.0.0.2:${port}`&&r.state==='listening'));
 assert.equal(configListen(daemonFixture.paseoHome),`${listen},127.0.0.2:${port}`);assert.equal(process.pid,pid);
 report.actualDaemonRpc.push('daemon.tailscale.set.request(enabled=true): fake loopback extra listener listening; config persisted');
 extraClient=new DaemonClient({url:`ws://127.0.0.2:${port}/ws`,clientType:'cli',appVersion:'0.10.1',connectTimeoutMs:5000,sessionPermissions:['daemon.read','daemon.manage','workspace.read']});
 await extraClient.ensureConnected({timeout:5000});
 await waitForServerInfo(extraClient,'extra-listener client');
 const guard=await extraClient.setTailscaleEnabled(false);
 assert.equal(guard.confirmationRequired,true,'same listener connection requires confirmation');
 assert.equal(configListen(daemonFixture.paseoHome),`${listen},127.0.0.2:${port}`,'confirm guard leaves config unchanged');
 report.actualDaemonRpc.push('daemon.tailscale.set.request(enabled=false) on same extra-listener connection: confirmationRequired=true');
 const disabled=await extraClient.setTailscaleEnabled(false,true);
 assert.equal(disabled.confirmationRequired,false);assert.equal(configListen(daemonFixture.paseoHome),listen,'single listen restored');assert.equal(process.pid,pid);
 await closeClient(extraClient);extraClient=null;
 await localClient.getDaemonStatus({includeProviders:false});
 report.actualDaemonRpc.push('same-connection confirmed disable: extra listener removed; original single-listen string restored');
 checks.push('server_info_features_tailscale_brand','status_includeProviders_false','daemon_read_authorization_blocks_manage_rpc','history_legacy_sort_page','tailscale_on_config_listener_pid','same_connection_confirm_guard_and_confirmed_off_restore');

 // Pure in-process policy seams: these calls open no socket and exercise locked cases only.
 const {createDaemonListeners}=await load(prepared,'node_modules/@getpaseo/server/dist/server/server/listeners.js');
 const fakeHttp=new http.Server();
 listeners=createDaemonListeners({http:fakeHttp,listen,overridden:false,getMain:()=>({type:'socket',path:path.join(temp,'unix.sock')}),getTailscaleNetwork:()=>({addresses:['127.0.0.2'],otherAddresses:new Set()})});
 assert.equal(listeners.status().tailscale.lockedBy,'main');assert.throws(()=>listeners.prepareTailscaleChange(listen,true,listen,false),/cannot be changed/);await listeners.stop();
 listeners=createDaemonListeners({http:fakeHttp,listen,overridden:true,getMain:()=>({type:'tcp',host:'127.0.0.1',port}),getTailscaleNetwork:()=>({addresses:['127.0.0.2'],otherAddresses:new Set()})});
 assert.equal(listeners.status().tailscale.lockedBy,'launch');assert.throws(()=>listeners.prepareTailscaleChange(listen,true,listen,false),/cannot be changed/);await listeners.stop();listeners=null;fakeHttp.close();
 report.inProcessSeams.push('Unix-socket main listener is locked','launch/override listener is locked');checks.push('socket_and_override_locked');
 report.processAssertionResult=process.pid===pid?'same orchestrator PID throughout the in-process daemon fixture':'unexpected PID change';
 report.checks=checks;report.result='passed';
}catch(e){failure=e;report.result='failed';report.failure={name:e?.name||'Error',message:String(e?.message||e).slice(0,500)};}
finally{
 await closeClient(extraClient);await closeClient(readOnlyClient);await closeClient(localClient);
 if(listeners)await listeners.stop().catch(()=>{});
 if(daemonFixture)await daemonFixture.close().catch(()=>{});
 globalThis.fetch=originalFetch;
 for(const key of Object.keys(process.env))delete process.env[key];Object.assign(process.env,savedEnv);
 fs.rmSync(temp,{recursive:true,force:true});report.cleanup='private temp directory removed; fixture clients, listeners, and daemon closed';
 if(reportPath){fs.mkdirSync(path.dirname(reportPath),{recursive:true});fs.writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n',{mode:0o600});}
 console.log(JSON.stringify({result:report.result,checks:report.checks,actualDaemonRpc:report.actualDaemonRpc,inProcessSeams:report.inProcessSeams,report:reportPath||'stdout only',realTailnetTested:false,supervisorPidTested:false,tasksPluginLoaded:false,...(report.failure?{failure:report.failure}:{})}));
}
if(failure)process.exitCode=1;
