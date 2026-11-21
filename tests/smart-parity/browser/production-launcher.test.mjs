import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { ParentChannel } from './parent-channel.mjs';
import { productionSessionState, openProductionSession } from './production-parent.mjs';
import { runPair } from './pair.mjs';
import { runCoordination } from './coordination.mjs';
import { runConversations } from './conversations.mjs';

const envelope={protocol:'agent-connect-browser-guard/v1',method:'finish',requestSha256:'a'.repeat(64),attemptId:'owned',outcome:'returned',result:{}};
function parent(t,body) {
 const child=spawn('python3',['-u','-c','import json,sys,time\n'+body],{stdio:['pipe','pipe','pipe']});
 const channel=new ParentChannel(child);t.after(()=>channel.close());return channel;
}
test('dedicated default CLI is local read-only and shared flows are importable',()=>{
 const value=JSON.parse(execFileSync(process.execPath,[new URL('./production.mjs',import.meta.url).pathname,'check'],{encoding:'utf8'}));
 assert.equal(value.productionMutations,false);assert.equal(value.perMutationGuard,true);assert.equal(value.maxSessionSeconds,1800);
 for(const fn of [runPair,runCoordination,runConversations])assert.equal(typeof fn,'function');
});
test('caller boolean/fake guard cannot mint a managed parent session',async()=>{
 assert.throws(()=>productionSessionState({approved:true,guard:{run(){}}}),/actual managed/);
 await assert.rejects(openProductionSession({action:'exec',brand:'apporo'}),/explicit action/);
 await assert.rejects(openProductionSession({action:'pair',brand:'apporo',seconds:1801}),/bounded/);
});
test('actual Python stdio fragments coalesce and matching reply returns once',async t=>{
 const c=parent(t,"v=json.loads(sys.stdin.readline());s=json.dumps(v);sys.stdout.write(s[:10]);sys.stdout.flush();time.sleep(.02);print(s[10:],flush=True);sys.stdin.read()\n");
 assert.deepEqual(await c.exchange(envelope),envelope);assert.equal((await c.close()).code,0);
});
test('actual Python wrong request hash poisons channel with no retry',async t=>{
 const c=parent(t,"v=json.loads(sys.stdin.readline());v['requestSha256']='foreign';print(json.dumps(v),flush=True);sys.stdin.read()\n");
 await assert.rejects(c.exchange(envelope),/binding differs/);await assert.rejects(c.exchange(envelope),/binding differs/);
});
test('actual EOF after a request is uncertain and cannot be retried',async t=>{
 const c=parent(t,"sys.stdin.readline()\n");
 await assert.rejects(c.exchange(envelope),/exited/);await assert.rejects(c.exchange(envelope),/exited/);
});
test('actual invalid/oversized parent frames fail closed',async t=>{
 for(const body of ["sys.stdin.readline();print('bad JSON',flush=True);sys.stdin.read()\n","sys.stdin.readline();print('x'*100001,flush=True);sys.stdin.read()\n"]){
  const c=parent(t,body);await assert.rejects(c.exchange(envelope));assert.throws(()=>c.assertAlive());await c.close();
 }
});
test('concurrent operation is rejected while first actual reply is pending',async t=>{
 const c=parent(t,"v=json.loads(sys.stdin.readline());time.sleep(.1);print(json.dumps(v),flush=True);sys.stdin.read()\n");
 const first=c.exchange(envelope);await assert.rejects(c.exchange(envelope),/Concurrent/);assert.deepEqual(await first,envelope);
});
test('timeout and caller cancellation leave channel permanently unavailable',async t=>{
 for(const cancel of [false,true]){
  const c=parent(t,"sys.stdin.readline();sys.stdin.read()\n"),abort=new AbortController();
  const result=c.exchange(envelope,{signal:abort.signal,timeoutMs:30});if(cancel)abort.abort();
  await assert.rejects(result,/timeout|aborted/);await assert.rejects(c.exchange(envelope));await c.close();
 }
});
