import test from 'node:test';
import assert from 'node:assert/strict';
import {memoryResult,memoryWrite,fixtureMcpResult,skillRead,sendAgentPrompt,assistantReplied,workspaceRows,agentRows,runPassed} from './acceptance-evidence.mjs';
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
