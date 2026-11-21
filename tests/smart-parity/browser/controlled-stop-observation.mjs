// Evidence checks only. Authentic authority/admission remain with HostTransport.
// Parent contract: reply.controlledStopJournals is a private hash-bound JSON ref:
// {schema:'agent-connect-returned-transition-bytes/v1',records:{[journalName]:
// {journalBase64:<EXACT original JSONL bytes>,resultBase64:<EXACT result bytes>}}}.
// Copy only the stop and its ordered save transitions into the browser evidence
// directory. Never synthesize rows from index fields or alter original timestamps.
import { isDeepStrictEqual as equal } from 'node:util';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const check = (ok, message) => { if (!ok) throw Error('Browser guard: controlled stop ' + message); };
const same = (a, b, message) => check(equal(a, b), message);
const hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const finite = v => typeof v === 'number' && Number.isFinite(v);
const sha = raw => createHash('sha256').update(raw).digest('hex');
const epoch = ['identity', 'runtime', 'runtimeIdentity', 'dataIdentity', 'ledger'];
const bound = ['scope', 'runId', 'release', 'phase', 'runtimeIdentity', 'dataIdentity', 'serverId'];
const hashes = ['keypairSha256', 'ownerSha256', 'configurationFileSha256', 'preferencesSha256'];
const schema = 'agent-connect-controlled-stop/v1';
const python = `import sys,json,hashlib,base64
v=json.load(sys.stdin)
d=lambda x:hashlib.sha256(json.dumps(x,sort_keys=True,separators=(",",":"),allow_nan=False).encode()).hexdigest()
rows=[json.loads(x) for x in base64.b64decode(v['journalBase64'],validate=True).splitlines()]
result=json.loads(base64.b64decode(v['resultBase64'],validate=True))
operation={'kind':rows[0]['action'],'hostLabel':v['hostLabel'],'expectedConnector':{k:result['result']['before']['connector'][k] for k in ['selectedTarget','activeTarget','configurationPending','daemonRunning']}}
print(json.dumps({'rows':rows,'rowHashes':[d({k:v for k,v in r.items() if k!='entrySha256'}) for r in rows],'envelope':result,'resultHash':d(result['result']),'payloadHash':d(operation)}))`;
function exactBytes(value) {
  check(typeof value === 'string' && value.length > 0 && value.length <= 2800000, 'raw journal/result bytes required');
  const raw = Buffer.from(value, 'base64'); same(raw.toString('base64'), value, 'byte encoding changed'); return raw;
}
function state(local) {
  check(local && local.connector && local.hashes && hashes.every(k => hash(local.hashes[k])) && hash(local.connector.configurationSha256), 'persistent hashes missing');
  for (const key of ['enabled', 'daemonRunning', 'configurationPending', 'packageEnabled', 'packageInstalled']) check(typeof local.connector[key] === 'boolean', 'connector state incomplete');
  check(['woowtech', 'apporo', 'paseo'].includes(local.connector.selectedTarget) &&
    [null, 'woowtech', 'apporo', 'paseo'].includes(local.connector.activeTarget), 'connector target invalid');
  return { connector: local.connector, hashes: local.hashes };
}
function unique(values, message) { check(Array.isArray(values) && new Set(values).size === values.length, message); return values; }
function returned(record, index, action, request, canonicalHash) {
  check(record && index && hash(index.journalSha256) && hash(index.resultSha256), 'returned bytes/index missing');
  same(sha(exactBytes(record.journalBase64)), index.journalSha256, 'actual journal bytes changed');
  same(sha(exactBytes(record.resultBase64)), index.resultSha256, 'actual result bytes changed');
  const decoded = JSON.parse(execFileSync('python3', ['-c', python], { input: JSON.stringify({ ...record, hostLabel: request.hostLabel }),
    encoding: 'utf8', timeout: 10000, maxBuffer: 6000000 }));
  const { rows, rowHashes, envelope } = decoded;
  check(rows.length === 2 && rows[0].status === 'dispatching_do_not_retry' && rows[1].status === 'returned', 'exact returned journal required');
  let previous = null;
  rows.forEach((row, i) => {
    for (const key of bound) same(row[key], request[key], 'returned journal binding changed: ' + key);
    same(row.canonicalSha256, canonicalHash, 'journal canonical changed'); same(row.podUid, request.identity.podUid, 'journal Pod changed');
    check(row.action === action && row.productionMutations === true && row.sequence === i && row.previousSha256 === previous &&
      row.entrySha256 === rowHashes[i] && hash(row.payloadSha256) && finite(row.at) && finite(row.deadline), 'journal chain changed');
    previous = row.entrySha256;
  });
  const transient = new Set(['sequence', 'status', 'at', 'previousSha256', 'entrySha256', 'resultSha256']);
  const intent = row => Object.fromEntries(Object.entries(row).filter(([k]) => !transient.has(k)));
  same(intent(rows[0]), intent(rows[1]), 'returned intent changed');
  for (const key of [...bound, 'canonicalSha256', 'podUid', 'action', 'deadline']) same(envelope[key], rows[1][key], 'result binding changed: ' + key);
  check(envelope.productionMutations === true && decoded.resultHash === rows[1].resultSha256 &&
    rows[0].payloadSha256 === decoded.payloadHash && rows[0].at <= rows[1].at && rows[0].at <= rows[0].deadline, 'returned result/payload changed');
  return { intent: rows[0], at: rows[1].at, body: envelope.result };
}
export function controlledStopObservation({ value, proof, checkpoint, checkpointHash, journal, request, original, now, returnedBytes, canonicalHash }) {
  check(['connector.start', 'connector.save-target'].includes(request.operation.kind), 'only start/save while stopped');
  check(!['activity', 'snapshot', 'sdk'].some(k => Object.hasOwn(value, k)), 'current SDK substitute forbidden');
  check(proof.schema === schema && checkpoint.schema === schema && proof.kind === 'controlled-stop-live-observation', 'actual stopped proof required');
  for (const key of bound) {
    same(proof.binding?.[key], request[key], 'binding changed: ' + key); same(checkpoint.binding?.[key], request[key], 'checkpoint changed: ' + key);
  }
  for (const source of [proof.binding, checkpoint.binding, journal]) same(source.canonicalSha256, canonicalHash, 'canonical binding changed');
  check(hash(checkpointHash) && proof.preStopSha256 === checkpointHash && journal.preStopSha256 === checkpointHash, 'checkpoint hash mismatch');
  same(proof.current, value, 'actual observation changed'); same(proof.historicalFullObservation, checkpoint.historicalFullObservation, 'historical observation changed');
  const historical = checkpoint.historicalFullObservation, previous = checkpoint.historicalLocalObservation, local = value.local;
  for (const key of epoch) { same(value[key], original.baseline[key], 'current epoch changed: ' + key); same(historical[key], original.baseline[key], 'historical epoch changed: ' + key); }
  for (const key of ['paseoKeypairSha256', 'wrapperCli']) same(historical.ui?.[key], original.baseline.ui[key], 'historical persistent identity changed');
  same(historical.ui?.omnigent?.hostIdSha256, original.baseline.ui.omnigent.hostIdSha256, 'historical Omnigent identity changed');
  const snapshot = historical.activity?.snapshot;
  check(snapshot?.complete === true && snapshot.serverId === request.serverId, 'historical complete snapshot required');
  same(snapshot.availableAgents, [], 'historical live agents present');
  check(Array.isArray(snapshot.agents) && snapshot.agents.every(a => ['idle', 'closed'].includes(a.status) &&
    a.activeTurn == null && a.pendingPermissions === 0), 'historical work or permissions present');
  unique(snapshot.agents.map(a => a.id), 'historical duplicate agents');
  for (const row of original.baseline.activity.snapshot.agents) same(snapshot.agents.find(a => a.id === row.id), row, 'nonowned historical agent changed');
  same(snapshot.schedules, original.baseline.activity.snapshot.schedules, 'schedules changed');
  check(snapshot.schedules.every(s => ['paused', 'completed'].includes(s.status) && Array.isArray(s.runs) &&
    s.runs.every(r => ['succeeded', 'failed'].includes(r.status) && r.endedAt)), 'active schedule or run');
  same(snapshot.terminals, original.baseline.activity.snapshot.terminals, 'terminals changed');
  check(snapshot.terminals.every(t => t.activity && (t.activity.state === 'idle' ||
    t.activity.state === 'attention' && t.activity.attentionReason === 'finished') && t.activity.attentionReason !== 'needs_input'), 'terminal work present');
  same(historical.activity.piRunningIds, [], 'historical Pi work present');
  check(finite(historical.activity.observedAt) && historical.activity.observedAt <= value.startedAt, 'historical snapshot is not prior');
  const names = unique([proof.stopJournal, ...proof.transitionJournals], 'transition replay');
  check(names.length > 0 && names.length <= 64 && names.every(n => typeof n === 'string' &&
    new RegExp('^' + request.release + '-[A-Za-z0-9_-]+\\.jsonl$').test(n)), 'actual stop journal names required');
  check(returnedBytes?.schema === 'agent-connect-returned-transition-bytes/v1' && returnedBytes.records, 'original returned bytes required');
  same(Object.keys(returnedBytes.records).sort(), [...names].sort(), 'returned journal inventory differs');
  check(checkpoint.journalIndex && proof.journalIndex, 'journal inventory missing');
  check(!names.some(n => Object.hasOwn(checkpoint.journalIndex, n)), 'historical transition replay');
  same(Object.keys(proof.journalIndex).sort(), [...Object.keys(checkpoint.journalIndex), ...names].sort(), 'intervening or missing journal');
  for (const [name, reference] of Object.entries(checkpoint.journalIndex)) same(proof.journalIndex[name], reference, 'historical journal changed');
  let cursor = state(previous), priorHash = null, completedAt = null;
  check(cursor.connector.enabled && cursor.connector.daemonRunning, 'historical daemon not running');
  check(cursor.hashes.keypairSha256.startsWith(historical.ui.paseoKeypairSha256) && historical.ui.paseoKeypairSha256.length >= 16, 'historical keypair binding changed');
  same(previous.connector, historical.activity.connector, 'historical connector changed');
  for (const [i, name] of names.entries()) {
    const record = returned(returnedBytes.records[name], proof.journalIndex[name], i ? 'connector.save-target' : 'connector.stop', request, canonicalHash);
    same(Object.keys(record.body).sort(), ['after', 'before', 'preStopSha256', 'priorTransitionSha256'], 'transition body differs');
    for (const source of [record.intent, record.body]) { same(source.preStopSha256, checkpointHash, 'transition checkpoint changed'); same(source.priorTransitionSha256, priorHash, 'transition chain changed'); }
    if (i === 0) check(record.intent.at >= Math.max(historical.activity.observedAt, previous.observedAt) &&
      finite(checkpoint.deadline) && record.intent.deadline <= checkpoint.deadline, 'stop outside prior observation window');
    else check(completedAt <= record.intent.at, 'transition time order changed');
    same(record.body.before, cursor, 'transition before changed'); const after = state(record.body.after);
    check(after.connector.enabled === false && after.connector.daemonRunning === false, 'returned daemon not stopped');
    const allowed = new Set(i ? ['selectedTarget', 'configurationPending', 'configurationSha256'] : ['enabled', 'daemonRunning']);
    const retained = connector => Object.fromEntries(Object.entries(connector).filter(([k]) => !allowed.has(k)));
    same(retained(after.connector), retained(cursor.connector), 'unowned connector change');
    if (i === 0) same(after.hashes, cursor.hashes, 'stop changed configuration/identity');
    else {
      for (const key of ['keypairSha256', 'ownerSha256', 'configurationFileSha256']) same(after.hashes[key], cursor.hashes[key], 'save changed persistent identity/daemon config');
      same(after.connector.selectedTarget, request.phase, 'save target outside phase');
      same(after.connector.configurationPending, cursor.connector.configurationPending || cursor.connector.selectedTarget !== request.phase, 'pending flag changed');
    }
    cursor = after; priorHash = proof.journalIndex[name].journalSha256; completedAt = record.at;
  }
  same(journal.priorTransitionSha256, priorHash, 'dispatch not bound to last returned transition');
  same(state(local), cursor, 'current stopped configuration/identity changed');
  check(completedAt <= value.startedAt, 'observation predates returned stop');
  same(local.mount, original.baseline.activity.mount, 'mount changed'); same(local.files, historical.activity.files, 'definitions changed'); same(local.fixture, previous.fixture, 'shared fixture changed');
  const scan = local.processes;
  check(scan?.method === 'linux-proc-environ-birth-bracket/v1' && scan.complete === true && scan.home === '/data/pi-agent/pi-paseo/daemon', 'process coverage missing');
  check(typeof scan.bootId === 'string' && scan.bootId.length > 0, 'boot identity missing'); same(scan.bootId, previous.processes.bootId, 'boot changed');
  same(scan.matches, [], 'daemon remains'); same(scan.enumeratedPids, scan.endingPids, 'process inventory changed');
  check(unique(scan.enumeratedPids, 'duplicate process inventory').length > 0 && scan.enumeratedPids.every(pid => Number.isSafeInteger(pid) && pid > 0), 'empty/invalid process inventory');
  check(Array.isArray(scan.tracked) && scan.tracked.every(p => p.birth === null), 'previous process present');
  const tracked = unique(scan.tracked.map(p => p.pid), 'duplicate tracked PID'), priorPids = unique(previous.processes.matches.map(p => p.pid), 'duplicate previous PID');
  check(priorPids.length > 0 && priorPids.includes(snapshot.daemon?.pid) && previous.processes.matches.every(p => /^\d+$/.test(p.startTicks)), 'previous daemon birth missing');
  same(tracked.sort((a, b) => a - b), priorPids.sort((a, b) => a - b), 'previous daemon coverage changed');
  const pi = local.pi;
  check(pi && Number.isSafeInteger(pi.sessionListVersion) && pi.sessionListVersion === pi.endingSessionListVersion, 'Pi inventory changed');
  same(pi.running, [], 'Pi work running'); same(pi.sessions, historical.activity.piSessions, 'Pi sessions changed'); same(pi.sessions, previous.pi.sessions, 'prior Pi observation changed');
  same(unique(pi.listedSessionIds, 'duplicate Pi list').slice().sort(), unique(pi.sessions.map(s => s.id), 'duplicate Pi session').sort(), 'Pi inventory incomplete');
  for (const s of pi.sessions) {
    check(typeof s.rpcAlive === 'boolean', 'Pi RPC unknown');
    if (s.rpcAlive) check(s.flags && typeof s.flags.isStreaming === 'boolean' && Object.values(s.flags).every(v => v === false) &&
      s.pendingMessageCount === 0 && (!s.queuedMessages || Object.keys(s.queuedMessages).sort().join(',') === 'followUp,steering' && Object.values(s.queuedMessages).every(v => v === 0)), 'Pi work or queue present');
  }
  for (const item of [value, local, pi, scan]) check(finite(item.startedAt) && finite(item.observedAt) && value.startedAt <= item.startedAt &&
    item.startedAt <= item.observedAt && item.observedAt <= value.observedAt && value.observedAt <= now, 'observation bracket invalid');
  check(local.startedAt <= pi.startedAt && pi.observedAt <= local.observedAt && local.startedAt <= scan.startedAt && scan.observedAt <= local.observedAt, 'local observation bracket changed');
  check(finite(proof.deadline) && now < proof.deadline && proof.deadline <= Math.min(value.startedAt, local.startedAt) + 30, 'expired observation');
  return { state: local.connector, startedAt: Math.min(value.startedAt, local.startedAt), observedAt: value.observedAt, deadline: proof.deadline };
}
