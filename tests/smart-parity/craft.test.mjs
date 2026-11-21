import assert from 'node:assert/strict';
import test from 'node:test';
import { assertWalkthrough, Craft } from './craft.mjs';

const complete = () => ({
  id: 'test', operation: 'web_walkthrough_record', coverage: { status: 'complete' },
  result: { aborted: null, action_count: 2, steps: [{ step_id: 'open', status: 'ok' }, { step_id: 'submit', status: 'ok' }] },
});
test('accepts a complete successful walkthrough', () => {
  assert.equal(assertWalkthrough(complete(), ['open', 'submit']).steps, 2);
});
for (const [name, mutate] of [
  ['aborted run despite successful steps', e => { e.result.aborted = 'timeout'; }],
  ['failed click despite CLI exit zero', e => { e.result.steps[1].status = 'error'; }],
  ['missing action', e => { e.result.steps.pop(); }],
  ['wrong action order', e => { e.result.steps.reverse(); }],
  ['truncated evidence', e => { e.coverage.status = 'partial'; }],
  ['unrelated evidence', e => { e.operation = 'web_page_show'; }],
]) {
  test(`rejects ${name}`, () => {
    const evidence = complete(); mutate(evidence);
    assert.throws(() => assertWalkthrough(evidence, ['open', 'submit']));
  });
}


test('comparison sends exact retained IDs without reserializing browser evidence', async () => {
  const before={id:'ev_'+'a'.repeat(64)},after={id:'ev_'+'b'.repeat(64)};
  let called=false;
  const value=await Craft.prototype.compare.call({call:async(tool,params)=>{
    called=true;assert.equal(tool,'web-snapshots-compare');
    assert.deepEqual(params.before,{kind:'saved',evidence_id:before.id});
    assert.deepEqual(params.after,{kind:'saved',evidence_id:after.id});
    return {id:'comparison',result:{comparable:true}};
  }},before,after,'pair');
  assert.equal(called,true);assert.equal(value.id,'comparison');
});
test('missing descriptors fail before invoking Craft instead of omitting evidence_id',async()=>{
 const call=async()=>assert.fail('invalid input reached CLI');
 for(const before of [undefined,null,{},'ev_'+'a'.repeat(64),{id:'wrong'}])
  await assert.rejects(Craft.prototype.compare.call({call},before,{id:'ev_'+'b'.repeat(64)},'bad'),/exact IDs/);
});
