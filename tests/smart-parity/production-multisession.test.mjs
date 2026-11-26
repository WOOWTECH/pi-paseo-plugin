import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { productionFixture } from './browser/production-fixture.mjs';
import { validateProductionManifest, validateProductionReport } from './production-scope.mjs';

// Synthetic local evidence only; no service, credential or publication calls.
const canonical = value => execFileSync('python3', ['-c',
  'import sys,json,hashlib;print(hashlib.sha256(json.dumps(json.load(sys.stdin),sort_keys=True,separators=(",",":")).encode()).hexdigest())'],
  {input:JSON.stringify(value),encoding:'utf8'}).trim();

function fixture(t, change = () => {}) {
  const f = productionFixture(t), transport = f.put('copies/transport.json', f.transport);
  const later = structuredClone(f.browser);
  later.guard.manifestPath = '/historical/private/session/transport.json';
  for (const [i, host] of later.hosts.entries()) {
    host.baseUrl = 'http://127.0.0.1:' + (32001+i);
    Object.assign(host.productionBinding.tunnel, {pid:2001+i,origin:host.baseUrl,expiresAt:host.productionBinding.tunnel.expiresAt+300});
  }
  change(later);
  const key = canonical(later), primary = canonical(f.browser);
  const index = {schema:'agent-connect-browser-sessions/v1',scope:f.browser.scope,runId:f.browser.runId,
    primarySourceManifestSha256:primary,transportSha256:transport.sha256,
    sessions:{[primary]:{manifest:f.put('copies/primary.json',f.browser),transport},
              [key]:{manifest:f.put('copies/later.json',later),transport}}};
  f.put('production-sessions.json', index);
  return {...f,later,key,primary,index};
}

test('distinct original loopback leases share one immutable transport without raw manifest rewrites', t => {
  const f = fixture(t), before = fs.readFileSync(path.join(f.root,'copies/later.json'));
  fs.unlinkSync(path.join(f.root,'validation-manifest.json'));
  const context = validateProductionManifest(f.browser,f.options);
  assert.equal(context.sessions.size,2);
  assert.deepEqual(context.sessions.get(f.key).manifest, f.later);
  assert.deepEqual(fs.readFileSync(path.join(f.root,'copies/later.json')),before);
});

test('only offline report validation accepts another verified session; live remains exact', t => {
  const f=fixture(t),context=validateProductionManifest(f.browser,f.options);
  const report={scope:f.browser.scope,runId:f.browser.runId,sourceManifestSha256:f.key};
  assert.throws(()=>validateProductionReport(report,context),/source manifest/);
  validateProductionReport(report,context,{allowSessions:true});
  assert.throws(()=>validateProductionReport({...report,sourceManifestSha256:'f'.repeat(64)},context,{allowSessions:true}),/source manifest/);
});

for (const [name, edit] of Object.entries({
  pod: m=>m.hosts[0].productionBinding.identity.podUid='replacement',
  pvc: m=>m.hosts[0].productionBinding.identity.pvcUid='replacement',
  server: m=>m.hosts[0].serverId='replacement',
  baseline: m=>m.hosts[0].productionBinding.baselineSha256='f'.repeat(64),
  authority: m=>m.hosts[0].productionBinding.canonicalProofSha256='f'.repeat(64),
  image: m=>m.imageId='sha256:'+'f'.repeat(64),
})) test('rehashed session cannot change original '+name, t=>{
  const f=fixture(t,edit);assert.throws(()=>validateProductionManifest(f.browser,f.options),/session original epoch differs/);
});

test('another transport hash is not an equivalent baseline',t=>{
  const f=fixture(t);f.index.sessions[f.key].transport=f.put('copies/other.json',{...f.transport,createdAt:123});
  f.put('production-sessions.json',f.index);
  assert.throws(()=>validateProductionManifest(f.browser,f.options),/session transport bytes differ/);
});

test('tunnel cannot escape loopback or bind another Pod',t=>{
  const f=fixture(t,m=>m.hosts[0].productionBinding.tunnel.podUid='other');
  assert.throws(()=>validateProductionManifest(f.browser,f.options),/tunnel epoch/);
});

test('missing primary session is rejected',t=>{
  const f=fixture(t);delete f.index.sessions[f.primary];f.put('production-sessions.json',f.index);
  assert.throws(()=>validateProductionManifest(f.browser,f.options),/primary session missing/);
});
