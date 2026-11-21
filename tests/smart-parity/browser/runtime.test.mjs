import test from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest, validatePairingReport } from './common.mjs';
import { runtimeBinding, packageSetDigest, validateReportRuntime } from './runtime.mjs';
const imageId = 'sha256:' + 'a'.repeat(64);
function fixture(platform) {
  const packages = [{name:'@woowtech/pi-paseo',version:'0.1.17',archiveSha256:'b'.repeat(64)},
    {name:'@woowtech/pi-omnigent',version:'0.3.33',archiveSha256:'c'.repeat(64)}];
  const runtime = ['k3s-paas','ha-addon'].includes(platform) ? {kind:'container-image',imageId} :
    {kind:'package-set',digest:packageSetDigest(packages),packages};
  const m={platform,runtime,scope:'isolated-candidate',productionMutations:false,runId:'test',hosts:[]};
  const binding=runtimeBinding(m);
  m.hosts=['one','two'].map((label,i)=>({label,runtimeIdentity:binding.runtimeIdentity,dataIdentity:'data-'+label,
    baseUrl:'http://127.0.0.1:'+(20001+i),ownership:{runId:'test',hostLabel:label}}));
  return m;
}
for(const platform of ['windows-wsl2','macos','ubuntu','k3s-paas','ha-addon']) test('maps '+platform+' to exact platform-specific runtime evidence',()=>{
  const m=fixture(platform), b=runtimeBinding(validateManifest(m));
  assert.equal(b.platform,platform);
  assert.equal(b.runtime.kind,['k3s-paas','ha-addon'].includes(platform)?'container-image':'package-set');
  assert.match(b.runtimeIdentity,b.runtime.kind==='container-image'?/^image:sha256:/:/^package-set:sha256:/);
  assert.equal(b.imageId,b.runtime.kind==='container-image'?imageId:undefined);
  validateReportRuntime({...b},m);
});
test('existing image manifest fields project with explicit platform only',()=>{
  const m=fixture('k3s-paas');delete m.runtime;m.imageId=imageId;
  for(const h of m.hosts){delete h.runtimeIdentity;h.imageId=imageId;}
  assert.equal(runtimeBinding(validateManifest(m)).imageId,imageId);
});
test('native digest uses stable name sorting and exact archive/version provenance',()=>{
  const m=fixture('ubuntu'), p=m.runtime.packages;
  assert.equal(packageSetDigest(p),packageSetDigest([...p].reverse()));
  assert.notEqual(packageSetDigest(p),packageSetDigest(p.map((r,i)=>i? r:{...r,version:'0.1.18'})));
  assert.notEqual(packageSetDigest(p),packageSetDigest(p.map((r,i)=>i? r:{...r,archiveSha256:'d'.repeat(64)})));
});
for(const [label,mutate] of [
  ['missing platform',m=>delete m.platform],['unknown platform',m=>m.platform='windows'],
  ['native image label',m=>m.imageId=imageId],['native image runtime',m=>m.runtime={kind:'container-image',imageId}],
  ['missing runtime',m=>delete m.runtime],['missing package list',m=>delete m.runtime.packages],
  ['empty package list',m=>m.runtime.packages=[]],['missing archive SHA',m=>delete m.runtime.packages[0].archiveSha256],
  ['non-exact package version',m=>m.runtime.packages[0].version='latest'],
  ['duplicate package',m=>m.runtime.packages.push({...m.runtime.packages[0]})],
  ['wrong set digest',m=>m.runtime.digest='sha256:'+'f'.repeat(64)],
  ['missing host runtime',m=>delete m.hosts[0].runtimeIdentity],
  ['stale host runtime',m=>m.hosts[0].runtimeIdentity='package-set:sha256:'+'f'.repeat(64)],
  ['native host image label',m=>m.hosts[0].imageId=imageId],
]) test('rejects '+label,()=>{const m=fixture('macos');mutate(m);assert.throws(()=>validateManifest(m));});
test('container platforms reject package-set runtime or missing image provenance',()=>{
  const m=fixture('ha-addon');m.runtime=fixture('ubuntu').runtime;assert.throws(()=>validateManifest(m));
  delete m.runtime;assert.throws(()=>validateManifest(m));
});
test('report platform and native initial runtime must match manifest',()=>{
  const m=fixture('windows-wsl2'),b=runtimeBinding(m);
  assert.throws(()=>validateReportRuntime({...b,platform:'ubuntu'},m));
  const report={brand:'paseo',scope:m.scope,runId:m.runId,...b,hosts:m.hosts.map(h=>({host:h.label,initialRuntimeIdentity:b.runtimeIdentity,status:'running'}))};
  validatePairingReport(report,m,'paseo',{complete:false});
  report.hosts[0].initialRuntimeIdentity='package-set:sha256:'+'e'.repeat(64);
  assert.throws(()=>validatePairingReport(report,m,'paseo',{complete:false}));
});
