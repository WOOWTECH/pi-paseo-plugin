import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
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

// ---- Pruning ----
// Every release is a full install (about 0.6-0.7 GB), and each upgrade leaves the previous one for a rollback and
// for controlling a daemon that still runs it. pruneRuntimeReleases removes the ones nothing needs any more.
// It only ever touches a plugin-owned release: a directory directly under <runtimeDir>/releases that is named like
// a revision (<paseo version>-r<n>-<12 hex of its lockfile hash>), is a real directory (never a link) and holds a
// receipt that says the same: .pi-paseo-runtime.json with revision equal to the name and a lockSha256 that begins
// with the name's hash. Anything else under releases/ (other names, plain files, links, half-installed
// directories without a receipt, copies someone else made) and everything outside it, including the legacy
// <runtimeDir>/node_modules that earlier plugin versions installed, stays as it is.
const RELEASE_NAME=/^(\d+)\.(\d+)\.(\d+)-r(\d+)-([0-9a-f]{12})$/;
const TOMB_NAME=/^\.pruning-(\d+\.\d+\.\d+-r\d+-[0-9a-f]{12})-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RECEIPT='.pi-paseo-runtime.json';
const compareOrder=(a,b)=>{for(let i=0;i<4;i++)if(a[i]!==b[i])return a[i]-b[i];return 0;};
function ownedRelease(releases,name) {
 const match=RELEASE_NAME.exec(name);if(!match)return null;
 const root=path.join(releases,name),receiptFile=path.join(root,RECEIPT);
 let fd;
 try {
  if(!fs.lstatSync(root).isDirectory())return null; // lstat: a link to a directory is not one
  assertSafePath(receiptFile);
  const stat=fs.lstatSync(receiptFile);
  if(!stat.isFile()||stat.size>65536)return null;
  fd=fs.openSync(receiptFile,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  const receipt=JSON.parse(fs.readFileSync(fd,'utf8'));
  if(!receipt||typeof receipt!=='object'||receipt.revision!==name)return null;
  if(typeof receipt.lockSha256!=='string'||!/^[0-9a-f]{64}$/.test(receipt.lockSha256)||receipt.lockSha256.slice(0,12)!==match[5])return null;
  return {name,order:match.slice(1,5).map(Number),receiptMtimeMs:stat.mtimeMs};
 } catch {return null;} finally {if(fd!==undefined)try{fs.closeSync(fd);}catch{}}
}
/** The plugin-owned releases under <runtimeDir>/releases, newest first (Paseo version, then revision number, then receipt time). */
export function ownedReleases(loc) {
 const releases=path.join(loc.runtimeDir,'releases');
 try {
  assertSafePath(releases);
  if(!fs.lstatSync(releases).isDirectory())return [];
  return fs.readdirSync(releases).map(name=>ownedRelease(releases,name)).filter(Boolean)
   .sort((a,b)=>compareOrder(b.order,a.order)||b.receiptMtimeMs-a.receiptMtimeMs||(a.name<b.name?1:-1));
 } catch {return [];}
}
// The release stops being one at once (the rename is a single step), then its files go. Removal does not follow
// links: a link inside the tree is unlinked, never its target.
async function removeDirectory(releases,name,tomb) {
 const root=path.join(releases,name);
 if(!fs.lstatSync(root).isDirectory())throw new RuntimeError('RUNTIME_NOT_OWNED');
 fs.renameSync(root,tomb);
 await fs.promises.rm(tomb,{recursive:true,force:true});
}
/** Removes old plugin-owned releases and returns their names only: {removed, kept, failed, skipped?}.
 * Kept: this release; the one newest earlier release (a rollback); every name in `keep`, which the caller fills
 * with the releases a running process still uses or needs for control. Best effort: a release that cannot be
 * removed is reported in `failed`, never thrown. Without a valid current release it removes nothing. */
export async function pruneRuntimeReleases(loc,{keep=[]}={}) {
 const result={removed:[],kept:[],failed:[]},releases=path.join(loc.runtimeDir,'releases');
 try {assertSafePath(releases);if(!fs.lstatSync(releases).isDirectory())return {...result,skipped:'RELEASES_NOT_A_DIRECTORY'};}
 catch(error) {return error?.code==='ENOENT'?result:{...result,skipped:'RELEASES_UNSAFE'};}
 const owned=ownedReleases(loc),current=owned.find(release=>release.name===RUNTIME_REVISION);
 if(!current)return {...result,skipped:'CURRENT_RELEASE_NOT_FOUND'};
 const stay=new Set([RUNTIME_REVISION,...keep]);
 const rollback=owned.find(release=>release.name!==current.name&&compareOrder(release.order,current.order)<0);
 if(rollback)stay.add(rollback.name);
 // What an earlier removal renamed away and could not finish deleting.
 let leftovers=[];try {leftovers=fs.readdirSync(releases).filter(name=>TOMB_NAME.test(name));} catch {}
 for(const name of leftovers) {
  try {if(fs.lstatSync(path.join(releases,name)).isDirectory()){await fs.promises.rm(path.join(releases,name),{recursive:true,force:true});result.removed.push(TOMB_NAME.exec(name)[1]);}}
  catch {result.failed.push(TOMB_NAME.exec(name)[1]);}
 }
 for(const release of owned) {
  if(stay.has(release.name)){result.kept.push(release.name);continue;}
  try {await removeDirectory(releases,release.name,path.join(releases,`.pruning-${release.name}-${randomUUID()}`));result.removed.push(release.name);}
  catch {result.failed.push(release.name);}
 }
 return result;
}
