import fs from 'node:fs';
import {gunzipSync} from 'node:zlib';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {runtimeDirectory,PASEO_VERSION,LEGACY_PASEO_VERSION} from '../../src/runtime-layout.mjs';
import {applyPidLockPatch,patchPidLockSource,PID_LOCK_PATCH_ID,PID_LOCK_0112,PID_LOCK_COPIES} from '../../src/pid-lock-patch.mjs';
import {applyBrandIdentityPatch,patchBrandIdentitySource,BRAND_IDENTITY_PATCH_ID,BRAND_0112,BRAND_SERVER_PATH} from '../../src/brand-identity-patch.mjs';
import {applySmartTasksPatch,SMART_TASKS_PATCH_ID,SMART_TASKS_REGISTRY_PATH,SMART_TASKS_DIRECTORY} from '../../src/smart-tasks-patch.mjs';
import {createHash} from 'node:crypto';
const fixtures=path.join(path.dirname(fileURLToPath(import.meta.url)),'../fixtures');
// Frozen 0.11.2 lockfiles of the releases Agent Connect 0.1.4-0.1.23 installed.
export const LOCK_0112_HONO='4cf9d40940bf5b58301775cb8322866d3bcd605db341125d98bd5218b0dfefc0';
export const LOCK_0112='6d8dbe5154790bbbb0b1281e991871b6f354919022fb55a1235162e969779526';
// Frozen runtime/package-lock.json from Agent Connect 0.1.24 (0.17.4-r1).
export const LOCK_0174_R1='a651f42711da045b31e8a2b8993d9b82e7b7cbbef0cffcf48dfdcd5baf9d8530';
// Frozen 0.17.4-r1/r2 descriptors. r2 adds Tasks; r1 must remain the original no-Tasks release.
export const PID_0174=Object.freeze({original:'a4e8bc790b27c944847b7bb84694b38d0366d08d7d565409edbc63dd6462b8f7',patched:'194013b387417fb9b6d74b7a305173d8f28478ef268b7a4c073b9882af66bd1b',patchId:'1451c9714ffd86380ff04cbe0219b4a2b0d5a3cd39e152fa5e5fabc0d5403828',helperSha256:'37bdef75ee090452ce946bbf051d411352d51fda95d8121ff0c83a34680e3987'});
export const BRAND_0174=Object.freeze({original:'bfc79901aa7768a51b98385b6f729dac69a1098f4480a66fd3d2be1d6af06b4b',patched:'17ea88357d2f25caab81ad63d32804fe41158c1d70e8e4f549c4fc7173fe8d68',patchId:'20f860e40bfb9d654182fd996f4f1999f2b73fe2f2f924519bc344a5592e89f2',helperSha256:'036471982ccbbb5a7c3418631518025b245ac50e1c0b1a29c3824d16ba069733'});
export const TASKS_0174_R2=Object.freeze({registrySha256:'f20ea6c51acf595a72148998547ab6edc8623275f3a36f86eb2dc51415f2098e',provenanceSha256:'08a0cbe942bd3136d983e63f8c723f2b17e21f433d410bddb6faf4b5a1c802c8',patchId:'2250785f3f115705f092c3a0b45ae43386c57ef596a1c9afb65a02a38caeb485'});
function seedServer(root,version,{patched=false}={}) {
 const fixture=path.join(fixtures,'paseo-'+version);
 const server=path.join(root,'node_modules/@getpaseo/server');
 for(const relative of PID_LOCK_COPIES){
  const directory=path.join(server,relative);fs.mkdirSync(directory,{recursive:true});
  for(const file of ['pid-lock.js','private-files.js','host-name.js'])fs.copyFileSync(path.join(fixture,file),path.join(directory,file));
  if(patched){
   fs.writeFileSync(path.join(directory,'pid-lock.js'),patchPidLockSource(fs.readFileSync(path.join(fixture,'pid-lock.js'),'utf8'),PID_LOCK_0112));
   fs.copyFileSync(fileURLToPath(new URL('../../src/pid-transition.mjs',import.meta.url)),path.join(directory,'pi-paseo-pid-transition.mjs'));
  }
 }
 fs.writeFileSync(path.join(server,'dist/server/server/websocket-server.js'),gunzipSync(fs.readFileSync(path.join(fixture,'websocket-server.js.gz'))));
 if(fs.existsSync(path.join(fixture,'builtin-index.js'))){
  const builtin=path.join(server,'dist/server/server/plugins/builtin');fs.mkdirSync(builtin,{recursive:true});
  fs.copyFileSync(path.join(fixture,'builtin-index.js'),path.join(builtin,'index.js'));
 }
 fs.writeFileSync(path.join(server,'package.json'),JSON.stringify({type:'module',version}));
 const zod=path.join(root,'node_modules/zod');
 if(!fs.existsSync(zod))fs.symlinkSync(path.dirname(createRequire(import.meta.url).resolve('zod/package.json')),zod,'dir');
 return server;
}
/** The current release's official writer and server sources, ready for markRuntimeReady. */
export function seedPidFiles(loc) {
 return seedServer(runtimeDirectory(loc),PASEO_VERSION);
}
/** A verified earlier release as Agent Connect left it. 0.17.4-r1 has PID-lock and brand patches but no
 * Smart Tasks. For 0.11.2, r3/r4 have patched writers, r2 has the original ones, and r4 also has branding. */
export function seedPriorRelease(loc,{generation='r4',version=generation==='r1'?'0.17.4':LEGACY_PASEO_VERSION,lockSha256=(version==='0.17.4'?LOCK_0174_R1:generation==='r2'?LOCK_0112:LOCK_0112_HONO),patched=generation!=='r2'}={}) {
 if(version==='0.17.4'&&(generation==='r1'||generation==='r2')){
  const revision=version+'-'+generation+'-'+lockSha256.slice(0,12);
  const root=path.join(loc.runtimeDir,'releases',revision);
  seedServer(root,version);
  const pidHelper=fs.readFileSync(new URL('../../src/pid-transition.mjs',import.meta.url));
  const brandHelper=fs.readFileSync(new URL('../../src/brand-identity.mjs',import.meta.url));
  if(createHash('sha256').update(pidHelper).digest('hex')!==PID_0174.helperSha256||createHash('sha256').update(brandHelper).digest('hex')!==BRAND_0174.helperSha256)throw new Error('0.17.4 patch helper bytes changed');
  const serverRoot=path.join(root,'node_modules/@getpaseo/server');
  for(const relative of PID_LOCK_COPIES){
   const dir=path.join(serverRoot,relative),file=path.join(dir,'pid-lock.js');
   fs.writeFileSync(file,patchPidLockSource(fs.readFileSync(file,'utf8'),PID_0174));
   fs.writeFileSync(path.join(dir,'pi-paseo-pid-transition.mjs'),pidHelper);
  }
  const brandFile=path.join(root,BRAND_SERVER_PATH);
  fs.writeFileSync(brandFile,patchBrandIdentitySource(fs.readFileSync(brandFile,'utf8'),BRAND_0174));
  fs.writeFileSync(path.join(path.dirname(brandFile),'pi-paseo-brand-identity.mjs'),brandHelper);
  if(generation==='r2')applySmartTasksPatch(root);
  const cli=path.join(root,'node_modules/@getpaseo/cli');fs.mkdirSync(cli,{recursive:true});
  fs.writeFileSync(path.join(cli,'package.json'),JSON.stringify({version}));
  fs.mkdirSync(path.join(root,'node_modules/@getpaseo/server/dist/server/web-ui'),{recursive:true});
  fs.writeFileSync(path.join(serverRoot,'dist/server/web-ui/index.html'),'fixture');
  fs.writeFileSync(path.join(root,'.pi-paseo-runtime.json'),JSON.stringify({lockSha256,revision,pidLockPatchId:PID_0174.patchId,brandIdentityPatchId:BRAND_0174.patchId,...(generation==='r2'?{smartTasksPatchId:TASKS_0174_R2.patchId}:{})}));
  return root;
 }
 const revision=LEGACY_PASEO_VERSION+'-'+generation+'-'+lockSha256.slice(0,12);
 const root=path.join(loc.runtimeDir,'releases',revision);
 seedServer(root,LEGACY_PASEO_VERSION,{patched});
 if(generation==='r4'){
  // The 0.1.23 helper bytes are frozen in BRAND_0112; this repository's copy has not changed since.
  const helper=fs.readFileSync(new URL('../../src/brand-identity.mjs',import.meta.url));
  if(createHash('sha256').update(helper).digest('hex')!==BRAND_0112.helperSha256)throw new Error('brand helper changed since 0.1.23: freeze its bytes here');
  const server=path.join(root,BRAND_SERVER_PATH);
  fs.writeFileSync(server,patchBrandIdentitySource(fs.readFileSync(server,'utf8'),BRAND_0112));
  fs.writeFileSync(path.join(path.dirname(server),'pi-paseo-brand-identity.mjs'),helper);
 }
 const cli=path.join(root,'node_modules/@getpaseo/cli');fs.mkdirSync(cli,{recursive:true});
 fs.writeFileSync(path.join(cli,'package.json'),JSON.stringify({version:LEGACY_PASEO_VERSION}));
 fs.mkdirSync(path.join(root,'node_modules/@getpaseo/server/dist/server/web-ui'),{recursive:true});
 fs.writeFileSync(path.join(root,'node_modules/@getpaseo/server/dist/server/web-ui/index.html'),'fixture');
 const receipt={lockSha256,revision,...(patched?{pidLockPatchId:PID_LOCK_0112.patchId}:{})};
 if(generation==='r4')receipt.brandIdentityPatchId=BRAND_0112.patchId;
 fs.writeFileSync(path.join(root,'.pi-paseo-runtime.json'),JSON.stringify(receipt));
 return root;
}
