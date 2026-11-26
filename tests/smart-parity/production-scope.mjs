// Offline evidence validation only. Authentic CI authorization and fresh, per-action
// checks belong to canary_pin/canary_validation, never to a manifest boolean.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual as equal } from 'node:util';
import { runtimeBinding } from './browser/runtime.mjs';

const scope = 'production-canary';
const contextName = 'woow-k3s', namespace = 'paas-ws-504a2b17';
const repository = 'jcr-prod.woowtech.io/woow-paas-docker-local/pi-agent';
const releases = { pi3: 'svc-febb366b', pi4: 'svc-966321b4' };
const brands = ['woowtech', 'apporo', 'paseo'], providers = ['claude', 'codex', 'pi'];
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const digest = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const source = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const text = value => typeof value === 'string' && value.length > 0;
const positive = value => Number.isSafeInteger(value) && value > 0;
const requireValue = (condition, reason) => { if (!condition) throw Error('Production evidence: ' + reason); };
const rawHash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const same = (actual, expected, reason) => requireValue(equal(actual, expected), reason);

export const productionCases = Object.freeze(['canonical-runtime-provenance', 'non-owned-baseline-preserved',
  'owned-agent-cleanup', 'fixture-cleanup', 'configuration-restoration']);

// Read the original JSON bytes in Python: JS parsing erases e.g. 1.0 versus 1.
// This deliberately matches canary_pin.digest, not a new JSON canonicalization.
const canonicalScript = 'import sys,json,hashlib\nv=json.load(sys.stdin)\nfor k in json.loads(sys.argv[1]): v=v[k]\nprint(hashlib.sha256(json.dumps(v,sort_keys=True,separators=(",",":")).encode()).hexdigest())';
function canonical(raw, selection = []) {
  return execFileSync('python3', ['-c', canonicalScript, JSON.stringify(selection)],
    { input: raw, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 }).trim();
}

export function productionReader(directory) {
  requireValue(text(directory) && path.isAbsolute(directory), 'private evidence root required');
  const stat = fs.lstatSync(directory), root = fs.realpathSync(directory);
  requireValue(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0, 'private real directory required');
  function read(reference, { json = true } = {}) {
    const name = typeof reference === 'string' ? reference : reference?.path;
    requireValue(text(name) && !name.split(/[\\/]/).includes('..'), 'invalid proof path');
    const file = path.resolve(root, name);
    requireValue(file.startsWith(root + path.sep), 'proof outside private root');
    const relative = path.relative(root, file);
    let current = root;
    for (const part of relative.split(path.sep)) {
      current = path.join(current, part);
      const info = fs.lstatSync(current);
      requireValue(!info.isSymbolicLink() && (info.mode & 0o077) === 0, 'proof paths must be private and not symlinks');
    }
    requireValue(fs.statSync(file).isFile() && fs.realpathSync(file) === file, 'regular contained proof file required');
    const raw = fs.readFileSync(file), sha256 = rawHash(raw);
    if (typeof reference !== 'string') requireValue(hash(reference.sha256) && reference.sha256 === sha256, 'proof checksum mismatch');
    return { value: json ? JSON.parse(raw) : undefined, raw, proof: { path: relative, sha256 }, canonical: selection => canonical(raw, selection) };
  }
  return { root, read };
}

function chainValid(chain, identity) {
  requireValue(chain && ['index', 'manifest', 'config'].every(k => digest(chain[k])) &&
    ['amd64', 'arm64'].includes(chain.architecture), 'complete OCI digest chain required');
  same(chain.runtimeIdentity, 'image:' + chain.manifest, 'runtime must be platform manifest identity');
  same(identity.architecture, chain.architecture, 'node architecture differs');
  requireValue(identity.image.startsWith(repository + ':') && !identity.image.includes('pending-approval') &&
    identity.image.endsWith('@' + chain.index), 'immutable approved repository reference required');
  requireValue([chain.manifest, repository + '@' + chain.manifest, 'docker-pullable://' + repository + '@' + chain.manifest,
    'docker://' + chain.config].includes(identity.criImageId), 'unsupported or mismatched CRI identity');
}

function canonicalValid(proof, transport, identity) {
  requireValue(proof?.scope === scope && source(proof.source), 'canonical proof source required');
  same(proof.selector, transport.selector, 'canonical selector differs');
  same(proof.image, identity.image, 'canonical image differs');
  chainValid(proof.chain, identity);
  const root = proof.root, approval = proof.approval;
  requireValue(root && root.publicationRunId === transport.selector.rootPublicationRunId &&
    source(root.revision) && digest(root.digest) && digest(root.baseManifest) && hash(root.receiptSha256), 'root publication proof required');
  requireValue(approval && approval.issue === transport.selector.approvalIssue && approval.comment === transport.selector.approvalCommentId &&
    text(approval.actor) && ['issueSha256', 'commentSha256', 'policySha256'].every(k => hash(approval[k])), 'canonical approval references required');
  const hashes = proof.sourceHashes;
  requireValue(hashes && Object.hasOwn(hashes, proof.source) && Object.entries(hashes).every(([revision, files]) =>
    source(revision) && files && digest(files['.gitea/workflows/build-pi-agent-image.yml']) &&
    Object.keys(files).length > 1 && Object.values(files).every(digest)), 'reviewed workflow/source hashes required');
  requireValue(digest(proof.jobLogs?.build) && digest(proof.jobLogs?.promotion), 'canonical job log references required');
}

function observedValid(observed, host, baseline, mountHash) {
  requireValue(observed?.scope === scope && observed.productionMutations === false, 'read-only production observation required');
  const identity = observed.identity, activity = observed.activity;
  requireValue(identity && identity.context === contextName && identity.namespace === namespace && identity.container === 'pi-web', 'workload scope mismatch');
  requireValue(['deploymentUid', 'podUid', 'podName', 'replicaSetUid', 'nodeUid', 'nodeName', 'containerId', 'pvcUid', 'pvcName', 'pvUid', 'pvName'].every(k => text(identity[k])), 'full workload/volume epoch required');
  requireValue(identity.csi?.driver === 'driver.longhorn.io' && text(identity.csi.volumeHandle), 'volume identity required');
  chainValid(observed.runtime, identity);
  same(observed.runtimeIdentity, observed.runtime.runtimeIdentity, 'observed runtime mismatch');
  same(observed.dataIdentity, 'pvc:' + identity.pvcUid + ':' + mountHash, 'actual mount/data identity mismatch');
  requireValue(activity?.mount?.mountpoint === '/data/pi-agent' && activity.mount.source === '/dev/longhorn/' + identity.csi.volumeHandle, 'actual PVC mount mismatch');
  requireValue(Number.isFinite(observed.observedAt) && Number.isFinite(activity.startedAt) && Number.isFinite(activity.observedAt) &&
    activity.startedAt <= activity.observedAt && activity.observedAt <= observed.observedAt && observed.observedAt - activity.startedAt <= 30,
    'stale or unordered runtime observation');
  same(observed.ledger?.release, host.release, 'observed release differs');
  same(observed.ledger?.namespace, namespace, 'observed ledger namespace differs');
  same(observed.ledger?.id, host.label === 'pi3' ? 173 : 172, 'observed service differs');
  requireValue(activity.snapshot?.complete === true && ['agents', 'availableAgents', 'schedules', 'terminals'].every(k => Array.isArray(activity.snapshot[k])) &&
    Array.isArray(activity.piSessions) && activity.files && activity.connector && observed.ui, 'complete nonfixture baseline required');
  same(activity.snapshot.serverId, host.serverId, 'Paseo server identity differs');
  if (baseline) {
    for (const key of ['identity', 'runtime', 'runtimeIdentity', 'dataIdentity', 'ledger']) same(observed[key], baseline[key], 'runtime/host/PVC epoch changed: ' + key);
    same(activity.mount, baseline.activity.mount, 'mount changed');
    requireValue(observed.observedAt >= baseline.observedAt, 'observation predates baseline');
  }
}

function validateManifestFile(manifest, { evidenceDirectory, manifestName = 'browser-hosts.private.json', transportReference } = {}) {
  requireValue(manifest?.scope === scope && manifest.schema === 1 && manifest.platform === 'k3s-paas' &&
    manifest.productionMutations === true && /^[a-f0-9]{32}$/.test(manifest.runId), 'explicit production schema/platform/run required');
  const reader = productionReader(evidenceDirectory), browserFile = reader.read(manifestName);
  same(browserFile.value, manifest, 'browser manifest file differs');
  const file = reader.read(transportReference || { path: manifest.guard?.manifestPath, sha256: manifest.guard?.manifestSha256 }), transport = file.value;
  same(file.proof.sha256, manifest.guard?.manifestSha256, 'original transport bytes differ');
  requireValue(transport?.schema === 1 && transport.scope === scope && transport.productionMutations === false &&
    transport.runId === manifest.runId && transport.context === contextName && transport.namespace === namespace,
    'production transport binding required');
  same(transport.brands, brands, 'brand scope changed'); same(transport.providers, providers, 'provider scope changed');
  const selectorKeys = ['promotionRunId', 'buildRunId', 'approvalIssue', 'approvalCommentId', 'rootPublicationRunId'];
  requireValue(transport.selector && Object.keys(transport.selector).length === selectorKeys.length &&
    selectorKeys.every(k => positive(transport.selector[k])), 'canonical authority selector required');
  same(Object.keys(transport.hosts || {}).sort(), Object.values(releases).sort(), 'exact canary releases required');
  requireValue(Array.isArray(manifest.hosts) && manifest.hosts.length === 2, 'two exact canary hosts required');
  const binding = runtimeBinding(manifest);
  same(binding.runtimeIdentity, transport.runtimeIdentity, 'manifest runtime differs from transport');
  const seen = new Map();
  for (const host of manifest.hosts) {
    requireValue(Object.hasOwn(releases, host.label) && releases[host.label] === host.release, 'host/release mismatch');
    for (const key of ['label', 'release', 'baseUrl', 'dataIdentity', 'serverId']) {
      requireValue(text(host[key]) && !(seen.get(key) || new Set()).has(host[key]), 'distinct host ' + key + ' required');
      if (!seen.has(key)) seen.set(key, new Set()); seen.get(key).add(host[key]);
    }
    same(host.ownership, { runId: manifest.runId, hostLabel: host.label }, 'host ownership changed');
    same(host.fixturePrefix, 'canary_' + manifest.runId, 'fixture prefix changed');
    same(host.runtimeIdentity, binding.runtimeIdentity, 'host runtime mismatch');
    const original = transport.hosts[host.release], baseline = original.baseline, proof = original.canonical, production = host.productionBinding;
    requireValue(production && baseline && proof, 'transport proof/baseline required');
    same(original.fixturePrefix, host.fixturePrefix, 'transport fixture scope differs');
    same(original.serverId, host.serverId, 'transport server differs');
    same(production.identity, baseline.identity, 'workload/Pod/PVC epoch differs');
    same(production.registryChain, baseline.runtime, 'registry chain differs');
    same(production.canonicalProofSha256, file.canonical(['hosts', host.release, 'canonical']), 'canonical proof hash differs');
    same(production.baselineSha256, file.canonical(['hosts', host.release, 'baseline']), 'baseline hash differs');
    same(baseline.dataIdentity, host.dataIdentity, 'host data differs');
    same(baseline.identity.image, transport.image, 'transport image differs');
    same(baseline.runtimeIdentity, binding.runtimeIdentity, 'baseline runtime differs');
    canonicalValid(proof, transport, baseline.identity);
    same(proof.chain, baseline.runtime, 'canonical/runtime chain differs');
    observedValid(baseline, host, null, file.canonical(['hosts', host.release, 'baseline', 'activity', 'mount']));
    const tunnel = production.tunnel, url = new URL(host.baseUrl);
    requireValue(url.protocol === 'http:' && url.hostname === '127.0.0.1' && positive(Number(url.port)) &&
      host.baseUrl === url.origin && !url.username && !url.password, 'adapter-owned loopback origin required');
    requireValue(tunnel && positive(tunnel.pid) && tunnel.podUid === baseline.identity.podUid && tunnel.origin === host.baseUrl &&
      Number.isFinite(tunnel.expiresAt) && tunnel.expiresAt > baseline.observedAt, 'owned tunnel epoch/expiry required');
    for (const key of ['deploymentUid', 'podUid', 'pvcUid', 'pvUid', 'containerId']) {
      const name = 'identity.' + key;
      requireValue(!(seen.get(name) || new Set()).has(baseline.identity[key]), 'hosts share ' + key);
      if (!seen.has(name)) seen.set(name, new Set()); seen.get(name).add(baseline.identity[key]);
    }
  }
  return { manifest, transport, reader, transportProof: file.proof, manifestProof: browserFile.proof, manifestSha256: browserFile.canonical() };
}

function sessionInvariant(manifest) {
  const value = structuredClone(manifest); delete value.guard.manifestPath;
  for (const host of value.hosts) { delete host.baseUrl; delete host.productionBinding.tunnel; }
  return value;
}

// Offline closure index only: copies original bytes and NEVER renews an action
// lease. Live report/guard admission remains bound to the selected session.
export function validateProductionManifest(manifest, options = {}) {
  const reader = productionReader(options.evidenceDirectory);
  const indexPath = path.join(reader.root, 'production-sessions.json');
  if (!fs.existsSync(indexPath)) return validateManifestFile(manifest, options);
  const index = reader.read('production-sessions.json'), value = index.value;
  const primary = reader.read(options.manifestName || 'browser-hosts.private.json');
  requireValue(value.schema === 'agent-connect-browser-sessions/v1' && value.scope === scope && value.runId === manifest.runId &&
    value.primarySourceManifestSha256 === primary.canonical() && hash(value.transportSha256) && value.sessions &&
    Object.keys(value.sessions).length > 0 && Object.keys(value.sessions).length <= 128, 'session index binding differs');
  const sessions = new Map();
  for (const [key, refs] of Object.entries(value.sessions)) {
    requireValue(hash(key) && equal(Object.keys(refs).sort(), ['manifest','transport']), 'session references required');
    const file = reader.read(refs.manifest), transport = reader.read(refs.transport);
    same(file.canonical(), key, 'session digest differs');
    same(transport.proof.sha256, value.transportSha256, 'session transport bytes differ');
    same(sessionInvariant(file.value), sessionInvariant(manifest), 'session original epoch differs');
    const context = validateManifestFile(file.value, { evidenceDirectory:reader.root,
      manifestName:refs.manifest.path, transportReference:refs.transport });
    sessions.set(key, context);
  }
  requireValue(sessions.has(value.primarySourceManifestSha256), 'primary session missing');
  const context = sessions.get(value.primarySourceManifestSha256);
  same(reader.read(context.manifestProof).raw, primary.raw, 'primary session bytes differ');
  same(primary.value, manifest, 'browser manifest differs');
  return { ...context, manifest, manifestProof:primary.proof, sessionIndex:index.proof, sessions };
}

export function validateProductionReport(report, context, { allowSessions = false } = {}) {
  requireValue(report?.scope === scope && report.runId === context.manifest.runId &&
    (report.sourceManifestSha256 === context.manifestSha256 ||
      (allowSessions && context.sessions?.has(report.sourceManifestSha256))), 'report scope/source manifest mismatch');
}

function receiptBinding(context, host) {
  return { schema: 1, scope, platform: 'k3s-paas', runId: context.manifest.runId, hostLabel: host.label, release: host.release,
    runtimeIdentity: host.runtimeIdentity, dataIdentity: host.dataIdentity, serverId: host.serverId,
    sourceManifestSha256: context.manifestSha256, productionMutations: true };
}

function assertBinding(value, binding) {
  for (const [key, expected] of Object.entries(binding)) same(value?.[key], expected, 'completion binding differs: ' + key);
}

function cleanResult(value) {
  requireValue(value?.status === 'passed' && value.passed === true && value.pending === false &&
    Array.isArray(value.conflicts) && value.conflicts.length === 0, 'completion failed, conflicting or pending');
}

function retained(before, after, files = before.activity.files) {
  for (const key of ['paseoKeypairSha256', 'wrapperCli']) same(after.ui[key], before.ui[key], 'persistent identity changed');
  same(after.ui.omnigent?.hostIdSha256, before.ui.omnigent?.hostIdSha256, 'Omnigent identity changed');
  for (const key of ['agents', 'availableAgents']) {
    const old = before.activity.snapshot[key], current = after.activity.snapshot[key];
    requireValue(new Set(current.map(x => x.id)).size === current.length && new Set(old.map(x => x.id)).size === old.length, 'ambiguous baseline agent inventory');
    for (const row of old) same(current.find(x => x.id === row.id), row, 'non-owned agent changed or missing');
  }
  for (const row of before.activity.piSessions) same(after.activity.piSessions.find(x => x.id === row.id), row, 'non-owned Pi session changed');
  for (const key of ['schedules', 'terminals']) same(after.activity.snapshot[key], before.activity.snapshot[key], 'non-owned background state changed');
  same(after.activity.files, files, 'non-owned definitions changed');
  for (const key of ['packageEnabled', 'packageInstalled']) same(after.activity.connector[key], before.activity.connector[key], 'package selection changed');
}

export function fixtureIdentifiers(runId, hostLabel) {
  requireValue(/^[a-f0-9]{32}$/.test(runId) && Object.hasOwn(releases, hostLabel), 'fixture run/host required');
  return { mcp: 'canary_' + runId, skill: 'canary-' + runId, memory: 'canary-' + runId + '-' + hostLabel };
}

export function requireCompleteInventory(entries, expected) {
  requireValue(Array.isArray(entries) && Array.isArray(expected) && expected.length > 0, 'complete ownership sources required');
  const identities = rows => rows.map(row => row.kind + '/' + row.key);
  const actualIds = identities(entries), expectedIds = identities(expected);
  requireValue(new Set(actualIds).size === actualIds.length && new Set(expectedIds).size === expectedIds.length,
    'duplicate inventory identity');
  same(actualIds.slice().sort(), expectedIds.slice().sort(), 'cleanup inventory is incomplete or includes foreign resources');
}

// These sources are independent of the cleanup result and cover every brand,
// provider, CLI sender, workspace, recovered agent and attempted Web write.
// Production adapters must emit sourceManifestSha256 and complete create/resolve
// records; the old isolated runner is not sufficient for this contract.
function ownedPhaseSources(context, host, used) {
  const expected = [], memoryKeys = new Set();
  for (const phase of brands) {
    const load = name => {
      const file = context.reader.read(`hosts/${host.label}/evidence/${phase}/${name}.json`); used.push(file.proof);
      const value = file.value; validateProductionReport(value, context, { allowSessions:true });
      if (context.sessions) {
        const capture = sourceFile(context, value.rawCapture, used).value;
        same(capture.binding.sourceManifestSha256, value.sourceManifestSha256, 'capture session relabelled');
        const raw = Buffer.from(capture.source.base64, 'base64');
        same(rawHash(raw), capture.source.sha256, 'capture raw bytes changed');
        same(value.rawSourceSha256, capture.source.sha256, 'capture source differs');
      }
      requireValue(value.phase === phase && value.hostLabel === host.label && value.runtimeIdentity === host.runtimeIdentity,
        'owned phase source binding differs');
      return value;
    };
    const report = load('provider-acceptance'), checkpoint = load('web-checkpoint.private');
    requireValue(Array.isArray(report.providers) && report.providers.length === providers.length &&
      equal(report.providers.map(x => x.provider).sort(), [...providers].sort()), 'complete provider ownership required');
    requireValue(Array.isArray(checkpoint.jobs) && checkpoint.jobs.length === providers.length &&
      equal(checkpoint.jobs.map(x => x.provider).sort(), [...providers].sort()), 'complete Web write ownership required');
    requireValue(Array.isArray(report.agents) && new Set(report.agents).size === report.agents.length &&
      report.agents.every(text), 'complete agent inventory required');
    requireValue(Array.isArray(report.communication?.edges) && report.communication.edges.length === providers.length &&
      equal(report.communication.edges.map(x => x.senderProvider).sort(), [...providers].sort()), 'complete CLI sender inventory required');
    for (const row of report.providers) requireValue(report.agents.includes(row.agentId), 'provider missing from owned agents');
    for (const row of report.communication.edges) requireValue(report.agents.includes(row.agentId), 'sender missing from owned agents');
    requireValue(Array.isArray(report.createAttempts) && report.createAttempts.length >= providers.length * 2 &&
      new Set(report.createAttempts.map(x => x.id)).size === report.createAttempts.length, 'all creation attempts required');
    requireValue(Array.isArray(report.creationResolutions) && report.creationResolutions.length === report.createAttempts.length,
      'all creation attempts must be resolved before cleanup');
    const resolved = [];
    for (const attempt of report.createAttempts) {
      const matches = report.creationResolutions.filter(x => x.attemptId === attempt.id);
      requireValue(matches.length === 1 && Array.isArray(matches[0].agentIds) && matches[0].agentIds.length > 0,
        'creation attempt lacks exact recovered agent IDs');
      resolved.push(...matches[0].agentIds);
    }
    same([...new Set(resolved)].sort(), [...report.agents].sort(), 'recovered creation IDs differ from owned inventory');
    expected.push(...report.agents.map(key => ({ kind: 'agent', key })));
    requireValue(text(report.workspaceId) && text(report.cliWorkspaceLifecycle?.workspaceId) &&
      report.workspaceId !== report.cliWorkspaceLifecycle.workspaceId && checkpoint.workspaceId === report.workspaceId,
      'both CLI and MCP workspaces required');
    expected.push({ kind: 'workspace', key: report.workspaceId }, { kind: 'workspace', key: report.cliWorkspaceLifecycle.workspaceId });
    for (const value of [...report.providers.map(x => x.write?.key), ...checkpoint.jobs.map(x => x.writeKey)]) {
      requireValue(text(value), 'every attempted memory write needs an exact key'); memoryKeys.add(value);
    }
  }
  return { expected, memoryKeys };
}

// Narrow evidence exceptions for the real locked MCP editor and attempted memory
// writes that never created a record. Neither is an approval or a broad hash bypass.
const mcpPath = '/data/pi-agent/mcp.json';
const proofDigest = value => canonical(Buffer.from(JSON.stringify(value)));
const exactRows = (rows, key = 'key') => {
  requireValue(Array.isArray(rows) && rows.every(r => r && text(r[key])), 'complete metadata inventory required');
  const result = new Map(rows.map(r => [r[key], r]));
  requireValue(result.size === rows.length, 'duplicate metadata identity'); return result;
};
function sourceFile(context, reference, used, options) {
  const file = context.reader.read(reference, options); used.push(file.proof); return file;
}
function resourceObservation(value, binding, baseline) {
  requireValue(value?.scope === scope && value.productionMutations === false && value.complete === true,
    'complete read-only resource observation required');
  for (const key of ['runId', 'hostLabel', 'release', 'runtimeIdentity', 'dataIdentity', 'serverId'])
    same(value[key], binding[key], 'resource observation binding changed');
  same(value.identity, baseline.identity, 'resource epoch changed');
  requireValue(Number.isFinite(value.startedAt) && Number.isFinite(value.observedAt) &&
    value.startedAt <= value.observedAt && value.observedAt - value.startedAt <= 30, 'resource observation interval invalid');
}
function returnedFixture(context, reference, action, binding, baseline, used) {
  const file = sourceFile(context, reference.journal, used, { json: false });
  const lines = file.raw.toString().trim().split('\n');
  requireValue(lines.length === 2, 'exact returned fixture journal required');
  const rows = lines.map(line => JSON.parse(line));
  let previous = null;
  rows.forEach((row, i) => {
    for (const key of ['scope', 'runId', 'release', 'runtimeIdentity', 'dataIdentity', 'serverId'])
      same(row[key], binding[key], 'fixture journal binding changed');
    same(row.action, action, 'fixture journal action changed');
    same(row.podUid, baseline.identity.podUid, 'fixture journal Pod changed');
    same(row.canonicalSha256, proofDigest(context.transport.hosts[binding.release].canonical), 'fixture journal canonical changed');
    requireValue(brands.includes(row.phase) && row.productionMutations === true && row.sequence === i &&
      row.previousSha256 === previous && row.status === (i ? 'returned' : 'dispatching_do_not_retry') &&
      hash(row.payloadSha256) && text(row.attempt) && Number.isFinite(row.at) && Number.isFinite(row.deadline), 'fixture journal sequence/intent changed');
    const { entrySha256, ...body } = row;
    // Parse the original line in Python so integer versus float identity is retained.
    const actual = execFileSync('python3', ['-c',
      'import json,sys,hashlib;v=json.load(sys.stdin);v.pop("entrySha256");print(hashlib.sha256(json.dumps(v,sort_keys=True,separators=(",",":")).encode()).hexdigest())'],
      { input: lines[i], encoding: 'utf8', timeout: 10000 }).trim();
    same(entrySha256, actual, 'fixture journal hash changed'); previous = entrySha256;
  });
  const mutable = new Set(['sequence', 'at', 'previousSha256', 'entrySha256', 'status', 'resultSha256']);
  same(Object.fromEntries(Object.entries(rows[0]).filter(([k]) => !mutable.has(k))),
    Object.fromEntries(Object.entries(rows[1]).filter(([k]) => !mutable.has(k))), 'fixture intent changed');
  requireValue(rows[0].at <= rows[1].at, 'fixture return precedes dispatch');
  const result = sourceFile(context, reference.result, used);
  for (const key of ['scope', 'runId', 'release', 'phase', 'action', 'runtimeIdentity', 'dataIdentity', 'serverId', 'podUid', 'canonicalSha256', 'deadline'])
    same(result.value[key], rows[1][key], 'fixture return binding changed');
  requireValue(result.value.productionMutations === true, 'actual mutation result required');
  same(result.canonical(['result']), rows[1].resultSha256, 'fixture returned bytes changed');
  return { intent: rows[0], returned: rows[1], value: result.value.result };
}
function mcpDocument(observation) {
  const encoded = observation.mcp?.rawBase64;
  requireValue(typeof encoded === 'string', 'actual MCP bytes required');
  const raw = Buffer.from(encoded, 'base64');
  same(raw.toString('base64'), encoded, 'invalid MCP byte encoding');
  const value = JSON.parse(raw);
  requireValue(value && !Array.isArray(value) && value.mcpServers && typeof value.mcpServers === 'object' &&
    !Array.isArray(value.mcpServers), 'MCP document shape changed');
  return { value, sha256: rawHash(raw) };
}
function mcpPreservation(reference, context, host, binding, before, after, used) {
  const receipt = sourceFile(context, reference, used).value; assertBinding(receipt, binding);
  same(receipt.method, 'owned-entry-cas-semantic-preservation/v1', 'typed MCP preservation proof required');
  const fixture = sourceFile(context, receipt.fixtureManifest, used);
  const identifiers = fixtureIdentifiers(binding.runId, host.label);
  for (const key of ['scope', 'runId', 'hostLabel', 'runtimeIdentity']) same(fixture.value[key], binding[key], 'fixture manifest scope changed');
  same(fixture.value.fixtureMcpName, identifiers.mcp, 'fixture MCP name changed');
  const prepared = returnedFixture(context, receipt.prepare, 'fixture-prepare', binding, before, used);
  same(prepared.value.status, 'ready', 'original fixture not prepared');
  same(prepared.value.manifestSha256, fixture.proof.sha256, 'immutable fixture bytes changed');
  same(prepared.value.fixtureMcpName, identifiers.mcp, 'prepared MCP name changed');
  same(prepared.value.mcpEntryHash, fixture.value.mcpEntryHash, 'prepared MCP hash changed');
  const cleanup = returnedFixture(context, receipt.cleanup, 'fixture-cleanup', binding, before, used);
  same(cleanup.value.status, 'cleaned', 'fixture cleanup not returned clean'); same(cleanup.value.conflicts, [], 'cleanup conflicts');
  same(cleanup.value.mcpEdit, { action: 'remove', present: false, removedSha256: fixture.value.mcpEntryHash }, 'actual locked MCP CAS return required');
  const pre = sourceFile(context, receipt.before, used).value, post = sourceFile(context, receipt.after, used).value;
  for (const value of [pre, post]) resourceObservation(value, binding, before);
  requireValue(prepared.returned.at < pre.startedAt && pre.observedAt <= cleanup.intent.at &&
    cleanup.returned.at <= post.startedAt && Math.abs(after.observedAt - post.observedAt) <= 30, 'MCP cleanup observation ordering changed');
  let old = {};
  requireValue(Object.hasOwn(before.activity.files, mcpPath), 'original MCP inventory required');
  if (receipt.baselineMcp === null) same(before.activity.files[mcpPath], null, 'original MCP was not absent');
  else {
    const original = sourceFile(context, receipt.baselineMcp, used);
    same(original.proof.sha256, before.activity.files[mcpPath], 'original MCP bytes changed'); old = original.value;
  }
  const a = mcpDocument(pre), b = mcpDocument(post), name = identifiers.mcp;
  const oldServers = old.mcpServers ?? {};
  requireValue(!Object.hasOwn(oldServers, name), 'MCP entry was not owned');
  same(a.value.mcpServers[name], fixture.value.mcpEntry, 'owned MCP entry changed');
  const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ?
    Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])])) : value;
  same(rawHash(JSON.stringify(stable(fixture.value.mcpEntry))), fixture.value.mcpEntryHash, 'owned MCP digest changed');
  for (const [key, value] of Object.entries(old)) if (key !== 'mcpServers') {
    same(a.value[key], value, 'original MCP field changed'); same(b.value[key], value, 'original MCP field changed');
  }
  for (const [key, value] of Object.entries(oldServers)) {
    same(a.value.mcpServers[key], value, 'original MCP entry changed'); same(b.value.mcpServers[key], value, 'original MCP entry changed');
  }
  const expected = structuredClone(a.value); delete expected.mcpServers[name];
  same(b.value, expected, 'non-owned concurrent MCP update lost or changed');
  same(after.activity.files[mcpPath], b.sha256, 'MCP observation differs from final files');
  return { ...before.activity.files, [mcpPath]: b.sha256 };
}
function memoryPreservation(reference, context, host, binding, baseline, current, used) {
  const proof = sourceFile(context, reference, used).value; assertBinding(proof, binding);
  same(proof.method, 'complete-memory-preservation/v1', 'typed memory preservation proof required');
  const observations = ['baseline', 'before', 'after'].map(k => sourceFile(context, proof[k], used).value);
  const inventories = observations.map(value => {
    resourceObservation(value, binding, baseline);
    requireValue(value.allMemory?.complete === true, 'complete global memory inventory required');
    const rows = exactRows(value.allMemory.entries);
    for (const row of rows.values()) requireValue(text(row.revision) && hash(row.contentSha256) && hash(row.fileSha256), 'memory metadata incomplete');
    return rows;
  });
  same(observations[0].baselineSha256, host.productionBinding.baselineSha256, 'original memory baseline changed');
  requireValue(observations[0].observedAt <= observations[1].startedAt && observations[1].observedAt <= observations[2].startedAt &&
    Math.abs(current.observedAt - observations[2].observedAt) <= 30, 'memory observation order changed');
  const prefix = fixtureIdentifiers(binding.runId, host.label).memory;
  const owned = key => key === prefix || key.startsWith(prefix + '-');
  for (const [key, row] of inventories[0]) {
    requireValue(!owned(key), 'memory namespace originally occupied');
    same(inventories[1].get(key), row, 'original non-owned memory changed'); same(inventories[2].get(key), row, 'original non-owned memory changed');
  }
  for (const [key, row] of inventories[1]) if (!owned(key)) same(inventories[2].get(key), row, 'concurrent non-owned memory changed');
  requireValue(![...inventories[2].keys()].some(owned), 'owned memory remains');
  for (const i of [1, 2]) {
    same(observations[i].memory.prefix, prefix, 'memory namespace changed');
    same(exactRows(observations[i].memory.entries), new Map([...inventories[i]].filter(([key]) => owned(key))), 'memory prefix inventory incomplete');
  }
}
function absentMemory(entry, outcome, evidence, context, host, binding, baseline, used) {
  requireValue(evidence && outcome.method === 'complete-namespace-absence' && outcome.afterExists === false &&
    !Object.hasOwn(entry, 'revision') && !Object.hasOwn(entry, 'sha256') && !Object.hasOwn(outcome, 'beforeSha256'), 'typed absent memory proof required');
  const before = sourceFile(context, evidence.before, used).value, after = sourceFile(context, evidence.after, used).value;
  for (const value of [before, after]) {
    resourceObservation(value, binding, baseline);
    same(value.memory.prefix, fixtureIdentifiers(binding.runId, host.label).memory, 'absence namespace changed');
    requireValue(value.allMemory?.complete === true && !exactRows(value.allMemory.entries).has(entry.key) &&
      !exactRows(value.memory.entries).has(entry.key), 'attempted memory actually exists');
  }
  const cleanup = returnedFixture(context, evidence.cleanup, 'fixture-cleanup', binding, baseline, used);
  same(cleanup.value.status, 'cleaned', 'cleanup not returned clean'); same(cleanup.value.conflicts, [], 'cleanup conflicts');
  same(exactRows(cleanup.value.memories).get(entry.key), { key: entry.key, status: 'absent' }, 'actual returned memory absence required');
  requireValue(before.observedAt <= cleanup.intent.at && cleanup.returned.at <= after.startedAt, 'memory absence ordering changed');
}

function checkObservations(name, observations, context, host, binding, used) {
  requireValue(observations && typeof observations === 'object' && !Array.isArray(observations), 'typed observations required');
  const load = key => { const file = context.reader.read(observations[key]); used.push(file.proof); return file; };
  const baseline = context.transport.hosts[host.release].baseline;
  const observed = key => {
    const file = load(key);
    observedValid(file.value, host, baseline, file.canonical(['activity', 'mount']));
    return file;
  };
  if (name === 'canonical-runtime-provenance') {
    const current = observed('current'), proof = load('canonical');
    canonicalValid(proof.value, context.transport, current.value.identity);
    const { verifiedAt, ...identity } = proof.value;
    same(identity, context.transport.hosts[host.release].canonical, 'current canonical proof changed');
    requireValue(Number.isFinite(verifiedAt) && Math.abs(current.value.observedAt - verifiedAt) <= 30, 'current canonical verification missing/stale');
  } else if (name === 'non-owned-baseline-preserved') {
    const before = load('before'), after = observed('after');
    same(before.canonical(), host.productionBinding.baselineSha256, 'baseline source changed');
    const files = observations.mcpPreservation ? mcpPreservation(observations.mcpPreservation, context, host, binding, before.value, after.value, used) : before.value.activity.files;
    retained(before.value, after.value, files);
    if (observations.memoryPreservation) memoryPreservation(observations.memoryPreservation, context, host, binding, before.value, after.value, used);
  } else if (name === 'configuration-restoration') {
    const receipt = load('restoration').value;
    assertBinding(receipt, binding); cleanResult(receipt);
    const fields = ['selectedTarget', 'enabled', 'daemonRunning', 'packageEnabled', 'packageInstalled'];
    for (const key of fields) {
      requireValue(Object.hasOwn(receipt.original || {}, key) && Object.hasOwn(receipt.expectedCurrent || {}, key) &&
        Object.hasOwn(receipt.observedBefore || {}, key) && Object.hasOwn(receipt.restored || {}, key), 'restoration fields incomplete');
      same(receipt.original[key], baseline.activity.connector[key], 'restoration original differs');
      same(receipt.observedBefore[key], receipt.expectedCurrent[key], 'compare-before-restore conflict');
      same(receipt.restored[key], receipt.original[key], 'original configuration not restored');
    }
    requireValue(Array.isArray(receipt.changedFields) && new Set(receipt.changedFields).size === receipt.changedFields.length &&
      receipt.changedFields.every(k => ['selectedTarget', 'enabled', 'daemonRunning'].includes(k)), 'restore touches unowned fields');
    same(receipt.changedFields.slice().sort(), fields.filter(k => !equal(receipt.original[k], receipt.expectedCurrent[k])).sort(), 'restore delta differs');
    const after = observed('after');
    for (const key of fields) same(after.value.activity.connector[key], receipt.restored[key], 'restore not observed');
    requireValue(after.value.activity.connector.configurationPending === false, 'restoration still pending');
    if (receipt.restored.daemonRunning) same(after.value.activity.connector.activeTarget, receipt.restored.selectedTarget, 'active target not restored');
  } else {
    const inventory = load('inventory').value, result = load('result').value;
    assertBinding(inventory, binding); assertBinding(result, binding); cleanResult(result);
    requireValue(Array.isArray(inventory.entries) && inventory.entries.length > 0 && Array.isArray(result.entries) &&
      result.entries.length === inventory.entries.length, 'exact cleanup inventory required');
    const sources = ownedPhaseSources(context, host, used);
    const identifiers = fixtureIdentifiers(binding.runId, host.label);
    let fixture;
    if (name === 'owned-agent-cleanup') requireCompleteInventory(inventory.entries, sources.expected);
    else {
      fixture = load('fixtureManifest').value;
      requireValue(fixture.scope === scope && fixture.runId === binding.runId && fixture.hostLabel === host.label &&
        fixture.runtimeIdentity === host.runtimeIdentity, 'fixture manifest binding differs');
      same(fixture.fixtureMcpName, identifiers.mcp, 'fixture MCP name differs');
      same(fixture.skillName, identifiers.skill, 'fixture skill name differs');
      same(fixture.localMemoryKey, identifiers.memory, 'fixture memory key differs');
      requireValue(Array.isArray(fixture.attemptedWrites), 'complete attempted-write inventory required');
      for (const write of fixture.attemptedWrites) { requireValue(text(write.key), 'invalid attempted write'); sources.memoryKeys.add(write.key); }
      sources.memoryKeys.add(identifiers.memory);
      requireCompleteInventory(inventory.entries, [{ kind: 'mcp', key: identifiers.mcp }, { kind: 'skill', key: identifiers.skill },
        ...[...sources.memoryKeys].map(key => ({ kind: 'memory', key }))]);
      for (const entry of inventory.entries) {
        if (entry.kind === 'mcp') same(entry.sha256, fixture.mcpEntryHash, 'MCP creation digest differs');
        if (entry.kind === 'skill') same(entry.sha256, fixture.skillSha256, 'skill creation digest differs');
      }
    }
    const ids = new Set(), results = new Set();
    for (const entry of result.entries) { requireValue(text(entry.key) && !results.has(entry.key), 'duplicate cleanup result'); results.add(entry.key); }
    for (const entry of inventory.entries) {
      requireValue(text(entry.key) && !ids.has(entry.key), 'duplicate cleanup ownership'); ids.add(entry.key);
      const outcome = result.entries.find(x => x.key === entry.key);
      requireValue(outcome && outcome.kind === entry.kind, 'cleanup result ownership mismatch');
      if (name === 'owned-agent-cleanup') {
        requireValue(['agent', 'workspace'].includes(entry.kind) && brands.includes(entry.phase) && text(entry.attempt) &&
          entry.runId === binding.runId, 'owned lifecycle scope required');
        requireValue(!baseline.activity.snapshot.agents.some(x => x.id === entry.key), 'baseline agent never cleanup-owned');
        if (entry.kind === 'agent') requireValue(providers.includes(entry.provider), 'cleanup provider required');
        requireValue(['cli-delete', 'mcp-archive', 'workspace-archive'].includes(entry.operation) && outcome.operation === entry.operation, 'cleanup operation mismatch');
        if (entry.operation === 'cli-delete') requireValue(entry.kind === 'agent' && outcome.absent === true, 'exact deleted agent absence required');
        else requireValue(outcome.archived === true && (entry.kind === 'workspace' ? outcome.directoryRetained === true : outcome.retainedInArchive === true), 'exact archive retention required');
      } else {
        requireValue(['mcp', 'skill', 'memory'].includes(entry.kind) &&
          (hash(entry.sha256) || (entry.kind === 'memory' && entry.state === 'observed-absent')), 'owned fixture scope/hash required');
        if (entry.kind !== 'memory') same(entry.key, identifiers[entry.kind], 'typed fixture identifier differs');
        else requireValue(entry.key === identifiers.memory || (entry.key.startsWith(identifiers.memory + '-') && sources.memoryKeys.has(entry.key)),
          'memory key must have exact host scope and independent write evidence');
        if (entry.kind === 'memory' && entry.state === 'observed-absent') {
          requireValue(fixture.attemptedWrites.some(write => write.key === entry.key), 'absent memory requires attempted write evidence');
          absentMemory(entry, outcome, result.evidence, context, host, binding, baseline, used);
          continue;
        }
        requireValue(outcome.beforeSha256 === entry.sha256 && outcome.afterExists === false, 'fixture changed or remains');
        if (entry.kind === 'mcp') same(outcome.method, 'locked-config-compare-delete', 'atomic MCP comparison required');
        if (entry.kind === 'skill') {
          same(outcome.method, 'exact-file-unlink', 'safe skill unlink required');
          same(outcome.beforeTree, [{ path: 'SKILL.md', type: 'file', sha256: entry.sha256 }], 'skill tree changed');
        }
        if (entry.kind === 'memory') requireValue(outcome.method === 'memory-cas-delete' && text(String(entry.revision ?? '')) &&
          outcome.expectedRevision === entry.revision && outcome.observedRevision === entry.revision, 'memory revision CAS required');
      }
    }
  }
}

function sessionClosure(completion, context, host, used) {
  if (!context.sessions) return;
  used.push(context.sessionIndex);
  for (const session of context.sessions.values()) used.push(session.manifestProof, session.transportProof);
  const provenances = Object.values(completion.cases).map(row => sourceFile(context, row.evidence, used).value.provenance);
  requireValue(provenances.length === productionCases.length && provenances.every(ref => equal(ref, provenances[0])), 'completion provenance differs');
  const p = sourceFile(context, provenances[0], used).value, binding = receiptBinding(context, host);
  assertBinding(p, binding); same(p.sessionIndex, context.sessionIndex, 'session index reference differs');
  same(Object.keys(p.phaseCaptures || {}).sort(), [...brands].sort(), 'all session phase captures required');
  for (const phase of brands) {
    const captures = p.phaseCaptures[phase];
    same(Object.keys(captures).sort(), ['acceptance-manifest.json','provider-acceptance.json','web-checkpoint.private.json','web-jobs.json'], 'four original captures required');
    let sessionHash;
    for (const ref of Object.values(captures)) {
      const capture = sourceFile(context, ref, used).value;
      for (const key of ['scope','runId','release','runtimeIdentity','dataIdentity','serverId']) same(capture.binding[key], binding[key], 'capture original epoch differs');
      same(capture.binding.phase, phase, 'capture phase differs');
      requireValue(context.sessions.has(capture.binding.sourceManifestSha256), 'capture session missing');
      sessionHash ??= capture.binding.sourceManifestSha256;
      same(capture.binding.sourceManifestSha256, sessionHash, 'phase capture session differs');
      same(rawHash(Buffer.from(capture.source.base64, 'base64')), capture.source.sha256, 'capture raw bytes differ');
    }
  }
  const browserActions = new Set(['connector.save-target','connector.stop','connector.start','connector.pair',
    'pair.accept','coordination.enable','conversation.model-set','conversation.send']);
  const browserRows = new Map(), baseline = context.transport.hosts[host.release].baseline;
  for (const [name, refs] of Object.entries(p.journals)) {
    const file = sourceFile(context, refs.journal, used, {json:false});
    const intent = JSON.parse(file.raw.toString().split('\n')[0]);
    if (!browserActions.has(intent.action) && !Object.hasOwn(intent,'sourceManifestSha256')) continue;
    const session = context.sessions.get(intent.sourceManifestSha256);
    requireValue(session, 'journal session missing');
    const original = session.manifest.hosts.find(row => row.release === host.release).productionBinding;
    const record = returnedFixture(context, refs, intent.action, binding, baseline, used);
    same(record.intent.identity, original.identity, 'journal session epoch differs');
    same(record.intent.tunnel, original.tunnel, 'journal original tunnel differs');
    requireValue(record.intent.at <= record.intent.deadline && record.intent.deadline <= original.tunnel.expiresAt,
      'journal original lease expired');
    const result = sourceFile(context, refs.result, used).value;
    same(result.sourceManifestSha256, intent.sourceManifestSha256, 'returned session differs');
    browserRows.set(name, record.intent);
  }
  const seq = sourceFile(context, p.inputs.restoreSequence, used).value;
  requireValue(context.sessions.has(seq.sourceManifestSha256), 'restoration session missing');
  for (const key of ['scope','runId','release','runtimeIdentity','dataIdentity','serverId']) same(seq[key], binding[key], 'restoration original epoch differs');
  const originalRef = ref => {
    const retained = p.restorationSources?.[ref.path];
    requireValue(retained?.sha256 === ref.sha256, 'original restoration reference missing');
    return sourceFile(context, retained, used).value;
  };
  const plan = originalRef(seq.intent);
  same(plan.sourceManifestSha256, seq.sourceManifestSha256, 'restoration intent session differs');
  for (const step of seq.steps) {
    for (const response of [step.begin, step.finish]) {
      const original = originalRef(response.journal);
      same(original.sourceManifestSha256, seq.sourceManifestSha256, 'restoration journal session differs');
      const matched = [...browserRows.values()].filter(row => row.attemptId === response.attemptId);
      requireValue(matched.length === 1 && matched[0].sourceManifestSha256 === seq.sourceManifestSha256, 'restoration journal missing');
    }
  }
}

export function productionCompletion(context, host) {
  const name = `hosts/${host.label}/production-completion.json`, binding = receiptBinding(context, host);
  let completion, error; const sessionProofs = [];
  try { completion = context.reader.read(name); assertBinding(completion.value, binding);
    requireValue(completion.value.status === 'passed', 'completion incomplete');
    same(Object.keys(completion.value.cases || {}).sort(), [...productionCases].sort(), 'completion case set differs');
    sessionClosure(completion.value, context, host, sessionProofs);
  } catch (e) { error = e; }
  return productionCases.map(testCase => {
    const used = [context.manifestProof, context.transportProof, ...(completion ? [completion.proof] : []), ...sessionProofs];
    try {
      if (error) throw error;
      const row = completion.value.cases[testCase]; requireValue(row.passed === true, 'case not passed');
      const file = context.reader.read(row.evidence); used.push(file.proof);
      assertBinding(file.value, binding); same(file.value.case, testCase, 'completion case differs'); cleanResult(file.value);
      checkObservations(testCase, file.value.observations, context, host, binding, used);
      return { host: host.label, case: testCase, status: 'pass', evidence: used };
    } catch (e) {
      return { host: host.label, case: testCase, status: e.code === 'ENOENT' ? 'unrun' : 'fail', evidence: used, problem: e.message };
    }
  });
}
