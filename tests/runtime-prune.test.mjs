import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {monitorEventLoopDelay} from 'node:perf_hooks';
import {RUNTIME_REVISION,REMOVAL_BATCH,ownedReleases,prunePlan,claimReleases,removeTree,removeTombs,pruneRuntimeReleases} from '../src/runtime-layout.mjs';

// Revisions of the releases Agent Connect 0.1.4-0.1.23 shipped (see runtime-layout.mjs), and this one.
const R4='0.11.2-r4-4cf9d40940bf',R3A='0.11.2-r3-4cf9d40940bf',R3B='0.11.2-r3-6d8dbe515479',R2='0.11.2-r2-6d8dbe515479',R1='0.11.2-r1-0123456789ab';
const lockOf=revision=>revision.slice(-12)+'0'.repeat(52);
const receipt=revision=>JSON.stringify({revision,lockSha256:lockOf(revision)});
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pi-paseo-prune-'));
 const loc={runtimeDir:path.join(dir,'runtime')};
 const releases=path.join(loc.runtimeDir,'releases');fs.mkdirSync(releases,{recursive:true});
 // A test may leave a directory it made unwritable: give the owner back its rights before removing the tree.
 t.after(()=>{spawnSync('chmod',['-R','u+rwX',dir]);fs.rmSync(dir,{recursive:true,force:true});});
 return {dir,loc,releases,
  /** A release as the installer leaves it: packages, a nested directory, a receipt. */
  release(revision,{withReceipt=true,receiptText=receipt(revision)}={}){
   const root=path.join(releases,revision);
   fs.mkdirSync(path.join(root,'node_modules/@getpaseo/cli'),{recursive:true});
   fs.writeFileSync(path.join(root,'node_modules/@getpaseo/cli/package.json'),'{"version":"0.0.0"}');
   fs.writeFileSync(path.join(root,'package.json'),'{}');
   if(withReceipt)fs.writeFileSync(path.join(root,'.pi-paseo-runtime.json'),receiptText);
   return root;
  },
  names:()=>fs.readdirSync(releases).sort()};
}

// The four fs.promises calls removeTree makes, with each one written down as [operation, path] before it runs.
const OPS=['lstat','readdir','unlink','rmdir'];
const watched=(seen,before=async()=>{})=>Object.fromEntries(OPS.map(op=>[op,async(target,...rest)=>{seen.push([op,target]);await before(op,target);return fs.promises[op](target,...rest);}]));
const EIO=()=>Object.assign(new Error('EIO'),{code:'EIO'});

const NEWER='0.99.0-r1-bbbbbbbbbbbb';
test('this release, exactly the newest earlier one and every newer one stay; the other plugin-owned releases go',async t=>{
 const f=fixture(t);
 for(const revision of [RUNTIME_REVISION,R4,R3A,R3B,R2,R1,NEWER])f.release(revision);
 const result=await pruneRuntimeReleases(f.loc);
 // A newer release (a plugin downgrade left it) is no rollback target, and costs 0.7 GB to download again: it stays.
 assert.deepEqual(f.names(),[NEWER,R4,RUNTIME_REVISION].sort());
 assert.deepEqual(result.kept,[NEWER,RUNTIME_REVISION,R4]);
 assert.deepEqual(result.removed.sort(),[R1,R2,R3A,R3B].sort());assert.deepEqual(result.failed,[]);assert.equal(result.skipped,undefined);
});

test('with only newer releases besides this one, the rollback is still the newest earlier release',async t=>{
 const f=fixture(t);
 for(const revision of [RUNTIME_REVISION,NEWER,'0.98.0-r2-cccccccccccc',R3A,R2])f.release(revision);
 await pruneRuntimeReleases(f.loc);
 assert.deepEqual(f.names(),[NEWER,'0.98.0-r2-cccccccccccc',R3A,RUNTIME_REVISION].sort());
});

test('planning reads only, claiming only renames, removing deletes: the lock is needed for the second step alone',async t=>{
 const f=fixture(t);
 for(const revision of [RUNTIME_REVISION,R4,R3A,R2])f.release(revision);
 const before=f.names(),plan=prunePlan(f.loc);
 assert.deepEqual(plan,{candidates:[R3A,R2],kept:[RUNTIME_REVISION,R4],tombs:[]});assert.deepEqual(f.names(),before,'planning changes nothing');
 const claim=claimReleases(f.loc,plan.candidates);
 assert.deepEqual(claim.failed,[]);assert.deepEqual(claim.claimed.map(row=>row.name),[R3A,R2]);
 assert.ok(claim.claimed.every(row=>row.tomb.startsWith('.pruning-'+row.name+'-')&&fs.existsSync(path.join(f.releases,row.tomb,'package.json'))),'renamed whole, nothing deleted yet');
 assert.deepEqual(ownedReleases(f.loc).map(release=>release.name),[RUNTIME_REVISION,R4],'a claimed release is no release any more');
 assert.deepEqual(prunePlan(f.loc).tombs.map(row=>row.name).sort(),[R2,R3A].sort(),'and the next plan lists it as a leftover');
 const seen=[],done=await removeTombs(f.loc,claim.claimed,{ops:watched(seen)});
 assert.deepEqual(done.removed.sort(),[R2,R3A].sort());assert.deepEqual(done.failed,[]);assert.deepEqual(f.names(),[R4,RUNTIME_REVISION].sort());
 const finished=seen.filter(([op])=>op==='rmdir').map(([,target])=>path.basename(target));
 for(const {tomb} of claim.claimed)assert.ok(finished.includes(tomb),'each tomb ends with the removal of its own directory: '+tomb);
 assert.ok(seen.every(([,target])=>target.startsWith(f.releases+path.sep+'.pruning-')),'only inside the tombs');
});

test('claiming refuses this release and whatever is not an owned release; removing touches tombs only',async t=>{
 const f=fixture(t);
 f.release(RUNTIME_REVISION);f.release(R4);f.release(R3A,{withReceipt:false});fs.mkdirSync(path.join(f.releases,'custom'));
 const claim=claimReleases(f.loc,[RUNTIME_REVISION,R3A,'custom','0.1.0-r1-aaaaaaaaaaaa']);
 assert.deepEqual(claim.claimed,[]);assert.deepEqual(claim.failed,[RUNTIME_REVISION,R3A,'custom','0.1.0-r1-aaaaaaaaaaaa']);
 assert.deepEqual(f.names(),[R3A,R4,RUNTIME_REVISION,'custom'].sort());
 const tomb='.pruning-'+R2+'-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';fs.mkdirSync(path.join(f.releases,tomb));
 const seen=[];
 const done=await removeTombs(f.loc,[{name:R4,tomb:R4},{name:'x',tomb:'custom'},{name:R2,tomb},{name:R1,tomb:'.pruning-'+R1+'-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'}],{ops:watched(seen)});
 assert.deepEqual([...new Set(seen.map(([,target])=>path.basename(target)))],[tomb],'only the tomb that exists was touched');assert.deepEqual(done.failed.sort(),[R4,'x'].sort());assert.deepEqual(done.removed.sort(),[R1,R2].sort(),'a tomb that is already gone counts as done');
 assert.ok(fs.existsSync(path.join(f.releases,R4,'package.json'))&&fs.existsSync(path.join(f.releases,'custom')));
 const broken={...fs.promises,lstat:async()=>{throw EIO();}};
 const failing=await removeTombs(f.loc,[{name:R2,tomb:'.pruning-'+R2+'-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'}],{ops:broken});
 assert.deepEqual(failing,{removed:[R2],failed:[]},'a missing tomb is done whatever the file system would say');
 fs.mkdirSync(path.join(f.releases,tomb));
 assert.deepEqual(await removeTombs(f.loc,[{name:R2,tomb}],{ops:broken}),{removed:[],failed:[R2]});
});

test('earlier means an older Paseo version, then an older revision number, whatever the directory times say',async t=>{
 const f=fixture(t);
 const older='0.17.3-r9-cccccccccccc',sameVersion='0.17.4-r0-dddddddddddd',oldest='0.16.2-r4-eeeeeeeeeeee';
 for(const revision of [RUNTIME_REVISION,older,sameVersion,oldest])f.release(revision);
 // The oldest release was touched last: recency is not what orders them.
 fs.utimesSync(path.join(f.releases,oldest),new Date(),new Date());fs.utimesSync(path.join(f.releases,oldest,'.pi-paseo-runtime.json'),new Date(),new Date());
 await pruneRuntimeReleases(f.loc);
 assert.deepEqual(f.names(),[sameVersion,RUNTIME_REVISION].sort());
 assert.deepEqual(ownedReleases(f.loc).map(release=>release.name),[RUNTIME_REVISION,sameVersion]);
});

test('two releases of one version and revision number (two lockfiles): the later receipt is the rollback',async t=>{
 const f=fixture(t);
 for(const revision of [RUNTIME_REVISION,R3A,R3B])f.release(revision);
 const early=new Date('2026-10-01T00:00:00Z'),late=new Date('2026-11-01T00:00:00Z');
 fs.utimesSync(path.join(f.releases,R3A,'.pi-paseo-runtime.json'),early,early);fs.utimesSync(path.join(f.releases,R3B,'.pi-paseo-runtime.json'),late,late);
 await pruneRuntimeReleases(f.loc);
 assert.deepEqual(f.names(),[R3B,RUNTIME_REVISION].sort());
});

// Two lockfiles under one Paseo version and revision number (r3 shipped that way): by number they tie with this release,
// so the receipt time that orders the list decides, and a tie is never a reason to remove one of them.
const SIBLING_A='0.17.4-r1-aaaaaaaaaaaa',SIBLING_B='0.17.4-r1-bbbbbbbbbbbb';
const stamp=(f,revision,iso)=>{const when=new Date(iso);fs.utimesSync(path.join(f.releases,revision,'.pi-paseo-runtime.json'),when,when);};
test('a sibling of this release (same Paseo version and revision number, another lockfile) is never pruned for the tie: installed later it is newer, earlier it is the rollback',async t=>{
 // Installed before this release: the rollback, and with it the one that decides which older release goes.
 const earlier=fixture(t);
 for(const revision of [RUNTIME_REVISION,SIBLING_A,R4])earlier.release(revision);
 stamp(earlier,RUNTIME_REVISION,'2026-11-20T00:00:00Z');stamp(earlier,SIBLING_A,'2026-11-01T00:00:00Z');
 assert.deepEqual(ownedReleases(earlier.loc).map(release=>release.name),[RUNTIME_REVISION,SIBLING_A,R4]);
 assert.deepEqual(prunePlan(earlier.loc),{candidates:[R4],kept:[RUNTIME_REVISION,SIBLING_A],tombs:[]});
 await pruneRuntimeReleases(earlier.loc);
 assert.deepEqual(earlier.names(),[SIBLING_A,RUNTIME_REVISION].sort());
 // Installed after this release: newer, kept like any newer release, and this release's rollback is the one after it.
 const later=fixture(t);
 for(const revision of [RUNTIME_REVISION,SIBLING_A,R4,R3A])later.release(revision);
 stamp(later,RUNTIME_REVISION,'2026-11-01T00:00:00Z');stamp(later,SIBLING_A,'2026-11-20T00:00:00Z');
 assert.deepEqual(ownedReleases(later.loc).map(release=>release.name),[SIBLING_A,RUNTIME_REVISION,R4,R3A]);
 assert.deepEqual(prunePlan(later.loc),{candidates:[R3A],kept:[SIBLING_A,RUNTIME_REVISION,R4],tombs:[]});
 await pruneRuntimeReleases(later.loc);
 assert.deepEqual(later.names(),[SIBLING_A,R4,RUNTIME_REVISION].sort());
});

test('with two siblings of this release, the one installed right before it is the rollback and the other goes with the older releases',async t=>{
 const f=fixture(t);
 for(const revision of [RUNTIME_REVISION,SIBLING_A,SIBLING_B,R4])f.release(revision);
 stamp(f,RUNTIME_REVISION,'2026-11-20T00:00:00Z');stamp(f,SIBLING_A,'2026-11-10T00:00:00Z');stamp(f,SIBLING_B,'2026-11-01T00:00:00Z');
 assert.deepEqual(prunePlan(f.loc),{candidates:[SIBLING_B,R4],kept:[RUNTIME_REVISION,SIBLING_A],tombs:[]});
 // The same receipt time: the larger name counts as newer, whichever way the directory happens to list them.
 for(const revision of [RUNTIME_REVISION,SIBLING_A,SIBLING_B])stamp(f,revision,'2026-11-01T00:00:00Z');
 const list=[...[RUNTIME_REVISION,SIBLING_A,SIBLING_B].sort().reverse(),R4],index=list.indexOf(RUNTIME_REVISION);
 assert.deepEqual(ownedReleases(f.loc).map(release=>release.name),list);
 assert.deepEqual(prunePlan(f.loc),{candidates:list.slice(index+2),kept:list.slice(0,index+2),tombs:[]});
});

test('a release the caller names stays, however old',async t=>{
 const f=fixture(t);
 for(const revision of [RUNTIME_REVISION,R4,R3A,R2])f.release(revision);
 const result=await pruneRuntimeReleases(f.loc,{keep:[R3A,'not-a-release-at-all']});
 assert.deepEqual(f.names(),[R3A,R4,RUNTIME_REVISION].sort());assert.deepEqual(result.removed,[R2]);
});

test('an entry that is not provably a plugin-owned release is never touched',async t=>{
 const f=fixture(t);
 f.release(RUNTIME_REVISION);f.release(R4);
 const foreign={
  noReceipt:f.release('0.11.2-r3-aaaaaaaaaaaa',{withReceipt:false}),
  otherRevision:f.release('0.11.2-r3-bbbbbbbbbbbb',{receiptText:receipt(R3A)}),
  brokenJson:f.release('0.11.2-r3-cccccccccccc',{receiptText:'{broken'}),
  hashOfAnother:f.release('0.11.2-r3-dddddddddddd',{receiptText:JSON.stringify({revision:'0.11.2-r3-dddddddddddd',lockSha256:lockOf(R3A)})}),
  noHash:f.release('0.11.2-r3-eeeeeeeeeeee',{receiptText:JSON.stringify({revision:'0.11.2-r3-eeeeeeeeeeee'})}),
  notAnObject:f.release('0.11.2-r3-ffffffffffff',{receiptText:'[]'}),
  hugeReceipt:f.release('0.11.2-r3-111111111111',{receiptText:' '.repeat(70000)+receipt('0.11.2-r3-111111111111')}),
 };
 // Names that are not revisions, a plain file named like one, an uppercase hash, a half-finished download.
 const others=['0.11.2-r2-6d8dbe515479.bak','custom','.tmp-install','0.11.2-r2-6D8DBE515479','0.11.2-r2-short','0.11.2-6d8dbe515479','v0.11.2-r2-6d8dbe515479'];
 for(const name of others){fs.mkdirSync(path.join(f.releases,name,'node_modules'),{recursive:true});fs.writeFileSync(path.join(f.releases,name,'.pi-paseo-runtime.json'),receipt('0.11.2-r2-6d8dbe515479'));}
 fs.writeFileSync(path.join(f.releases,'0.11.2-r2-aaaaaaaaaaaa'),receipt('0.11.2-r2-aaaaaaaaaaaa'));
 // Outside releases/: the legacy control copy earlier plugin versions installed, and files nobody here owns.
 fs.mkdirSync(path.join(f.loc.runtimeDir,'node_modules/@getpaseo/cli'),{recursive:true});fs.writeFileSync(path.join(f.loc.runtimeDir,'node_modules/@getpaseo/cli/package.json'),'{"version":"0.11.2"}');
 fs.writeFileSync(path.join(f.loc.runtimeDir,'package.json'),'{}');
 const before=f.names();
 const result=await pruneRuntimeReleases(f.loc);
 assert.deepEqual(f.names(),before,'nothing was removed or renamed');assert.deepEqual(result.removed,[]);assert.deepEqual(result.failed,[]);
 for(const root of Object.values(foreign))assert.ok(fs.existsSync(path.join(root,'package.json')),root);
 assert.ok(fs.existsSync(path.join(f.loc.runtimeDir,'node_modules/@getpaseo/cli/package.json')));assert.ok(fs.existsSync(path.join(f.loc.runtimeDir,'package.json')));
 assert.deepEqual(ownedReleases(f.loc).map(release=>release.name),[RUNTIME_REVISION,R4]);
});

test('a link is never followed: a release-named link, a linked receipt, a linked releases directory, a link inside a release',async t=>{
 const f=fixture(t);
 f.release(RUNTIME_REVISION);f.release(R4);
 const outside=path.join(f.dir,'outside');fs.mkdirSync(path.join(outside,'target/node_modules'),{recursive:true});
 fs.writeFileSync(path.join(outside,'target/.pi-paseo-runtime.json'),receipt(R3A));fs.writeFileSync(path.join(outside,'target/node_modules/keep.txt'),'precious');
 fs.symlinkSync(path.join(outside,'target'),path.join(f.releases,R3A),'dir');
 // A release whose receipt is a link to a valid one, and an old release with a link into the outside directory.
 f.release(R3B,{withReceipt:false});fs.symlinkSync(path.join(outside,'target/.pi-paseo-runtime.json'),path.join(f.releases,R3B,'.pi-paseo-runtime.json'));
 f.release(R2);fs.symlinkSync(outside,path.join(f.releases,R2,'node_modules/escape'),'dir');
 const result=await pruneRuntimeReleases(f.loc);
 assert.equal(fs.lstatSync(path.join(f.releases,R3A)).isSymbolicLink(),true,'the link stays');
 assert.equal(fs.readFileSync(path.join(outside,'target/node_modules/keep.txt'),'utf8'),'precious');assert.ok(fs.existsSync(path.join(f.releases,R3B,'package.json')),'a linked receipt does not make an owned release');
 assert.deepEqual(result.removed,[R2]);assert.equal(fs.existsSync(path.join(f.releases,R2)),false);
 assert.equal(fs.readFileSync(path.join(outside,'target/node_modules/keep.txt'),'utf8'),'precious','what the link inside a removed release pointed to is untouched');
 // The releases directory itself behind a link: not even listed.
 const real=path.join(f.dir,'real-releases');fs.renameSync(f.releases,real);fs.symlinkSync(real,f.releases,'dir');
 const before=fs.readdirSync(real).sort();
 assert.deepEqual(await pruneRuntimeReleases(f.loc),{removed:[],kept:[],failed:[],skipped:'RELEASES_UNSAFE'});assert.deepEqual(fs.readdirSync(real).sort(),before);assert.deepEqual(ownedReleases(f.loc),[]);
});

test('a failure to remove is reported by name, breaks nothing, and the next run finishes the job',{skip:process.getuid?.()===0&&'permissions do not stop root'},async t=>{
 const f=fixture(t);
 for(const revision of [RUNTIME_REVISION,R4,R3A,R2])f.release(revision);
 // Nothing can be renamed in a read-only releases directory: every release stays whole and valid.
 fs.chmodSync(f.releases,0o555);
 const refused=await pruneRuntimeReleases(f.loc);
 assert.deepEqual(refused.removed,[]);assert.deepEqual(refused.failed.sort(),[R2,R3A].sort());
 fs.chmodSync(f.releases,0o755);assert.deepEqual(ownedReleases(f.loc).map(release=>release.name).sort(),[RUNTIME_REVISION,R4,R3A,R2].sort());
 // A tree that cannot be emptied: the release is already renamed away, so it cannot be mistaken for a release...
 const stuck=path.join(f.releases,R3A,'node_modules/@getpaseo/cli');fs.chmodSync(stuck,0o555);
 const partial=await pruneRuntimeReleases(f.loc);
 assert.deepEqual(partial.removed,[R2]);assert.deepEqual(partial.failed,[R3A]);
 assert.deepEqual(ownedReleases(f.loc).map(release=>release.name).sort(),[RUNTIME_REVISION,R4].sort());
 assert.equal(f.names().filter(name=>name.startsWith('.pruning-'+R3A+'-')).length,1,'what is left is named for what it was');
 // ...and once it can be emptied, the next prune removes it and says so.
 for(const name of f.names().filter(name=>name.startsWith('.pruning-')))fs.chmodSync(path.join(f.releases,name,'node_modules/@getpaseo/cli'),0o755);
 const finished=await pruneRuntimeReleases(f.loc);
 assert.deepEqual(finished.removed,[R3A]);assert.deepEqual(finished.failed,[]);assert.deepEqual(f.names(),[R4,RUNTIME_REVISION].sort());
});

test('pruning twice changes nothing the second time',async t=>{
 const f=fixture(t);
 for(const revision of [RUNTIME_REVISION,R4,R3A,R2])f.release(revision);
 const first=await pruneRuntimeReleases(f.loc),again=await pruneRuntimeReleases(f.loc);
 assert.deepEqual(first.removed.sort(),[R2,R3A].sort());
 assert.deepEqual(again,{removed:[],kept:[RUNTIME_REVISION,R4],failed:[]});assert.deepEqual(f.names(),[R4,RUNTIME_REVISION].sort());
});

test('without a valid current release, or without a releases directory, nothing is removed',async t=>{
 const f=fixture(t);
 for(const revision of [R4,R3A])f.release(revision);
 assert.deepEqual(await pruneRuntimeReleases(f.loc),{removed:[],kept:[],failed:[],skipped:'CURRENT_RELEASE_NOT_FOUND'});assert.deepEqual(f.names(),[R3A,R4].sort());
 f.release(RUNTIME_REVISION,{withReceipt:false});
 assert.equal((await pruneRuntimeReleases(f.loc)).skipped,'CURRENT_RELEASE_NOT_FOUND');
 fs.rmSync(f.releases,{recursive:true});
 assert.deepEqual(await pruneRuntimeReleases(f.loc),{removed:[],kept:[],failed:[]});
 fs.writeFileSync(f.releases,'a file');
 assert.equal((await pruneRuntimeReleases(f.loc)).skipped,'RELEASES_NOT_A_DIRECTORY');
});

test('only a leftover that this code named is finished, and only if it is a real directory',async t=>{
 const f=fixture(t);
 f.release(RUNTIME_REVISION);
 const own='.pruning-'+R3A+'-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
 fs.mkdirSync(path.join(f.releases,own,'node_modules'),{recursive:true});fs.mkdirSync(path.join(f.releases,'.pruning-custom'),{recursive:true});
 const outside=path.join(f.dir,'outside');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'keep.txt'),'precious');
 fs.symlinkSync(outside,path.join(f.releases,'.pruning-'+R2+'-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'),'dir');
 const result=await pruneRuntimeReleases(f.loc);
 assert.deepEqual(result.removed,[R3A]);assert.equal(fs.existsSync(path.join(f.releases,own)),false);
 assert.ok(fs.existsSync(path.join(f.releases,'.pruning-custom')));assert.equal(fs.readFileSync(path.join(outside,'keep.txt'),'utf8'),'precious');
});

// ---- removeTree: one operation at a time, no link followed, over when it is told to be ----
const fileCount=root=>{let count=0;const walk=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true}))entry.isDirectory()?walk(path.join(dir,entry.name)):count++;};walk(root);return count;};
const manyFiles=(root,count)=>{for(let d=0,made=0;made<count;d++){const sub=path.join(root,'node_modules',`pkg-${d%40}`,`lib-${d}`);fs.mkdirSync(sub,{recursive:true});for(let i=0;i<250&&made<count;i++,made++)fs.writeFileSync(path.join(sub,`f${i}.js`),'x');}};

test('removeTree empties a tree from the leaves up, one operation at a time, and never follows a link',async t=>{
 const f=fixture(t),root=path.join(f.dir,'tomb'),outside=path.join(f.dir,'outside');
 fs.mkdirSync(path.join(outside,'dir'),{recursive:true});fs.writeFileSync(path.join(outside,'dir/keep.txt'),'precious');fs.writeFileSync(path.join(outside,'file.txt'),'precious');
 for(const dir of ['a/b/c','a/d','e'])fs.mkdirSync(path.join(root,dir),{recursive:true});
 for(const file of ['top.txt','a/one.txt','a/b/two.txt','a/b/c/three.txt','e/four.txt'])fs.writeFileSync(path.join(root,file),'x');
 fs.chmodSync(path.join(root,'a/b/two.txt'),0o444);
 fs.symlinkSync(path.join(outside,'dir'),path.join(root,'a/link-to-dir'),'dir');fs.symlinkSync(path.join(outside,'file.txt'),path.join(root,'e/link-to-file'));fs.symlinkSync(path.join(f.dir,'nowhere'),path.join(root,'dangling'));
 let inFlight=0,most=0;
 const ops=Object.fromEntries(OPS.map(op=>[op,async(...args)=>{most=Math.max(most,++inFlight);try {return await fs.promises[op](...args);} finally {inFlight--;}}]));
 assert.equal(await removeTree(root,{ops}),true);
 assert.equal(fs.existsSync(root),false);assert.equal(most,1,'one operation at a time');
 assert.equal(fs.readFileSync(path.join(outside,'dir/keep.txt'),'utf8'),'precious','a linked directory is unlinked, not entered');assert.equal(fs.readFileSync(path.join(outside,'file.txt'),'utf8'),'precious');
 // The root itself as a link: the link goes and what it points to stays. A root that is not there is done.
 fs.symlinkSync(outside,path.join(f.dir,'root-link'),'dir');
 assert.equal(await removeTree(path.join(f.dir,'root-link')),true);assert.equal(fs.existsSync(path.join(f.dir,'root-link')),false);assert.equal(fs.existsSync(path.join(outside,'dir/keep.txt')),true);
 assert.equal(await removeTree(path.join(f.dir,'no-such-tomb')),true);
});

test('removeTree: an entry someone else already removed is done, any other failure is thrown',async t=>{
 const f=fixture(t),root=path.join(f.dir,'tomb');
 fs.mkdirSync(path.join(root,'sub'),{recursive:true});for(const file of ['one','sub/two'])fs.writeFileSync(path.join(root,file),'x');
 // Every file is removed by someone else just before this one tries; so is the directory.
 const raced=Object.fromEntries(OPS.map(op=>[op,async(target,...rest)=>{if(op==='unlink'||op==='rmdir')fs.rmSync(target,{recursive:true,force:true});return fs.promises[op](target,...rest);}]));
 assert.equal(await removeTree(root,{ops:raced}),true);assert.equal(fs.existsSync(root),false);
 fs.mkdirSync(root);fs.writeFileSync(path.join(root,'one'),'x');
 await assert.rejects(removeTree(root,{ops:{...fs.promises,unlink:async()=>{throw EIO();}}}),{code:'EIO'});
 assert.ok(fs.existsSync(path.join(root,'one')),'what failed stays');
});

test('removeTree stops before its next operation once it is told to, and what it leaves is finished by another call',async t=>{
 const f=fixture(t),root=path.join(f.dir,'tomb');
 for(let d=0;d<5;d++){fs.mkdirSync(path.join(root,'d'+d),{recursive:true});for(let i=0;i<20;i++)fs.writeFileSync(path.join(root,'d'+d,'f'+i),'x');}
 let count=0;
 const ops=Object.fromEntries(OPS.map(op=>[op,async(...args)=>{count++;return fs.promises[op](...args);}]));
 assert.equal(await removeTree(root,{ops,aborted:()=>count>=30}),false);
 assert.equal(count,30,'not one operation after the stop');
 assert.ok(fs.existsSync(root)&&fileCount(root)>0&&fileCount(root)<100,'the directory is still there, partly emptied');
 assert.equal(await removeTree(root),true);assert.equal(fs.existsSync(root),false);
});

test('an aborted removal reports what it finished and nothing else: the tomb it stopped in is neither removed nor failed, and the next run finishes it',async t=>{
 const f=fixture(t);
 for(const revision of [RUNTIME_REVISION,R4,R3A,R2])f.release(revision);
 const plan=prunePlan(f.loc),claim=claimReleases(f.loc,plan.candidates),[first,second]=claim.claimed;
 assert.deepEqual([first.name,second.name],[R3A,R2]);
 let inSecond=0;
 const ops=watched([],async(op,target)=>{if(target.includes(second.tomb))inSecond++;});
 const done=await removeTombs(f.loc,claim.claimed,{ops,aborted:()=>inSecond>=2});
 assert.deepEqual(done,{removed:[R3A],failed:[],aborted:true});
 assert.equal(fs.existsSync(path.join(f.releases,first.tomb)),false);assert.ok(fs.existsSync(path.join(f.releases,second.tomb)),'the tomb it stopped in is still there');
 assert.deepEqual(ownedReleases(f.loc).map(release=>release.name),[RUNTIME_REVISION,R4],'it was a release no longer, and is none now');
 // pruneRuntimeReleases says so too; a later run lists the leftover as a tomb and finishes it.
 const again=await pruneRuntimeReleases(f.loc,{aborted:()=>true});
 assert.equal(again.aborted,true);assert.deepEqual(again.removed,[]);
 const later=await pruneRuntimeReleases(f.loc);
 assert.deepEqual(later.removed,[R2]);assert.equal(later.aborted,undefined);assert.deepEqual(f.names(),[R4,RUNTIME_REVISION].sort());
});

test('removeTree gives the event loop a turn at least every REMOVAL_BATCH operations, even when every operation answers at once',async t=>{
 // A synthetic tree on a file system that answers immediately: no thread pool, so only the pause between batches can yield.
 const entries=(prefix,count)=>Array.from({length:count},(_,i)=>({name:prefix+i,isDirectory:()=>prefix==='d'}));
 let sinceTurn=0,most=0,turns=0,live=true,total=0;
 const turn=()=>{most=Math.max(most,sinceTurn);sinceTurn=0;turns++;if(live)setImmediate(turn);};setImmediate(turn);
 const count=()=>{sinceTurn++;total++;};
 const ops={lstat:async()=>{count();return {isDirectory:()=>true};},readdir:async dir=>{count();return dir==='/virtual/root'?entries('d',10):entries('f',300);},unlink:async()=>{count();},rmdir:async()=>{count();}};
 assert.equal(await removeTree('/virtual/root',{ops}),true);live=false;
 assert.ok(total>3000,'a tree of '+total+' operations');
 assert.ok(most<=REMOVAL_BATCH+1,`${most} operations between two turns of the event loop`);
 assert.ok(turns>=Math.floor(total/(REMOVAL_BATCH+1)),`${turns} turns for ${total} operations`);
});

test('measured: 20 000 files go without stalling the event loop, and a stop ends a deletion within a fraction of a second',{timeout:180000},async t=>{
 const f=fixture(t),whole=path.join(f.dir,'whole'),stopped=path.join(f.dir,'stopped');
 manyFiles(whole,20000);manyFiles(stopped,8000);
 const lag=monitorEventLoopDelay({resolution:5});lag.enable();
 assert.equal(await removeTree(whole),true);
 lag.disable();
 const worstMs=lag.max/1e6; // fs.promises.rm on a tree of this kind stood still for 250 ms and more (measured with 50 000 files)
 assert.equal(fs.existsSync(whole),false);
 assert.ok(worstMs<250,`the event loop stood still for ${Math.round(worstMs)} ms`);
 // A stop 300 ms into a deletion that needs more than a second.
 let stop=false,stopAt=0;setTimeout(()=>{stop=true;stopAt=performance.now();},300);
 const result=await removeTree(stopped,{aborted:()=>stop}),lateMs=performance.now()-stopAt;
 assert.equal(result,false,'the deletion was still running when the stop came');
 assert.ok(lateMs<500,`ended ${Math.round(lateMs)} ms after the stop`);
 assert.ok(fs.existsSync(stopped)&&fileCount(stopped)>0,'what is left stays');
 assert.equal(await removeTree(stopped),true);assert.equal(fs.existsSync(stopped),false);
});
