import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import os from 'node:os';
// Unit adapters isolate the cleanup entrypoint. The private live harness also
// runs these cases against the actual shared-runtime memory implementation.
const directory=os.tmpdir();
const provider=new URL('./',import.meta.url);
const commonSource=`import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
export const locations=()=>({home:process.env.PI_SHARED_HOME,data:process.env.PI_SHARED_DATA_DIR});
export const digest=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
export const readJSON=f=>fs.existsSync(f)?JSON.parse(fs.readFileSync(f)):{};
export const saveJSON=(f,v)=>{fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,JSON.stringify(v));};`;
const memorySource=`import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
const file=(loc,key)=>path.join(loc.data,'memory',key+'.json');
const conflict=()=>{throw Object.assign(new Error('revision conflict'),{code:'MEMORY_CONFLICT'});};
export function memoryRead(loc,key){const f=file(loc,key);return fs.existsSync(f)?JSON.parse(fs.readFileSync(f)):null;}
export async function memoryWrite(loc,args){const current=memoryRead(loc,args.key);if((current?.revision??null)!==args.expectedRevision)conflict();const record={key:args.key,content:args.content,revision:crypto.randomUUID()};fs.mkdirSync(path.dirname(file(loc,args.key)),{recursive:true});fs.writeFileSync(file(loc,args.key),JSON.stringify(record));return record;}
export async function memoryDelete(loc,args){const current=memoryRead(loc,args.key);if(!current||current.revision!==args.expectedRevision)conflict();fs.unlinkSync(file(loc,args.key));}`;
const {memoryRead,memoryWrite}=await import('data:text/javascript;base64,'+Buffer.from(memorySource).toString('base64'));
const write=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value),{mode:0o600});};
const read=file=>JSON.parse(fs.readFileSync(file));
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function fixture() {
 const temporary=fs.mkdtempSync(path.join(directory,'owned-case-'));
 const home=path.join(temporary,'home'),data=path.join(temporary,'data'),root=path.join(temporary,'shared-shim');fs.mkdirSync(home);fs.mkdirSync(data);
 const raceFile=path.join(temporary,'race.json');
 write(path.join(root,'src/common.mjs'),commonSource);
 write(path.join(root,'src/memory-base.mjs'),memorySource);
 const memory=pathToFileURL(path.join(root,'src/memory-base.mjs')).href;
 write(path.join(root,'src/memory.mjs'),`import fs from 'node:fs';import * as real from ${JSON.stringify(memory)};export const memoryRead=real.memoryRead;export const memoryWrite=real.memoryWrite;export async function memoryDelete(loc,args){const file=${JSON.stringify(raceFile)};if(fs.existsSync(file)&&JSON.parse(fs.readFileSync(file)).key===args.key){fs.unlinkSync(file);const previous=real.memoryRead(loc,args.key);await real.memoryWrite(loc,{key:args.key,content:previous.content,expectedRevision:previous.revision});}return real.memoryDelete(loc,args);}`);
 write(path.join(root,'src/sync.mjs'),"export async function synchronize(){return {skills:[{name:'acceptance-cleanup-test'},{name:'shared-host-memory'}],conflicts:[]};}");
 const env={PATH:process.env.PATH,HOME:home,PI_SHARED_HOME:home,PI_SHARED_DATA_DIR:data,PI_SHARED_PACKAGE_ROOT:root,PASEO_ACCEPTANCE_RUNTIME_IDENTITY:'package-set:sha256:'+'a'.repeat(64)};
 const invoke=(name,args)=>spawnSync(process.execPath,[fileURLToPath(new URL(name,provider)),...args],{env,encoding:'utf8',timeout:15000,maxBuffer:1024*1024});
 const prepared=invoke('prepare-shared-fixtures.mjs',['cleanup-test','hosta','hostb','--execute']);assert.equal(prepared.status,0,prepared.stderr);
 const manifestFile=path.join(home,'work/agent-connect-acceptance-cleanup-test/acceptance-manifest.json'),manifest=read(manifestFile),loc={home,data};
 const skill=path.join(manifest.skillDir,'SKILL.md'),originalSkillHash=sha(skill);
 return {temporary,home,data,root,raceFile,manifestFile,manifest,loc,skill,originalSkillHash,
  save(){write(manifestFile,manifest);},
  cleanup(){const result=invoke('cleanup-shared-fixtures.mjs',[manifestFile,'--execute']);let receipt;try{receipt=JSON.parse(result.stdout.trim().split('\n').at(-1));}catch{}return {...result,receipt};},
  dispose(){fs.rmSync(temporary,{recursive:true,force:true});}};
}
function explicitConflict(result,kind,identity) {
 assert.notEqual(result.status,0,'conflicting cleanup must not return success');
 assert.ok(result.receipt,'cleanup must emit a structured receipt even after a partial failure');
 assert.equal(result.receipt.cleanupPass,false,'receipt must not claim complete cleanup');
 assert.ok(result.receipt.conflicts?.some(row=>row.kind===kind&&Object.entries(identity).every(([key,value])=>row[key]===value)),'receipt must identify the conflicting owned resource');
}
test('control: exact fixture cleans successfully and a second cleanup is harmless',()=>{
 const f=fixture();try{
  const result=f.cleanup();assert.equal(result.status,0,result.stderr);assert.equal(result.receipt.cleanupPass,true);assert.equal(result.receipt.skillRemoved,true);assert.equal(result.receipt.mcpRemoved,true);assert.ok(result.receipt.removedMemories.includes(f.manifest.localMemoryKey));assert.equal(memoryRead(f.loc,f.manifest.localMemoryKey),null);assert.equal(fs.existsSync(f.manifestFile),true);
  const second=f.cleanup();assert.equal(second.status,0,second.stderr);assert.deepEqual(second.receipt.removedMemories,[]);
 }finally{f.dispose();}
});
test('skill content changed while retaining the nonce must be preserved and reported',()=>{
 const f=fixture();try{
  fs.appendFileSync(f.skill,'\nUser-owned instructions added after fixture creation.\n');const changed=sha(f.skill);assert.notEqual(changed,f.originalSkillHash);
  const result=f.cleanup();assert.equal(fs.existsSync(f.skill),true,'marker substring must not authorize removing modified instructions');assert.equal(sha(f.skill),changed);explicitConflict(result,'skill',{path:f.manifest.skillDir});
 }finally{f.dispose();}
});
test('an extra file makes the skill tree no longer exactly owned',()=>{
 const f=fixture();try{
  const extra=path.join(f.manifest.skillDir,'user-assets','keep.txt');write(extra,'user-owned content');const bytes=fs.readFileSync(extra),skillHash=sha(f.skill);
  const result=f.cleanup();assert.equal(fs.existsSync(extra),true,'recursive deletion must not remove an unregistered tree member');assert.deepEqual(fs.readFileSync(extra),bytes);assert.equal(sha(f.skill),skillHash);explicitConflict(result,'skill',{path:f.manifest.skillDir});
 }finally{f.dispose();}
});
for(const location of ['skill-directory','SKILL.md','skills-parent'])test(`symlink at ${location} is rejected without removing link or target`,()=>{
 const f=fixture();try{
  const external=path.join(f.temporary,'other-owner');fs.mkdirSync(external);let link,target;
  if(location==='skill-directory'){target=path.join(external,'skill');fs.renameSync(f.manifest.skillDir,target);link=f.manifest.skillDir;fs.symlinkSync(target,link,'dir');}
  else if(location==='SKILL.md'){target=path.join(external,'instructions.md');fs.renameSync(f.skill,target);link=f.skill;fs.symlinkSync(target,link,'file');}
  else{target=path.join(external,'skills');link=path.dirname(f.manifest.skillDir);fs.renameSync(link,target);fs.symlinkSync(target,link,'dir');}
  const targetFile=location==='SKILL.md'?target:location==='skill-directory'?path.join(target,'SKILL.md'):path.join(target,f.manifest.skillName,'SKILL.md');const bytes=fs.readFileSync(targetFile);
  const result=f.cleanup();assert.ok(fs.lstatSync(link,{throwIfNoEntry:false})?.isSymbolicLink(),'cleanup must preserve a foreign symlink');assert.equal(fs.existsSync(targetFile),true,'cleanup must not traverse a symlink to delete foreign files');assert.deepEqual(fs.readFileSync(targetFile),bytes);explicitConflict(result,'skill',{path:f.manifest.skillDir});
 }finally{f.dispose();}
});
test('newer attempted write is owned even when writes contains an older accepted marker',async()=>{
 const f=fixture();try{
  const key='owned-retry',old='OLD_'+crypto.randomUUID(),fresh='NEW_'+crypto.randomUUID();
  const first=await memoryWrite(f.loc,{key,content:old,expectedRevision:null});const latest=await memoryWrite(f.loc,{key,content:fresh,expectedRevision:first.revision});
  f.manifest.writes=[{key,marker:old,revision:first.revision}];f.manifest.attemptedWrites=[{key,marker:old},{key,marker:fresh}];f.save();
  const result=f.cleanup();assert.equal(result.status,0,result.stderr);assert.equal(memoryRead(f.loc,key),null,'current owned attempted write must not be silently skipped');assert.ok(result.receipt.removedMemories.includes(key));assert.notEqual(latest.revision,first.revision);assert.equal(result.receipt.memoryResults.find(row=>row.key===key).expectedRevision,latest.revision);
 }finally{f.dispose();}
});
test('unrecognized current memory content remains and produces a conflict receipt',async()=>{
 const f=fixture();try{
  const key='owned-key-conflict',owned='OWNED_'+crypto.randomUUID(),other='USER_'+crypto.randomUUID();const original=await memoryWrite(f.loc,{key,content:owned,expectedRevision:null});const changed=await memoryWrite(f.loc,{key,content:other,expectedRevision:original.revision});f.manifest.attemptedWrites=[{key,marker:owned}];f.save();
  const result=f.cleanup();assert.deepEqual(memoryRead(f.loc,key),changed);explicitConflict(result,'memory',{key});assert.equal(result.stdout.includes(other),false,'receipt must not expose foreign memory content');
 }finally{f.dispose();}
});
test('revision race preserves the replacement memory and records MEMORY_CONFLICT',async()=>{
 const f=fixture();try{
  const key='owned-race',marker='RACE_'+crypto.randomUUID(),first=await memoryWrite(f.loc,{key,content:marker,expectedRevision:null});f.manifest.attemptedWrites=[{key,marker}];f.save();write(f.raceFile,{key});
  const result=f.cleanup(),current=memoryRead(f.loc,key);assert.equal(current.content,marker);assert.notEqual(current.revision,first.revision);explicitConflict(result,'memory',{key,code:'MEMORY_CONFLICT'});assert.ok(!result.receipt.removedMemories.includes(key));
 }finally{f.dispose();}
});
