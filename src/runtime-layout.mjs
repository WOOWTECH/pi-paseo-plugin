import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {privateDirectory,atomicJson,RuntimeError,assertSafePath} from './state.mjs';
import {applyPidLockPatch,pidLockPatchReady,PID_LOCK_PATCH_ID,PID_LOCK_COPIES,ORIGINAL_PID_LOCK_SHA256} from './pid-lock-patch.mjs';
const template=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../runtime');
const lock=fs.readFileSync(path.join(template,'package-lock.json'));
const lockSha256=createHash('sha256').update(lock).digest('hex');
export const RUNTIME_REVISION='0.11.2-r3-'+lockSha256.slice(0,12);
export const runtimeDirectory=loc=>path.join(loc.runtimeDir,'releases',RUNTIME_REVISION);
// Existing-daemon control compatibility only; these releases are never started.
const priorLockSha256='6d8dbe5154790bbbb0b1281e991871b6f354919022fb55a1235162e969779526';
const priorReleases=[
 {generation:'r3',sha:priorLockSha256,patched:true},
 {generation:'r2',sha:priorLockSha256,patched:false},
 {generation:'r2',sha:lockSha256,patched:false},
];
export function previousRuntimeDirectory(loc) {
 // Never follow state-provided paths or scan arbitrary versions.
 for(const {generation,sha,patched} of priorReleases){
  const revision='0.11.2-'+generation+'-'+sha.slice(0,12);
  const root=path.join(loc.runtimeDir,'releases',revision);
  try {
   const receiptFile=path.join(root,'.pi-paseo-runtime.json');assertSafePath(receiptFile);
   const receipt=JSON.parse(fs.readFileSync(receiptFile));
   if(receipt.revision!==revision||receipt.lockSha256!==sha)continue;
   for(const pkg of ['cli','server']){
    const file=path.join(root,'node_modules/@getpaseo',pkg,'package.json');assertSafePath(file);
    if(JSON.parse(fs.readFileSync(file)).version!=='0.11.2')throw new Error('unsupported package');
   }
   if(patched){
    if(receipt.pidLockPatchId!==PID_LOCK_PATCH_ID||!pidLockPatchReady(root))continue;
   }else for(const copy of PID_LOCK_COPIES){
    const file=path.join(root,'node_modules/@getpaseo/server',copy,'pid-lock.js');assertSafePath(file);
    if(createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==ORIGINAL_PID_LOCK_SHA256)throw new Error('unsupported writer');
   }
   return root;
  }catch{ /* Unsupported or unsafe releases cannot supply offline control. */ }
 }
 return null;
}

export function runtimeReady(loc) {
 try {
  const root=runtimeDirectory(loc);
  assertSafePath(path.join(root,'.pi-paseo-runtime.json'));
  const receipt=JSON.parse(fs.readFileSync(path.join(root,'.pi-paseo-runtime.json')));
  return receipt.lockSha256===lockSha256&&receipt.pidLockPatchId===PID_LOCK_PATCH_ID&&pidLockPatchReady(root)&&JSON.parse(fs.readFileSync(path.join(root,'node_modules/@getpaseo/cli/package.json'))).version==='0.11.2';
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
export function markRuntimeReady(loc) {const root=runtimeDirectory(loc);applyPidLockPatch(root);atomicJson(path.join(root,'.pi-paseo-runtime.json'),{lockSha256,revision:RUNTIME_REVISION,pidLockPatchId:PID_LOCK_PATCH_ID});}
