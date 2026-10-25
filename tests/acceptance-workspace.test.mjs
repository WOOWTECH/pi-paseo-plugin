import test from 'node:test';import assert from 'node:assert/strict';
import {acceptanceWorkspace} from '../src/acceptance-workspace.mjs';
test('repeated checks reuse the same directory without adding or touching workspaces',async()=>{
 let created=0;const c={fetchWorkspaces:async()=>({entries:[{id:'existing',workspaceDirectory:'/work/check',archivingAt:null}],pageInfo:{hasMore:false}}),createWorkspace:async()=>{created++;}};
 for(let i=0;i<3;i++)assert.equal(await acceptanceWorkspace(c,'/work/check'),'existing');assert.equal(created,0);
});
test('searches later pages and excludes archiving or unrelated directories',async()=>{
 let calls=0;const c={fetchWorkspaces:async({page})=>{calls++;return page.cursor?{entries:[{id:'match',workspaceDirectory:'/work/check'}],pageInfo:{hasMore:false}}:{entries:[{id:'archiving',workspaceDirectory:'/work/check',archivingAt:'now'},{id:'unrelated',workspaceDirectory:'/work/check-2'}],pageInfo:{hasMore:true,nextCursor:'page2'}};}};
 assert.equal(await acceptanceWorkspace(c,'/work/check'),'match');assert.equal(calls,2);
});
test('creates only after a complete empty search',async()=>{
 const c={fetchWorkspaces:async()=>({entries:[],pageInfo:{hasMore:false}}),createWorkspace:async input=>{assert.deepEqual(input,{source:{kind:'directory',path:'/work/check'}});return {workspace:{id:'created'}};}};
 assert.equal(await acceptanceWorkspace(c,'/work/check'),'created');
});
test('listing errors and invalid pagination cannot create duplicates',async()=>{
 let created=0;const c={fetchWorkspaces:async()=>({entries:[],pageInfo:{hasMore:true,nextCursor:'same'}}),createWorkspace:async()=>{created++;}};
 await assert.rejects(acceptanceWorkspace(c,'/work/check'),{code:'WORKSPACE_LIST_FAILED'});assert.equal(created,0);
 c.fetchWorkspaces=async()=>{throw Error('offline');};await assert.rejects(acceptanceWorkspace(c,'/work/check'),/offline/);assert.equal(created,0);
});
