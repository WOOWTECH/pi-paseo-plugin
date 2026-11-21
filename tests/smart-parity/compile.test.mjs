import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compile } from './compile.mjs';
import { evidenceStore, semanticWebPassed } from './evidence-store.mjs';

const imageId = 'sha256:' + 'a'.repeat(64);
const brand = 'woowtech';
const steps = ['open-model-picker', 'select-provider-model', 'type-memory-probe', 'send-web-message', 'observe-completed-turn', 'observe-reconnected-conversation'];
const checks = () => Object.fromEntries(['actualProvider','completed','requestedModel','actualModel','modelChanged','freshMemoryRead','freshSkillRead','freshSharedMemorySkillRead','freshGlobalMcpCall','freshMemoryWriteRead','freshMemoryWrite','persistedMemoryWrite','answered'].map(key => [key, true]));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-evidence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (file, value) => { fs.mkdirSync(path.dirname(path.join(root,file)), { recursive: true }); fs.writeFileSync(path.join(root,file), JSON.stringify(value)); };
  const manifest = { platform: 'k3s-paas', scope: 'isolated-candidate', runId: 'test-run', imageId, productionMutations: false,
    hosts: ['one','two'].map((label,i) => ({ label, imageId, dataIdentity: 'volume-'+label, baseUrl: 'http://127.0.0.1:'+(26041+i), ownership: {runId:'test-run',hostLabel:label} })) };
  put('browser-hosts.private.json', manifest);
  const exportCraft = (id, file, actions=steps) => {
    put(file, { id, operation: 'web_walkthrough_record', coverage: {status:'complete'}, result:{aborted:null,action_count:actions.length,steps:actions.map(step_id=>({step_id,status:'ok'}))} });
    put(file.replace(/\.json$/, '-schema.json'), {result:{valid:true,steps:actions.length}});
    return id;
  };
  return {root,put,manifest,exportCraft};
}
function providerFixture(t) {
  const f=fixture(t), base='hosts/one/evidence/'+brand;
  const backend={runId:'test-run',hostLabel:'one',phase:brand,runtimeIdentity:'image:'+imageId,workspaceId:'workspace',providers:[{provider:'claude',phase:brand,agentId:'agent',evidenceFile:'/private/claude-timeline.json',modelSwitch:{passed:true},initial:{globalMcpCall:true,memoryWrite:true}}]};
  const verifier={runId:'test-run',hostLabel:'one',phase:brand,runtimeIdentity:'image:'+imageId,providers:[{provider:'claude',agentId:'agent',targetModel:'alternate',actualModel:'alternate',beforeModel:{runtime:'initial'},checks:checks(),passed:true,evidenceFile:'/private/claude-web-timeline.json'}]};
  const browser={brand,platform:f.manifest.platform,scope:f.manifest.scope,runId:f.manifest.runId,imageId,rows:[{host:'one',provider:'claude',agentId:'agent',workspaceId:'workspace',targetModel:'alternate',status:'ui-completed-awaiting-tool-verification',evidence:['web-id'],activeAgentVerified:true,reconnected:true,completionVisible:true,reconnectedAgentVerified:true,reconnectedAnswerVisible:true}]};
  const save=()=>{f.put(base+'/provider-acceptance.json',backend);f.put(base+'/web-verification.json',verifier);f.put('web-live/'+brand+'-web-conversations.json',browser);};
  f.put(base+'/claude-timeline.json',[]);f.put(base+'/claude-web-timeline.json',[]);
  f.exportCraft('web-id','web-live/attempts/test/web.json');save();
  return {...f,base,backend,verifier,browser,save};
}
function lifecycleFixture(t) {
  const f=fixture(t), providers=['claude','codex','pi'], senders=['codex','pi','claude'].map(provider=>({senderProvider:provider,agentId:'sender-'+provider}));
  const backend={runId:'test-run',hostLabel:'one',phase:brand,runtimeIdentity:'image:'+imageId,workspaceId:'workspace',cleanupPass:true,workspaceArchived:true,workspaceDirectoryRetained:true,cliWorkspaceLifecycle:{created:true,archived:true,directoryRetained:true},providers:providers.map(provider=>({provider,agentId:'receiver-'+provider})),communication:{agentId:senders[0].agentId,edges:senders}};
  backend.agents=[...backend.providers.map(row=>row.agentId),...senders.map(row=>row.agentId)];
  backend.deleted=[...backend.agents];backend.deletedAgentAbsence=backend.agents.map(id=>({id,absent:true}));
  backend.mcpConversationLifecycle=backend.providers.map(row=>({agentId:row.agentId,archived:true,retainedInArchive:true}));
  const save=()=>f.put('hosts/one/evidence/'+brand+'/provider-acceptance.json',backend);save();
  const statuses=()=>Object.fromEntries(compile(f.root).matrix.results.filter(row=>row.host==='one'&&row.brand===brand&&['workspace-archive','conversation-cli-create-delete','conversation-mcp-create-archive'].includes(row.case)).map(row=>[row.case,row.status]));
  return {...f,backend,save,statuses};
}
test('lifecycle cases require successful cleanup of all owned CLI senders and exact MCP agents',t=>{
  const f=lifecycleFixture(t);assert.deepEqual(Object.values(f.statuses()),['pass','pass','pass']);
  f.backend.cleanupPass=false;f.save();assert.deepEqual(Object.values(f.statuses()),['fail','fail','fail']);
  f.backend.cleanupPass=true;f.backend.cleanupErrors=[{agentId:'sender-pi'}];f.save();assert.deepEqual(Object.values(f.statuses()),['fail','fail','fail']);
});
for(const [label,mutate] of [
  ['second sender not deleted',r=>r.deleted=r.deleted.filter(id=>id!=='sender-pi')],
  ['third sender still present',r=>r.deletedAgentAbsence.find(x=>x.id==='sender-claude').absent=false],
  ['only first sender absence recorded',r=>r.deletedAgentAbsence=r.deletedAgentAbsence.filter(x=>x.id===r.communication.agentId)],
  ['sender outside owned agents',r=>r.agents=r.agents.filter(id=>id!=='sender-pi')],
  ['duplicate CLI sender',r=>r.communication.edges[1].agentId=r.communication.edges[0].agentId],
  ['duplicate absence receipt',r=>r.deletedAgentAbsence.push({...r.deletedAgentAbsence.at(-1)})],
  ['first-sender alias without full cycle',r=>delete r.communication.edges],
])test('CLI lifecycle rejects '+label,t=>{const f=lifecycleFixture(t);mutate(f.backend);f.save();assert.equal(f.statuses()['conversation-cli-create-delete'],'fail');});
for(const [label,mutate] of [
  ['foreign archive agent',r=>r.mcpConversationLifecycle[1].agentId='foreign-agent'],
  ['duplicate archive agent',r=>r.mcpConversationLifecycle[1].agentId=r.mcpConversationLifecycle[0].agentId],
  ['duplicate provider agent',r=>r.providers[1].agentId=r.providers[0].agentId],
  ['provider outside owned agents',r=>r.agents=r.agents.filter(id=>id!=='receiver-codex')],
  ['missing retained archive',r=>r.mcpConversationLifecycle[1].retainedInArchive=false],
])test('MCP lifecycle rejects '+label,t=>{const f=lifecycleFixture(t);mutate(f.backend);f.save();assert.equal(f.statuses()['conversation-mcp-create-archive'],'fail');});
test('empty run remains explicitly unrun, never a passing matrix', t=>{
  const f=fixture(t), {matrix,result}=compile(f.root);
  assert.equal(result.passed,false);assert.equal(matrix.results.length,178);
  assert.ok(matrix.results.every(row=>row.status==='unrun'));
});
test('valid observer/Craft input compiles one provider without certifying absent cases',t=>{
  const f=providerFixture(t),{matrix,result}=compile(f.root);
  assert.equal(matrix.results.find(r=>r.host==='one'&&r.brand===brand&&r.provider==='claude'&&r.case==='web-conversation').status,'pass');
  assert.equal(result.passed,false);assert.deepEqual(result.problems,[]);
});
for(const [label,mutate] of [
  ['stale backend run',f=>f.backend.runId='old-run'],
  ['stale backend runtime',f=>f.backend.runtimeIdentity='image:sha256:'+'f'.repeat(64)],
  ['missing backend runtime',f=>delete f.backend.runtimeIdentity],
  ['stale verifier run',f=>f.verifier.runId='old-run'],
  ['missing verifier run',f=>delete f.verifier.runId],
  ['stale verifier runtime',f=>f.verifier.runtimeIdentity='image:sha256:'+'f'.repeat(64)],
  ['missing verifier runtime',f=>delete f.verifier.runtimeIdentity],
  ['stale browser image',f=>f.browser.imageId='sha256:'+'b'.repeat(64)],
  ['wrong browser scope',f=>f.browser.scope='existing-production'],
  ['foreign browser host',f=>f.browser.rows[0].host='foreign'],
  ['mixed agent IDs',f=>f.verifier.providers[0].agentId='old-agent'],
  ['mixed provider phase',f=>f.backend.providers[0].phase='apporo'],
  ['mixed workspace',f=>f.browser.rows[0].workspaceId='other-workspace'],
  ['mixed target model',f=>f.browser.rows[0].targetModel='other-model'],
  ['duplicate provider',f=>f.backend.providers.push({...f.backend.providers[0]})],
  ['unknown provider',f=>f.browser.rows[0].provider='unknown'],
  ['status label without semantic checks',f=>delete f.verifier.providers[0].checks],
  ['missing timeline declaration',f=>delete f.verifier.providers[0].evidenceFile],
]) test('rejects '+label,t=>{const f=providerFixture(t);mutate(f);f.save();assert.throws(()=>compile(f.root));});
test('missing raw timeline remains in evidence and fails integrity audit',t=>{
  const f=providerFixture(t);fs.unlinkSync(path.join(f.root,f.base,'claude-web-timeline.json'));
  const {matrix,result}=compile(f.root),row=matrix.results.find(r=>r.case==='web-conversation'&&r.provider==='claude'&&r.host==='one'&&r.brand===brand);
  assert.ok(row.evidence.some(e=>e.missing&&e.sha256===null));assert.ok(result.problems.some(p=>p.includes('Missing or changed evidence')));
});
test('partial semantic verifier checks cannot pass',()=>{assert.equal(semanticWebPassed({passed:true,checks:{actualProvider:true}}),false);});
for(const [label,mutate] of [
  ['unresolved Craft ID',f=>f.browser.rows[0].evidence=['absent-id']],
  ['duplicate Craft ID',f=>f.browser.rows[0].evidence=['web-id','web-id']],
  ['missing Craft schema',f=>fs.unlinkSync(path.join(f.root,'web-live/attempts/test/web-schema.json'))],
  ['invalid Craft schema',f=>f.put('web-live/attempts/test/web-schema.json',{result:{valid:false,steps:steps.length}})],
  ['wrong schema action count',f=>f.put('web-live/attempts/test/web-schema.json',{result:{valid:true,steps:1}})],
  ['missing GUI action',f=>f.exportCraft('web-id','web-live/attempts/test/web.json',steps.slice(1))],
  ['ambiguous Craft export',f=>f.exportCraft('web-id','web-live/attempts/other/web.json')],
]) test('rejects '+label,t=>{const f=providerFixture(t);mutate(f);f.save();assert.throws(()=>compile(f.root));});
test('rejects Craft evidence reused for another provider',t=>{
  const f=providerFixture(t);f.browser.rows.push({...f.browser.rows[0],provider:'codex',agentId:'other'});f.save();assert.throws(()=>compile(f.root),/reused/);
});
test('pair case contains every host action and global picker raw/schema evidence',t=>{
  const f=fixture(t), pairSteps=['select-target','save-target','start-selected-target','connect-host'];
  const hosts=f.manifest.hosts.map(h=>({host:h.label,initialImage:imageId,serverId:'server-'+h.label,status:'paired',confirmationDismissed:true,visibleInHostPicker:true,ready:{selectedTarget:brand,activeTarget:brand,healthy:true,configurationPending:false},evidence:[f.exportCraft('pair-'+h.label,'web-live/attempts/pair/'+h.label+'.json',pairSteps)]}));
  f.put('web-live/'+brand+'-hosts.json',{brand,platform:f.manifest.platform,scope:f.manifest.scope,runId:f.manifest.runId,imageId,hosts,hostListEvidence:[f.exportCraft('list','web-live/attempts/pair/list.json',['list-connected-hosts'])]});
  const {matrix}=compile(f.root),pair=matrix.results.find(r=>r.host==='one'&&r.brand===brand&&r.case==='pair');
  assert.equal(pair.status,'pass');assert.equal(pair.evidence.length,6);
  hosts[1].serverId=hosts[0].serverId;
  f.put('web-live/'+brand+'-hosts.json',{brand,platform:f.manifest.platform,scope:f.manifest.scope,runId:f.manifest.runId,imageId,hosts});
  assert.throws(()=>compile(f.root),/pairing/);
});
test('private store rejects traversal, symlink escapes and non-private root',t=>{
  const f=fixture(t);fs.symlinkSync('/etc/hosts',path.join(f.root,'escape'));const store=evidenceStore(f.root);
  assert.throws(()=>store.proof(['../outside']));assert.throws(()=>store.proof(['escape']));
  fs.chmodSync(f.root,0o755);assert.throws(()=>evidenceStore(f.root),/private/);
});

test('compiler derives platform from manifest and refuses another platform label',t=>{
  const f=fixture(t);f.manifest.platform='ha-addon';f.put('browser-hosts.private.json',f.manifest);
  const {matrix}=compile(f.root);assert.equal(matrix.platform,'ha-addon');assert.match(matrix.hosts[0].runtimeIdentity,/^image:sha256:/);
  assert.throws(()=>compile(f.root,{platform:'k3s-paas'}),/platform/);
});
test('compiler maps native package-set identity without inventing image provenance',async t=>{
  const {packageSetDigest}=await import('./browser/runtime.mjs'), f=fixture(t);
  const packages=[{name:'@woowtech/pi-paseo',version:'0.1.17',archiveSha256:'d'.repeat(64)}], digest=packageSetDigest(packages);
  delete f.manifest.imageId;f.manifest.platform='ubuntu';f.manifest.runtime={kind:'package-set',digest,packages};
  for(const host of f.manifest.hosts){delete host.imageId;host.runtimeIdentity='package-set:'+digest;}
  f.put('browser-hosts.private.json',f.manifest);
  const {matrix,result}=compile(f.root);assert.equal(matrix.platform,'ubuntu');assert.equal(result.passed,false);
  assert.ok(matrix.hosts.every(h=>h.runtimeIdentity==='package-set:'+digest));assert.ok(!JSON.stringify(matrix).includes('image:'));
});
