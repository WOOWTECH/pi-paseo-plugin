import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateManifest, validatePairingReport, validateJobs, completionMarker, workspaceRoute,
  verifyReconnectedConversation, configuration, writePrivate } from './common.mjs';
const imageId = 'sha256:' + 'a'.repeat(64);
function fixture() {
  return { platform: 'k3s-paas', scope: 'isolated-candidate', productionMutations: false, runId: 'test-run', imageId,
    providerTurnsAuthorized: true, hosts: ['one','two'].map((label, i) => ({ label, imageId, dataIdentity: 'volume-' + label,
      baseUrl: `http://127.0.0.1:${26041+i}`, ownership: { runId: 'test-run', hostLabel: label } })) };
}
function pairing(m = fixture()) {
  return { brand: 'woowtech', platform: m.platform, scope: m.scope, runId: m.runId, imageId, hostListEvidence: ['ev_list'],
    hosts: m.hosts.map(h => ({ host: h.label, initialImage: imageId, serverId: 'server-' + h.label,
      evidence: ['ev_select','ev_start','ev_connect'], status: 'paired', visibleInHostPicker: true, confirmationDismissed: true, connection: {settingsAvailable: true, afterReload: true, route: '/settings/hosts/server-'+h.label+'/agents'},
      ready: { selectedTarget: 'woowtech', activeTarget: 'woowtech', healthy: true, configurationPending: false } })) };
}
function jobs() {
  return fixture().hosts.map(h => ({ runId: 'test-run', hostLabel: h.label, phase: 'woowtech', runtimeIdentity: 'image:' + imageId, workspaceId: 'workspace-' + h.label,
    jobs: ['claude','codex','pi'].map(provider => ({ provider, agentId: 'agent-' + provider,
      targetModel: 'first', alternateModel: 'second', prompt: 'Reply WEB_UI_OK_' + h.label + '_' + provider })) }));
}
test('accepts separately owned isolated hosts and complete provider jobs', () => {
  const m=fixture(); assert.equal(validateManifest(m),m); validateManifest(m,{providerTurns:true});
  validatePairingReport(pairing(m),m,'woowtech'); validateJobs(jobs(),m,'woowtech');
});
for (const [label, mutate] of [
  ['production scope', m => m.scope='existing-production'],
  ['missing production declaration', m => delete m.productionMutations],
  ['one host', m => m.hosts.pop()],
  ['duplicate host labels', m => m.hosts[1].label=m.hosts[0].label],
  ['shared data', m => m.hosts[1].dataIdentity=m.hosts[0].dataIdentity],
  ['wrong image', m => m.hosts[1].imageId='sha256:'+'b'.repeat(64)],
  ['foreign ownership', m => m.hosts[0].ownership.runId='another-run'],
  ['public origin', m => m.hosts[0].baseUrl='https://example.com'],
  ['URL credentials', m => m.hosts[0].baseUrl='http://secret@127.0.0.1:26041'],
  ['duplicate host endpoint', m => m.hosts[1].baseUrl=m.hosts[0].baseUrl],
]) test('rejects '+label,()=>{const m=fixture();mutate(m);assert.throws(()=>validateManifest(m));});
test('conversation requires prior provider-turn authorization',()=>{const m=fixture();m.providerTurnsAuthorized=false;assert.throws(()=>validateManifest(m,{providerTurns:true}));});
for(const [label, mutate] of [
  ['registered but disconnected', r=>delete r.hosts[0].connection],
  ['connection lost on reload', r=>r.hosts[0].connection.afterReload=false],
  ['wrong connected host', r=>r.hosts[0].connection.route='/settings/hosts/other/agents'],
  ['confirmation still open', r=>r.hosts[0].confirmationDismissed=false],
  ['wrong image', r=>r.hosts[0].initialImage='old'],
  ['same server twice', r=>r.hosts[1].serverId=r.hosts[0].serverId],
  ['unseen host', r=>r.hosts[0].visibleInHostPicker=false],
  ['pending target', r=>r.hosts[0].ready.configurationPending=true],
]) test('pairing rejects '+label,()=>{const r=pairing();mutate(r);assert.throws(()=>validatePairingReport(r,fixture(),'woowtech'));});
for(const [label,mutate] of [
  ['foreign host', j=>j[0].hostLabel='foreign'],
  ['wrong brand', j=>j[0].phase='apporo'],
  ['stale run', j=>j[0].runId='old-run'],
  ['missing run', j=>delete j[0].runId],
  ['stale runtime', j=>j[0].runtimeIdentity='image:sha256:'+'f'.repeat(64)],
  ['missing runtime', j=>delete j[0].runtimeIdentity],
  ['duplicate agent', j=>j[0].jobs[1].agentId=j[0].jobs[0].agentId],
  ['duplicate provider', j=>j[0].jobs[1].provider='claude'],
  ['same model', j=>j[0].jobs[0].alternateModel='first'],
  ['reused completion marker', j=>j[1].jobs[0].prompt=j[0].jobs[0].prompt],
]) test('jobs reject '+label,()=>{const j=jobs();mutate(j);assert.throws(()=>validateJobs(j,fixture(),'woowtech'));});
test('deep links follow public workspace encoding and completion markers are explicit',()=>{
 assert.equal(workspaceRoute('srv','opaque-id','id'),'/h/srv/workspace/opaque-id?open=agent%3Aid');
 assert.match(workspaceRoute('srv','/path with spaces','id'),/workspace\/b64_[A-Za-z0-9_-]+\?open=agent%3Aid$/);
 assert.throws(()=>completionMarker({prompt:'no marker'}));
});
function page({selected='true', answer=true, origin='https://smart.woowtech.io'}={}) {
 return { url:()=>origin+'/h/srv/workspace/owned', locator:()=>({waitFor:async()=>{}}),
 getByTestId:id=>id==='workspace-tab-agent_expected'?{isVisible:async()=>true,getAttribute:async()=>selected}:
 id==='assistant-message'?{filter:({hasText})=>({waitFor:async()=>{assert.equal(hasText,'WEB_UI_OK_expected');if(!answer)throw Error('reply absent');}})}:
 {isVisible:async()=>false,getAttribute:async()=>null} };
}
const expected={agentId:'expected',completion:'WEB_UI_OK_expected',url:'https://smart.woowtech.io/h/srv/workspace/owned?open=agent%3Aexpected'};
test('reload accepts consumed query only with exact active agent and answer',async()=>{
 assert.deepEqual(await verifyReconnectedConversation(page(),expected,1),{reconnected:true,reconnectedAgentVerified:true,reconnectedAnswerVisible:true});
});
test('same workspace and composer cannot conceal a different active agent',async()=>{
 await assert.rejects(verifyReconnectedConversation(page({selected:'false'}),expected,1));
});
test('reload rejects missing unique assistant answer and wrong host origin',async()=>{
 await assert.rejects(verifyReconnectedConversation(page({answer:false}),expected,1));
 await assert.rejects(verifyReconnectedConversation(page({origin:'https://smart.apporo.ai'}),expected,1));
});
test('configuration refuses non-private evidence and reads paths from explicit environment',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'browser-parity-'));fs.chmodSync(root,0o700);
 try{
  writePrivate(path.join(root,'browser-hosts.private.json'),fixture());
  const env={SMART_PARITY_EVIDENCE_DIR:root,SMART_PARITY_PLAYWRIGHT_MODULE:'/test/playwright.mjs',SMART_PARITY_CHROMIUM_EXECUTABLE_PATH:'/test/chromium',SMART_PARITY_CRAFT_CLI:'/test/craft'};
  assert.equal(configuration('woowtech',env).url,'https://smart.woowtech.io');
  assert.throws(()=>configuration('unknown',env));
  fs.chmodSync(root,0o755);assert.throws(()=>configuration('woowtech',env));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
