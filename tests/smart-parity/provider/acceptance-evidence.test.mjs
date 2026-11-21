import test from 'node:test';
import assert from 'node:assert/strict';
import {invokes,memoryResult,memoryWrite,fixtureMcpResult,skillRead,sendAgentPrompt,assistantReplied,workspaceRows,agentRows,runPassed} from './acceptance-evidence.mjs';
const event = (name,input,output) => ({type:'tool_call',status:'completed',name,detail:{type:'unknown',input,output}});
const proxy = (tool,args,output) => event('mcp__pi_shared_runtime__pi_global_mcp',{tool,args}, {content:[{type:'text',text:JSON.stringify(output)}]});
test('absent read requires exact call, key and structured null in result',()=>{
  assert.equal(memoryResult([proxy('pi_shared_memory_read',{key:'foreign'},{memory:null})],'foreign',null),true);
  for (const call of [proxy('pi_shared_memory_read',{key:'other'},{memory:null}),proxy('unrelated',{key:'foreign'},{memory:null}),proxy('pi_shared_memory_read',{key:'foreign'},{status:'missing',memory:{key:'foreign',content:'null'}}),event('read',{key:'foreign'},{memory:null}),proxy('pi_shared_memory_read',{key:'foreign'},{message:'missing',something:null}),{...proxy('pi_shared_memory_read',{key:'foreign'},{memory:null}),error:'failed'},proxy('pi_shared_memory_read',{key:'foreign'},{isError:true,memory:null})]) assert.equal(memoryResult([call],'foreign',null),false);
});
test('nested MCP strings and native direct calls are accepted without scanning input',()=>{
 const call=event('mcp__pi_shared_memory__read',JSON.stringify({key:'local'}),JSON.stringify({result:{content:[{type:'text',text:JSON.stringify({memory:{key:'local',content:'nonce'}})}]}}));
 assert.equal(memoryResult([call],'local','nonce'),true);
 assert.equal(memoryResult([event('pi_shared_runtime.pi_global_mcp',{tool:'pi_shared_memory_read',args:{key:'foreign'}},{content:[{type:'text',text:'{\"memory\":null}'}]})],'foreign',null),true);
 assert.equal(memoryResult([proxy('pi_shared_memory_read',{key:'local',content:'nonce'},{memory:null})],'local','nonce'),false);
});
const namespace = (server,tool,args,output) => event('mcp__pi_shared_runtime__pi_global_mcp__'+server,{tool,args},{output});
test('Claude server dispatcher binds exact server, prefixed tool and nested arguments',()=>{
 assert.equal(memoryResult([namespace('pi_shared_memory','pi_shared_memory_read',{key:'local'},{memory:{key:'local',content:'nonce'}})],'local','nonce'),true);
 assert.equal(memoryWrite([namespace('pi_shared_memory','pi_shared_memory_write',{key:'local',content:'nonce'},{memory:{key:'local',content:'nonce',revision:'r'}})],'local','nonce'),true);
 assert.equal(fixtureMcpResult([namespace('acceptance_test','acceptance_test_read_marker',{},'fixture-marker')],'acceptance_test','fixture-marker'),true);
});
test('Claude server dispatcher also accepts the exact short underlying tool name',()=>{
 assert.equal(memoryResult([namespace('pi_shared_memory','read',{key:'foreign'},{memory:null})],'foreign',null),true);
 assert.equal(memoryWrite([namespace('pi_shared_memory','write',{key:'local',content:'nonce'},{memory:{key:'local',content:'nonce',revision:'r'}})],'local','nonce'),true);
 assert.equal(fixtureMcpResult([namespace('acceptance_test','read_marker',{},'fixture-marker')],'acceptance_test','fixture-marker'),true);
 assert.equal(memoryResult([namespace('other','read',{key:'foreign'},{memory:null})],'foreign',null),false);
 assert.equal(memoryResult([namespace('pi_shared_memory','other_read',{key:'foreign'},{memory:null})],'foreign',null),false);
});
test('Claude dispatcher rejects wrong server, tool, argument nesting, completion and output',()=>{
 const valid=namespace('pi_shared_memory','pi_shared_memory_read',{key:'local'},{memory:{key:'local',content:'nonce'}});
 for(const mutate of [c=>c.name='mcp__pi_shared_runtime__pi_global_mcp__other',c=>c.name+='__extra',c=>c.detail.input.tool='other_read',c=>c.detail.input.tool='pi_shared_memory_read_extra',c=>c.detail.input.tool='pi_shared_memory_write',c=>c.detail.input.args.key='other',c=>c.detail.input.server='other',c=>c.detail.input.args=[],c=>{c.detail.input.key='local';delete c.detail.input.args;},c=>c.status='running',c=>c.status='failed',c=>c.error='failed',c=>c.detail.output={isError:true,output:{memory:{key:'local',content:'nonce'}}},c=>c.detail.output={output:{isError:true,memory:{key:'local',content:'nonce'}}},c=>{c.detail.input.args.content='nonce';c.detail.output={output:{memory:null}};}]) {
  const call=structuredClone(valid);mutate(call);assert.equal(memoryResult([call],'local','nonce'),false);
 }
 assert.equal(fixtureMcpResult([namespace('other','acceptance_test_read_marker',{},'fixture-marker')],'acceptance_test','fixture-marker'),false);
 assert.equal(memoryWrite([namespace('other','pi_shared_memory_write',{key:'local',content:'nonce'},{memory:{key:'local',content:'nonce',revision:'r'}})],'local','nonce'),false);
});
test('write evidence binds content and successful returned revision',()=>{
 assert.equal(memoryWrite([proxy('pi_shared_memory_write',{key:'local',content:'nonce'},{memory:{key:'local',content:'nonce',revision:'r'}})],'local','nonce'),true);
 assert.equal(memoryWrite([proxy('pi_shared_memory_write',{key:'local',content:'nonce'},{memory:null})],'local','nonce'),false);
});
test('fixture output must come from exact MCP route',()=>{
 assert.equal(fixtureMcpResult([event('pi_global_mcp',{tool:'acceptance_test_read_marker',args:{}},{content:[{type:'text',text:'nonce'}]})],'acceptance_test','nonce'),true);
 assert.equal(fixtureMcpResult([event('pi_global_mcp',{tool:'unrelated',args:{nonce:'nonce'}},'nonce')],'acceptance_test','nonce'),false);
});
test('skill evidence requires real skill source and output',()=>{
 assert.equal(skillRead([event('Skill',{skill:'test'},'marker')],'test','marker'),true);
 assert.equal(skillRead([{...event('read',{},null),detail:{type:'read',filePath:'/home/skills/test/SKILL.md',content:'marker'}}],'test','marker'),true);
 assert.equal(skillRead([{...event('read',{},null),detail:{type:'read',filePath:'/home/manifest.json',content:'marker'}}],'test','marker'),false);
});
test('shared runtime Skill requires exact name, successful completion and hidden output',()=>{
 const call=event('mcp__pi_shared_runtime__Skill',{skill:'acceptance-test'},{output:'actual instructions hidden-marker'});
 assert.equal(skillRead([call],'acceptance-test','hidden-marker'),true);
 for(const mutate of [c=>c.detail.input.skill='other',c=>c.name='mcp__other__Skill',c=>c.detail.output='different instructions',c=>c.detail.output={isError:true,output:'hidden-marker'},c=>c.status='failed',c=>c.error='failed',c=>{c.detail.input.marker='hidden-marker';c.detail.output='';}]) {
  const changed=structuredClone(call);mutate(changed);assert.equal(skillRead([changed],'acceptance-test','hidden-marker'),false);
 }
 assert.equal(skillRead([{...event('Read',{},'hidden-marker'),detail:{type:'read',filePath:'/workspace/.claude/skills',content:'hidden-marker'}}],'acceptance-test','hidden-marker'),false);
});
test('coordination requires send receiver identity and separate assistant response',()=>{
 assert.equal(sendAgentPrompt([event('mcp__paseo__send_agent_prompt',{agentId:'owned'}, {})],'owned'),true);
 assert.equal(sendAgentPrompt([event('mcp__paseo__send_agent_prompt',{agentId:'other',prompt:'owned'}, {})],'owned'),false);
 assert.equal(assistantReplied([event('send_agent_prompt',{},'marker')],'marker'),false);
 assert.equal(assistantReplied([{type:'assistant_message',text:'marker'}],'marker'),true);
});
test('list response shape fails closed',()=>{
 assert.deepEqual(workspaceRows({workspaces:[]}),[]); assert.deepEqual(agentRows([]),[]);
 assert.throws(()=>workspaceRows({items:[]})); assert.throws(()=>agentRows({agents:[]}));
});
test('aggregate cannot pass with missing provider, model, lifecycle or coordination proof',()=>{
 const report={providers:Array.from({length:3},()=>({initial:{skill:true,foreign:true,prior:null},modelSwitch:{passed:true}})),cliWorkspaceLifecycle:{created:true,archived:true,directoryRetained:true},communication:{actualSendTool:true,receivedMarker:true,receiverResponded:true,edges:[['codex','claude'],['pi','codex'],['claude','pi']].map(([senderProvider,receiverProvider])=>({senderProvider,receiverProvider,agentId:'sender-'+senderProvider,receiverId:'receiver-'+receiverProvider,actualSenderProvider:true,actualReceiverProvider:true,actualSendTool:true,receivedMarker:true,receiverResponded:true}))}};
 assert.equal(runPassed(report),true);
 for(const mutate of [r=>r.providers.pop(),r=>r.providers[0].initial.skill=false,r=>r.providers[1].modelSwitch.passed=false,r=>r.cliWorkspaceLifecycle.archived=false,r=>r.communication.receiverResponded=false,r=>r.communication.edges.pop(),r=>r.communication.edges[0].actualSenderProvider=false,r=>r.communication.edges[1].receiverResponded=false,r=>r.communication.edges[2]={...r.communication.edges[0]},r=>r.communication.edges[0].receiverProvider='codex',r=>r.communication.edges[1].agentId=r.communication.edges[0].agentId,r=>r.communication.edges[1].receiverId='',r=>delete r.communication.edges]) { const r=structuredClone(report);mutate(r);assert.equal(runPassed(r),false); }
});
function webFixture() {
 const agent={provider:'codex',status:'idle',model:'new',runtimeInfo:{model:'new'}};
 const job={provider:'codex',agentId:'owned',targetModel:'new',beforeModel:{runtime:'old'},beforeToolIds:['old-call'],memoryKey:'local',expectedMemory:'nonce',replyMarker:'WEB_UI_OK_new',skillName:'acceptance-test',expectedSkill:'skill-marker',sharedMemorySkillName:'shared-host-memory',expectedSharedMemorySkill:'Memory belongs to this host.',fixtureMcpName:'acceptance_test',expectedMcp:'mcp-marker',writeKey:'web-owned',expectedWrite:'web-nonce'};
 const calls=[proxy('pi_shared_memory_read',{key:'local'},{memory:{key:'local',content:'nonce'}}),event('read',{path:'/skills/acceptance-test/SKILL.md'},'skill-marker'),event('read',{path:'/skills/shared-host-memory/SKILL.md'},'Memory belongs to this host.'),proxy('acceptance_test_read_marker',{},'mcp-marker'),proxy('pi_shared_memory_read',{key:'web-owned'},{memory:null}),proxy('pi_shared_memory_write',{key:'web-owned',content:'web-nonce',expectedRevision:null},{memory:{key:'web-owned',content:'web-nonce',revision:'revision'}})];
 const items=[...calls.map((x,i)=>({...x,callId:'new-call-'+i})),{type:'assistant_message',text:'WEB_UI_OK_new'}];
 return {agent,job,items,stored:{key:'web-owned',content:'web-nonce',revision:'revision'}};
}
test('Web verifier needs fresh resource tools, persisted CAS write and actual changed runtime model',async()=>{
 const {webTurnChecks}=await import('./acceptance-evidence.mjs'); const {agent,job,items,stored}=webFixture();
 assert.equal(Object.values(webTurnChecks(agent,job,items,stored)).every(Boolean),true);
 assert.equal(webTurnChecks({...agent,runtimeInfo:{model:'old'}},job,items,stored).actualModel,false);
 assert.equal(webTurnChecks({...agent,status:'running'},job,items,stored).completed,false);
 assert.equal(webTurnChecks(agent,{...job,beforeModel:{runtime:'new'}},items,stored).modelChanged,false);
 for(const [index,check] of [[0,'freshMemoryRead'],[1,'freshSkillRead'],[2,'freshSharedMemorySkillRead'],[3,'freshGlobalMcpCall'],[4,'freshMemoryWriteRead'],[5,'freshMemoryWrite']]) {
  const stale=structuredClone(items);stale[index].callId='old-call';assert.equal(webTurnChecks(agent,job,stale,stored)[check],false,check+' cannot reuse earlier provider events');
  const failed=structuredClone(items);failed[index].error='failed';assert.equal(webTurnChecks(agent,job,failed,stored)[check],false,check+' needs completed success');
 }
 assert.equal(Object.values(webTurnChecks(agent,job,[items.at(-1)],stored)).every(Boolean),false);
});
test('Web freshness and CAS checks apply to Claude dispatcher and shared Skill events',async()=>{
 const {webTurnChecks}=await import('./acceptance-evidence.mjs');
 const {agent,job,items,stored}=webFixture();agent.provider=job.provider='claude';
 for(const index of [0,3,4,5]) {
  const call=items[index],args=call.detail.input,server=index===3?'acceptance_test':'pi_shared_memory';
  call.name='mcp__pi_shared_runtime__pi_global_mcp__'+server;
  call.detail.output={output:JSON.parse(call.detail.output.content[0].text)};
  if(index===4)args.tool='read';
 }
 for(const index of [1,2]){items[index].name='mcp__pi_shared_runtime__Skill';items[index].detail.input={skill:index===1?job.skillName:job.sharedMemorySkillName};}
 assert.equal(Object.values(webTurnChecks(agent,job,items,stored)).every(Boolean),true);
 for(const mutate of [x=>x[5].name='mcp__pi_shared_runtime__pi_global_mcp__other',x=>x[5].detail.input.args.expectedRevision='stale',x=>x[4].callId='old-call',x=>x[1].callId='old-call',x=>x[1].detail.output='missing-marker']) {
  const changed=structuredClone(items);mutate(changed);assert.equal(Object.values(webTurnChecks(agent,job,changed,stored)).every(Boolean),false);
 }
});
test('Web resource claims cannot substitute wrong routes, files, values, CAS or persisted memory',async()=>{
 const {webTurnChecks}=await import('./acceptance-evidence.mjs'); const {agent,job,items,stored}=webFixture();
 for(const mutate of [x=>x[1].detail.input.path='/manifest.json',x=>x[1].detail.output='wrong-skill',x=>x[2].detail.input.path='/skills/unrelated/SKILL.md',x=>x[3].detail.input.tool='other_read_marker',x=>x[3].detail.output='wrong-mcp',x=>x[5].detail.input.args.expectedRevision='old-revision',x=>x[5].detail.input.args.key='other',x=>x[5].detail.output={memory:{key:'web-owned',content:'web-nonce',revision:'different'}},x=>x[5].callId=undefined,x=>{[x[4],x[5]]=[x[5],x[4]];}]) {
  const changed=structuredClone(items);mutate(changed);assert.equal(Object.values(webTurnChecks(agent,job,changed,stored)).every(Boolean),false);
 }
 for(const storedValue of [null,{...stored,content:'other'},{...stored,key:'other'},{...stored,revision:'other'}])assert.equal(Object.values(webTurnChecks(agent,job,items,storedValue)).every(Boolean),false);
 for(const missing of ['expectedMemory','expectedSkill','expectedSharedMemorySkill','expectedMcp','expectedWrite'])assert.equal(Object.values(webTurnChecks(agent,{...job,[missing]:undefined},items,stored)).every(Boolean),false);
});
test('verified public Web writes append once and refuse conflicting existing ownership',async()=>{
 const {appendVerifiedWebWrite}=await import('./acceptance-evidence.mjs');
 const manifest={writes:[]},record={key:'owned',marker:'nonce',provider:'codex',agentId:'id',phase:'woowtech',source:'public-web',revision:'r',writtenAt:'first'};
 assert.equal(appendVerifiedWebWrite(manifest,record),true);assert.equal(appendVerifiedWebWrite(manifest,{...record,writtenAt:'second'}),false);assert.equal(manifest.writes.length,1);assert.equal(manifest.writes[0].writtenAt,'first');
 for(const field of ['marker','provider','agentId','phase','source','revision'])assert.throws(()=>appendVerifiedWebWrite(manifest,{...record,[field]:'conflict'}),/conflict/);
 assert.equal(manifest.writes[0].marker,'nonce');
});

test('zero-argument fixture dispatcher accepts omitted args only through the explicit fixture opt-in',()=>{
 const call=event('mcp__pi_shared_runtime__pi_global_mcp',{tool:'acceptance_test_read_marker',server:'acceptance_test'},{output:'fixture-marker'});
 assert.equal(invokes(call,'acceptance_test','read_marker'),false);
 assert.equal(fixtureMcpResult([call],'acceptance_test','fixture-marker'),true);
 for(const tool of ['read_marker','acceptance_test_read_marker']){
  const perServer=event('mcp__pi_shared_runtime__pi_global_mcp__acceptance_test',{tool},{output:'fixture-marker'});
  assert.equal(invokes(perServer,'acceptance_test','read_marker'),false);
  assert.equal(fixtureMcpResult([perServer],'acceptance_test','fixture-marker'),true);
 }
});
test('fixture dispatcher rejects non-object args including decoded malformed values',()=>{
 for(const name of ['mcp__pi_shared_runtime__pi_global_mcp','mcp__pi_shared_runtime__pi_global_mcp__acceptance_test']){
  for(const args of [null,[],undefined,false,0,'null','[]','false','0','"scalar"','"{}"','scalar','{',' ']){
   const call=event(name,{tool:'acceptance_test_read_marker',server:'acceptance_test',args},{output:'fixture-marker'});
   assert.equal(fixtureMcpResult([call],'acceptance_test','fixture-marker'),false);
  }
 }
});
test('fixture dispatcher accepts the adapter object or JSON-encoded object union',()=>{
 for(const name of ['mcp__pi_shared_runtime__pi_global_mcp','mcp__pi_shared_runtime__pi_global_mcp__acceptance_test']){
  for(const args of [{},'{}',' {"unused":true} ']){
   const call=event(name,{tool:'acceptance_test_read_marker',server:'acceptance_test',args},{output:'fixture-marker'});
   assert.equal(fixtureMcpResult([call],'acceptance_test','fixture-marker'),true);
   for(const mutate of [c=>c.detail.input.server='other',c=>c.detail.input.tool='other_read_marker',c=>c.status='running',c=>c.error='failed',c=>c.detail.output={output:'wrong-marker'},c=>c.detail.output={isError:true,output:'fixture-marker'}]){
    const changed=structuredClone(call);mutate(changed);assert.equal(fixtureMcpResult([changed],'acceptance_test','fixture-marker'),false);
   }
  }
 }
});
test('adapter empty string means omitted args only for the zero-argument fixture opt-in',()=>{
 for(const name of ['mcp__pi_shared_runtime__pi_global_mcp','mcp__pi_shared_runtime__pi_global_mcp__acceptance_test']){
  const call=event(name,{tool:'acceptance_test_read_marker',server:'acceptance_test',args:''},{output:'fixture-marker'});
  assert.equal(fixtureMcpResult([call],'acceptance_test','fixture-marker'),true);
  assert.equal(invokes(call,'acceptance_test','read_marker'),false);
  assert.equal(invokes(call,'acceptance_test','read_marker',{required:'value'},{allowOmittedArgs:true}),false);
  call.detail.input.args=undefined;
  assert.equal(fixtureMcpResult([call],'acceptance_test','fixture-marker'),false);
 }
});
test('zero-argument fixture still requires exact dispatcher server/tool and genuine completed output',()=>{
 const valid=event('mcp__pi_shared_runtime__pi_global_mcp',{tool:'acceptance_test_read_marker',server:'acceptance_test'},{output:'fixture-marker'});
 for(const mutate of [c=>c.detail.input.server='other',c=>c.detail.input.tool='other_read_marker',c=>c.name='mcp__pi_shared_runtime__pi_global_mcp__other',c=>c.status='running',c=>c.status='failed',c=>c.error='error',c=>c.detail.output={output:'wrong-marker'},c=>c.detail.output={isError:true,output:'fixture-marker'},c=>c.detail.output={output:{isError:true,content:'fixture-marker'}}]){
  const call=structuredClone(valid);mutate(call);assert.equal(fixtureMcpResult([call],'acceptance_test','fixture-marker'),false);
 }
 const explicitWrong=structuredClone(valid);explicitWrong.detail.input.server='other';explicitWrong.detail.input.args={};
 assert.equal(fixtureMcpResult([explicitWrong],'acceptance_test','fixture-marker'),false);
 const explicit=structuredClone(valid);explicit.detail.input.args={};assert.equal(fixtureMcpResult([explicit],'acceptance_test','fixture-marker'),true);
});
test('parameterized memory tools cannot use omitted args even when omission is requested',()=>{
 for(const name of ['mcp__pi_shared_runtime__pi_global_mcp','mcp__pi_shared_runtime__pi_global_mcp__pi_shared_memory']){
  const read=event(name,{tool:'pi_shared_memory_read',server:'pi_shared_memory'},{output:{memory:null}});
  assert.equal(memoryResult([read],'owned-key',null),false);
  assert.equal(invokes(read,'pi_shared_memory','read',{key:'owned-key'},{allowOmittedArgs:true}),false);
  for(const args of ['', '{}', undefined, 'null', '[]', 'false', '0', 'invalid']){
   read.detail.input.args=args;
   assert.equal(memoryResult([read],'owned-key',null),false);
   assert.equal(invokes(read,'pi_shared_memory','read',{key:'owned-key'},{allowOmittedArgs:true}),false);
  }
  read.detail.input.args='{"key":"owned-key"}';
  assert.equal(memoryResult([read],'owned-key',null),true);
  const write=event(name,{tool:'pi_shared_memory_write',server:'pi_shared_memory'},{output:{memory:{key:'owned-key',content:'nonce',revision:'r'}}});
  assert.equal(memoryWrite([write],'owned-key','nonce'),false);
 }
});
