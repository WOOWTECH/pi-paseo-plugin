import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {runtimeDirectory} from '../../src/runtime-layout.mjs';
export function seedPidFiles(loc) {
 const fixture=path.join(path.dirname(fileURLToPath(import.meta.url)),'../fixtures/paseo-0.11.2');
 const server=path.join(runtimeDirectory(loc),'node_modules/@getpaseo/server');
 for(const relative of ['dist/server/server','dist/src/server']){
  const directory=path.join(server,relative);fs.mkdirSync(directory,{recursive:true});
  for(const file of ['pid-lock.js','private-files.js','host-name.js'])fs.copyFileSync(path.join(fixture,file),path.join(directory,file));
 }
 fs.writeFileSync(path.join(server,'package.json'),JSON.stringify({type:'module',version:'0.11.2'}));
 const zod=path.join(runtimeDirectory(loc),'node_modules/zod');
 if(!fs.existsSync(zod))fs.symlinkSync(path.dirname(createRequire(import.meta.url).resolve('zod/package.json')),zod,'dir');
 return server;
}
