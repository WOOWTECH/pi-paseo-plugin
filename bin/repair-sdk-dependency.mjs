import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

// Pi 1.0.0 publishes npm-shrinkwrap.json; npm ignores consumer overrides for
// its nested dependencies. Repair the fixed versions before loading Pi.
const readJson=file=>JSON.parse(fs.readFileSync(file));
// Search node_modules like Node does, without depending on a package's exports map.
const packageDir=(from,name)=>(createRequire(path.join(from,'package.json')).resolve.paths(name)||[])
 .map(dir=>path.join(dir,name)).find(dir=>fs.existsSync(path.join(dir,'package.json')));
// The staged copy must load each dependency at the version its source copy uses,
// for example minimatch 11's hoisted @isaacs/nonrecursive-glob-match.
function dependenciesResolve(source,stage,dependencies={}) {
 return Object.keys(dependencies).every(name=>{
  const expected=packageDir(source,name),actual=packageDir(stage,name);
  if(!expected||!actual)return false;
  const want=readJson(path.join(expected,'package.json')),have=readJson(path.join(actual,'package.json'));
  return have.name===name&&have.version===want.version;
 });
}
function atLeast(version,minimum) {
 const parts=/^(\d+)\.(\d+)\.(\d+)$/.exec(version)?.slice(1).map(Number),floor=minimum.split('.').map(Number);
 if(!parts)return false;
 for(let i=0;i<3;i++)if(parts[i]!==floor[i])return parts[i]>floor[i];
 return true;
}
function replaceNestedDependency(source, target, name, unsafe, safe, sdk, patched=version=>version===safe) {
 const manifest=readJson(path.join(target,'package.json'));
 if(manifest.name!==name)throw new Error('SDK_PATCH_PATH_INVALID');
 if(patched(manifest.version))return;
 if(manifest.version!==unsafe)throw new Error('SDK_DEPENDENCY_UNSUPPORTED');
 const sourceManifest=readJson(path.join(source,'package.json'));
 if(sourceManifest.name!==name||sourceManifest.version!==safe)throw new Error('SDK_PATCH_SOURCE_INVALID');
 if(fs.lstatSync(target).isSymbolicLink()||fs.lstatSync(source).isSymbolicLink()||
    path.relative(sdk,target).startsWith('..')||target===source)throw new Error('SDK_PATCH_PATH_INVALID');
 const stage=target+'.'+randomUUID(),backup=stage+'.old';
 try {
  fs.cpSync(source,stage,{recursive:true});
  if(!dependenciesResolve(source,stage,sourceManifest.dependencies))throw new Error('SDK_PATCH_DEPENDENCY_UNRESOLVED');
  fs.renameSync(target,backup);
  try {fs.renameSync(stage,target);}catch(error){fs.renameSync(backup,target);throw error;}
  fs.rmSync(backup,{recursive:true});
 } finally {fs.rmSync(stage,{recursive:true,force:true});}
}
export function repairSdkDependency(root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')) {
 const require=createRequire(path.join(path.resolve(root),'package.json'));
 let sdk;
 sdk=require.resolve.paths('@earendil-works/pi-coding-agent').map(dir=>path.join(dir,'@earendil-works/pi-coding-agent')).find(dir=>fs.existsSync(path.join(dir,'package.json')));
 if(!sdk)return {skipped:true};
 if(readJson(path.join(sdk,'package.json')).name!=='@earendil-works/pi-coding-agent')throw new Error('SDK_PATCH_PATH_INVALID');
 const sdkRequire=createRequire(path.join(sdk,'package.json'));
 const minimatchFile=sdkRequire.resolve('minimatch');
 const minimatchRequire=createRequire(minimatchFile);
 replaceNestedDependency(path.dirname(require.resolve('brace-expansion/package.json')),
  path.dirname(minimatchRequire.resolve('brace-expansion/package.json')),'brace-expansion','5.0.9','5.0.12',sdk);
 replaceNestedDependency(path.dirname(require.resolve('undici/package.json')),
  path.dirname(sdkRequire.resolve('undici/package.json')),'undici','8.10.2','8.12.3',sdk);
 // minimatch 11.0.1 fixes GHSA-g3hv-75wg-m249; Pi 1.5 and later ship a fixed release.
 // Only a root that pins the fix can supply it, and the Pi Web host adapter does not yet.
 if(readJson(path.join(path.resolve(root),'package.json')).dependencies?.minimatch)
  replaceNestedDependency(path.dirname(require.resolve('minimatch/package.json')),
   path.dirname(sdkRequire.resolve('minimatch/package.json')),'minimatch','10.2.6','11.0.1',sdk,version=>atLeast(version,'11.0.1'));
 return {patched:true};
}
