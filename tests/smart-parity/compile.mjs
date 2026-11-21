import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { audit } from './audit.mjs';
import { communicationCyclePassed } from './provider/acceptance-evidence.mjs';
import { contract, validateManifest, validatePairingReport, writePrivate, runtimeBinding } from './browser/common.mjs';
import { validateReportRuntime } from './browser/runtime.mjs';
import { evidenceStore, assertProviderIdentity, assertProviderRows, semanticWebPassed } from './evidence-store.mjs';

const uniqueIds = values => Array.isArray(values) && values.every(id => typeof id === 'string' && id.length > 0) && new Set(values).size === values.length;
function cliSendersDeleted(report, providers) {
 const edges=report?.communication?.edges;
 if(!Array.isArray(edges)||edges.length!==providers.length||!uniqueIds(edges.map(e=>e.agentId))||new Set(edges.map(e=>e.senderProvider)).size!==providers.length||edges.some(e=>!providers.includes(e.senderProvider)))return false;
 if(!uniqueIds(report.agents)||!Array.isArray(report.deleted)||!Array.isArray(report.deletedAgentAbsence))return false;
 return edges.every(({agentId})=>report.agents.includes(agentId)&&report.deleted.filter(id=>id===agentId).length===1&&report.deletedAgentAbsence.filter(row=>row.id===agentId).length===1&&report.deletedAgentAbsence.some(row=>row.id===agentId&&row.absent===true));
}
function providerAgentsArchived(report, providers) {
 const rows=report?.providers, lifecycle=report?.mcpConversationLifecycle;
 if(!Array.isArray(rows)||rows.length!==providers.length||!uniqueIds(rows.map(row=>row.agentId))||!uniqueIds(report.agents)||!Array.isArray(lifecycle)||lifecycle.length!==rows.length||!uniqueIds(lifecycle.map(row=>row.agentId)))return false;
 return rows.every(row=>report.agents.includes(row.agentId)&&lifecycle.some(value=>value.agentId===row.agentId&&value.archived===true&&value.retainedInArchive===true));
}

// This compiles actual observer/Craft evidence. It does not run providers or grant release approval.
export function compile(evidenceDirectory, { platform, manifestName = 'browser-hosts.private.json' } = {}) {
 const store=evidenceStore(evidenceDirectory),root=store.root,read=store.read,proof=store.proof;
 const deployment=validateManifest(read(manifestName));
 const binding=runtimeBinding(deployment);
 if(platform!==undefined&&platform!==binding.platform)throw Error('Requested platform does not match runtime manifest');
 platform=binding.platform;
 const brands=Object.keys(contract.brands),providers=contract.providers;
 const craftOwners=new Map();
 const craft=(ids,steps,owner)=>{
  const files=store.craft(ids,steps);
  for(const id of ids){if(craftOwners.has(id)&&craftOwners.get(id)!==owner)throw Error('Craft evidence reused across host/provider identities');craftOwners.set(id,owner);}
  return files;
 };
 const matrix={platform,scope:deployment.scope,runId:deployment.runId,generatedAt:new Date().toISOString(),hosts:deployment.hosts.map(h=>({id:h.label,dataIdentity:h.dataIdentity,runtimeIdentity:binding.runtimeIdentity})),results:[]};
 const add=(host,brand,provider,name,available,passed,files,extra={})=>matrix.results.push({host,...(brand?{brand}:{}),...(provider?{provider}:{}),case:name,status:available?(passed===true?'pass':'fail'):'unrun',evidence:proof(files),...extra});
for(const host of deployment.hosts){
 const phases=[];
 for(const brand of brands){
  const base=`hosts/${host.label}/evidence/${brand}`;
  const rf=base+'/provider-acceptance.json',wf=base+'/web-verification.json';
  const r=read(rf),w=read(wf),pf=`web-live/${brand}-hosts.json`,bf=`web-live/${brand}-web-conversations.json`;
  const pairingReport=read(pf),pairing=pairingReport?.hosts?.find(x=>x.host===host.label);
  if(pairingReport)validatePairingReport(pairingReport,deployment,brand,{complete:false});
  const browserReport=read(bf),browser=browserReport?.rows?.filter(x=>x.host===host.label)||[];
  if(browserReport&&(!Array.isArray(browserReport.rows)||browserReport.rows.some(row=>!deployment.hosts.some(h=>h.label===row.host))))throw Error('Unknown browser host evidence');
  for(const rows of [r?.providers,w?.providers,browser])assertProviderRows(rows,providers);
  if(r&&(r.runId!==deployment.runId||r.hostLabel!==host.label||r.phase!==brand||r.runtimeIdentity!==binding.runtimeIdentity))throw Error('Backend evidence ownership mismatch: '+rf);
  if(w&&(w.runId!==deployment.runId||w.hostLabel!==host.label||w.phase!==brand||w.runtimeIdentity!==binding.runtimeIdentity))throw Error('Web verifier ownership mismatch: '+wf);
  if(browserReport&&(browserReport.brand!==brand||browserReport.runId!==deployment.runId||browserReport.scope!==deployment.scope))throw Error('Browser evidence brand mismatch: '+bf);
  if(browserReport)validateReportRuntime(browserReport,deployment);
  phases.push({brand,r,w,files:[rf,wf,pf,bf]});
  const pairFiles=[pf,manifestName];
  if(pairing?.status==='paired')pairFiles.push(...craft(pairing.evidence,['select-target','save-target','start-selected-target','connect-host'],host.label+'/'+brand+'/pair'),...craft(pairingReport.hostListEvidence,['list-connected-hosts'],brand+'/host-list'));
  add(host.label,brand,null,'pair',!!pairing,pairing?.status==='paired'&&pairing.visibleInHostPicker===true&&pairing.confirmationDismissed===true&&pairing.ready?.selectedTarget===brand&&pairing.ready?.activeTarget===brand&&pairing.ready?.healthy===true&&pairing.ready.configurationPending===false,pairFiles);
  const reconnectFiles=[bf];
  for(const row of browser)reconnectFiles.push(...craft(row.evidence,['observe-reconnected-conversation'],host.label+'/'+brand+'/'+row.provider));
  add(host.label,brand,null,'reconnect',browser.length>0,browser.length===providers.length&&new Set(browser.map(x=>x.provider)).size===providers.length&&browser.every(x=>x.activeAgentVerified===true&&x.reconnected===true&&x.completionVisible===true&&x.reconnectedAgentVerified===true&&x.reconnectedAnswerVisible===true),reconnectFiles);
  add(host.label,brand,null,'workspace-cli-create',!!r,r?.cliWorkspaceLifecycle?.created===true,[rf]);
  add(host.label,brand,null,'workspace-mcp-create',!!r,typeof r?.workspaceId==='string'&&r.workspaceId.length>0,[rf]);
  const cleaned=r?.cleanupPass===true&&!r.cleanupErrors?.length;
  add(host.label,brand,null,'workspace-archive',typeof r?.cleanupPass==='boolean',cleaned&&r.workspaceArchived===true&&r.workspaceDirectoryRetained===true&&r.cliWorkspaceLifecycle?.archived===true,[rf]);
  add(host.label,brand,null,'conversation-cli-create-delete',typeof r?.cleanupPass==='boolean',cleaned&&cliSendersDeleted(r,providers),[rf]);
  add(host.label,brand,null,'conversation-mcp-create-archive',typeof r?.cleanupPass==='boolean',cleaned&&providerAgentsArchived(r,providers),[rf]);
  add(host.label,brand,null,'agent-coordination',!!r?.communication,r?.communication?.actualSendTool===true&&r.communication.receivedMarker===true&&r.communication.receiverResponded===true&&communicationCyclePassed(r.communication),[rf,...(r?.communication?.edges||[]).flatMap(edge=>[edge.evidenceFile&&base+'/'+path.basename(edge.evidenceFile),edge.receiverEvidenceFile&&base+'/'+path.basename(edge.receiverEvidenceFile)])]);
  for(const provider of providers){
   const p=r?.providers?.find(x=>x.provider===provider),v=w?.providers?.find(x=>x.provider===provider),b=browser.find(x=>x.provider===provider);
   if(v&&b){assertProviderIdentity({backend:p,verifier:v,browser:b,provider,brand});if(b.workspaceId!==r?.workspaceId)throw Error('Mixed browser workspace identity');}
   const evidence=[rf,wf,bf,p?.evidenceFile&&base+'/'+path.basename(p.evidenceFile),v?.evidenceFile&&base+'/'+path.basename(v.evidenceFile)];
   if(b)evidence.push(...craft(b.evidence,['open-model-picker','select-provider-model','type-memory-probe','send-web-message','observe-completed-turn','observe-reconnected-conversation'],host.label+'/'+brand+'/'+provider));
   if(v?.passed&&!semanticWebPassed(v))throw Error('Web success lacks complete semantic verifier checks');
   if(p?.modelSwitch?.evidenceFile)evidence.push(base+'/'+path.basename(p.modelSwitch.evidenceFile));
   if(v?.passed&&(!p?.evidenceFile||!v.evidenceFile))throw Error('Provider timeline missing: '+base+'/'+provider);
   add(host.label,brand,provider,'web-conversation',!!v&&!!b,semanticWebPassed(v)&&b?.status==='ui-completed-awaiting-tool-verification',evidence);
   add(host.label,brand,provider,'model-switch',!!v&&!!b,v?.checks?.modelChanged===true&&v.checks.actualModel===true&&v.checks.requestedModel===true&&p?.modelSwitch?.passed===true,evidence,{models:{initial:v?.beforeModel?.runtime,alternate:v?.targetModel,actual:v?.actualModel}});
   add(host.label,brand,provider,'shared-mcp-tool',!!v&&!!b,v?.checks?.freshGlobalMcpCall===true&&p?.initial?.globalMcpCall===true,evidence);
   add(host.label,brand,provider,'shared-skill-read',!!v&&!!b,v?.checks?.freshSkillRead===true&&v.checks.freshSharedMemorySkillRead===true,evidence);
   add(host.label,brand,provider,'shared-memory-write',!!v&&!!b,v?.checks?.freshMemoryWrite===true&&v.checks.persistedMemoryWrite===true&&p?.initial?.memoryWrite===true,evidence);
   add(host.label,brand,provider,'shared-memory-read-other-provider',!!p,p?.initial?.priorProviderRead===true,[...evidence,p?.priorProviderEvidenceFile&&base+'/'+path.basename(p.priorProviderEvidenceFile)]);
   const isolation=r?.crossHostIsolation?.providers?.find(x=>x.provider===provider);
   add(host.label,brand,provider,'foreign-host-memory-absent',!!isolation,isolation?.passed===true&&isolation.keys?.length>0&&isolation.keys.every(x=>x.absent===true),[rf,isolation?.evidenceFile&&base+'/'+path.basename(isolation.evidenceFile)]);
  }
 }
 const later=phases.slice(1);
 add(host.label,null,null,'memory-read-after-brand-switch',later.every(x=>!!x.r),later.every(x=>x.r?.providers?.length===providers.length&&x.r.providers.every(p=>p.initial?.previousBrandRead===true&&p.previousBrandWrite?.source==='public-web')),later.flatMap(x=>x.files));
 add(host.label,null,null,'target-switch-preserves-resources',phases.every(x=>!!x.r&&!!x.w),phases.every(x=>x.r?.providers?.length===providers.length&&x.r.providers.every(p=>p.initial?.skillRead===true&&p.initial.globalMcpCall===true&&p.initial.memoryRead===true)&&x.w?.passed===true),phases.flatMap(x=>x.files));
}

 return { matrix, result: audit(matrix,root) };
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const [directory,platform]=process.argv.slice(2);
 if(!directory)throw Error('Usage: node tests/smart-parity/compile.mjs PRIVATE_EVIDENCE_DIRECTORY [PLATFORM]');
 const {matrix,result}=compile(directory,{platform});
 writePrivate(path.join(directory,'matrix.json'),matrix);writePrivate(path.join(directory,'matrix-audit.json'),result);
 console.log(JSON.stringify({platform:result.platform,scope:result.scope,passed:result.passed,requiredCases:result.requiredCases,recordedCases:result.recordedCases,unsuccessful:result.unsuccessful.length,problems:result.problems}));
 if(!result.passed)process.exitCode=1;
}
