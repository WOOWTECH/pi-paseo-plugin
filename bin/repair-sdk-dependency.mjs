import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

// Pi 1.0.0 publishes npm-shrinkwrap.json; npm ignores consumer overrides for
// its nested brace-expansion. Repair that private dependency before using Pi.
export function repairSdkDependency(root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')) {
 const require=createRequire(path.join(path.resolve(root),'package.json'));
 let sdk;
 sdk=require.resolve.paths('@earendil-works/pi-coding-agent').map(dir=>path.join(dir,'@earendil-works/pi-coding-agent')).find(dir=>fs.existsSync(path.join(dir,'package.json')));
 if(!sdk)return {skipped:true};
 if(JSON.parse(fs.readFileSync(path.join(sdk,'package.json'))).name!=='@earendil-works/pi-coding-agent')throw new Error('SDK_PATCH_PATH_INVALID');
 const sdkRequire=createRequire(path.join(sdk,'package.json'));
 const minimatchFile=sdkRequire.resolve('minimatch');
 const minimatchRequire=createRequire(minimatchFile);
 const target=path.dirname(minimatchRequire.resolve('brace-expansion/package.json'));
 const manifest=JSON.parse(fs.readFileSync(path.join(target,'package.json')));
 if(manifest.version==='5.0.12')return {patched:true};
 if(manifest.version!=='5.0.9')throw new Error('SDK_DEPENDENCY_UNSUPPORTED');
 const source=path.dirname(require.resolve('brace-expansion/package.json'));
 if(JSON.parse(fs.readFileSync(path.join(source,'package.json'))).version!=='5.0.12')throw new Error('SDK_PATCH_SOURCE_INVALID');
 if(fs.lstatSync(target).isSymbolicLink()||fs.lstatSync(source).isSymbolicLink())throw new Error('SDK_PATCH_PATH_INVALID');
 const stage=target+'.'+randomUUID(),backup=stage+'.old';
 try {
  fs.cpSync(source,stage,{recursive:true});
  fs.renameSync(target,backup);
  try {fs.renameSync(stage,target);}catch(error){fs.renameSync(backup,target);throw error;}
  fs.rmSync(backup,{recursive:true});
 } finally {fs.rmSync(stage,{recursive:true,force:true});}
 return {patched:true};
}
