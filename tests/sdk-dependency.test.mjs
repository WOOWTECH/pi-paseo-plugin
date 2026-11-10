import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {repairSdkDependency} from '../bin/repair-sdk-dependency.mjs';
const write=(file,content)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,typeof content==='string'?content:JSON.stringify(content));};
const versionAt=dir=>JSON.parse(fs.readFileSync(path.join(dir,'package.json'))).version;
function fixture(t,version='5.0.9') {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-paseo-sdk-patch-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const sdk=path.join(root,'node_modules/@earendil-works/pi-coding-agent');
 const target=path.join(sdk,'node_modules/brace-expansion');const source=path.join(root,'node_modules/brace-expansion');
 const targetUndici=path.join(sdk,'node_modules/undici');const sourceUndici=path.join(root,'node_modules/undici');
 const minimatch=path.join(sdk,'node_modules/minimatch');
 for(const d of [target,source,targetUndici,sourceUndici,minimatch])fs.mkdirSync(d,{recursive:true});
 fs.writeFileSync(path.join(root,'package.json'),'{}');fs.writeFileSync(path.join(sdk,'package.json'),'{"name":"@earendil-works/pi-coding-agent"}');
 fs.writeFileSync(path.join(target,'package.json'),JSON.stringify({name:'brace-expansion',version,main:'index.cjs'}));fs.writeFileSync(path.join(target,'index.cjs'),'exports.expand=()=>["old"];');
 fs.writeFileSync(path.join(source,'package.json'),'{"name":"brace-expansion","version":"5.0.12","main":"index.cjs"}');fs.writeFileSync(path.join(source,'index.cjs'),'exports.expand=()=>["a","b"];');
 fs.writeFileSync(path.join(targetUndici,'package.json'),'{"name":"undici","version":"8.10.2","main":"index.cjs"}');fs.writeFileSync(path.join(targetUndici,'index.cjs'),'exports.version="8.10.2";');
 fs.writeFileSync(path.join(sourceUndici,'package.json'),'{"name":"undici","version":"8.12.3","main":"index.cjs"}');fs.writeFileSync(path.join(sourceUndici,'index.cjs'),'exports.version="8.12.3";');
 fs.writeFileSync(path.join(minimatch,'package.json'),'{"main":"index.cjs"}');fs.writeFileSync(path.join(minimatch,'index.cjs'),'exports.braceExpand=require("brace-expansion").expand;');
 return {root,target,source,targetUndici,sourceUndici,sdk,minimatch};
}
// The plugin pins minimatch 11.0.1 beside Pi 1.0.0's private 10.2.6. With `nested`, npm put the
// plugin's copy and its new dependency under the plugin, below a consumer that holds the SDK.
function minimatchFixture(t,{sdkVersion='10.2.6',nested=false}={}) {
 const f=fixture(t),plugin=nested?path.join(f.root,'node_modules/@woowtech/pi-paseo'):f.root;
 write(path.join(plugin,'package.json'),{name:'@woowtech/pi-paseo',dependencies:{minimatch:'11.0.1'}});
 write(path.join(f.minimatch,'package.json'),{name:'minimatch',version:sdkVersion,main:'index.cjs'});
 write(path.join(f.minimatch,'index.cjs'),`exports.version=${JSON.stringify(sdkVersion)};exports.braceExpand=require("brace-expansion").expand;`);
 const source=path.join(plugin,'node_modules/minimatch'),glob=path.join(plugin,'node_modules/@isaacs/nonrecursive-glob-match');
 write(path.join(source,'package.json'),{name:'minimatch',version:'11.0.1',main:'index.cjs',dependencies:{'@isaacs/nonrecursive-glob-match':'^1.0.1','brace-expansion':'^5.0.12'}});
 write(path.join(source,'index.cjs'),'const {Matcher}=require("@isaacs/nonrecursive-glob-match");exports.version="11.0.1";exports.braceExpand=require("brace-expansion").expand;exports.minimatch=(p,pattern)=>new Matcher(pattern).match(p);');
 write(path.join(glob,'package.json'),{name:'@isaacs/nonrecursive-glob-match',version:'1.1.0',main:'index.cjs'});
 write(path.join(glob,'index.cjs'),'exports.Matcher=class{constructor(p){this.p=p}match(s){return this.p==="*"||this.p===s}};');
 return {...f,plugin,glob};
}
test('repairs the shrinkwrapped private SDK dependency before a fresh import and is idempotent',t=>{
 const f=fixture(t);assert.deepEqual(repairSdkDependency(f.root),{patched:true});
 const require=createRequire(path.join(f.sdk,'package.json'));assert.deepEqual(require('minimatch').braceExpand('{a,b}'),['a','b']);
 assert.equal(JSON.parse(fs.readFileSync(path.join(f.targetUndici,'package.json'))).version,'8.12.3');
 assert.equal(require('undici').version,'8.12.3');
 assert.equal(JSON.parse(fs.readFileSync(path.join(f.target,'package.json'))).version,'5.0.12');
 assert.deepEqual(repairSdkDependency(f.root),{patched:true});
 assert.deepEqual(fs.readdirSync(path.dirname(f.target)).sort(),['brace-expansion','minimatch','undici']);
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
test('replaces the private minimatch 10 with the pinned 11.0.1, whose new dependency resolves from the SDK',t=>{
 const f=minimatchFixture(t);assert.deepEqual(repairSdkDependency(f.plugin),{patched:true});
 const require=createRequire(path.join(f.sdk,'package.json')),minimatch=require('minimatch');
 assert.equal(minimatch.version,'11.0.1');assert.equal(versionAt(f.minimatch),'11.0.1');
 assert.equal(minimatch.minimatch('extensions/keep.ts','*'),true);assert.deepEqual(minimatch.braceExpand('{a,b}'),['a','b']);
 assert.deepEqual(repairSdkDependency(f.plugin),{patched:true});
 assert.deepEqual(fs.readdirSync(path.dirname(f.minimatch)).sort(),['brace-expansion','minimatch','undici']);
});
test('a minimatch whose dependency the SDK cannot load is not installed until npm hoists it',t=>{
 const f=minimatchFixture(t,{nested:true});
 assert.throws(()=>repairSdkDependency(f.plugin),/SDK_PATCH_DEPENDENCY_UNRESOLVED/);
 assert.equal(versionAt(f.minimatch),'10.2.6');
 assert.deepEqual(fs.readdirSync(path.dirname(f.minimatch)).sort(),['brace-expansion','minimatch','undici']);
 fs.renameSync(path.dirname(f.glob),path.join(f.root,'node_modules/@isaacs'));
 assert.deepEqual(repairSdkDependency(f.plugin),{patched:true});
 assert.equal(createRequire(path.join(f.sdk,'package.json'))('minimatch').minimatch('a','a'),true);
});
test('a later Pi with patched minimatch is kept and unknown minimatch versions fail closed',t=>{
 for(const [sdkVersion,error] of [['11.0.3',null],['12.0.0',null],['10.2.5',/SDK_DEPENDENCY_UNSUPPORTED/],['11.0.0',/SDK_DEPENDENCY_UNSUPPORTED/]]) {
  const f=minimatchFixture(t,{sdkVersion});
  if(error)assert.throws(()=>repairSdkDependency(f.plugin),error);else assert.deepEqual(repairSdkDependency(f.plugin),{patched:true});
  assert.equal(createRequire(path.join(f.sdk,'package.json'))('minimatch').version,sdkVersion);
 }
});
test('a root that does not pin minimatch, like the Pi Web host, keeps the SDK copy it shipped',t=>{
 const f=fixture(t);write(path.join(f.minimatch,'package.json'),{name:'minimatch',version:'10.2.6',main:'index.cjs'});
 assert.deepEqual(repairSdkDependency(f.root),{patched:true});
 assert.equal(versionAt(f.minimatch),'10.2.6');assert.equal(versionAt(f.target),'5.0.12');assert.equal(versionAt(f.targetUndici),'8.12.3');
});
test('the installed Pi SDK matches globs with the minimatch 11 that the lockfile records',async t=>{
 // npm ci installs Pi 1.0.0's shrinkwrapped copies; its postinstall must leave the tree npm audit reads.
 const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
 const lock=JSON.parse(fs.readFileSync(path.join(repo,'package-lock.json'))).packages;
 const sdk=path.join(repo,'node_modules/@earendil-works/pi-coding-agent');
 for(const name of ['minimatch','brace-expansion','undici']) {
  const key=`node_modules/@earendil-works/pi-coding-agent/node_modules/${name}`;
  assert.equal(versionAt(path.join(repo,key)),lock[key].version,key);
 }
 assert.equal(lock['node_modules/@earendil-works/pi-coding-agent/node_modules/minimatch'].version,'11.0.1');
 const glob=createRequire(path.join(sdk,'node_modules/minimatch/package.json')).resolve('@isaacs/nonrecursive-glob-match');
 assert.equal(path.relative(path.join(repo,'node_modules/@isaacs/nonrecursive-glob-match'),glob).startsWith('..'),false);
 assert.equal(versionAt(path.join(repo,'node_modules/@isaacs/nonrecursive-glob-match')),lock['node_modules/@isaacs/nonrecursive-glob-match'].version);
 const load=file=>import(pathToFileURL(path.join(sdk,'dist/core',file)).href);
 const [{DefaultPackageManager},{SettingsManager},{resolveModelScopeFromModels}]=await Promise.all(['package-manager.js','settings-manager.js','model-resolver.js'].map(load));
 const models=[{provider:'anthropic',id:'claude-sonnet-4-5'},{provider:'anthropic',id:'claude-opus-4-1'},{provider:'openai',id:'gpt-5.1-codex'},{provider:'openai',id:'gpt-5.1'}];
 const scope=resolveModelScopeFromModels(['anthropic/*SONNET*','*codex*:high','openai/gpt-5.?','none/*'],models);
 assert.deepEqual(scope.scopedModels.map(s=>`${s.model.provider}/${s.model.id}${s.thinkingLevel?':'+s.thinkingLevel:''}`),
  ['anthropic/claude-sonnet-4-5','openai/gpt-5.1-codex:high','openai/gpt-5.1']);
 assert.deepEqual(scope.diagnostics.map(d=>d.pattern),['none/*']);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pi-paseo-sdk-glob-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const agentDir=path.join(dir,'agent'),cwd=path.join(dir,'work'),pkg=path.join(dir,'pkg');fs.mkdirSync(agentDir);fs.mkdirSync(cwd);
 for(const file of ['extensions/keep.ts','extensions/skip.ts','extensions/nested/index.ts'])write(path.join(pkg,file),'export default function () {}\n');
 for(const skill of ['alpha','beta'])write(path.join(pkg,'skills',skill,'SKILL.md'),`---\nname: ${skill}\ndescription: Fixture skill ${skill}\n---\n`);
 write(path.join(pkg,'package.json'),{name:'glob-fixture',version:'1.0.0',pi:{extensions:['./extensions'],skills:['./skills']}});
 write(path.join(agentDir,'settings.json'),{packages:[{source:pkg,extensions:['extensions/*.ts','!**/skip.ts'],skills:['!skills/b*']}]});
 const resolved=await new DefaultPackageManager({cwd,agentDir,settingsManager:SettingsManager.create(cwd,agentDir)}).resolve();
 const enabled=type=>resolved[type].map(r=>[path.relative(pkg,r.path),r.enabled]);
 assert.deepEqual(enabled('extensions'),[['extensions/keep.ts',true],['extensions/nested/index.ts',false],['extensions/skip.ts',false]]);
 assert.deepEqual(enabled('skills'),[['skills/alpha/SKILL.md',true],['skills/beta/SKILL.md',false]]);
});
