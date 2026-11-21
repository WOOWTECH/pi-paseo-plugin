import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { productionFixture } from './production-fixture.mjs';
import { validateProductionManifest } from '../production-scope.mjs';
import { createProductionGuard, guardProtocol, sha256 } from './production-guard.mjs';

// Synthetic private parent replies only. No production, browser or service calls.
const canonical = value => execFileSync('python3', ['-c',
  'import sys,json,hashlib;print(hashlib.sha256(json.dumps(json.load(sys.stdin),sort_keys=True,separators=(",",":")).encode()).hexdigest())'],
  { input: JSON.stringify(value), encoding: 'utf8' }).trim();
const schema = 'agent-connect-controlled-stop/v1';
function harness(t, { mutate = () => {}, transitions = false, kind = 'connector.start' } = {}) {
  const f = productionFixture(t), host = f.browser.hosts[0], original = f.transport.hosts[host.release], base = original.baseline;
  base.activity.connector.configurationSha256 = 'a'.repeat(64);
  base.activity.snapshot.agents[0].pendingPermissions = 0;
  base.activity.snapshot.daemon = { pid: 42 };
  host.productionBinding.baselineSha256 = canonical(base); f.save();
  const context = validateProductionManifest(f.browser, f.options), timestamp = base.observedAt;
  const now = timestamp + 5, binding = { scope: 'production-canary', runId: f.browser.runId, release: host.release,
    phase: 'apporo', runtimeIdentity: host.runtimeIdentity, dataIdentity: host.dataIdentity, serverId: host.serverId,
    canonicalSha256: canonical(original.canonical) };
  const historical = structuredClone(base);
  historical.activity.startedAt = timestamp + .1; historical.activity.observedAt = timestamp + .5; historical.observedAt = timestamp + .6;
  const previous = { startedAt: timestamp + .1, observedAt: timestamp + 1, connector: structuredClone(historical.activity.connector),
    hashes: { keypairSha256: 'd'.repeat(64), ownerSha256: 'b'.repeat(64), configurationFileSha256: 'c'.repeat(64), preferencesSha256: 'e'.repeat(64) },
    files: historical.activity.files, mount: historical.activity.mount, fixture: null,
    processes: { bootId: 'boot', matches: [{ pid: 42, startTicks: '100' }, { pid: 43, startTicks: '101' }] },
    pi: { sessions: structuredClone(historical.activity.piSessions) } };
  const checkpoint = { schema, binding, deadline: timestamp + 30.1, historicalFullObservation: historical,
    historicalLocalObservation: previous, journalIndex: {} };
  const names = [host.release + '-stop.jsonl', ...(transitions ? [host.release + '-save.jsonl'] : [])];
  const stopAfter = { connector: { ...previous.connector, enabled: false, daemonRunning: false }, hashes: { ...previous.hashes } };
  const saveAfter = structuredClone(stopAfter);
  if (transitions) saveAfter.hashes.preferencesSha256 = 'f'.repeat(64);
  const local = { ...structuredClone(previous), ...structuredClone(saveAfter), startedAt: timestamp + 4, observedAt: timestamp + 4.5,
    processes: { method: 'linux-proc-environ-birth-bracket/v1', complete: true, home: '/data/pi-agent/pi-paseo/daemon', bootId: 'boot',
      startedAt: timestamp + 4.1, observedAt: timestamp + 4.4, matches: [], enumeratedPids: [1, 100], endingPids: [1, 100],
      tracked: [{ pid: 42, birth: null }, { pid: 43, birth: null }] },
    pi: { startedAt: timestamp + 4.05, observedAt: timestamp + 4.3, sessionListVersion: 1, endingSessionListVersion: 1,
      listedSessionIds: historical.activity.piSessions.map(s => s.id), sessions: structuredClone(historical.activity.piSessions), running: [] } };
  const current = { ...structuredClone(base), startedAt: timestamp + 3.9, observedAt: timestamp + 4.6, local };
  delete current.activity;
  const operation = { kind, hostLabel: host.label, expectedConnector: Object.fromEntries(
    ['selectedTarget', 'activeTarget', 'configurationPending', 'daemonRunning'].map(k => [k, local.connector[k]])) };
  let writes = 0, dispatch, requestHash; const calls = [];
  const makeRecord = (action, before, after, at, checkpointHash, previousHash) => {
    const op = { kind: action, hostLabel: host.label, expectedConnector: Object.fromEntries(
      ['selectedTarget', 'activeTarget', 'configurationPending', 'daemonRunning'].map(k => [k, before.connector[k]])) };
    const ticket = { ...binding, action, podUid: base.identity.podUid, deadline: timestamp + 30,
      preStopSha256: checkpointHash, priorTransitionSha256: previousHash, payloadSha256: canonical(op), attempt: action };
    const body = { preStopSha256: checkpointHash, priorTransitionSha256: previousHash, before, after };
    let hash = null;
    const rows = ['dispatching_do_not_retry', 'returned'].map((status, sequence) => {
      const row = { ...ticket, productionMutations: true, status, sequence, previousSha256: hash, at: at + sequence * .01,
        ...(sequence ? { resultSha256: canonical(body) } : {}) };
      row.entrySha256 = canonical(row); hash = row.entrySha256; return row;
    });
    const raw = Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    const result = Buffer.from(JSON.stringify({ ...ticket, productionMutations: true, result: body }) + '\n');
    return { index: { journalSha256: sha256(raw), resultSha256: sha256(result) },
      bytes: { journalBase64: raw.toString('base64'), resultBase64: result.toString('base64') } };
  };
  const exchange = async envelope => {
    calls.push(envelope);
    if (envelope.method === 'finish') return { protocol: guardProtocol, method: 'finish', requestSha256: requestHash,
      attemptId: dispatch.attemptId, status: envelope.outcome,
      journal: f.put('guard/finished.json', { ...dispatch, requestSha256: requestHash, status: envelope.outcome }) };
    dispatch = JSON.parse(envelope.requestJson); requestHash = envelope.requestSha256;
    const checkpointHash = canonical(checkpoint);
    const first = makeRecord('connector.stop', { connector: previous.connector, hashes: previous.hashes }, stopAfter, timestamp + 2, checkpointHash, null);
    const journalIndex = { [names[0]]: first.index }, records = { [names[0]]: first.bytes };
    if (transitions) {
      const second = makeRecord('connector.save-target', stopAfter, saveAfter, timestamp + 3, checkpointHash, first.index.journalSha256);
      journalIndex[names[1]] = second.index; records[names[1]] = second.bytes;
    }
    const proof = { schema, kind: 'controlled-stop-live-observation', binding: { ...binding }, preStopSha256: checkpointHash,
      historicalFullObservation: structuredClone(historical), stopJournal: names[0], transitionJournals: names.slice(1), journalIndex,
      current: structuredClone(current), deadline: timestamp + 33.9 };
    const journal = { ...dispatch, canonicalSha256: binding.canonicalSha256, requestSha256: requestHash,
      status: 'dispatching_do_not_retry', preStopSha256: checkpointHash, priorTransitionSha256: journalIndex[names.at(-1)].journalSha256,
      preStopReference: f.put('guard/pre-stop.json', checkpoint) };
    const bytes = { schema: 'agent-connect-returned-transition-bytes/v1', records };
    const canonicalProof = { ...original.canonical, verifiedAt: timestamp + 4.8 };
    const reply = { protocol: guardProtocol, method: 'begin', requestSha256: requestHash, attemptId: dispatch.attemptId,
      status: 'dispatching_do_not_retry', checkedAt: timestamp + 4.8, expiresAt: timestamp + 20 };
    mutate({ current, proof, checkpoint, journal, bytes, reply, names, canonical: canonicalProof });
    for (const [key, value] of Object.entries({ current, controlledStop: proof, controlledStopJournals: bytes,
      journal, canonical: canonicalProof })) reply[key] = f.put('guard/' + key + '.json', value);
    return reply;
  };
  const guard = createProductionGuard({ context, phase: 'apporo', exchange, now: () => now });
  const page = { url: () => host.baseUrl + '/omnigent', getByRole: () => ({ inputValue: async () => 'apporo' }) };
  return { run: () => guard.run({ page, operation, execute: async () => { writes++; } }), calls, writes: () => writes };
}

function rehashReturned(data, change) {
  const name=data.names[0], record=data.bytes.records[name];
  const rows=Buffer.from(record.journalBase64,'base64').toString().trim().split('\n').map(JSON.parse);
  const envelope=JSON.parse(Buffer.from(record.resultBase64,'base64'));
  change(rows,envelope,data);
  rows[1].resultSha256=canonical(envelope.result); let previous=null;
  for(const row of rows) { delete row.entrySha256; row.previousSha256=previous; row.entrySha256=canonical(row); previous=row.entrySha256; }
  const raw=Buffer.from(rows.map(r=>JSON.stringify(r)).join('\n')+'\n'), result=Buffer.from(JSON.stringify(envelope)+'\n');
  record.journalBase64=raw.toString('base64'); record.resultBase64=result.toString('base64');
  data.proof.journalIndex[name]={journalSha256:sha256(raw),resultSha256:sha256(result)};
  data.journal.priorTransitionSha256=sha256(raw);
}

test('stopped start reads actual returned bytes and preserves historical SDK separately', async t => {
  const h = harness(t); await h.run(); assert.equal(h.writes(), 1); assert.equal(h.calls.at(-1).outcome, 'returned');
});
test('stopped save/start chain verifies ordered returned configuration transitions', async t => {
  const h = harness(t, { transitions: true, kind: 'connector.save-target' }); await h.run(); assert.equal(h.writes(), 1);
});
for (const [name, mutate] of Object.entries({
  'synthetic current SDK': ({ current, proof }) => { current.activity = {}; proof.current.activity = {}; },
  'different Pod': ({ current, proof }) => { current.identity.podUid = 'replacement'; proof.current.identity.podUid = 'replacement'; },
  'different PVC': ({ current, proof }) => { current.identity.pvcUid = 'replacement'; proof.current.identity.pvcUid = 'replacement'; },
  'stale canonical': ({ canonical }) => { canonical.source = 'f'.repeat(40); },
  'wrong checkpoint hash': ({ journal }) => { journal.preStopSha256 = '0'.repeat(64); },
  'replayed current operation': ({ journal }) => { journal.requestSha256 = '0'.repeat(64); },
  'old owned tunnel': ({ journal }) => { journal.tunnel = { ...journal.tunnel, pid: 1 }; },
  'missing original bytes': ({ bytes }) => { bytes.records = {}; },
  'journal index alone': ({ bytes, names }) => { bytes.records[names[0]] = { journalSha256: 'a'.repeat(64), resultSha256: 'b'.repeat(64) }; },
  'changed original journal': ({ bytes, names }) => { bytes.records[names[0]].journalBase64 = Buffer.from('{}\n').toString('base64'); },
  'changed returned result': ({ bytes, names }) => { bytes.records[names[0]].resultBase64 = Buffer.from('{}\n').toString('base64'); },
  'intervening unreturned operation': ({ proof }) => { proof.journalIndex['svc-febb366b-other.jsonl'] = { journalSha256: 'a'.repeat(64), resultSha256: 'b'.repeat(64) }; },
  'wrong predecessor': ({ journal }) => { journal.priorTransitionSha256 = '0'.repeat(64); },
  'definition changed': ({ current, proof }) => { current.local.files['/data/pi-agent/settings.json'] = '0'.repeat(64); proof.current = structuredClone(current); },
  'persistent keypair changed': ({ current, proof }) => { current.local.hashes.keypairSha256 = '0'.repeat(64); proof.current = structuredClone(current); },
  'preferences unjournaled': ({ current, proof }) => { current.local.hashes.preferencesSha256 = '0'.repeat(64); proof.current = structuredClone(current); },
  'process still present': ({ current, proof }) => { current.local.processes.matches = [{ pid: 42 }]; proof.current = structuredClone(current); },
  'previous process reused': ({ current, proof }) => { current.local.processes.tracked[0].birth = 'different'; proof.current = structuredClone(current); },
  'missing previous PID': ({ current, proof }) => { current.local.processes.tracked.pop(); proof.current = structuredClone(current); },
  'partial process scan': ({ current, proof }) => { current.local.processes.complete = false; proof.current = structuredClone(current); },
  'empty process scan': ({ current, proof }) => { current.local.processes.enumeratedPids = current.local.processes.endingPids = []; proof.current = structuredClone(current); },
  'invalid process PID': ({ current, proof }) => { current.local.processes.enumeratedPids = current.local.processes.endingPids = [-1]; proof.current = structuredClone(current); },
  'Pi queue active': ({ current, proof }) => { current.local.pi.running = ['user-session']; proof.current = structuredClone(current); },
  'incomplete Pi list': ({ current, proof }) => { current.local.pi.listedSessionIds = []; proof.current = structuredClone(current); },
  'stale local observation': ({ current, proof }) => { current.local.startedAt -= 60; proof.current = structuredClone(current); },
  'expired proof': ({ proof }) => { proof.deadline -= 60; },
  'expanded proof window': ({ proof }) => { proof.deadline += 60; },
  'dispatch after proof': ({ reply }) => { reply.expiresAt += 60; },
})) test('stopped dispatch rejects ' + name + ' without mutation or automatic retry', async t => {
  const h = harness(t, { mutate }); await assert.rejects(h.run()); assert.equal(h.writes(), 0);
  assert.equal(h.calls.at(-1).outcome, 'not-dispatched'); const count = h.calls.length;
  await assert.rejects(h.run(), /no retry/); assert.equal(h.calls.length, count);
});

for(const [name,change] of [
 ['uncertain actual stop',rows=>{rows[1].status='uncertain';}],
 ['wrong actual action',(rows,envelope)=>{for(const r of rows)r.action='connector.start';envelope.action='connector.start';}],
 ['invented target payload',rows=>{for(const r of rows)r.payloadSha256='0'.repeat(64);}],
 ['stop changed daemon config',(rows,envelope,data)=>{envelope.result.after.hashes.configurationFileSha256='0'.repeat(64);data.current.local.hashes.configurationFileSha256='0'.repeat(64);data.proof.current=structuredClone(data.current);}],
 ['stop changed persistent owner',(rows,envelope,data)=>{envelope.result.after.hashes.ownerSha256='0'.repeat(64);data.current.local.hashes.ownerSha256='0'.repeat(64);data.proof.current=structuredClone(data.current);}],
 ['unobserved stop predecessor',(rows,envelope)=>{envelope.result.before.connector.selectedTarget='woowtech';}],
]) test('rehash-bound stopped integration rejects '+name,async t=>{
 const h=harness(t,{mutate:data=>rehashReturned(data,change)});
 await assert.rejects(h.run());assert.equal(h.writes(),0);assert.equal(h.calls.at(-1).outcome,'not-dispatched');
});
