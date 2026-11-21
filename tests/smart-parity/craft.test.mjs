import assert from 'node:assert/strict';
import test from 'node:test';
import { assertWalkthrough } from './craft.mjs';

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
