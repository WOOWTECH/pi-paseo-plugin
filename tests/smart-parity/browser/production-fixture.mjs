import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

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

export function productionFixture(t) {
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

