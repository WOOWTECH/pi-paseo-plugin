import fs from 'node:fs';
import {gunzipSync} from 'node:zlib';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {runtimeDirectory,PASEO_VERSION,LEGACY_PASEO_VERSION} from '../../src/runtime-layout.mjs';
import {patchPidLockSource,PID_LOCK_0112,PID_LOCK_COPIES} from '../../src/pid-lock-patch.mjs';
const fixtures=path.join(path.dirname(fileURLToPath(import.meta.url)),'../fixtures');
// Frozen 0.11.2 lockfiles of the releases Agent Connect 0.1.4-0.1.23 installed.
export const LOCK_0112_HONO='4cf9d40940bf5b58301775cb8322866d3bcd605db341125d98bd5218b0dfefc0';
export const LOCK_0112='6d8dbe5154790bbbb0b1281e991871b6f354919022fb55a1235162e969779526';
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
 fs.writeFileSync(path.join(server,'package.json'),JSON.stringify({type:'module',version}));
 const zod=path.join(root,'node_modules/zod');
 if(!fs.existsSync(zod))fs.symlinkSync(path.dirname(createRequire(import.meta.url).resolve('zod/package.json')),zod,'dir');
 return server;
}
/** The current release's official writer and server sources, ready for markRuntimeReady. */
export function seedPidFiles(loc) {
 return seedServer(runtimeDirectory(loc),PASEO_VERSION);
}
/** A verified 0.11.2 release from an earlier Agent Connect: r3/r4 patched, r2 original writers. */
export function seedPriorRelease(loc,{generation='r4',lockSha256=LOCK_0112_HONO,patched=generation!=='r2'}={}) {
 const revision=LEGACY_PASEO_VERSION+'-'+generation+'-'+lockSha256.slice(0,12);
 const root=path.join(loc.runtimeDir,'releases',revision);
 seedServer(root,LEGACY_PASEO_VERSION,{patched});
 const cli=path.join(root,'node_modules/@getpaseo/cli');fs.mkdirSync(cli,{recursive:true});
 fs.writeFileSync(path.join(cli,'package.json'),JSON.stringify({version:LEGACY_PASEO_VERSION}));
 fs.mkdirSync(path.join(root,'node_modules/@getpaseo/server/dist/server/web-ui'),{recursive:true});
 fs.writeFileSync(path.join(root,'node_modules/@getpaseo/server/dist/server/web-ui/index.html'),'fixture');
 const receipt={lockSha256,revision,...(patched?{pidLockPatchId:PID_LOCK_0112.patchId}:{})};
 if(generation==='r4')receipt.brandIdentityPatchId='d1f27c35db3eb9f456085893a6ca46ecc8aa353eb9dc3b3f9f8b833fd30e4d81';
 fs.writeFileSync(path.join(root,'.pi-paseo-runtime.json'),JSON.stringify(receipt));
 return root;
}
