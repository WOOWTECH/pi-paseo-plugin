import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {privateDirectory,atomicJson,RuntimeError,assertSafePath} from './state.mjs';
import {applyPidLockPatch,pidLockPatchReady,PID_LOCK_PATCH_ID,PID_LOCK_COPIES,PID_LOCK_0112} from './pid-lock-patch.mjs';
import {applyBrandIdentityPatch,brandIdentityPatchReady,BRAND_IDENTITY_PATCH_ID,BRAND_0112} from './brand-identity-patch.mjs';
export const PASEO_VERSION='0.17.4';
// Every earlier managed release ran Paseo 0.11.2, as did the pre-release runtimeDir layout.
export const LEGACY_PASEO_VERSION='0.11.2';
const template=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../runtime');
const lock=fs.readFileSync(path.join(template,'package-lock.json'));
const lockSha256=createHash('sha256').update(lock).digest('hex');
export const RUNTIME_REVISION=PASEO_VERSION+'-r1-'+lockSha256.slice(0,12);
export const runtimeDirectory=loc=>path.join(loc.runtimeDir,'releases',RUNTIME_REVISION);
// Existing-daemon control compatibility only; these releases are never started.
// Frozen 0.11.2 lockfiles: 4cf9d4… shipped with later r3 and all r4 (Agent Connect
// 0.1.18-0.1.23 run 0.11.2-r4-4cf9d40940bf), 6d8dbe… with r2 and the first r3. These four are
// every release Agent Connect 0.1.4-0.1.23 shipped, newest first (0.1.1-0.1.3 ran r1: unsupported).
// Only r4 (0.1.18+) records its revision in state.json for non-Linux daemons.
const LOCK_0112_HONO='4cf9d40940bf5b58301775cb8322866d3bcd605db341125d98bd5218b0dfefc0';
const LOCK_0112='6d8dbe5154790bbbb0b1281e991871b6f354919022fb55a1235162e969779526';
const priorReleases=[
 {generation:'r4',sha:LOCK_0112_HONO,patched:true,branded:true},
 {generation:'r3',sha:LOCK_0112_HONO,patched:true},
 {generation:'r3',sha:LOCK_0112,patched:true},
 {generation:'r2',sha:LOCK_0112,patched:false},
].map(release=>Object.freeze({...release,revision:LEGACY_PASEO_VERSION+'-'+release.generation+'-'+release.sha.slice(0,12)}));
/** Revisions of the earlier releases, newest first. */
export const PRIOR_RUNTIME_REVISIONS=Object.freeze(priorReleases.map(release=>release.revision));
function verifiedPrior(loc,{revision,sha,patched,branded}) {
 // Never follow state-provided paths or scan arbitrary versions.
 const root=path.join(loc.runtimeDir,'releases',revision);
 try {
  const receiptFile=path.join(root,'.pi-paseo-runtime.json');assertSafePath(receiptFile);
  const receipt=JSON.parse(fs.readFileSync(receiptFile));
  if(receipt.revision!==revision||receipt.lockSha256!==sha)return null;
  for(const pkg of ['cli','server']){
   const file=path.join(root,'node_modules/@getpaseo',pkg,'package.json');assertSafePath(file);
   if(JSON.parse(fs.readFileSync(file)).version!==LEGACY_PASEO_VERSION)return null;
  }
  if(patched){
   if(receipt.pidLockPatchId!==PID_LOCK_0112.patchId||!pidLockPatchReady(root,PID_LOCK_0112))return null;
  }else for(const copy of PID_LOCK_COPIES){
   const file=path.join(root,'node_modules/@getpaseo/server',copy,'pid-lock.js');assertSafePath(file);
   if(createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==PID_LOCK_0112.original)return null;
  }
  if(branded&&(receipt.brandIdentityPatchId!==BRAND_0112.patchId||!brandIdentityPatchReady(root,BRAND_0112)))return null;
  return root;
 }catch{return null;} // Unsupported or unsafe releases cannot supply offline control.
}
/** The verified directory of exactly this earlier release, or null. */
export function priorRuntimeDirectory(loc,revision) {
 const release=priorReleases.find(entry=>entry.revision===revision);
 return release?verifiedPrior(loc,release):null;
}
/** The newest verified earlier release; with `unrecordedOnly`, among those that never recorded their revision. */
export function previousRuntimeDirectory(loc,{unrecordedOnly=false}={}) {
 for(const release of priorReleases){
  if(unrecordedOnly&&release.generation==='r4')continue;
  const root=verifiedPrior(loc,release);if(root)return root;
 }
 return null;
}

export function runtimeReady(loc) {
 try {
  const root=runtimeDirectory(loc);
  assertSafePath(path.join(root,'.pi-paseo-runtime.json'));
  const receipt=JSON.parse(fs.readFileSync(path.join(root,'.pi-paseo-runtime.json')));
  return receipt.lockSha256===lockSha256&&receipt.pidLockPatchId===PID_LOCK_PATCH_ID&&pidLockPatchReady(root)&&receipt.brandIdentityPatchId===BRAND_IDENTITY_PATCH_ID&&brandIdentityPatchReady(root)&&JSON.parse(fs.readFileSync(path.join(root,'node_modules/@getpaseo/cli/package.json'))).version===PASEO_VERSION;
 } catch {return false;}
}
export function prepareRuntimeManifest(loc) {
 const root=runtimeDirectory(loc);privateDirectory(root);
 const file=path.join(root,'package.json');assertSafePath(file);
 if(fs.existsSync(file)&&JSON.parse(fs.readFileSync(file)).name!=='pi-paseo-managed-runtime')throw new RuntimeError('RUNTIME_NOT_OWNED');
 for(const name of ['package.json','package-lock.json']) {
  assertSafePath(path.join(root,name));fs.copyFileSync(path.join(template,name),path.join(root,name));
 }
 return root;
}
export function markRuntimeReady(loc) {const root=runtimeDirectory(loc);applyPidLockPatch(root);applyBrandIdentityPatch(root);atomicJson(path.join(root,'.pi-paseo-runtime.json'),{lockSha256,revision:RUNTIME_REVISION,pidLockPatchId:PID_LOCK_PATCH_ID,brandIdentityPatchId:BRAND_IDENTITY_PATCH_ID});}
