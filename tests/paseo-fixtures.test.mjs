import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {configFixture,configProvenance,loadPersistedConfig} from './helpers/paseo-config.mjs';
import {LOCK_0112_HONO} from './helpers/runtime-pid-files.mjs';
import {PASEO_VERSION,LEGACY_PASEO_VERSION} from '../src/runtime-layout.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sha256=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const runtimeLock=JSON.parse(fs.readFileSync(path.join(root,'runtime/package-lock.json'),'utf8'));
function listed(dir,base=dir) {
 return fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?listed(path.join(dir,entry.name),base):[path.relative(base,path.join(dir,entry.name))]);
}

for(const version of [PASEO_VERSION,LEGACY_PASEO_VERSION])test(`vendored ${version} config modules are exactly the files their provenance records`,()=>{
 const provenance=configProvenance(version),dir=configFixture(version);
 assert.deepEqual(listed(dir).filter(file=>file!=='provenance.json').sort(),Object.keys(provenance.files).sort());
 for(const [file,hash] of Object.entries(provenance.files))assert.equal(sha256(path.join(dir,file)),hash,file);
 for(const pkg of Object.values(provenance.packages)){assert.equal(pkg.version,version);assert.match(pkg.tarballIntegrity,/^sha512-[A-Za-z0-9+/]{86}==$/);}
 // The pid-lock regression fixtures vendor the same upstream private-files.js.
 assert.deepEqual(fs.readFileSync(path.join(dir,'server/dist/server/server/private-files.js')),fs.readFileSync(path.join(dir,'../private-files.js')));
});

test('0.17.5 fixtures come from the tarballs the runtime lockfile pins',()=>{
 for(const [name,pkg] of Object.entries(configProvenance(PASEO_VERSION).packages)){
  const locked=runtimeLock.packages['node_modules/'+name];
  assert.ok(locked,name);assert.equal(locked.version,pkg.version,name);assert.equal(locked.integrity,pkg.tarballIntegrity,name);
 }
 const fixtureDir=path.join(root,'tests/fixtures/paseo-'+PASEO_VERSION);
 const writer=JSON.parse(fs.readFileSync(path.join(fixtureDir,'provenance.json'),'utf8'));
 for(const [file,hash] of Object.entries(writer.files))assert.equal(sha256(path.join(fixtureDir,file)),hash,file);
 const server=runtimeLock.packages['node_modules/@getpaseo/server'];
 assert.equal(writer.tarballIntegrity,server.integrity);assert.equal(writer.version,PASEO_VERSION);
 assert.equal(writer.tarballIntegrity,runtimeLock.packages['node_modules/@getpaseo/server'].integrity);
 assert.equal(runtimeLock.packages['node_modules/@getpaseo/cli'].version,PASEO_VERSION);
});

test('the retained 0.17.4 fixtures keep their frozen release provenance',()=>{
 const fixtureDir=path.join(root,'tests/fixtures/paseo-0.17.4');
 const writer=JSON.parse(fs.readFileSync(path.join(fixtureDir,'provenance.json'),'utf8'));
 assert.equal(writer.version,'0.17.4');
 assert.equal(sha256(path.join(fixtureDir,'pid-lock.js')),writer.pidLockSha256);
 assert.equal(createHash('sha256').update(gunzipSync(fs.readFileSync(path.join(fixtureDir,'websocket-server.js.gz')))).digest('hex'),writer.websocketServerSha256);
});

test('0.11.2 fixtures come from the lockfile of the 0.11.2-r4 release Agent Connect 0.1.18-0.1.23 installed',()=>{
 assert.equal(configProvenance(LEGACY_PASEO_VERSION).lockfileSha256,LOCK_0112_HONO);
});

test('vendored modules load and parse without the stubbed process helpers',async()=>{
 for(const version of [PASEO_VERSION,LEGACY_PASEO_VERSION]){
  const config=await loadPersistedConfig(version);
  for(const name of ['readPersistedConfig','savePersistedConfig'])assert.equal(typeof config[name],'function',version+' '+name);
  assert.equal(config.PersistedConfigSchema.safeParse({version:1,daemon:{listen:'127.0.0.1:6769'}}).success,true,version);
  assert.equal(config.PersistedConfigSchema.safeParse({version:1,unknown:true}).success,false,version);
 }
});
