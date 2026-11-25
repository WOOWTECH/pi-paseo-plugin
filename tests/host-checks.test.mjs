import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {checkProcessTable,PS_TABLE_ARGS,psInspectArgs,PS_UNAVAILABLE,PS_INCOMPATIBLE} from '../src/host-checks.mjs';
import {diagnose,status} from '../src/runtime.mjs';
import {locations,readState} from '../src/state.mjs';

// Paseo 0.17.4 lists processes with these arguments (dist/server/terminal/terminal-worker-processes.js,
// dist/server/server/managed-processes/managed-processes.js). A shim `ps` only answers exactly them.
const TABLE='-A -ww -o pid= -o ppid= -o sid= -o lstart=';
const linux={skip:process.platform!=='linux'&&'the host check runs on Linux only'};
function shim(t,script){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pi-paseo-ps-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 if(script!==null)fs.writeFileSync(path.join(dir,'ps'),'#!/bin/sh\n'+script,{mode:0o755});
 return dir;
}
// Answers like procps for the pid 4242 whose parent is 4141; LC_ALL must be C.
const GOOD=(extra='')=>`test "$LC_ALL" = C || { echo "LC_ALL=$LC_ALL" >&2; exit 65; }
case "$*" in
 "${TABLE}") printf '    1     0     1 Mon Nov 24 07:33:00 2026\\n 4242  4141  4141 Wed Nov  5 19:52:11 2026\\n';;
 "-ww -p 4242 -o lstart= -o command=") printf 'Wed Nov  5 19:52:11 2026 node smoke.mjs\\n';;
 *) echo "unexpected arguments: $*" >&2; exit 64;;
esac
${extra}`;
const self={pid:4242,ppid:4141};
const check=(dir,options={})=>checkProcessTable({platform:'linux',env:{PATH:dir},...self,timeoutMs:5000,...options});

test('the check calls ps with the exact arguments and locale upstream uses',()=>{
 assert.deepEqual([...PS_TABLE_ARGS],TABLE.split(' '));assert.deepEqual(psInspectArgs(4242),'-ww -p 4242 -o lstart= -o command='.split(' '));
});
test('a ps that serves both of upstream\'s commands passes',linux,async t=>{
 assert.deepEqual(await check(shim(t,GOOD())),{checked:true,ok:true});
});
test('the real ps of this host passes',linux,async t=>{
 if(spawnSync('ps',['-A','-o','pid='],{encoding:'utf8'}).status!==0)return t.skip('this host has no usable ps');
 assert.deepEqual(await checkProcessTable({timeoutMs:15000}),{checked:true,ok:true});
});
test('no ps on the PATH is PS_UNAVAILABLE',linux,async t=>{
 assert.deepEqual(await check(shim(t,null)),{checked:true,ok:false,code:PS_UNAVAILABLE});
});
test('a ps that refuses the flags is PS_INCOMPATIBLE',linux,async t=>{
 assert.deepEqual(await check(shim(t,'echo "ps: unrecognized option: A" >&2\nexit 1\n')),{checked:true,ok:false,code:PS_INCOMPATIBLE});
});
test('a ps that lists processes but refuses -p (busybox-like) is PS_INCOMPATIBLE',linux,async t=>{
 const script=GOOD().replace('"-ww -p 4242 -o lstart= -o command=") printf \'Wed Nov  5 19:52:11 2026 node smoke.mjs\\n\';;','"-ww -p 4242 -o lstart= -o command=") echo "ps: invalid option -- p" >&2; exit 1;;');
 assert.notEqual(script,GOOD());
 assert.deepEqual(await check(shim(t,script)),{checked:true,ok:false,code:PS_INCOMPATIBLE});
});
test('output that is not a process table is PS_INCOMPATIBLE, and so is a table without this process',linux,async t=>{
 assert.equal((await check(shim(t,'echo hello\n'))).code,PS_INCOMPATIBLE);
 assert.equal((await check(shim(t,GOOD()),{pid:4243})).code,PS_INCOMPATIBLE);
 assert.equal((await check(shim(t,GOOD()),{ppid:1})).code,PS_INCOMPATIBLE);
 assert.equal((await check(shim(t,''))).code,PS_INCOMPATIBLE);
});
test('two forms that print one birth time differently are PS_INCOMPATIBLE: no terminal program would match its record',linux,async t=>{
 const script=GOOD().replace("printf 'Wed Nov  5 19:52:11 2026 node smoke.mjs\\n'","printf 'Wed Nov 05 19:52:11 2026 node smoke.mjs\\n'");
 assert.notEqual(script,GOOD());
 assert.equal((await check(shim(t,script))).code,PS_INCOMPATIBLE);
 // A table row whose birth time is not in the LC_ALL=C layout.
 const odd=GOOD().replace('4141 Wed Nov  5 19:52:11 2026','4141 2026-11-05 19:52:11');
 assert.notEqual(odd,GOOD());
 assert.equal((await check(shim(t,odd))).code,PS_INCOMPATIBLE);
});
test('a ps that hangs is PS_UNAVAILABLE at the bound',linux,async t=>{
 const started=Date.now();
 assert.deepEqual(await check(shim(t,'read line\n'),{timeoutMs:300}),{checked:true,ok:false,code:PS_UNAVAILABLE});
 assert.ok(Date.now()-started<5000);
});
test('the check never throws and is not made off Linux',async()=>{
 assert.deepEqual(await checkProcessTable({platform:'darwin',run:()=>assert.fail('no ps call off Linux')}),{checked:false});
 assert.deepEqual(await checkProcessTable({platform:'win32',run:()=>assert.fail('no ps call off Linux')}),{checked:false});
 assert.deepEqual(await checkProcessTable({platform:'linux',run:async()=>{throw undefined;}}),{checked:true,ok:false,code:PS_UNAVAILABLE});
 assert.deepEqual(await checkProcessTable({platform:'linux',run:async()=>{throw Object.assign(new Error('x'),{code:2});}}),{checked:true,ok:false,code:PS_INCOMPATIBLE});
});

test('diagnose records the host check: a warning while ps is unusable, gone once it works',linux,async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pi-paseo-ps-diagnose-'));
 const saved=Object.fromEntries(['HOME','PI_CODING_AGENT_DIR','PI_PASEO_STATE_DIR','PI_PASEO_RUNTIME_DIR','PI_PASEO_PORT','PATH'].map(key=>[key,process.env[key]]));
 t.after(()=>{for(const[key,value]of Object.entries(saved))value===undefined?delete process.env[key]:process.env[key]=value;fs.rmSync(dir,{recursive:true,force:true});});
 Object.assign(process.env,{HOME:path.join(dir,'home'),PI_CODING_AGENT_DIR:path.join(dir,'agent'),PI_PASEO_STATE_DIR:path.join(dir,'state'),PI_PASEO_RUNTIME_DIR:path.join(dir,'runtime')});delete process.env.PI_PASEO_PORT;
 const provider=path.join(dir,'providers');fs.mkdirSync(provider);
 for(const name of ['claude','codex','pi'])fs.writeFileSync(path.join(provider,name),'#!/bin/sh\nprintf "1.0.0\\n"\n',{mode:0o700});
 const broken=path.join(dir,'broken-ps');fs.mkdirSync(broken);fs.writeFileSync(path.join(broken,'ps'),'#!/bin/sh\nexit 1\n',{mode:0o755});
 const good=process.env.PATH;
 process.env.PATH=[provider,broken,good].join(path.delimiter);
 const bad=await diagnose();
 assert.deepEqual(bad.warnings.map(row=>row.code),[PS_INCOMPATIBLE]);assert.equal(readState().processTable.ok,false);assert.equal(bad.diagnosticCode,null);
 assert.deepEqual((await status()).warnings.map(row=>row.code),[PS_INCOMPATIBLE],'status shows the recorded check without running ps');
 process.env.PATH=[provider,good].join(path.delimiter);
 if(spawnSync('ps',['-A','-o','pid='],{encoding:'utf8'}).status!==0)return t.skip('this host has no usable ps');
 assert.deepEqual((await diagnose()).warnings,[]);assert.equal(readState().processTable.ok,true);
 assert.equal(locations().stateDir,path.join(dir,'state'));
});
