import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { validateManifest, configuration } from './browser/common.mjs';
import { compile } from './compile.mjs';
import { audit } from './audit.mjs';
import { validateProductionManifest, productionCases, productionCompletion, fixtureIdentifiers, requireCompleteInventory } from './production-scope.mjs';

// Entirely synthetic. No authority, production credentials, service calls or real receipts.
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const canonical = value => execFileSync('python3', ['-c',
  'import sys,json,hashlib;print(hashlib.sha256(json.dumps(json.load(sys.stdin),sort_keys=True,separators=(",",":")).encode()).hexdigest())'],
  { input: JSON.stringify(value), encoding: 'utf8' }).trim();
const digest = c => 'sha256:' + c.repeat(64);
const releases = { pi3: 'svc-febb366b', pi4: 'svc-966321b4' };
const runId = 'a'.repeat(32), timestamp = 1795276800.25;
const chain = { index: digest('a'), manifest: digest('b'), config: digest('c'), runtimeIdentity: 'image:' + digest('b'), architecture: 'amd64' };
const selector = { promotionRunId: 2, buildRunId: 1, approvalIssue: 4, approvalCommentId: 5, rootPublicationRunId: 11 };
const image = 'jcr-prod.woowtech.io/woow-paas-docker-local/pi-agent:synthetic@' + chain.index;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synthetic-canary-schema-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (file, value) => {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const bytes = JSON.stringify(value, null, 2) + '\n';
    fs.writeFileSync(target, bytes, { mode: 0o600 });
    return { path: file, sha256: sha(bytes) };
  };
  const transport = { schema: 1, scope: 'production-canary', runId, context: 'woow-k3s', namespace: 'paas-ws-504a2b17',
    productionMutations: false, image, selector: structuredClone(selector), runtimeIdentity: chain.runtimeIdentity, createdAt: timestamp,
    brands: ['woowtech', 'apporo', 'paseo'], providers: ['claude', 'codex', 'pi'], hosts: {} };
  const browser = { schema: 1, scope: 'production-canary', platform: 'k3s-paas', runId, productionMutations: true,
    runtime: { kind: 'container-image', imageId: chain.manifest }, imageId: chain.manifest, hosts: [] };
  for (const [label, release] of Object.entries(releases)) {
    const identity = { context: transport.context, namespace: transport.namespace, container: 'pi-web',
      deploymentUid: label + '-deployment-uid', podUid: label + '-pod-uid', podName: release + '-pi-agent-pod',
      replicaSetUid: label + '-replica-uid', nodeUid: 'shared-node-uid', nodeName: 'synthetic-node', architecture: 'amd64',
      image, criImageId: chain.manifest, containerId: 'containerd://' + label,
      pvcUid: label + '-pvc-uid', pvcName: label + '-pvc', pvUid: label + '-pv-uid', pvName: label + '-pv',
      csi: { driver: 'driver.longhorn.io', volumeHandle: label + '-volume' } };
    const mount = { device: label + '-device', root: '/', mountpoint: '/data/pi-agent', fsType: 'ext4',
      source: '/dev/longhorn/' + identity.csi.volumeHandle, statDevice: 100, inode: 200 };
    const serverId = label + '-server';
    const baseline = { scope: 'production-canary', productionMutations: false, observedAt: timestamp,
      ledger: { id: label === 'pi3' ? 173 : 172, release, namespace: transport.namespace }, identity, runtime: structuredClone(chain),
      runtimeIdentity: chain.runtimeIdentity, dataIdentity: 'pvc:' + identity.pvcUid + ':' + canonical(mount),
      ui: { paseoKeypairSha256: 'd'.repeat(64), wrapperCli: 'synthetic-cli', omnigent: { hostIdSha256: 'e'.repeat(64) } },
      activity: { startedAt: timestamp - 1, observedAt: timestamp, mount, piRunningIds: [], piSessions: [{ id: label + '-user-session', rpcAlive: false }],
        files: { '/data/pi-agent/settings.json': 'f'.repeat(64) }, connector: { selectedTarget: 'apporo', activeTarget: 'apporo', configurationPending: false,
          enabled: true, daemonRunning: true, packageEnabled: true, packageInstalled: true },
        snapshot: { complete: true, serverId, agents: [{ id: label + '-archived-user', status: 'closed', title: '使用者🐈' }],
          availableAgents: [], schedules: [], terminals: [], daemon: 'synthetic-daemon' } } };
    const proof = { scope: 'production-canary', selector: structuredClone(selector), source: 'a'.repeat(40), image, chain: structuredClone(chain),
      root: { publicationRunId: 11, digest: digest('d'), revision: 'b'.repeat(40), baseManifest: digest('d'), receiptSha256: 'f'.repeat(64) },
      approval: { issue: 4, comment: 5, actor: 'synthetic-reviewer', issueSha256: '1'.repeat(64), commentSha256: '2'.repeat(64), policySha256: '3'.repeat(64) },
      sourceHashes: { ['a'.repeat(40)]: { '.gitea/workflows/build-pi-agent-image.yml': digest('e'), 'scripts/synthetic.sh': digest('f') } },
      jobLogs: { build: digest('1'), promotion: digest('2') } };
    transport.hosts[release] = { baseline, canonical: proof, serverId, fixturePrefix: 'canary_' + runId };
    const baseUrl = 'http://127.0.0.1:' + (label === 'pi3' ? 31001 : 31002);
    browser.hosts.push({ label, release, baseUrl, runtimeIdentity: chain.runtimeIdentity, dataIdentity: baseline.dataIdentity, serverId,
      ownership: { runId, hostLabel: label }, fixturePrefix: 'canary_' + runId,
      productionBinding: { identity: structuredClone(identity), registryChain: structuredClone(chain),
        canonicalProofSha256: canonical(proof), baselineSha256: canonical(baseline),
        tunnel: { pid: label === 'pi3' ? 1001 : 1002, podUid: identity.podUid, origin: baseUrl, expiresAt: timestamp + 600 } } });
  }
  const save = () => {
    const proof = put('validation-manifest.json', transport);
    browser.guard = { manifestPath: path.join(root, proof.path), manifestSha256: proof.sha256 };
    return put('browser-hosts.private.json', browser);
  };
  save();
  const options = { evidenceDirectory: root };
  return { root, put, transport, browser, save, options };
}

function completionFixture(f) {
  const host = f.browser.hosts[0], baseline = f.transport.hosts[host.release].baseline;
  const binding = { schema: 1, scope: 'production-canary', platform: 'k3s-paas', runId,
    hostLabel: host.label, release: host.release, runtimeIdentity: host.runtimeIdentity, dataIdentity: host.dataIdentity,
    serverId: host.serverId, sourceManifestSha256: canonical(f.browser), productionMutations: true };
  const success = { status: 'passed', passed: true, pending: false, conflicts: [] };
  const fixtures = fixtureIdentifiers(runId, host.label);
  const resourceManifest = { ...binding, fixtureMcpName: fixtures.mcp, skillName: fixtures.skill, localMemoryKey: fixtures.memory,
    mcpEntryHash: '1'.repeat(64), skillSha256: '2'.repeat(64), attemptedWrites: [] };
  const owned = { ...binding, entries: [] };
  const resources = { ...binding, entries: [{ kind: 'mcp', key: fixtures.mcp, sha256: resourceManifest.mcpEntryHash },
    { kind: 'skill', key: fixtures.skill, sha256: resourceManifest.skillSha256 },
    { kind: 'memory', key: fixtures.memory, sha256: '3'.repeat(64), revision: 'rev-base' }] };
  const phases = [];
  for (const phase of ['woowtech', 'apporo', 'paseo']) {
    const report = { ...binding, phase, workspaceId: phase + '-mcp-workspace', cliWorkspaceLifecycle: { workspaceId: phase + '-cli-workspace' },
      providers: [], communication: { edges: [] }, agents: [], createAttempts: [], creationResolutions: [] };
    const checkpoint = { ...binding, phase, workspaceId: report.workspaceId, jobs: [] };
    for (const provider of ['claude', 'codex', 'pi']) {
      const receiver = phase + '-' + provider, sender = receiver + '-sender';
      for (const key of [receiver, sender]) {
        const attempt = 'attempt-' + key;
        report.agents.push(key); report.createAttempts.push({ id: attempt, provider });
        report.creationResolutions.push({ attemptId: attempt, agentIds: [key] });
        owned.entries.push({ kind: 'agent', key, phase, provider, runId, attempt, operation: 'cli-delete' });
      }
      const key = fixtures.memory + '-' + phase + '-' + provider;
      report.providers.push({ provider, agentId: receiver, write: { key } });
      report.communication.edges.push({ senderProvider: provider, agentId: sender });
      checkpoint.jobs.push({ provider, agentId: receiver, writeKey: key + '-web' });
      for (const memoryKey of [key, key + '-web']) {
        resourceManifest.attemptedWrites.push({ key: memoryKey });
        resources.entries.push({ kind: 'memory', key: memoryKey, sha256: '3'.repeat(64), revision: 'rev-' + memoryKey });
      }
    }
    for (const key of [report.workspaceId, report.cliWorkspaceLifecycle.workspaceId]) owned.entries.push({ kind: 'workspace', key, runId, phase, attempt: 'workspace-' + key, operation: 'workspace-archive' });
    phases.push({ report, checkpoint });
  }
  const ownedResult = { ...binding, ...success, entries: owned.entries.map(e => ({ kind: e.kind, key: e.key, operation: e.operation,
    ...(e.kind === 'agent' ? { absent: true } : { archived: true, directoryRetained: true }) })) };
  const resourceResult = { ...binding, ...success, entries: resources.entries.map(e => ({ kind: e.kind, key: e.key, beforeSha256: e.sha256, afterExists: false,
    ...(e.kind === 'mcp' ? { method: 'locked-config-compare-delete' } : e.kind === 'skill' ? { method: 'exact-file-unlink', beforeTree: [{ path: 'SKILL.md', type: 'file', sha256: e.sha256 }] } :
      { method: 'memory-cas-delete', expectedRevision: e.revision, observedRevision: e.revision }) })) };
  const connector = baseline.activity.connector;
  const restoration = { ...binding, ...success, original: structuredClone(connector), expectedCurrent: structuredClone(connector),
    observedBefore: structuredClone(connector), restored: structuredClone(connector), changedFields: [] };
  const after = structuredClone(baseline);
  const proof = { ...structuredClone(f.transport.hosts[host.release].canonical), verifiedAt: baseline.observedAt };
  const save = () => {
    for (const { report, checkpoint } of phases) {
      f.put(`hosts/pi3/evidence/${report.phase}/provider-acceptance.json`, report);
      f.put(`hosts/pi3/evidence/${report.phase}/web-checkpoint.private.json`, checkpoint);
    }
    const beforeRef = f.put('safety/before.json', baseline), afterRef = f.put('safety/after.json', after);
    const observations = {
      'canonical-runtime-provenance': { canonical: f.put('safety/canonical.json', proof), current: afterRef },
      'non-owned-baseline-preserved': { before: beforeRef, after: afterRef },
      'owned-agent-cleanup': { inventory: f.put('safety/owned-inventory.json', owned), result: f.put('safety/owned-result.json', ownedResult) },
      'fixture-cleanup': { inventory: f.put('safety/fixture-inventory.json', resources), result: f.put('safety/fixture-result.json', resourceResult), fixtureManifest: f.put('safety/fixture-manifest.json', resourceManifest) },
      'configuration-restoration': { restoration: f.put('safety/restoration.json', restoration), after: afterRef },
    };
    const cases = {};
    for (const name of productionCases) cases[name] = { passed: true, evidence: f.put('safety/' + name + '.json', { ...binding, ...success, case: name, observations: observations[name] }) };
    f.put('hosts/pi3/production-completion.json', { ...binding, status: 'passed', cases });
    return productionCompletion(validateProductionManifest(f.browser, f.options), host);
  };
  return { save, owned, ownedResult, resources, resourceResult, resourceManifest, restoration, phases, after, proof };
}

test('explicit production evidence manifest accepts bound transport proof, independent of isolated authorization boolean', t => {
  const f = fixture(t);
  assert.equal(validateManifest(f.browser, f.options), f.browser);
  const context = validateProductionManifest(f.browser, f.options);
  assert.equal(context.manifestSha256, canonical(f.browser));
  assert.equal(context.manifestProof.path, 'browser-hosts.private.json');
  assert.equal(productionCases.length, 5);
});

const corruptions = {
  'wrong platform': f => { f.browser.platform = 'ubuntu'; },
  'legacy production scope': f => { f.browser.scope = 'existing-production'; },
  'missing explicit production action scope': f => { f.browser.productionMutations = false; },
  'nonrandom run': f => { f.browser.runId = 'old-run'; },
  'wrong namespace': f => { f.browser.hosts[0].productionBinding.identity.namespace = 'other'; },
  'wrong workload UID': f => { f.browser.hosts[0].productionBinding.identity.deploymentUid = 'different'; },
  'old pod epoch': f => { f.browser.hosts[0].productionBinding.identity.podUid = 'previous'; },
  'wrong PVC': f => { f.browser.hosts[0].productionBinding.identity.pvcUid = 'other'; },
  'old container epoch': f => { f.browser.hosts[0].productionBinding.identity.containerId = 'old'; },
  'unapproved host': f => { f.browser.hosts[0].release = 'svc-98687125'; },
  'wrong server identity': f => { f.browser.hosts[0].serverId = 'other-server'; },
  'shared data': f => { f.browser.hosts[1].dataIdentity = f.browser.hosts[0].dataIdentity; },
  'unowned tunnel': f => { f.browser.hosts[0].productionBinding.tunnel.podUid = 'other'; },
  'public tunnel': f => { f.browser.hosts[0].baseUrl = 'http://example.com:31001'; },
  'config digest mistaken for manifest': f => { f.browser.runtime.imageId = chain.config; f.browser.imageId = chain.config; },
  'chain changed': f => { f.browser.hosts[0].productionBinding.registryChain.config = digest('9'); },
  'canonical hash wrong': f => { f.browser.hosts[0].productionBinding.canonicalProofSha256 = '9'.repeat(64); },
  'baseline hash wrong': f => { f.browser.hosts[0].productionBinding.baselineSha256 = '9'.repeat(64); },
  'missing proof reference': f => { delete f.browser.guard; },
  'isolated disguised as transport': f => { f.transport.scope = 'isolated-candidate'; },
  'forged approval boolean': f => { f.transport.hosts[releases.pi3].canonical = { approved: true }; },
  'missing real authority selector': f => { delete f.transport.selector.approvalCommentId; },
  'unsupported CRI form': f => { f.transport.hosts[releases.pi3].baseline.identity.criImageId = 'containerd://' + chain.config; },
  'stale baseline clock': f => { f.transport.hosts[releases.pi3].baseline.activity.observedAt = timestamp - 1000; },
  'wrong actual mount': f => { f.transport.hosts[releases.pi3].baseline.activity.mount.source = '/dev/another'; },
};
for (const [name, corrupt] of Object.entries(corruptions)) test('rejects ' + name, t => {
  const f = fixture(t); corrupt(f);
  const hasGuard = !!f.browser.guard; f.save(); if (!hasGuard) delete f.browser.guard;
  assert.throws(() => validateManifest(f.browser, f.options));
});

test('requires private hash-matching contained proof files', t => {
  const f = fixture(t);
  assert.throws(() => validateManifest(f.browser));
  fs.appendFileSync(path.join(f.root, 'validation-manifest.json'), ' ');
  assert.throws(() => validateManifest(f.browser, f.options), /hash|checksum/i);
  f.save(); fs.chmodSync(path.join(f.root, 'validation-manifest.json'), 0o644);
  assert.throws(() => validateManifest(f.browser, f.options), /private/i);
});

test('static valid proof never enables unguarded production browser execution', t => {
  const f = fixture(t);
  const env = { SMART_PARITY_EVIDENCE_DIR: f.root, SMART_PARITY_PLAYWRIGHT_MODULE: '/unused', SMART_PARITY_CHROMIUM_EXECUTABLE_PATH: '/unused', SMART_PARITY_CRAFT_CLI: '/unused' };
  assert.throws(() => configuration('apporo', env, { providerTurns: true }), /action.*guard|guard.*action/i);
});

test('production compile requires 188 cases; functional results alone cannot pass production audit', t => {
  const f = fixture(t);
  const { matrix, result } = compile(f.root);
  assert.equal(result.requiredCases, 188);
  assert.equal(matrix.results.length, 188);
  assert.equal(result.passed, false);
  assert.equal(matrix.scope, 'production-canary');
  const legacy = structuredClone(matrix);
  legacy.results = legacy.results.filter(r => !productionCases.includes(r.case));
  assert.equal(audit(legacy, f.root).missing.length, 10);
});

test('a completion status label with arbitrary observations cannot prove safety cases', t => {
  const f = fixture(t), context = validateProductionManifest(f.browser, f.options), host = f.browser.hosts[0];
  f.put('hosts/pi3/production-completion.json', { scope: 'production-canary', status: 'passed', passed: true, observations: { approved: true }, cases: {} });
  const rows = productionCompletion(context, host);
  assert.equal(rows.length, 5);
  assert.ok(rows.every(row => row.status !== 'pass'));
});

test('typed production fixture names match canary_fixture_resources exactly', () => {
  assert.deepEqual(fixtureIdentifiers(runId, 'pi3'), {
    mcp: 'canary_' + runId, skill: 'canary-' + runId, memory: 'canary-' + runId + '-pi3',
  });
  assert.notEqual(fixtureIdentifiers(runId, 'pi3').memory, fixtureIdentifiers(runId, 'pi4').memory);
  assert.throws(() => fixtureIdentifiers(runId, 'pi1'));
});

test('cleanup inventory rejects omitted kinds, agents, workspaces, recovered IDs and unrelated additions', () => {
  const fixtures = [{ kind: 'mcp', key: 'mcp' }, { kind: 'skill', key: 'skill' }, { kind: 'memory', key: 'memory' }, { kind: 'memory', key: 'web-write' }];
  const owned = [{ kind: 'agent', key: 'provider' }, { kind: 'agent', key: 'sender' }, { kind: 'agent', key: 'recovered' },
    { kind: 'workspace', key: 'cli' }, { kind: 'workspace', key: 'mcp' }];
  for (const expected of [fixtures, owned]) {
    requireCompleteInventory(structuredClone(expected), expected);
    for (let i = 0; i < expected.length; i++) assert.throws(() => requireCompleteInventory(expected.filter((_, n) => n !== i), expected));
    assert.throws(() => requireCompleteInventory([...expected, { kind: 'agent', key: 'foreign' }], expected));
    assert.throws(() => requireCompleteInventory([...expected, expected[0]], expected));
  }
});

test('typed complete synthetic receipts verify all five safety cases', t => {
  const state = completionFixture(fixture(t)), rows = state.save();
  assert.ok(rows.every(row => row.status === 'pass'), JSON.stringify(rows.filter(r => r.status !== 'pass')));
});

for (const [name, mutate, cases] of [
  ['omitted MCP kind', s => { s.resources.entries.shift(); s.resourceResult.entries.shift(); }, ['fixture-cleanup']],
  ['renamed MCP with invented suffix', s => { s.resources.entries[0].key += '_fake'; s.resourceResult.entries[0].key += '_fake'; }, ['fixture-cleanup']],
  ['missing attempted Web write', s => { s.resources.entries.pop(); s.resourceResult.entries.pop(); }, ['fixture-cleanup']],
  ['omitted sender from both cleanup inventories', s => { s.owned.entries.splice(1, 1); s.ownedResult.entries.splice(1, 1); }, ['owned-agent-cleanup']],
  ['omitted workspace from both inventories', s => { s.owned.entries.pop(); s.ownedResult.entries.pop(); }, ['owned-agent-cleanup']],
  ['unresolved creation attempt', s => { s.phases[0].report.creationResolutions.pop(); }, ['owned-agent-cleanup', 'fixture-cleanup']],
  ['new recovered agent omitted from inventory', s => { const r = s.phases[0].report; r.agents.push('recovered'); r.creationResolutions[0].agentIds.push('recovered'); }, ['owned-agent-cleanup']],
  ['missing brand evidence', s => { s.phases[1].report.providers.pop(); }, ['owned-agent-cleanup', 'fixture-cleanup']],
  ['archived non-owned conversation disappeared', s => { s.after.activity.snapshot.agents = []; }, ['non-owned-baseline-preserved']],
  ['MCP changed before removal', s => { s.resourceResult.entries[0].beforeSha256 = '9'.repeat(64); }, ['fixture-cleanup']],
  ['skill has additional file', s => { s.resourceResult.entries[1].beforeTree.push({ path: 'user.txt', type: 'file', sha256: '4'.repeat(64) }); }, ['fixture-cleanup']],
  ['memory CAS revision changed', s => { s.resourceResult.entries[2].observedRevision = 'foreign'; }, ['fixture-cleanup']],
  ['configuration compare conflict', s => { s.restoration.observedBefore.selectedTarget = 'woowtech'; }, ['configuration-restoration']],
  ['configuration still pending', s => { s.after.activity.connector.configurationPending = true; }, ['configuration-restoration']],
  ['canonical verification stale', s => { s.proof.verifiedAt -= 100; }, ['canonical-runtime-provenance']],
]) test('rehash-bound completion rejects ' + name, t => {
  const state = completionFixture(fixture(t)); mutate(state); const rows = state.save();
  for (const name of cases) assert.notEqual(rows.find(row => row.case === name).status, 'pass', name);
});

function preservationFixture(t, absent = false) {
  const f = fixture(t), host = f.browser.hosts[0], baseline = f.transport.hosts[host.release].baseline;
  const mcpPath = '/data/pi-agent/mcp.json', original = { mcpServers: { user: { command: '使用者-tool' } }, flag: true };
  const rawOriginal = Buffer.from(JSON.stringify(original) + '\n');
  const rawPut = (name, bytes) => {
    const target = path.join(f.root, name); fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, bytes, { mode: 0o600 }); return { path: name, sha256: sha(bytes) };
  };
  baseline.activity.files[mcpPath] = sha(rawOriginal);
  host.productionBinding.baselineSha256 = canonical(baseline); f.save();
  const s = completionFixture(f), binding = Object.fromEntries(Object.entries(s.owned).filter(([k]) => k !== 'entries'));
  const resourceManifest = s.resourceManifest, entry = { args: ['/owned/marker.mjs'], command: '/usr/local/bin/node' };
  resourceManifest.mcpEntry = entry; resourceManifest.mcpEntryHash = sha(JSON.stringify(entry));
  s.resources.entries[0].sha256 = s.resourceResult.entries[0].beforeSha256 = resourceManifest.mcpEntryHash;
  const preDoc = { ...structuredClone(original), mcpServers: { ...structuredClone(original.mcpServers), concurrent: { command: 'keep-me' }, [resourceManifest.fixtureMcpName]: entry } };
  const postDoc = structuredClone(preDoc); delete postDoc.mcpServers[resourceManifest.fixtureMcpName];
  const memoryRow = { key: 'user-memory', revision: 'original', contentSha256: 'a'.repeat(64), fileSha256: 'b'.repeat(64) };
  const envelope = at => ({ ...binding, productionMutations: false, identity: baseline.identity, complete: true, startedAt: at - .1, observedAt: at });
  const originalMemory = { ...envelope(timestamp), baselineSha256: host.productionBinding.baselineSha256,
    allMemory: { complete: true, entries: [structuredClone(memoryRow)] } };
  const resource = (at, doc) => ({ ...envelope(at), mcp: { rawBase64: Buffer.from(JSON.stringify(doc, null, 2) + '\n').toString('base64') },
    allMemory: { complete: true, entries: [structuredClone(memoryRow)] }, memory: { prefix: resourceManifest.localMemoryKey, entries: [] } });
  const pre = resource(timestamp + 1, preDoc), post = resource(timestamp + 4, postDoc);
  s.after.observedAt = timestamp + 4; s.after.activity.startedAt = timestamp + 3; s.after.activity.observedAt = timestamp + 4;
  s.proof.verifiedAt = timestamp + 4;
  const cleanup = { status: 'cleaned', conflicts: [], mcpRemoved: true,
    mcpEdit: { action: 'remove', present: false, removedSha256: resourceManifest.mcpEntryHash }, memories: [] };
  if (absent) {
    const candidate = s.resources.entries.find(row => row.kind === 'memory' && row.key !== resourceManifest.localMemoryKey);
    const outcome = s.resourceResult.entries.find(row => row.key === candidate.key);
    delete candidate.revision; delete candidate.sha256; candidate.state = 'observed-absent';
    delete outcome.expectedRevision; delete outcome.observedRevision; delete outcome.beforeSha256;
    outcome.method = 'complete-namespace-absence'; cleanup.memories.push({ key: candidate.key, status: 'absent' });
  }
  const journal = (action, result, at) => {
    const ticket = { ...binding, phase: 'paseo', action, podUid: baseline.identity.podUid, deadline: at + 30,
      canonicalSha256: canonical(f.transport.hosts[host.release].canonical), attempt: action, payloadSha256: 'f'.repeat(64) };
    let previous = null;
    const rows = ['dispatching_do_not_retry', 'returned'].map((status, sequence) => {
      const row = { ...ticket, sequence, previousSha256: previous, status, at: at + sequence * .01,
        ...(sequence ? { resultSha256: canonical(result) } : {}) };
      row.entrySha256 = canonical(row); previous = row.entrySha256; return row;
    });
    return { journal: rawPut('safety/' + action + '.jsonl', Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n')),
      result: f.put('safety/' + action + '-result.json', { ...ticket, result }) };
  };
  const save = () => {
    s.after.activity.files[mcpPath] = sha(Buffer.from(post.mcp.rawBase64, 'base64'));
    s.save();
    const fixtureRef = f.put('safety/immutable-fixture.json', resourceManifest);
    const prepareRef = journal('fixture-prepare', { status: 'ready', manifestSha256: fixtureRef.sha256,
      fixtureMcpName: resourceManifest.fixtureMcpName, mcpEntryHash: resourceManifest.mcpEntryHash }, timestamp + .1);
    const cleanupRef = journal('fixture-cleanup', cleanup, timestamp + 2);
    const beforeRef = f.put('safety/resources-before.json', pre), afterRef = f.put('safety/resources-after.json', post);
    const mcpProof = { ...binding, method: 'owned-entry-cas-semantic-preservation/v1',
      fixtureManifest: fixtureRef, baselineMcp: rawPut('safety/original-mcp.json', rawOriginal),
      prepare: prepareRef, cleanup: cleanupRef, before: beforeRef, after: afterRef };
    const memoryProof = { ...binding, method: 'complete-memory-preservation/v1',
      baseline: f.put('safety/original-memory.json', originalMemory), before: beforeRef, after: afterRef };
    const indexPath = 'hosts/pi3/production-completion.json', index = JSON.parse(fs.readFileSync(path.join(f.root, indexPath)));
    const casePath = 'safety/non-owned-baseline-preserved.json', preservation = JSON.parse(fs.readFileSync(path.join(f.root, casePath)));
    preservation.observations.mcpPreservation = f.put('safety/mcp-preservation.json', mcpProof);
    preservation.observations.memoryPreservation = f.put('safety/memory-preservation.json', memoryProof);
    index.cases['non-owned-baseline-preserved'].evidence = f.put(casePath, preservation);
    s.resourceResult.evidence = { before: beforeRef, after: afterRef, cleanup: cleanupRef };
    const resultRef = f.put('safety/fixture-result.json', s.resourceResult);
    const fixturePath = 'safety/fixture-cleanup.json', fixtureCase = JSON.parse(fs.readFileSync(path.join(f.root, fixturePath)));
    fixtureCase.observations.result = resultRef;
    index.cases['fixture-cleanup'].evidence = f.put(fixturePath, fixtureCase); f.put(indexPath, index);
    return productionCompletion(validateProductionManifest(f.browser, f.options), host);
  };
  const initial = save();
  assert.ok(initial.every(r => r.status === 'pass'), 'valid preservation control: ' + JSON.stringify(initial.filter(r => r.status !== 'pass')));
  return { f, s, save, pre, post, cleanup, originalMemory, fixture: resourceManifest };
}

test('real editor formatting permits byte changes only with bound CAS and preserved concurrent entries', t => {
  const rows = preservationFixture(t).save(); assert.ok(rows.every(r => r.status === 'pass'), JSON.stringify(rows.filter(r => r.status !== 'pass')));
});
test('attempted never-created memory has actual absence proof and no manufactured revision', t => {
  const rows = preservationFixture(t, true).save(); assert.ok(rows.every(r => r.status === 'pass'), JSON.stringify(rows.filter(r => r.status !== 'pass')));
});
for (const [name, corrupt, expectedCase] of [
  ['removed boolean without CAS', s => { delete s.cleanup.mcpEdit; }, 'non-owned-baseline-preserved'],
  ['wrong removed entry', s => { s.cleanup.mcpEdit.removedSha256 = '9'.repeat(64); }, 'non-owned-baseline-preserved'],
  ['replacement Pod', s => { s.post.identity = { ...s.post.identity, podUid: 'replacement' }; }, 'non-owned-baseline-preserved'],
  ['partial resource observation', s => { s.post.complete = false; }, 'non-owned-baseline-preserved'],
  ['resource observation before cleanup', s => { s.post.startedAt = timestamp; }, 'non-owned-baseline-preserved'],
  ['original MCP entry changed', s => {
    const doc = JSON.parse(Buffer.from(s.post.mcp.rawBase64, 'base64')); doc.mcpServers.user.command = 'changed';
    s.post.mcp.rawBase64 = Buffer.from(JSON.stringify(doc)).toString('base64');
  }, 'non-owned-baseline-preserved'],
  ['concurrent MCP entry erased', s => {
    const doc = JSON.parse(Buffer.from(s.post.mcp.rawBase64, 'base64')); delete doc.mcpServers.concurrent;
    s.post.mcp.rawBase64 = Buffer.from(JSON.stringify(doc)).toString('base64');
  }, 'non-owned-baseline-preserved'],
  ['unowned definition changed alongside MCP', s => { s.s.after.activity.files['/data/pi-agent/settings.json'] = '9'.repeat(64); }, 'non-owned-baseline-preserved'],
  ['original memory changed', s => { s.post.allMemory.entries[0].revision = 'concurrent'; }, 'non-owned-baseline-preserved'],
  ['missing global memory enumeration', s => { delete s.post.allMemory; }, 'non-owned-baseline-preserved'],
  ['memory prefix hides owned key', s => { s.post.allMemory.entries.push({ key: s.fixture.localMemoryKey + '-hidden', revision: 'r', contentSha256: 'a'.repeat(64), fileSha256: 'b'.repeat(64) }); }, 'non-owned-baseline-preserved'],
  ['absent memory has invented revision', s => { s.s.resources.entries.find(e => e.state === 'observed-absent').revision = 'fake'; }, 'fixture-cleanup'],
  ['absent memory actually exists', s => { s.pre.memory.entries.push({ key: s.cleanup.memories[0].key, revision: 'real' }); }, 'fixture-cleanup'],
  ['missing actual absence return', s => { s.cleanup.memories = []; }, 'fixture-cleanup'],
  ['absence return for different key', s => { s.cleanup.memories[0].key += '-other'; }, 'fixture-cleanup'],
]) test('rehash-bound preservation rejects ' + name, t => {
  const state = preservationFixture(t, true); corrupt(state);
  const row = state.save().find(r => r.case === expectedCase); assert.notEqual(row.status, 'pass', name);
});
