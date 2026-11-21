import fs from 'node:fs';
import path from 'node:path';
import { configuration, launch, readJson, redact, until, connector as api,
  reportWriter, validatePairingReport, runtimeBinding } from './common.mjs';

const [brand, action = 'pair'] = process.argv.slice(2);
if (!['pair', 'inspect'].includes(action)) throw new Error('Usage: node pair.mjs BRAND pair|inspect');
const config = configuration(brand);
const hostManifest = config.manifest;
const binding = runtimeBinding(hostManifest);
const recordName = `${brand}-hosts.json`;
const report = action === 'inspect' ? validatePairingReport(readJson(path.join(config.output, recordName)), hostManifest, brand, { complete: false }) :
  { brand, scope: hostManifest.scope, runId: hostManifest.runId, ...binding, hosts: [] };
if (action === 'inspect' && report.craftProject !== 'web-live/shared.cany') throw new Error('Inspect requires the retained shared Craft project; old separate projects cannot be silently relabeled');
const browser = await launch(config, action);
const { context, output, record: capture } = browser;
delete report.error;
delete report.hostPickerMissing;
report.attempt = browser.attempt;
report.craftProject = browser.craftProject;
report.attemptDirectory = path.relative(config.root, output);
const save = reportWriter(config, browser, recordName, report);
try{
 if(action==='pair'){
  for(const host of hostManifest.hosts){
   const base=new URL(host.baseUrl).origin,local=await context.newPage(),row={host:host.label,base,initialRuntimeIdentity:binding.runtimeIdentity,evidence:[],status:'running'};report.hosts.push(row);save();
   const recordHost=async(...args)=>{const e=await capture(...args);row.evidence.push(e.id);save();return e;};
   await local.goto(base+'/omnigent',{waitUntil:'domcontentloaded',timeout:45000});
   await local.getByRole('button',{name:'Agent Connect',exact:true}).click({timeout:30000});
   await local.getByRole('region',{name:'Agent Connect 連線設定'}).waitFor({timeout:30000});
   await until(async()=>!(await local.getByRole('combobox',{name:'連線標的'}).isDisabled()));
   const old=await api(base);row.previousTarget=old.selectedTarget;row.initialRuntimeIdentity=binding.runtimeIdentity;
   await recordHost(local,`${brand}-${host.label}-select-target`,[{step_id:'select-target',kind:'select',selector:'select[aria-label="連線標的"]',value:brand},{step_id:'save-target',kind:'click',role:'button',name:'儲存設定'}]);
   await until(async()=>{const s=await api(base);return s.selectedTarget===brand;});
   const saved=await api(base);row.pendingObserved=saved.configurationPending===true;
   const stop=local.getByRole('button',{name:'停止 Agent Connect 服務',exact:true});
   if(await stop.isEnabled()){
    await recordHost(local,`${brand}-${host.label}-stop`,[{step_id:'stop-selected-host',kind:'click',role:'button',name:'停止 Agent Connect 服務'}]);
    await until(async()=>{const s=await api(base);return s.daemon?.running===false;});
   }
   await local.getByRole('button',{name:'啟動服務',exact:true}).waitFor();
   await until(async()=>!(await local.getByRole('button',{name:'啟動服務',exact:true}).isDisabled()));
   await recordHost(local,`${brand}-${host.label}-start`,[{step_id:'start-selected-target',kind:'click',role:'button',name:'啟動服務'}]);
   const ready=await until(async()=>{const s=await api(base);return s.selectedTarget===brand&&s.activeTarget===brand&&!s.configurationPending&&s.daemon?.healthy?s:null;});
   row.ready={selectedTarget:ready.selectedTarget,activeTarget:ready.activeTarget,configurationPending:ready.configurationPending,healthy:ready.daemon.healthy};
   // Pair only after recording the settings page, so no unredacted offer enters that evidence.
   const offer=await api(base,{action:'pair'});if(offer.target!==brand)throw Error('Pairing target mismatch');
   const u=new URL(offer.url,base),payload=u.hash.slice(7),decoded=JSON.parse(Buffer.from(payload,'base64url').toString());
   if(!payload||!decoded.serverId)throw Error('Pairing offer absent');
   row.serverId=decoded.serverId;
   const app=await context.newPage(),url=config.url+'/'+u.hash;
   await app.goto(url,{waitUntil:'domcontentloaded',timeout:45000});
   await app.getByText(decoded.serverId,{exact:true}).waitFor({timeout:30000});
   await recordHost(app,`${brand}-${host.label}-connect`,[{step_id:'wait-confirmation-armed',kind:'wait',ms:1500},{step_id:'keyboard-gesture-in-confirmation',kind:'press',role:'button',name:'Cancel',key:'Tab'},{step_id:'connect-host',kind:'click',role:'button',name:'Connect'},{step_id:'connection-settle',kind:'wait',ms:1000}],[url,u.hash,payload,offer.url]);
   await app.getByRole('dialog').filter({has:app.getByRole('button',{name:'Connect',exact:true})}).waitFor({state:'hidden',timeout:45000});
   row.confirmationDismissed=true;
   await app.waitForURL(v=>!v.hash.includes('offer='),{timeout:45000});
   const skip=app.getByText('Skip setup',{exact:true});if(await skip.isVisible().catch(()=>false))await skip.click();
   await app.waitForTimeout(2500);
   row.path=new URL(app.url()).pathname;row.status='confirmed-awaiting-host-picker';save();
   await app.screenshot({path:path.join(output,`${brand}-${host.label}-paired.png`)});fs.chmodSync(path.join(output,`${brand}-${host.label}-paired.png`),0o600);
   fs.writeFileSync(path.join(output,`${brand}-${host.label}-paired.aria.txt`),redact(await app.locator('body').ariaSnapshot()),{mode:0o600});
   await local.close();await app.close();console.log(JSON.stringify({brand,host:host.label,status:row.status,serverId:row.serverId,path:row.path}));
  }
 }
 const page=await context.newPage();await page.goto(config.url+'/settings',{waitUntil:'domcontentloaded',timeout:45000});await page.waitForTimeout(3000);
 fs.writeFileSync(path.join(output,`${brand}-settings.aria.txt`),redact(await page.locator('body').ariaSnapshot()),{mode:0o600});
 const trigger=page.getByTestId('settings-host-picker');
 if(await trigger.isVisible()){
  const hostList=await capture(page,`${brand}-all-hosts`,[{step_id:'list-connected-hosts',kind:'click',test_id:'settings-host-picker'},{step_id:'host-list-settle',kind:'wait',ms:300}]);
  report.hostListEvidence=[hostList.id];
  for(const row of report.hosts){row.visibleInHostPicker=await page.getByTestId(`settings-host-picker-item-${row.serverId}`).isVisible();if(row.visibleInHostPicker&&row.confirmationDismissed)row.status='registered-awaiting-connection';}
 }else{report.hostPickerMissing=true;}
 await page.screenshot({path:path.join(output,`${brand}-all-hosts.png`)});fs.chmodSync(path.join(output,`${brand}-all-hosts.png`),0o600);
 fs.writeFileSync(path.join(output,`${brand}-all-hosts.aria.txt`),redact(await page.locator('body').ariaSnapshot()),{mode:0o600});save();
 // A saved pairing in the picker does not establish a working relay. Apporo
 // can reject hello with close4004 after confirmation; exercise a host RPC UI
 // and a fresh connection before calling the host paired.
 for(const row of report.hosts){
  if(!row.visibleInHostPicker||!row.confirmationDismissed)throw Error('Host registration incomplete');
  const route=`/settings/hosts/${encodeURIComponent(row.serverId)}/agents`;
  await page.goto(config.url+route,{waitUntil:'domcontentloaded',timeout:45000});
  const control=page.getByTestId('host-page-inject-mcp-card').getByRole('switch');
  await control.waitFor({timeout:45000});
  row.connection={route,settingsAvailable:true,afterReload:false};
  row.evidence.push((await capture(page,`${brand}-${row.host}-connected`,[{step_id:'verify-connected-host',kind:'wait',ms:500}])).id);save();
  await page.reload({waitUntil:'domcontentloaded',timeout:45000});
  await page.waitForURL(value=>value.origin===new URL(config.url).origin&&value.pathname===route);
  await control.waitFor({timeout:45000});
  row.connection.afterReload=true;
  row.evidence.push((await capture(page,`${brand}-${row.host}-reconnected`,[{step_id:'verify-reconnected-host',kind:'wait',ms:500}])).id);
  row.status='paired';save();
 }
 console.log(JSON.stringify({brand,hosts:report.hosts.map(x=>({host:x.host,serverId:x.serverId,visible:x.visibleInHostPicker})),hostPickerMissing:report.hostPickerMissing}));
 validatePairingReport(report,hostManifest,brand);
}catch(error){
 report.error=redact(error.message);save();
 for(const [index,page] of context.pages().entries()){
  const prefix=path.join(output,`${brand}-pair-error-${index}`);
  fs.writeFileSync(prefix+'.aria.txt',redact(await page.locator('body').ariaSnapshot().catch(()=>'')),{mode:0o600});
  await page.screenshot({path:prefix+'.png'}).then(()=>fs.chmodSync(prefix+'.png',0o600)).catch(()=>{});
 }
 console.error(JSON.stringify({brand,error:report.error}));process.exitCode=1;
}
finally{await browser.close();}
