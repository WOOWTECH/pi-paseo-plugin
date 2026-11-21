import fs from 'node:fs';
import path from 'node:path';
import { bindConversationControls } from './conversation-controls.mjs';
import { loadConversationResume } from './conversation-resume.mjs';
import { configuration, launch, readJson, redact, reportWriter,
  validatePairingReport, validateJobs, completionMarker, workspaceRoute, contract, verifyActiveAgent, verifyReconnectedConversation, runtimeBinding, until } from './common.mjs';

const [brand, ...jobFiles] = process.argv.slice(2);
const config = configuration(brand, process.env, { providerTurns: true });
const pairing = validatePairingReport(readJson(path.join(config.output, brand + '-hosts.json')), config.manifest, brand);
const jobs = validateJobs(jobFiles.map(readJson), config.manifest, brand);
const resume = loadConversationResume(config, jobs, process.env.SMART_PARITY_RESUME_REPORT);
const browser = await launch(config, 'conversations');
const { context, output, record } = browser;
const report = { brand, scope: config.manifest.scope, runId: config.manifest.runId,
  ...runtimeBinding(config.manifest), attempt: browser.attempt, craftProject: browser.craftProject, attemptDirectory: path.relative(config.root, output),
  startedAt: new Date().toISOString(), ...(resume.resumeFrom ? { resumeFrom: resume.resumeFrom } : {}), rows: resume.rows };
const save = reportWriter(config, browser, brand + '-web-conversations.json', report);
let currentPage;
let completedPrefix = resume.rows.length;
try{
 for(const host of jobs){
  const paired=pairing.hosts.find(x=>x.host===host.hostLabel);
  if(!paired?.serverId||paired.visibleInHostPicker!==true)throw Error('Host was not verified in public web picker');
  for(const job of host.jobs){
   if(!['claude','codex','pi'].includes(job.provider)||typeof job.prompt!=='string'||!job.targetModel||job.targetModel===job.alternateModel)throw Error('Unexpected provider job');
   if (completedPrefix > 0) { completedPrefix--; continue; }
   const row={host:host.hostLabel,provider:job.provider,agentId:job.agentId,workspaceId:host.workspaceId,targetModel:job.targetModel,evidence:[],status:'running'};
   report.rows.push(row);save();
   const page=await context.newPage();currentPage=page;
   const route=workspaceRoute(paired.serverId,host.workspaceId,job.agentId);
   await page.goto(config.url+route,{waitUntil:'domcontentloaded',timeout:45000});
   const controls=await bindConversationControls(page,job.agentId);
   const {composer,model:selector,send,selectors}=controls;
   row.activeAgentVerified=true;
   row.beforeLabel=await selector.innerText();
   row.evidence.push((await record(page,`${brand}-${host.hostLabel}-${job.provider}-model-open`,[{step_id:'open-model-picker',kind:'click',selector:selectors.model}])).id);
   const modelId=`model-row-${job.provider}-${job.targetModel}`;
   const providerId=`model-provider-${job.provider}`;
   await until(async()=>await page.getByTestId(modelId).isVisible()||await page.getByTestId(providerId).isVisible(),30000);
   if(!await page.getByTestId(modelId).isVisible()){
    if(await page.getByTestId(providerId).isVisible())row.evidence.push((await record(page,`${brand}-${host.hostLabel}-${job.provider}-provider-select`,[{step_id:'open-provider-models',kind:'click',test_id:providerId}])).id);
   }
   await page.getByTestId(modelId).waitFor({timeout:20000});
   // Craft 0.6.1 clicks the DOM box center without scrolling. A model can be
   // attached and visible while clipped by the menu's scroll container.
   await page.getByTestId(modelId).scrollIntoViewIfNeeded();
   row.evidence.push((await record(page,`${brand}-${host.hostLabel}-${job.provider}-model-select`,[{step_id:'select-provider-model',kind:'click',test_id:modelId},{step_id:'settle-selection',kind:'wait',ms:500}])).id);
   await page.getByTestId(modelId).waitFor({state:'hidden',timeout:20000});
   await until(async()=>await selector.innerText()!==row.beforeLabel,20000);
   row.afterLabel=await selector.innerText();
   const completion=completionMarker(job);
   if(!completion)throw Error('Missing unique web completion marker');
   await bindConversationControls(page,job.agentId);
   row.evidence.push((await record(page,`${brand}-${host.hostLabel}-${job.provider}-web-type`,[
    {step_id:'type-memory-probe',kind:'fill',selector:selectors.composer,value:job.prompt}
   ])).id);
   await until(async()=>await composer.inputValue()===job.prompt&&await send.isEnabled(),20000);
   row.evidence.push((await record(page,`${brand}-${host.hostLabel}-${job.provider}-web-send`,[
    {step_id:'send-web-message',kind:'click',selector:selectors.send},
    {step_id:'observe-send',kind:'wait',ms:1000}
   ])).id);
   // Match the assistant bubble, never the marker echoed in the user's prompt.
   await page.getByTestId('assistant-message').filter({hasText:completion}).waitFor({timeout:180000});
   row.completionVisible=true;
   row.evidence.push((await record(page,`${brand}-${host.hostLabel}-${job.provider}-web-result`,[{step_id:'observe-completed-turn',kind:'wait',ms:500}])).id);
   // A browser reconnection must recover the same owned conversation and composer.
   await page.reload({waitUntil:'domcontentloaded',timeout:45000});
   Object.assign(row,await verifyReconnectedConversation(page,{agentId:job.agentId,completion,url:config.url+route}));
   row.evidence.push((await record(page,`${brand}-${host.hostLabel}-${job.provider}-reconnect`,[{step_id:'observe-reconnected-conversation',kind:'wait',ms:500}])).id);
   await page.screenshot({path:path.join(output,`${brand}-${host.hostLabel}-${job.provider}-web.png`)});
   fs.chmodSync(path.join(output,`${brand}-${host.hostLabel}-${job.provider}-web.png`),0o600);
   fs.writeFileSync(path.join(output,`${brand}-${host.hostLabel}-${job.provider}-web.aria.txt`),redact(await page.locator('body').ariaSnapshot()),{mode:0o600});
   row.status='ui-completed-awaiting-tool-verification';save();
   console.log(JSON.stringify({brand,host:host.hostLabel,provider:job.provider,status:row.status,reconnected:row.reconnected}));
   await page.close();currentPage=null;
  }
 }
 report.uiCompleted=report.rows.length===config.manifest.hosts.length*contract.providers.length&&report.rows.every(x=>x.completionVisible&&x.reconnected&&x.activeAgentVerified&&x.reconnectedAgentVerified&&x.reconnectedAnswerVisible);save();
 if(!report.uiCompleted)process.exitCode=1;
}catch(error){
 report.error=redact(error.message);
 if(currentPage){fs.writeFileSync(path.join(output,brand+'-web-error.aria.txt'),redact(await currentPage.locator('body').ariaSnapshot().catch(()=>'')),{mode:0o600});await currentPage.screenshot({path:path.join(output,brand+'-web-error.png')}).then(()=>fs.chmodSync(path.join(output,brand+'-web-error.png'),0o600)).catch(()=>{});}
 save();console.error(JSON.stringify({brand,error:report.error}));process.exitCode=1;
}finally{await browser.close();}
