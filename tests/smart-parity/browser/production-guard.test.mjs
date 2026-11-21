import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { productionFixture } from './production-fixture.mjs';
import { validateProductionManifest } from '../production-scope.mjs';
import { createProductionGuard, guardProtocol, isServerMutation, sha256 } from './production-guard.mjs';
import { assertCraftOperation, assertBoundControlSelector, guardedRecordCall } from './guarded-craft.mjs';
import { conversationSelectors } from './conversation-controls.mjs';
import { browserActions, configuration, launch } from './common.mjs';

// Synthetic transport only. None of these receipts represent authenticated CI
// or a deployed production host, and a caller-created guard cannot open the production launcher.
function harness(t, options = {}) {
  const f = productionFixture(t), context = validateProductionManifest(f.browser, f.options);
  const host = f.browser.hosts[0], original = f.transport.hosts[host.release];
  let clock = original.baseline.observedAt + 2;
  let active = 'owned-agent', currentUrl = 'https://smart.apporo.ai/h/pi3-server/workspace/owned-workspace';
  let prompt = 'Reply WEB_UI_OK_guard';
  const page = { url: () => currentUrl,
    getByTestId: id => ({ isVisible: async () => id === 'workspace-tab-agent_' + active,
      getAttribute: async () => 'true', evaluate: async () => 'workspace-pane-main', getByRole: () => ({ getAttribute: async () => 'false' }) }),
    getByText: () => ({ isVisible: async () => true }),
    locator: () => ({ count: async () => 1, inputValue: async () => prompt, evaluate: async () => ' > div:nth-child(2)',
      isVisible: async () => true, isEnabled: async () => true, innerText: async () => 'Model A' }) };
  const operation = { kind: 'conversation.send', hostLabel: host.label, provider: 'pi', agentId: active,
    workspaceId: 'owned-workspace', prompt };
  const group = { scope: f.browser.scope, runId: f.browser.runId, sourceManifestSha256: context.manifestSha256,
    runtimeIdentity: host.runtimeIdentity, hostLabel: host.label, phase: 'apporo', workspaceId: operation.workspaceId,
    jobs: [{ agentId: active, provider: 'pi', prompt, targetModel: 'model-2', alternateModel: 'model-1' }] };
  const calls = [], writes = [];
  let dispatch, requestHash;
  const exchange = async (envelope, { signal }) => {
    calls.push(envelope);
    assert.equal(envelope.protocol, guardProtocol);
    if (options.exchange) return options.exchange(envelope, { signal });
    if (envelope.method === 'begin') {
      dispatch = JSON.parse(envelope.requestJson); requestHash = envelope.requestSha256;
      assert.equal(requestHash, sha256(envelope.requestJson));
      const binding = Object.fromEntries(['scope', 'runId', 'sourceManifestSha256', 'release', 'phase', 'runtimeIdentity', 'dataIdentity', 'serverId'].map(k => [k, dispatch[k]]));
      const current = structuredClone(original.baseline);
      current.activity.startedAt = clock - 1; current.activity.observedAt = clock; current.observedAt = clock;
      const canonical = { ...structuredClone(original.canonical), verifiedAt: clock };
      const journal = { ...binding, identity: dispatch.identity, tunnel: dispatch.tunnel,
        attemptId: dispatch.attemptId, requestSha256: requestHash, status: 'dispatching_do_not_retry' };
      const checkpoint = { ...group, ...binding };
      const ownership = { ...binding, agents: [{ id: operation.agentId, provider: 'pi', workspaceId: operation.workspaceId, discoveredModels: ['model-1', 'model-2'] }],
        workspaces: [{ id: operation.workspaceId }] };
      const reply = { protocol: guardProtocol, method: 'begin', requestSha256: requestHash, attemptId: dispatch.attemptId,
        status: 'dispatching_do_not_retry', checkedAt: clock, expiresAt: clock + 20 };
      options.mutate?.({ current, canonical, journal, ownership, checkpoint, reply, request: dispatch, setActive: value => { active = value; } });
      ownership.checkpoint = f.put('guard/checkpoint.json', checkpoint);
      for (const [name, value] of Object.entries({ current, canonical, journal, ownership })) reply[name] = f.put('guard/' + name + '.json', value);
      options.reply?.(reply);
      return reply;
    }
    if (options.finish) return options.finish(envelope);
    const journal = { ...dispatch, requestSha256: requestHash, status: envelope.outcome };
    options.finishMutate?.(journal);
    return { protocol: guardProtocol, method: 'finish', requestSha256: requestHash, attemptId: dispatch.attemptId,
      status: envelope.outcome, journal: f.put('guard/finished.json', journal) };
  };
  const guard = createProductionGuard({ context, phase: 'apporo', exchange, jobs: [group], now: () => clock, timeoutMs: options.timeoutMs || 100 });
  return { f, context, host, page, operation, guard, calls, group,
    setUrl: value => { currentUrl = value; }, setPrompt: value => { prompt = value; },
    setActive: value => { active = value; },
    advance: seconds => { clock += seconds; },
    run: (op = operation, execute = async () => { writes.push(op.kind); return { id: 'ev_actual_call' }; }) => guard.run({ page, operation: op, execute }), writes };
}

test('actual send obtains fresh bound intent and result once, including exact request bytes', async t => {
  const h = harness(t); const result = await h.run();
  assert.equal(result.id, 'ev_actual_call'); assert.deepEqual(h.writes, ['conversation.send']);
  assert.deepEqual(h.calls.map(c => c.method), ['begin', 'finish']);
  assert.equal(h.calls[1].outcome, 'returned');
});
test('model commit binds discovered model to immutable checkpoint', async t => {
  const h = harness(t), { prompt, ...operation } = h.operation;
  await h.run({ ...operation, kind: 'conversation.model-set', model: 'model-2' });
  assert.equal(h.calls.length, 2);
});
test('successful send cannot be replayed with a freshly generated nonce', async t => {
  const h = harness(t); await h.run();
  await assert.rejects(h.run(), /replayed/);
  assert.equal(h.calls.length, 2); assert.equal(h.writes.length, 1);
});
test('exact canonical proof may be reused by the live authority session while current activity is fresh', async t => {
  const h = harness(t, { mutate: ({ canonical }) => { canonical.verifiedAt -= 120; } });
  await h.run(); assert.equal(h.writes.length, 1);
});
test('model absent from fresh discovered ownership cannot be committed', async t => {
  const h = harness(t, { mutate: ({ ownership }) => { ownership.agents[0].discoveredModels = ['model-1']; } });
  const { prompt, ...operation } = h.operation;
  await assert.rejects(h.run({ ...operation, kind: 'conversation.model-set', model: 'model-2' }), /discovered checkpoint/);
  assert.equal(h.writes.length, 0);
});

const corruptions = {
  'static approval boolean': ({ reply }) => { reply.status = 'approved'; reply.authorized = true; },
  'wrong nonce': ({ reply }) => { reply.attemptId = 'different'; },
  'wrong request bytes': ({ reply }) => { reply.requestSha256 = 'e'.repeat(64); },
  'expired observation': ({ reply }) => { reply.expiresAt = reply.checkedAt - 1; },
  'overlong dispatch window': ({ reply }) => { reply.expiresAt += 100; },
  'future observation': ({ current }) => { current.observedAt += 1; },
  'old activity disguised by fresh timestamp': ({ current }) => { current.activity.startedAt -= 60; },
  'changed pod': ({ current }) => { current.identity.podUid = 'replacement'; },
  'changed PVC': ({ current }) => { current.identity.pvcUid = 'replacement'; },
  'changed mount': ({ current }) => { current.activity.mount.source = '/dev/wrong'; },
  'changed runtime': ({ current }) => { current.runtimeIdentity += 'wrong'; },
  'wrong server': ({ current }) => { current.activity.snapshot.serverId = 'other-host'; },
  'incomplete snapshot': ({ current }) => { current.activity.snapshot.complete = false; },
  'wrong selected brand': ({ current }) => { current.activity.connector.selectedTarget = 'paseo'; },
  'wrong active brand': ({ current }) => { current.activity.connector.activeTarget = 'woowtech'; },
  'pending brand': ({ current }) => { current.activity.connector.configurationPending = true; },
  'changed canonical source': ({ canonical }) => { canonical.source = 'f'.repeat(40); },
  'future canonical proof': ({ canonical }) => { canonical.verifiedAt += 60; },
  'journal wrong operation': ({ journal }) => { journal.requestSha256 = 'e'.repeat(64); },
  'journal unowned tunnel': ({ journal }) => { journal.tunnel = { ...journal.tunnel, pid: 333 }; },
  'foreign agent': ({ ownership }) => { ownership.agents[0].id = 'user-agent'; },
  'foreign workspace': ({ ownership }) => { ownership.workspaces[0].id = 'user-workspace'; },
  'wrong provider': ({ ownership }) => { ownership.agents[0].provider = 'claude'; },
  'wrong ownership phase': ({ ownership }) => { ownership.phase = 'paseo'; },
  'stale ownership manifest': ({ ownership }) => { ownership.sourceManifestSha256 = 'e'.repeat(64); },
  'changed checkpoint prompt': ({ checkpoint }) => { checkpoint.jobs[0].prompt = 'not this job'; },
  'different active tab after guard': ({ setActive }) => { setActive('user-agent'); },
};
for (const [name, mutate] of Object.entries(corruptions)) test('rejects ' + name + ' without a server write', async t => {
  const h = harness(t, { mutate });
  await assert.rejects(h.run()); assert.equal(h.writes.length, 0);
  assert.equal(h.calls.at(-1).outcome, 'not-dispatched');
  const before = h.calls.length;
  await assert.rejects(h.run(), /no retry/); assert.equal(h.calls.length, before);
});
test('hash mismatch in actual proof bytes is rejected', async t => {
  const h = harness(t, { reply: reply => { reply.current.sha256 = 'a'.repeat(64); } });
  await assert.rejects(h.run(), /checksum/); assert.equal(h.writes.length, 0);
});
test('user or archived baseline agent cannot become owned through a self-labelled receipt', async t => {
  const h = harness(t, { mutate: ({ current, ownership, checkpoint, request }) => {
    ownership.agents[0].id = request.operation.agentId;
    checkpoint.jobs[0].agentId = request.operation.agentId;
  } });
  h.setActive('pi3-archived-user');
  await assert.rejects(h.run({ ...h.operation, agentId: 'pi3-archived-user' }), /baseline user agent/);
  assert.equal(h.writes.length, 0);
});
test('wrong route and draft fail before contacting transport', async t => {
  const h = harness(t); h.setUrl('https://smart.apporo.ai/h/other-server/workspace/owned-workspace');
  await assert.rejects(h.run(), /route/); assert.equal(h.calls.length, 0);
  h.setUrl('https://smart.apporo.ai/h/pi3-server/workspace/owned-workspace'); h.setPrompt('user draft');
  await assert.rejects(h.run(), /draft/); assert.equal(h.calls.length, 0);
});
test('deadline expiring during the final DOM check prevents dispatch', async t => {
  const h = harness(t); const get = h.page.getByTestId;
  let advanced = false;
  h.page.getByTestId = id => ({ ...get(id), getAttribute: async () => {
    if (!advanced && h.calls.some(c => c.method === 'begin')) { advanced = true; h.advance(25); }
    return 'true';
  } });
  await assert.rejects(h.run(), /expired during DOM/); assert.equal(h.writes.length, 0);
  assert.equal(h.calls.at(-1).outcome, 'not-dispatched');
});
test('lost actual send result leaves uncertain intent and blocks automatic retry', async t => {
  const h = harness(t);
  await assert.rejects(h.run(h.operation, async () => { throw Error('connection lost after send'); }), /connection lost/);
  assert.equal(h.calls.at(-1).outcome, 'uncertain');
  await assert.rejects(h.run(), /no retry/);
  assert.equal(h.calls.filter(c => c.method === 'begin').length, 1);
});
test('missing finish acknowledgement cannot turn a mutation into successful evidence', async t => {
  const h = harness(t, { finish: () => ({ status: 'passed', authorized: true }) });
  await assert.rejects(h.run(), /completion/); assert.equal(h.writes.length, 1);
  await assert.rejects(h.run(), /no retry/);
});
test('completion with a different Pod epoch remains uncertain despite matching request hash', async t => {
  const h = harness(t, { finishMutate: journal => { journal.identity = { ...journal.identity, podUid: 'replacement' }; } });
  await assert.rejects(h.run(), /completion epoch/);
  assert.equal(h.calls.at(-1).outcome, 'uncertain');
  await assert.rejects(h.run(), /no retry/);
});
test('transport timeout aborts, does not dispatch, and never retries with a new nonce', async t => {
  const h = harness(t, { timeoutMs: 5, exchange: () => new Promise(() => {}) });
  await assert.rejects(h.run(), /timeout/); assert.equal(h.writes.length, 0);
  await assert.rejects(h.run(), /no retry/);
  assert.equal(h.calls.filter(c => c.method === 'begin').length, 1);
});
test('concurrent dispatch is rejected while the first action is unresolved', async t => {
  const h = harness(t);
  let entered, release;
  const began = new Promise(resolve => { entered = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  const first = h.run(h.operation, async () => { entered(); await waiting; return { id: 'ev_first' }; });
  await began;
  await assert.rejects(h.run(), /concurrent/); release(); await first;
  assert.equal(h.calls.filter(c => c.method === 'begin').length, 1);
});

test('navigation/reload/menu/focus/fill/local selection create no guard RPC or mutation journal', async t => {
  const h = harness(t, { exchange: () => { throw Error('local UI must not request authority'); } });
  const { prompt, ...base } = h.operation;
  for (const kind of ['conversation.model-open', 'conversation.provider-select', 'conversation.reload']) await h.run({ ...base, kind });
  await h.run({ ...h.operation, kind: 'conversation.prompt-fill' });
  await h.run({ ...base, kind: 'conversation.navigate', url: 'https://smart.apporo.ai/h/pi3-server/workspace/owned-workspace?open=agent%3Aowned-agent' });
  h.setUrl('http://127.0.0.1:31001/omnigent');
  for (const kind of ['connector.open', 'connector.select-target']) await h.run({ kind, hostLabel: 'pi3' });
  h.setUrl('https://smart.apporo.ai/');
  for (const kind of ['pair.focus', 'pair.skip-setup']) await h.run({ kind, hostLabel: 'pi3' });
  assert.equal(h.calls.length, 0);
  assert.equal(fs.existsSync(path.join(h.f.root, 'guard')), false);
});
test('local fill still rejects a foreign agent, job prompt or workspace without obtaining a grant', async t => {
  const h = harness(t);
  for (const delta of [{ agentId: 'user-agent' }, { workspaceId: 'user-workspace' }, { prompt: 'not the job' }]) {
    await assert.rejects(h.run({ ...h.operation, kind: 'conversation.prompt-fill', ...delta }), /local/);
  }
  assert.equal(h.calls.length, 0);
});
test('local inspection remains available after uncertain write without consuming another grant', async t => {
  const h = harness(t);
  await assert.rejects(h.run(h.operation, async () => { throw Error('uncertain'); }));
  const { prompt, ...base } = h.operation;
  const calls = h.calls.length;
  await h.run({ ...base, kind: 'conversation.reload' });
  assert.equal(h.calls.length, calls);
});
test('exact eight operations classify as actual server mutations', () => {
  for (const kind of ['connector.save-target', 'connector.stop', 'connector.start', 'connector.pair', 'pair.accept', 'coordination.enable', 'conversation.model-set', 'conversation.send']) assert.equal(isServerMutation({ kind }), true);
  for (const kind of ['connector.open', 'connector.select-target', 'pair.navigate', 'pair.focus', 'pair.skip-setup', 'hosts.open-picker', 'conversation.navigate', 'conversation.reload', 'conversation.model-open', 'conversation.provider-select', 'conversation.prompt-fill']) assert.equal(isServerMutation({ kind }), false);
});

const sendAction = { step_id: 'send', kind: 'click', selector: conversationSelectors('workspace-pane-main','owned-agent',' > div:nth-child(2)').send };
test('Craft rejects missing intent, different selector, hidden extra mutation and wait-before-send', () => {
  const operation = { kind: 'conversation.send', agentId: 'owned-agent' };
  assert.throws(() => assertCraftOperation([sendAction], null, 'apporo'));
  assert.throws(() => assertCraftOperation([sendAction, sendAction], operation, 'apporo'));
  assert.throws(() => assertCraftOperation([{ ...sendAction, selector: '#foreign' }], operation, 'apporo'));
  assert.throws(() => assertCraftOperation([{ step_id: 'delay', kind: 'wait', ms: 1000 }, sendAction], operation, 'apporo'));
  assertCraftOperation([sendAction, { step_id: 'settle', kind: 'wait', ms: 500 }], operation, 'apporo');
});
test('Craft acquires a fresh guard after slow schema preflight, caps actual dispatch to its deadline', async t => {
  const h = harness(t), calls = [];
  const call = async (tool, params, name, timeout) => {
    calls.push({ tool, params, timeout });
    if (tool === 'web-walkthrough-check') { assert.equal(h.calls.length, 0); h.advance(60); return { result: { valid: true } }; }
    assert.equal(h.calls.at(-1).method, 'begin'); return { id: 'ev_guarded', operation: 'web_walkthrough_record',
      coverage: { status: 'complete' }, result: { action_count: 1, steps: [{ step_id: 'send', status: 'ok' }] } };
  };
  const options = { call, guard: h.guard, page: h.page, operation: h.operation, phase: 'apporo', name: 'send' };
  await guardedRecordCall({ ...options, tool: 'web-walkthrough-check', params: {} });
  await guardedRecordCall({ ...options, tool: 'web-walkthrough-record', params: { actions: [sendAction], action_timeout_ms: 20000 } });
  assert.ok(calls[1].timeout <= 19750 && calls[1].timeout > 18000); assert.equal(calls[1].params.timeout_secs, 19);
  assert.equal(h.calls.length, 2);
});
test('partial Craft result closes as uncertain before a returned journal can be written', async t => {
  const h = harness(t);
  await assert.rejects(guardedRecordCall({ guard: h.guard, page: h.page, operation: h.operation, phase: 'apporo', name: 'send',
    tool: 'web-walkthrough-record', params: { actions: [sendAction], action_timeout_ms: 20000 },
    call: async () => ({ id: 'ev_partial', operation: 'web_walkthrough_record', result: { aborted: 'timeout' } }),
  }), /aborted/);
  assert.equal(h.calls.at(-1).outcome, 'uncertain');
  assert.equal(h.calls.some(c => c.outcome === 'returned'), false);
});
test('wait-only Craft observation requests no mutation guard', async () => {
  let calls = 0;
  await guardedRecordCall({ call: async () => { calls++; }, guard: { run: () => { throw Error('not allowed'); } },
    tool: 'web-walkthrough-record', params: { actions: [{ step_id: 'observe', kind: 'wait', ms: 300 }] }, phase: 'apporo' });
  assert.equal(calls, 1);
});
test('browser connector POST and local UI use separate common paths', async t => {
  const h = harness(t); h.setUrl(h.host.baseUrl + '/omnigent');
  const http = [], controls = [];
  h.page.getByRole = () => ({ click: async () => { controls.push('open'); } });
  const actions = browserActions({ manifest: h.f.browser, brand: 'apporo' }, { guard: h.guard,
    request: async (base, body) => { http.push(body || null); return body ? { target: 'apporo' } : {
      selectedTarget: 'apporo', activeTarget: 'apporo', configurationPending: false, daemon: { running: true } }; } });
  await actions.openConnector(h.page, 'pi3'); assert.deepEqual(controls, ['open']); assert.equal(h.calls.length, 0); assert.equal(http.length, 0);
  await actions.pair(h.page, 'pi3'); assert.deepEqual(http, [null, { action: 'pair' }]); assert.equal(h.calls.length, 2);
});
test('pair request refuses another selected brand even when the caller echoes that current state', async t => {
  const h = harness(t, { mutate: ({ current }) => {
    current.activity.connector.selectedTarget = 'paseo'; current.activity.connector.activeTarget = 'paseo';
  } });
  h.setUrl(h.host.baseUrl + '/omnigent');
  await assert.rejects(h.run({ kind: 'connector.pair', hostLabel: 'pi3', expectedConnector: {
    selectedTarget: 'paseo', activeTarget: 'paseo', configurationPending: false, daemonRunning: true,
  } }), /wrong selected brand/);
  assert.equal(h.writes.length, 0);
});
test('save-target rejects changed local combobox before any authority request', async t => {
  const h = harness(t); h.setUrl(h.host.baseUrl + '/omnigent');
  h.page.getByRole = () => ({ inputValue: async () => 'paseo' });
  await assert.rejects(h.run({ kind: 'connector.save-target', hostLabel: 'pi3', expectedConnector: {
    selectedTarget: 'apporo', activeTarget: 'apporo', configurationPending: false, daemonRunning: true,
  } }), /local target/);
  assert.equal(h.calls.length, 0); assert.equal(h.writes.length, 0);
});
test('pair acceptance checks server inside confirmation dialog, not unrelated page text', async t => {
  const h = harness(t); h.setUrl('https://smart.apporo.ai/');
  h.page.getByRole = () => ({ filter: () => ({ getByText: () => ({ isVisible: async () => false }) }) });
  await assert.rejects(h.run({ kind: 'pair.accept', hostLabel: 'pi3' }), /foreign server/);
  assert.equal(h.calls.length, 0); assert.equal(h.writes.length, 0);
});
test('production execution stays closed even if caller supplies approval flags or a fake guard', async t => {
  const h = harness(t);
  const env = { SMART_PARITY_EVIDENCE_DIR: h.f.root, SMART_PARITY_PRODUCTION_APPROVED: '1' };
  assert.throws(() => configuration('apporo', env), /requires per-action/);
  await assert.rejects(launch({ manifest: h.f.browser, approved: true }, 'pair', { productionGuard: h.guard }), /actual managed ParentTransport/);
});


test('conversation Craft selectors reject broad, foreign, escaping and unbounded paths', () => {
 const op={kind:'conversation.send',agentId:'owned-agent'};
 const good=sendAction.selector; assert.equal(assertBoundControlSelector(good,op),'send');
 for(const bad of [
  '[role="button"][aria-label="Send message"]', good.replace('owned-agent','foreign'),
  good+', body button',good.replace(' > div:nth-child(2)',''),
  good.replace(' > div:nth-child(2)',' > div:nth-child(0)'),
  good.replace(' > div:nth-child(2)',' > div:nth-child(2)'.repeat(65)),
  good.replace('[aria-selected="true"]','[aria-selected="false"]'),
  good.replace(' > div:nth-child(2)',' > div:has(textarea)'),
 ]) assert.throws(()=>assertBoundControlSelector(bad,op));
 assert.throws(()=>assertCraftOperation([{step_id:'send',kind:'click',role:'button',name:'Send message'}],op,'apporo'));
});

test('Craft compares bounded selector to freshly derived visible path before recording',async t=>{
 const h=harness(t);let calls=0;
 const wrong={...sendAction,selector:sendAction.selector.replace('nth-child(2)','nth-child(3)')};
 await assert.rejects(guardedRecordCall({guard:h.guard,page:h.page,operation:h.operation,phase:'apporo',name:'send',
  tool:'web-walkthrough-record',params:{actions:[wrong],action_timeout_ms:20000},call:async()=>{calls++;}}),/visible composer path changed/);
 assert.equal(calls,0);assert.equal(h.calls.at(-1).outcome,'uncertain');
 await assert.rejects(h.run(),/no retry/);
});
