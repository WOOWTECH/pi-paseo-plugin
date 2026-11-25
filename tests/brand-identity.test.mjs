import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {selectedBrand} from '../src/brand-identity.mjs';
import {targetEnvironment} from '../src/connection-targets.mjs';
import {patchBrandIdentitySource, applyBrandIdentityPatch, brandIdentityPatchReady, BRAND_SERVER_PATH,
  ORIGINAL_BRAND_SERVER_SHA256, PATCHED_BRAND_SERVER_SHA256} from '../src/brand-identity-patch.mjs';
import {runtimeDirectory, markRuntimeReady, runtimeReady, previousRuntimeDirectory, PASEO_VERSION} from '../src/runtime-layout.mjs';
import {seedPidFiles, seedPriorRelease} from './helpers/runtime-pid-files.mjs';
const source = gunzipSync(fs.readFileSync(new URL('./fixtures/paseo-0.17.4/websocket-server.js.gz', import.meta.url))).toString();
const source0112 = gunzipSync(fs.readFileSync(new URL('./fixtures/paseo-0.11.2/websocket-server.js.gz', import.meta.url))).toString();
const sha = value => createHash('sha256').update(value).digest('hex');
function fixture(t) {
  const runtimeDir=fs.mkdtempSync(path.join(os.tmpdir(),'paseo-brand-'));
  t.after(()=>fs.rmSync(runtimeDir,{recursive:true,force:true}));
  const loc={runtimeDir};seedPidFiles(loc);
  const root=runtimeDirectory(loc),cli=path.join(root,'node_modules/@getpaseo/cli');
  fs.mkdirSync(cli,{recursive:true});fs.writeFileSync(path.join(cli,'package.json'),JSON.stringify({version:PASEO_VERSION}));
  return {loc,root,file:path.join(root,BRAND_SERVER_PATH)};
}
function payload(text, target) {
  // Exercise the actual frozen upstream payload builder, including all feature
  // flags. The remaining class needs real providers/network and runs in CI/live.
  const method=text.slice(text.indexOf('    buildServerInfoStatusPayload(session) {'),text.indexOf('    createServerInfoMessage(session) {'));
  const object=vm.runInNewContext('({' + method + '})',{WS_PROTOCOL_VERSION:1,getHostName:()=> 'fixture',agentConnectBrand:selectedBrand(target)});
  const daemon={serverId:'srv_fixture',daemonVersion:PASEO_VERSION,providerSnapshotManager:{supportsConfigRequiredProvider:()=>false}};
  return object.buildServerInfoStatusPayload.call(daemon,{getPermissions:()=>[],getHostSourceId:()=>'owner'});
}
test('Apporo hello regression: the actual server payload declares the selected target',()=>{
  assert.equal(payload(source,'apporo').brand,undefined,'upstream reproduces Apporo close4004');
  const patched=patchBrandIdentitySource(source);
  for(const target of ['paseo','woowtech','apporo']) {
    const before=payload(source,target),after=payload(patched,target);
    assert.deepEqual(JSON.parse(JSON.stringify(after.brand)),selectedBrand(targetEnvironment(target).PI_PASEO_CONNECTION_TARGET));
    delete after.brand;assert.equal(JSON.stringify(after),JSON.stringify(before),'identity must not change capabilities/permissions');
  }
});
test('brand identity rejects unsupported targets and cannot be changed by callers',()=>{
  for(const target of ['',null,'__proto__','constructor','other'])assert.throws(()=>selectedBrand(target),{code:'INVALID_CONNECTION_TARGET'});
  assert.throws(()=>{selectedBrand('apporo').id='woowtech';},TypeError);
});
test('known server source patches deterministically and idempotently',()=>{
  assert.equal(sha(source),ORIGINAL_BRAND_SERVER_SHA256);
  const patched=patchBrandIdentitySource(source);
  assert.equal(sha(patched),PATCHED_BRAND_SERVER_SHA256);
  assert.equal(patchBrandIdentitySource(patched),patched);
  assert.throws(()=>patchBrandIdentitySource(source+'\n'),{code:'BRAND_IDENTITY_SOURCE_MISMATCH'});
  // A release never receives a patch made for another upstream version.
  assert.throws(()=>patchBrandIdentitySource(source0112),{code:'BRAND_IDENTITY_SOURCE_MISMATCH'});
});
test('unknown source fails before writing either server or helper',t=>{
  const {root,file}=fixture(t);fs.appendFileSync(file,'\n');
  assert.throws(()=>applyBrandIdentityPatch(root),{code:'BRAND_IDENTITY_SOURCE_MISMATCH'});
  assert.equal(fs.readFileSync(file,'utf8'),source+'\n');
  assert.equal(fs.existsSync(path.join(path.dirname(file),'pi-paseo-brand-identity.mjs')),false);
});
test('readiness verifies identity patch, helper and receipt; repeated marking retains bytes',t=>{
  const {loc,root,file}=fixture(t);markRuntimeReady(loc);assert.equal(runtimeReady(loc),true);
  for(const name of [file,path.join(path.dirname(file),'pi-paseo-brand-identity.mjs')]){
    const bytes=fs.readFileSync(name);fs.appendFileSync(name,'\n');assert.equal(brandIdentityPatchReady(root),false);assert.equal(runtimeReady(loc),false);fs.writeFileSync(name,bytes);
  }
  const before=fs.statSync(file).mtimeMs;markRuntimeReady(loc);assert.equal(fs.statSync(file).mtimeMs,before);
  const receipt=path.join(root,'.pi-paseo-runtime.json'),value=JSON.parse(fs.readFileSync(receipt));delete value.brandIdentityPatchId;fs.writeFileSync(receipt,JSON.stringify(value));assert.equal(runtimeReady(loc),false);
});
for(const generation of ['r3','r4'])test(generation+' (0.11.2) daemon remains available for owned offline shutdown without rewriting its source',t=>{
  const {loc,root}=fixture(t);
  const old=seedPriorRelease(loc,{generation});
  fs.rmSync(root,{recursive:true});
  assert.equal(runtimeReady(loc),false);assert.equal(previousRuntimeDirectory(loc),old);
  // Preparing the 0.17.4 release beside it leaves the old release byte-for-byte.
  seedPidFiles(loc);const cli=path.join(root,'node_modules/@getpaseo/cli');
  fs.mkdirSync(cli,{recursive:true});fs.writeFileSync(path.join(cli,'package.json'),JSON.stringify({version:PASEO_VERSION}));
  markRuntimeReady(loc);assert.equal(runtimeReady(loc),true);assert.equal(previousRuntimeDirectory(loc),old);
  assert.equal(fs.readFileSync(path.join(old,BRAND_SERVER_PATH),'utf8'),source0112);
  assert.equal(fs.existsSync(path.join(path.dirname(path.join(old,BRAND_SERVER_PATH)),'pi-paseo-brand-identity.mjs')),false);
});
