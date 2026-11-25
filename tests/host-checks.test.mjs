import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {checkProcessTable,PS_TABLE_ARGS,psInspectArgs,PS_UNAVAILABLE,PS_INCOMPATIBLE} from '../src/host-checks.mjs';
import {diagnose,status} from '../src/runtime.mjs';
import {locations,readState} from '../src/state.mjs';

// Paseo 0.17.4 lists processes with these arguments (dist/server/terminal/terminal-worker-processes.js,
// dist/server/server/managed-processes/managed-processes.js). A shim `ps` only answers exactly them.
const TABLE='-A -ww -o pid= -o ppid= -o sid= -o lstart=';
const linux={skip:process.platform!=='linux'&&'the host check runs on Linux only'};
// Only the tests that name this host's own ps need one that serves upstream's two commands; every other test answers
// with a shim, so none depends on what the machine has installed.
const hostPs=process.platform==='linux'?await checkProcessTable({timeoutMs:15000}):{ok:false};
const needsProcps={skip:process.platform!=='linux'?'the host check runs on Linux only':!hostPs.ok&&'this host has no procps-compatible ps'};
function shim(t,script){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pi-paseo-ps-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 if(script!==null)fs.writeFileSync(path.join(dir,'ps'),'#!/bin/sh\n'+script,{mode:0o755});
 return dir;
}
// Answers like procps for one process and its parent (4242 and 4141 unless told); LC_ALL must be C.
const goodPs=(pid=4242,ppid=4141)=>`test "$LC_ALL" = C || { echo "LC_ALL=$LC_ALL" >&2; exit 65; }
case "$*" in
 "${TABLE}") printf '    1     0     1 Mon Nov 24 07:33:00 2026\\n ${pid}  ${ppid}  ${ppid} Wed Nov  5 19:52:11 2026\\n';;
 "-ww -p ${pid} -o lstart= -o command=") printf 'Wed Nov  5 19:52:11 2026 node smoke.mjs\\n';;
 *) echo "unexpected arguments: $*" >&2; exit 64;;
esac
`;
const GOOD=()=>goodPs();
const self={pid:4242,ppid:4141};
const check=(dir,options={})=>checkProcessTable({platform:'linux',env:{PATH:dir},...self,timeoutMs:5000,...options});

test('the check calls ps with the exact arguments and locale upstream uses',()=>{
 assert.deepEqual([...PS_TABLE_ARGS],TABLE.split(' '));assert.deepEqual(psInspectArgs(4242),'-ww -p 4242 -o lstart= -o command='.split(' '));
});
test('a ps that serves both of upstream\'s commands passes',linux,async t=>{
 assert.deepEqual(await check(shim(t,GOOD())),{checked:true,ok:true});
});
test('the real ps of this host passes',needsProcps,async()=>{
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

// diagnose() on the real module with a PATH of shims: provider commands that answer, and a ps that works or does not.
function diagnoseEnvironment(t) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pi-paseo-ps-diagnose-'));
 const saved=Object.fromEntries(['HOME','PI_CODING_AGENT_DIR','PI_PASEO_STATE_DIR','PI_PASEO_RUNTIME_DIR','PI_PASEO_PORT','PATH'].map(key=>[key,process.env[key]]));
 t.after(()=>{for(const[key,value]of Object.entries(saved))value===undefined?delete process.env[key]:process.env[key]=value;fs.rmSync(dir,{recursive:true,force:true});});
 Object.assign(process.env,{HOME:path.join(dir,'home'),PI_CODING_AGENT_DIR:path.join(dir,'agent'),PI_PASEO_STATE_DIR:path.join(dir,'state'),PI_PASEO_RUNTIME_DIR:path.join(dir,'runtime')});delete process.env.PI_PASEO_PORT;
 const providers=path.join(dir,'providers');fs.mkdirSync(providers);
 for(const name of ['claude','codex','pi'])fs.writeFileSync(path.join(providers,name),'#!/bin/sh\nprintf "1.0.0\\n"\n',{mode:0o700});
 const withPs=(name,script)=>{const bin=path.join(dir,name);fs.mkdirSync(bin);fs.writeFileSync(path.join(bin,'ps'),'#!/bin/sh\n'+script,{mode:0o755});return bin;};
 // The shims come first; the rest of the host's PATH stays behind them (flock, sh and node are needed to take locks).
 const host=(saved.PATH||'').split(path.delimiter);
 return {dir,providers,host,withPs,path:(...bins)=>{process.env.PATH=[...bins,...host].join(path.delimiter);}};
}
test('diagnose records the host check: a warning while ps is unusable, shown by status without running ps again',linux,async t=>{
 const env=diagnoseEnvironment(t);
 env.path(env.providers,env.withPs('broken-ps','exit 1\n'));
 const bad=await diagnose();
 assert.deepEqual(bad.warnings.map(row=>row.code),[PS_INCOMPATIBLE]);assert.equal(readState().processTable.ok,false);assert.equal(bad.diagnosticCode,null);
 assert.deepEqual((await status()).warnings.map(row=>row.code),[PS_INCOMPATIBLE],'status shows the recorded check without running ps');
 assert.equal(locations().stateDir,path.join(env.dir,'state'));
});
test('diagnose clears the warning once a ps that works is back (a shim answering for this very process)',linux,async t=>{
 const env=diagnoseEnvironment(t);
 env.path(env.providers,env.withPs('broken-ps','exit 1\n'));
 assert.deepEqual((await diagnose()).warnings.map(row=>row.code),[PS_INCOMPATIBLE]);
 env.path(env.providers,env.withPs('good-ps',goodPs(process.pid,process.ppid)));
 assert.deepEqual((await diagnose()).warnings,[]);assert.equal(readState().processTable.ok,true);
});
test('diagnose with this host\'s own ps records a pass',needsProcps,async t=>{
 const env=diagnoseEnvironment(t);
 env.path(env.providers);
 assert.deepEqual((await diagnose()).warnings,[]);assert.equal(readState().processTable.ok,true);
});
