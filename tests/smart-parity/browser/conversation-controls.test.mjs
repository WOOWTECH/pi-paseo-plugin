import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationSelectors, bindConversationControls } from './conversation-controls.mjs';

test('Craft selectors bind controls to the exact selected agent and pane using native CSS', () => {
 const selectors=conversationSelectors('workspace-pane-main','agent-123');
 for(const key of ['model','composer','send']) {
  assert.match(selectors[key], /workspace-pane-main/);
  assert.match(selectors[key], /workspace-tab-agent_agent-123/);
  assert.match(selectors[key], /aria-selected="true"/);
  assert.match(selectors[key], /message-input-root/);
  assert.doesNotMatch(selectors[key], /:visible|:first|nth/);
 }
});
for(const [pane,agent] of [['other','id'],['workspace-pane-main','id"]'],['workspace-pane-','id'],[null,'id']])
 test(`reject invalid selector identity ${pane}/${agent}`,()=>assert.throws(()=>conversationSelectors(pane,agent)));
function page({selected=true,counts={},visible=true,enabled=true,label='Model A'}={}) {
 const selectors=conversationSelectors('workspace-pane-main','agent-123');
 return {
  getByTestId:id=>({isVisible:async()=>true,getAttribute:async()=>selected?'true':'false',evaluate:async()=>'workspace-pane-main'}),
  locator:selector=>({count:async()=>counts[Object.keys(selectors).find(k=>selectors[k]===selector)]??1,
   isVisible:async()=>visible,isEnabled:async()=>enabled,innerText:async()=>label})
 };
}
test('accepts hydrated unambiguous controls in the selected pane', async()=>{
 const result=await bindConversationControls(page(),'agent-123',1);
 assert.deepEqual(result.selectors,conversationSelectors('workspace-pane-main','agent-123'));
});
for(const [name,options] of [['wrong agent',{selected:false}],['duplicate panes',{counts:{pane:2}}],
 ['duplicate composer roots',{counts:{root:2}}],['duplicate models',{counts:{model:2}}],
 ['duplicate textareas',{counts:{composer:2}}],['hidden controls',{visible:false}],
 ['disabled model',{enabled:false}],['not hydrated',{label:'Select model'}]])
 test('rejects '+name+' before recording',async()=>assert.rejects(bindConversationControls(page(options),'agent-123',1)));
