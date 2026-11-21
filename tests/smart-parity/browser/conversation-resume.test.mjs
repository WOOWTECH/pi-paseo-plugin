import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadConversationResume } from './conversation-resume.mjs';
import { runtimeBinding } from './runtime.mjs';

const steps = ['open-model-picker','select-provider-model','type-memory-probe','send-web-message','observe-completed-turn','observe-reconnected-conversation'];
const flags = ['activeAgentVerified','completionVisible','reconnected','reconnectedAgentVerified','reconnectedAnswerVisible'];
const ambiguity = 'Ambiguous model selector DOM; bind the active agent before recording';
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'conversation-resume-'));
  fs.chmodSync(root,0o700);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const mkdir=dir=>{fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.chmodSync(dir,0o700);};
  const write=(file,value)=>{fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n',{mode:0o600});fs.chmodSync(file,0o600);};
  const output=path.join(root,'web-live');mkdir(output);mkdir(path.join(output,'attempts'));mkdir(path.join(output,'shared.cany'));
  const imageId='sha256:'+'a'.repeat(64),brand='paseo',attempt=brand+'-conversations-1234567890-11111111-2222-4333-8444-555555555555';
  const directory=path.join(output,'attempts',attempt);mkdir(directory);
  const manifest={runId:'test',scope:'isolated-candidate',productionMutations:false,platform:'k3s-paas',imageId,
    hosts:['hosta','hostb'].map((label,index)=>({label,imageId,dataIdentity:'data-'+label,baseUrl:'http://127.0.0.1:'+(21001+index),ownership:{runId:'test',hostLabel:label}}))};
  const jobs=manifest.hosts.map(host=>({runId:manifest.runId,hostLabel:host.label,runtimeIdentity:'image:'+imageId,phase:brand,workspaceId:'workspace-'+host.label,
    jobs:['claude','codex','pi'].map(provider=>({provider,agentId:host.label+'-'+provider,targetModel:'target-'+provider,alternateModel:'alternate-'+provider,
      prompt:'Read actual tools then reply WEB_UI_OK_'+host.label+'_'+provider}))}));
  const mapping=jobs.flatMap(group=>group.jobs.map(job=>({host:group.hostLabel,provider:job.provider,agentId:job.agentId,workspaceId:group.workspaceId,targetModel:job.targetModel})));
  const proofFiles=[];
  const completed=index=>{
    const job=mapping[index],evidence=[];
    for(const [i,step]of steps.entries()){
      const id='ev_'+index+'_'+i,file=path.join(directory,`${brand}-${job.host}-${job.provider}-action-${i}.json`);
      write(file,{id,operation:'web_walkthrough_record',coverage:{status:'complete'},result:{aborted:null,action_count:1,steps:[{step_id:step,status:'ok'}]}});
      write(file.replace(/\.json$/,'-schema.json'),{result:{valid:true,steps:1}});evidence.push(id);proofFiles.push(file);
    }
    return {...job,evidence,status:'ui-completed-awaiting-tool-verification',...Object.fromEntries(flags.map(key=>[key,true])),beforeLabel:'Old model',afterLabel:'New model'};
  };
  const partial=index=>({...mapping[index],status:'running',evidence:[],activeAgentVerified:true});
  const report={brand,scope:manifest.scope,runId:manifest.runId,...runtimeBinding(manifest),attempt,craftProject:'web-live/shared.cany',
    attemptDirectory:path.relative(root,directory),startedAt:'2026-11-21T10:00:00.000Z',rows:[completed(0),partial(1)],error:ambiguity};
  const file=path.join(directory,brand+'-web-conversations.json'),config={root,output,manifest,brand};
  const save=()=>write(file,report);save();
  return {root,output,directory,file,config,jobs,report,mapping,completed,partial,proofFiles,write,save,
    load:()=>loadConversationResume(config,jobs,file)};
}

test('no resume is an empty result without reading evidence',()=>{
  for(const file of [undefined,null,''])assert.deepEqual(loadConversationResume({},null,file),{rows:[],resumeFrom:null});
});
test('retains only the completed ordered prefix and SHA of untouched original bytes',t=>{
  const f=fixture(t),raw=fs.readFileSync(f.file),before=fs.statSync(f.file),value=f.load();
  assert.equal(value.rows.length,1);assert.deepEqual(value.rows,[f.report.rows[0]]);
  assert.deepEqual(value.resumeFrom,{attempt:f.report.attempt,file:path.relative(f.root,f.file),sha256:crypto.createHash('sha256').update(raw).digest('hex')});
  assert.deepEqual(loadConversationResume(f.config,f.jobs,path.relative(f.root,f.file)),value);
  value.rows[0].evidence.push('mutation');assert.equal(f.load().rows[0].evidence.length,6);
  assert.deepEqual(fs.readFileSync(f.file),raw);assert.equal(fs.statSync(f.file).mtimeMs,before.mtimeMs);
});
test('accepts a completed-only unfinished prefix or known empty composer failure',t=>{
  const f=fixture(t);f.report.rows.pop();delete f.report.error;f.save();assert.equal(f.load().rows.length,1);
  f.report.rows.push(f.partial(1));f.report.error='Ambiguous composer DOM; bind the active agent before recording';f.save();assert.equal(f.load().rows.length,1);
});
test('known failure before the first mutation skips zero jobs',t=>{
  const f=fixture(t);f.report.rows=[f.partial(0)];f.save();assert.equal(f.load().rows.length,0);
});
for(const [label,mutate]of[
  ['brand',f=>f.report.brand='apporo'],['run',f=>f.report.runId='old'],['scope',f=>f.report.scope='production'],
  ['platform',f=>f.report.platform='ha-addon'],['runtime identity',f=>f.report.runtimeIdentity='image:sha256:'+'b'.repeat(64)],
  ['runtime provenance',f=>f.report.runtime.imageId='sha256:'+'b'.repeat(64)],['missing runtime',f=>delete f.report.runtime],
  ['Craft project',f=>f.report.craftProject='web-live/old.cany'],['attempt identity',f=>f.report.attempt=f.report.attempt.replace('1234567890','1234567891')],
  ['attempt directory',f=>f.report.attemptDirectory='web-live'],['recursive resume',f=>f.report.resumeFrom={attempt:'previous'}],
  ['recursive empty field',f=>f.report.resumeFrom=null],['empty rows',f=>f.report.rows=[]],['completed report',f=>f.report.uiCompleted=true],
])test('rejects stale or unsafe '+label,t=>{const f=fixture(t);mutate(f);f.save();assert.throws(f.load);});
for(const key of ['host','provider','agentId','workspaceId','targetModel'])test('binds ordered row '+key+' to the current jobs',t=>{
  const f=fixture(t);f.report.rows[0][key]='changed';f.save();assert.throws(f.load);
});
test('rejects duplicated/reordered rows and changed current job identity',t=>{
  const f=fixture(t);const original=structuredClone(f.report.rows);
  for(const rows of [[original[1],original[0]],[original[0],original[0]], [original[0],original[1],f.partial(2)]]){
    f.report.rows=rows;f.save();assert.throws(f.load);
  }
  f.report.rows=original;f.save();f.jobs[0].jobs[0].agentId='new-agent';assert.throws(f.load);
});
for(const flag of flags)test('completed prefix requires '+flag+' true',t=>{
  const f=fixture(t);for(const value of [undefined,false,1]){f.report.rows[0][flag]=value;f.save();assert.throws(f.load);}
});
test('requires distinct nonempty actual model labels',t=>{
  const f=fixture(t);for(const [before,after]of [['','New'],['Old',''],['Old','Old'],[' Old ','Old'],[null,'New']]){
    f.report.rows[0].beforeLabel=before;f.report.rows[0].afterLabel=after;f.save();assert.throws(f.load);
  }
});
test('rejects unknown failure and every indication of partial mutation',t=>{
  const f=fixture(t);for(const error of ['Timed out','Ambiguous model selector DOM',null,undefined]){f.report.error=error;f.save();assert.throws(f.load);}
  f.report.error=ambiguity;
  for(const field of ['beforeLabel','afterLabel','completionVisible','reconnected','reconnectedAgentVerified','reconnectedAnswerVisible','sent']){
    f.report.rows[1]=f.partial(1);f.report.rows[1][field]=false;f.save();assert.throws(f.load);
  }
  for(const evidence of [['recorded-mutation'],null,'']){f.report.rows[1]=f.partial(1);f.report.rows[1].evidence=evidence;f.save();assert.throws(f.load);}
});
test('refuses replay when all jobs already completed',t=>{
  const f=fixture(t);f.report.rows=f.mapping.map((_,i)=>f.completed(i));delete f.report.error;f.save();assert.throws(f.load,/all jobs completed/);
});
test('rejects missing or unretained Craft IDs and schema proof',t=>{
  const f=fixture(t);f.report.rows[0].evidence[0]='missing';f.save();assert.throws(f.load);
  f.report.rows[0].evidence[0]='ev_0_0';f.save();fs.unlinkSync(f.proofFiles[0].replace(/\.json$/,'-schema.json'));assert.throws(f.load);
});
test('rejects incomplete, failed, duplicated or reordered Craft action evidence',t=>{
  const f=fixture(t),file=f.proofFiles[0],original=JSON.parse(fs.readFileSync(file));
  for(const mutate of [v=>v.coverage.status='partial',v=>v.result.aborted='failed',v=>v.result.steps[0].status='failed',v=>v.result.steps[0].step_id='wrong',v=>v.operation='other']){
    const value=structuredClone(original);mutate(value);f.write(file,value);assert.throws(f.load);
  }
  f.write(file,original);f.report.rows[0].evidence.reverse();f.save();assert.throws(f.load);
  f.report.rows[0].evidence=['ev_0_0','ev_0_0'];f.save();assert.throws(f.load);
});
test('rejects proof belonging to a different attempt or job',t=>{
  const f=fixture(t),file=f.proofFiles[0],other=file.replace('paseo-hosta-claude-','paseo-hostb-claude-');
  fs.renameSync(file,other);fs.renameSync(file.replace(/\.json$/,'-schema.json'),other.replace(/\.json$/,'-schema.json'));assert.throws(f.load);
});
test('only the original private attempt report is eligible, never latest aliases',t=>{
  const f=fixture(t),latest=path.join(f.output,'paseo-web-conversations.json');fs.copyFileSync(f.file,latest);
  assert.throws(()=>loadConversationResume(f.config,f.jobs,latest));
  assert.throws(()=>loadConversationResume(f.config,f.jobs,'../outside.json'));
  fs.chmodSync(f.file,0o644);assert.throws(f.load);fs.chmodSync(f.file,0o600);
  const hardlink=path.join(f.directory,'hardlink');fs.linkSync(f.file,hardlink);assert.throws(f.load);fs.unlinkSync(hardlink);
  const original=f.file+'.original';fs.renameSync(f.file,original);fs.symlinkSync(original,f.file);assert.throws(f.load);
});
test('rejects symlinked attempt directories and nonprivate proof files',t=>{
  const f=fixture(t);fs.chmodSync(f.proofFiles[0],0o644);assert.throws(f.load);fs.chmodSync(f.proofFiles[0],0o600);
  const actual=f.directory+'-real';fs.renameSync(f.directory,actual);fs.symlinkSync(actual,f.directory);assert.throws(f.load);
});
