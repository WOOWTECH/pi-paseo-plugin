// Explicit offline integration: real Python stdio + actual Chromium + pinned
// Craft. Only the test tree's host/authority reads are synthetic; zero external
// network, provider or production operations. Production CLI has no test mode.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { productionFixture } from './production-fixture.mjs';
const cleanups = [], f = productionFixture({after:fn=>cleanups.push(fn)});
fs.chmodSync(f.root,0o700);
const original = fileURLToPath(new URL('../../../../live-acceptance',import.meta.url));
const tree = path.join(f.root,'work'), repo=path.join(tree,'standard'), parent=path.join(tree,'live-acceptance');
fs.mkdirSync(parent,{recursive:true,mode:0o700});
fs.cpSync(fileURLToPath(new URL('..',import.meta.url)),path.join(repo,'tests/smart-parity'),{recursive:true});
fs.writeFileSync(path.join(parent,'canary_browser_transport.py'),`import sys,runpy\nsys.path.insert(0,${JSON.stringify(original)})\nrunpy.run_path(${JSON.stringify(path.join(original,'test_canary_browser_launcher_fixture.py'))},run_name='__main__')\n`,{mode:0o600});
execFileSync('python3',[path.join(parent,'canary_browser_transport.py'),'prepare','--receipts',f.root]);
const load = file => import(pathToFileURL(path.join(repo,'tests/smart-parity/browser',file)));
const {openProductionSession,productionSessionState}=await load('production-parent.mjs');
const {launch,writePrivate,runtimeBinding}=await load('common.mjs');
const root=path.join(f.root,'evidence');
const options={receipts:f.root,root,brand:'apporo',action:'pair',seconds:1800};
let session,browser,cases=0;
const html=base=>`<html><head><meta charset="utf-8"></head><body><select aria-label="連線標的"><option>woowtech</option><option>apporo</option></select>
<button onclick="act('connector.save-target')">儲存設定</button><button onclick="act('connector.stop')">停止 Agent Connect 服務</button><button onclick="act('connector.start')">啟動服務</button>
<div role="dialog"><span>pi3-server</span><button onclick="act('pair.accept')">Connect</button></div>
<div data-testid="host-page-inject-mcp-card"><button role="switch" aria-checked="false" onclick="act('coordination.enable')">tools</button></div>
<script>window.done=0;async function act(action){await fetch(${JSON.stringify(base+'/api/plugin-paseo')},{method:'POST',body:JSON.stringify({action})});window.done++}</script></body></html>`;
try {
 session=await openProductionSession(options);let state=productionSessionState(session);
 const remaining=state.config.manifest.hosts[0].productionBinding.tunnel.expiresAt-Date.now()/1000;
 assert.ok(remaining>600&&remaining<=1800);cases++;
 browser=await launch(state.config,'offline-launcher',{productionGuard:state.guard});
 const base=state.config.manifest.hosts[0].baseUrl;
 await browser.context.route('**/*',async route=>{
  const u=new URL(route.request().url());
  if(u.pathname==='/api/plugin-paseo'&&u.origin===base){
   const response=await fetch(u,{method:route.request().method(),...(route.request().postData()?{body:route.request().postData()}:{} )});
   return route.fulfill({status:response.status,contentType:'application/json',body:await response.text()});
  }
  if(u.origin===base||u.origin==='https://smart.apporo.ai')return route.fulfill({contentType:'text/html',body:html(base)});
  throw Error('External fixture network forbidden');
 });
 const page=await browser.context.newPage();await page.goto(base+'/omnigent');
 const record=async(kind,action)=>browser.record(page,'fixture-'+kind.replaceAll('.','-'),[{step_id:'actual-control',...action}],[],{kind,hostLabel:'pi3'});
 await record('connector.select-target',{kind:'select',selector:'select[aria-label="連線標的"]',value:'apporo'});
 assert.equal(fs.existsSync(path.join(f.root,'fixture-dispatches.jsonl')),false);cases++;
 for(const [kind,name] of [['connector.save-target','儲存設定'],['connector.stop','停止 Agent Connect 服務'],['connector.start','啟動服務']]) {
  await record(kind,{kind:'click',role:'button',name});cases++;
 }
 assert.equal(await page.evaluate(()=>window.done),3);
 assert.equal((await browser.pair(page,'pi3')).target,'apporo');cases++;
 const files=fs.readdirSync(path.dirname(state.ready.browserManifest));
 const bundle=files.find(n=>n.startsWith('controlled-stop-journals-'));assert.ok(bundle);
 const raw=fs.readFileSync(path.join(path.dirname(state.ready.browserManifest),bundle));assert.ok(raw.includes(Buffer.from('Base64')));cases++;
 // Read-only UI routing performs no admission. Actual pair acceptance and
 // coordination exercise the same real parent and Craft begin/finish channel.
 await page.goto('https://smart.apporo.ai/');
 await record('pair.accept',{kind:'click',role:'button',name:'Connect'});cases++;
 await page.goto('https://smart.apporo.ai/settings/hosts/pi3-server/agents');
 await record('coordination.enable',{kind:'click',selector:'[data-testid="host-page-inject-mcp-card"] [role="switch"]'});cases++;
 const dispatched=fs.readFileSync(path.join(f.root,'fixture-dispatches.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 assert.deepEqual(dispatched.map(x=>x.kind),['connector.save-target','connector.stop','connector.start','connector.pair','pair.accept','coordination.enable']);
 assert.equal(new Set(dispatched.map(x=>x.intent)).size,6);
 const priorManifest=state.config.manifest,priorSource=JSON.parse(fs.readFileSync(path.join(path.dirname(state.ready.browserManifest),files.find(n=>n.startsWith('dispatch-')))));
 // A historical pairing report keeps its exact original source binding. It
 // grants no mutation; a later parent has fresh ports/expiry and a fresh guard.
 const old={brand:'apporo',scope:priorManifest.scope,runId:priorManifest.runId,...runtimeBinding(priorManifest),sourceManifestSha256:priorSource.sourceManifestSha256,
  craftProject:'web-live/shared.cany',hostListEvidence:['ev_fixture'],hosts:priorManifest.hosts.map(h=>({host:h.label,serverId:h.serverId,
  initialRuntimeIdentity:h.runtimeIdentity,status:'paired',visibleInHostPicker:true,confirmationDismissed:true,evidence:['a','b','c'],
  connection:{route:`/settings/hosts/${h.serverId}/agents`,settingsAvailable:true,afterReload:true},ready:{selectedTarget:'apporo',activeTarget:'apporo',healthy:true,configurationPending:false}}))};
 const retained=JSON.stringify(old);writePrivate(path.join(state.config.output,'apporo-hosts.json'),old);
 await browser.close();browser=null;assert.equal((await session.close()).code,0);session=null;
 assert.equal(fs.readFileSync(path.join(f.root,'fixture-parent-closed'),'utf8'),'closed');cases++;
 session=await openProductionSession({...options,action:'coordination'});state=productionSessionState(session);
 assert.notEqual(state.config.manifest.hosts[0].baseUrl,priorManifest.hosts[0].baseUrl);
 assert.deepEqual(state.config.coordinationBefore,{pi3:false,pi4:false});
 assert.equal(JSON.stringify(session.pairing(old)),retained);cases++;
 assert.throws(()=>session.pairing({...old,sourceManifestSha256:'0'.repeat(64)}));cases++;
 assert.throws(()=>session.pairing({...old,hosts:[{...old.hosts[0],serverId:'foreign'},old.hosts[1]]}));cases++;
 assert.equal((await session.close()).code,0);session=null;
 console.log(JSON.stringify({passed:true,cases,actualPythonStdio:true,actualChromium:true,actualPinnedCraft:true,
  actualReturnedStopBytes:true,syntheticBackendWrites:6,externalRequests:0,productionMutations:false}));
} catch(error) {
 if(browser)for(const name of fs.readdirSync(browser.output).filter(n=>n.endsWith('.json')&&!n.includes('schema'))){const raw=JSON.parse(fs.readFileSync(path.join(browser.output,name)));console.error(JSON.stringify({name,aborted:raw.result?.aborted,steps:raw.result?.steps}));}
 for(const file of fs.readdirSync(path.join(root,'parent-logs')).filter(n=>n.endsWith('.stderr')))console.error(fs.readFileSync(path.join(root,'parent-logs',file),'utf8'));
 throw error;
} finally {if(browser)await browser.close();if(session)await session.close();for(const fn of cleanups.reverse())fn();}
