import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
// The real persisted-config modules of pinned Paseo releases, from tests/fixtures/paseo-<version>/config
// (see its provenance.json). Only modules config parsing never calls are stubbed, and they throw if called.
const fixtures=path.join(path.dirname(fileURLToPath(import.meta.url)),'../fixtures');
export const configFixture=version=>path.join(fixtures,'paseo-'+version,'config');
export const configProvenance=version=>JSON.parse(fs.readFileSync(path.join(configFixture(version),'provenance.json'),'utf8'));
const write=(file,text)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);};
const unused='()=>{throw new Error("not used by config parsing");}';
/** Lays the vendored files out as installed packages under root; returns persisted-config.js. */
export function installPersistedConfig(version,root) {
 const modules=path.join(root,'node_modules');
 for(const relative of Object.keys(configProvenance(version).files)){
  const [pkg,...rest]=relative.split('/');
  write(path.join(modules,'@getpaseo',pkg,...rest),fs.readFileSync(path.join(configFixture(version),relative)));
 }
 write(path.join(modules,'@getpaseo/server/package.json'),JSON.stringify({name:'@getpaseo/server',version,type:'module'}));
 write(path.join(modules,'@getpaseo/protocol/package.json'),JSON.stringify({name:'@getpaseo/protocol',version,type:'module',exports:{'./*':'./dist/*.js'}}));
 write(path.join(modules,'@getpaseo/plugin/package.json'),JSON.stringify({name:'@getpaseo/plugin',type:'module',exports:{'./server':'./server.js'}}));
 write(path.join(modules,'@getpaseo/plugin/server.js'),`const unused=${unused};export const spawnProcess=unused,execCommand=unused;\n`);
 write(path.join(modules,'which/package.json'),JSON.stringify({name:'which',main:'index.js'}));
 write(path.join(modules,'which/index.js'),`module.exports=${unused};\n`);
 const zod=path.join(modules,'zod');
 if(!fs.existsSync(zod))fs.symlinkSync(path.dirname(createRequire(import.meta.url).resolve('zod/package.json')),zod,'dir');
 return path.join(modules,'@getpaseo/server/dist/server/server/persisted-config.js');
}
const loaded=new Map();
/** The module namespace of one release's dist/server/server/persisted-config.js, installed once per test process. */
export function loadPersistedConfig(version) {
 if(!loaded.has(version)){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),`pi-paseo-config-${version}-`));
  process.once('exit',()=>fs.rmSync(root,{recursive:true,force:true}));
  loaded.set(version,import(pathToFileURL(installPersistedConfig(version,root)).href));
 }
 return loaded.get(version);
}
