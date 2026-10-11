import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {repairSdkDependency} from '../bin/repair-sdk-dependency.mjs';
function fixture(t,version='5.0.9') {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-paseo-sdk-patch-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const sdk=path.join(root,'node_modules/@earendil-works/pi-coding-agent');
 const target=path.join(sdk,'node_modules/brace-expansion');const source=path.join(root,'node_modules/brace-expansion');
 const minimatch=path.join(sdk,'node_modules/minimatch');
 for(const d of [target,source,minimatch])fs.mkdirSync(d,{recursive:true});
 fs.writeFileSync(path.join(root,'package.json'),'{}');fs.writeFileSync(path.join(sdk,'package.json'),'{"name":"@earendil-works/pi-coding-agent"}');
 fs.writeFileSync(path.join(target,'package.json'),JSON.stringify({name:'brace-expansion',version,main:'index.cjs'}));fs.writeFileSync(path.join(target,'index.cjs'),'exports.expand=()=>["old"];');
 fs.writeFileSync(path.join(source,'package.json'),'{"name":"brace-expansion","version":"5.0.12","main":"index.cjs"}');fs.writeFileSync(path.join(source,'index.cjs'),'exports.expand=()=>["a","b"];');
 fs.writeFileSync(path.join(minimatch,'package.json'),'{"main":"index.cjs"}');fs.writeFileSync(path.join(minimatch,'index.cjs'),'exports.braceExpand=require("brace-expansion").expand;');
 return {root,target,source,sdk,minimatch};
}
test('repairs the shrinkwrapped private SDK dependency before a fresh import and is idempotent',t=>{
 const f=fixture(t);assert.deepEqual(repairSdkDependency(f.root),{patched:true});
 const require=createRequire(path.join(f.sdk,'package.json'));assert.deepEqual(require('minimatch').braceExpand('{a,b}'),['a','b']);
 assert.equal(JSON.parse(fs.readFileSync(path.join(f.target,'package.json'))).version,'5.0.12');
 assert.deepEqual(repairSdkDependency(f.root),{patched:true});
 assert.deepEqual(fs.readdirSync(path.dirname(f.target)).sort(),['brace-expansion','minimatch']);
});
test('unknown dependency versions fail closed without replacing existing files',t=>{
 const f=fixture(t,'6.0.0');assert.throws(()=>repairSdkDependency(f.root),/SDK_DEPENDENCY_UNSUPPORTED/);
 assert.equal(JSON.parse(fs.readFileSync(path.join(f.target,'package.json'))).version,'6.0.0');
});
test('a redirected repair target cannot replace external files',t=>{
 const f=fixture(t);fs.rmSync(f.target,{recursive:true});fs.symlinkSync(f.source,f.target,'dir');
 // A version already patched is harmless and requires no replacement.
 fs.writeFileSync(path.join(f.source,'package.json'),'{"name":"brace-expansion","version":"5.0.9","main":"index.cjs"}');
 assert.throws(()=>repairSdkDependency(f.root),/SDK_PATCH_SOURCE_INVALID|SDK_PATCH_PATH_INVALID/);
 assert.equal(fs.lstatSync(f.target).isSymbolicLink(),true);
});
