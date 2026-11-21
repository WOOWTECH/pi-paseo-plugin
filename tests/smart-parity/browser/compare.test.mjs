import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireCraftProject } from './common.mjs';
import { comparisonPlan } from './compare.mjs';
import { evidenceStore } from '../evidence-store.mjs';

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'craft-compare-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const imageId='sha256:'+'a'.repeat(64), runtimeIdentity='image:'+imageId;
  const manifest={platform:'k3s-paas',imageId,scope:'isolated-candidate',productionMutations:false,runId:'test',hosts:['one','two'].map((label,i)=>({label,imageId,dataIdentity:'data-'+label,baseUrl:'http://127.0.0.1:'+(21001+i),ownership:{runId:'test',hostLabel:label}}))};
  const reports={};
  const record=(id,steps)=>{
    const directory=path.join(root,'web-live/attempts/fixture');fs.mkdirSync(directory,{recursive:true});
    fs.writeFileSync(path.join(directory,id+'.json'),JSON.stringify({id,operation:'web_walkthrough_record',coverage:{status:'complete'},result:{aborted:null,action_count:steps.length,steps:steps.map(step_id=>({step_id,status:'ok'}))}}));
    fs.writeFileSync(path.join(directory,id+'-schema.json'),JSON.stringify({result:{valid:true,steps:steps.length}}));return id;
  };
  for(const brand of ['woowtech','apporo','paseo']){
    const binding={platform:manifest.platform,imageId,runtimeIdentity,scope:manifest.scope,runId:manifest.runId,brand,craftProject:'web-live/shared.cany'};
    const pairing={...binding,hosts:[],hostListEvidence:[record(brand+'-list',['list-connected-hosts'])]},conversations={...binding,rows:[]};
    for(const host of manifest.hosts){
      pairing.hosts.push({host:host.label,initialRuntimeIdentity:runtimeIdentity,serverId:brand+'-server-'+host.label,status:'paired',confirmationDismissed:true,visibleInHostPicker:true,ready:{selectedTarget:brand,activeTarget:brand,healthy:true,configurationPending:false},evidence:[record(brand+'-'+host.label+'-select',['select-target','save-target']),record(brand+'-'+host.label+'-start',['start-selected-target']),record(brand+'-'+host.label+'-connect',['connect-host'])]});
      for(const provider of ['claude','codex','pi'])conversations.rows.push({host:host.label,provider,agentId:brand+'-'+host.label+'-'+provider,workspaceId:'workspace',status:'ui-completed-awaiting-tool-verification',activeAgentVerified:true,completionVisible:true,reconnected:true,reconnectedAgentVerified:true,reconnectedAnswerVisible:true,evidence:[record(brand+'-'+host.label+'-'+provider,['open-model-picker','select-provider-model','type-memory-probe','send-web-message','observe-completed-turn','observe-reconnected-conversation'])]});
    }
    reports[brand]={pairing,conversations};
  }
  return {root,manifest,reports,record,plan:()=>comparisonPlan(manifest,reports,evidenceStore(root))};
}
test('shared Craft project persists across attempts and rejects concurrent writers',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'craft-project-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const first=acquireCraftProject(root);fs.writeFileSync(path.join(first.project,'retained-id'),'retained');
  assert.throws(()=>acquireCraftProject(root),{code:'EEXIST'});first.release();first.release();
  const second=acquireCraftProject(root);assert.equal(second.project,first.project);assert.equal(fs.readFileSync(path.join(second.project,'retained-id'),'utf8'),'retained');second.release();
});
test('plans complete pairing and provider flows for all three brand pairs using saved IDs',t=>{
  const f=fixture(t),rows=f.plan();assert.equal(rows.length,39);
  assert.deepEqual([...new Set(rows.map(r=>r.left+'>'+r.right))],['woowtech>apporo','woowtech>paseo','apporo>paseo']);
  assert.ok(rows.every(r=>r.before?.id&&r.after?.id&&r.before.file&&r.after.file));
  assert.ok(rows.some(r=>r.flow.includes('connect-host')));assert.ok(rows.some(r=>r.flow.includes('observe-reconnected-conversation')));
});
test('optional controls absent in another brand stay explicit comparison gaps',t=>{
  const f=fixture(t);f.reports.woowtech.pairing.hosts[0].evidence.push(f.record('woowtech-only-stop',['stop-selected-host']));
  const rows=f.plan(),missing=rows.filter(r=>!r.before||!r.after);assert.equal(missing.length,2);assert.ok(missing.every(r=>r.flow.includes('stop-selected-host')));
});
for(const [label,mutate] of [
  ['separate project',f=>f.reports.paseo.conversations.craftProject='web-live/attempts/old/live.cany'],
  ['missing brand',f=>delete f.reports.apporo],
  ['stale runtime',f=>f.reports.apporo.conversations.runtimeIdentity='image:sha256:'+'f'.repeat(64)],
  ['missing provider',f=>f.reports.woowtech.conversations.rows.pop()],
  ['failed reconnect',f=>f.reports.paseo.conversations.rows[0].reconnectedAgentVerified=false],
  ['unresolved Craft ID',f=>f.reports.woowtech.conversations.rows[0].evidence=['absent']],
  ['Craft reuse across hosts',f=>f.reports.paseo.conversations.rows[1].evidence=f.reports.paseo.conversations.rows[0].evidence],
])test('rejects '+label,t=>{const f=fixture(t);mutate(f);assert.throws(()=>f.plan());});
