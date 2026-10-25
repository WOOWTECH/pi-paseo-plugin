import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../bin/cli.mjs',import.meta.url),'utf8').replace(/^#!.*\n/,'').replace(/^import .*;\r?\n/gm,'');
async function run(action,runtime){
 let stdout='',stderr='';const process={argv:['node','cli.mjs',action],env:{},stdout:{write:x=>stdout+=x},stderr:{write:x=>stderr+=x}};
 await vm.runInNewContext(`(async()=>{${source}\n})()`,{process,runtime,host:runtime});
 return {exitCode:process.exitCode||0,stdout,stderr};
}
test('acceptance returns nonzero when any provider conversation failed',async()=>{
 const r=await run('acceptance',{acceptance:async()=>({passed:false,results:[{provider:'claude',passed:false}]})});
 assert.equal(r.exitCode,1);assert.equal(JSON.parse(r.stdout).passed,false);
});
test('acceptance returns zero only for explicitly passing results',async()=>{
 for(const passed of [undefined,null,false])assert.equal((await run('acceptance',{acceptance:async()=>({passed})})).exitCode,1);
 assert.equal((await run('acceptance',{acceptance:async()=>({passed:true})})).exitCode,0);
});
test('CLI exposes actionable safe resource code and stage without command output',async()=>{
 const r=await run('status',{status:async()=>{throw Object.assign(Error('PRIVATE_SECRET_URL'),{name:'UiInstallError',code:'INSTALL_DISK_FULL',stage:'dependencies'});}});
 assert.equal(r.exitCode,1);assert.equal(JSON.parse(r.stderr).code,'INSTALL_DISK_FULL');assert.equal(JSON.parse(r.stderr).stage,'dependencies');assert.doesNotMatch(r.stderr,/PRIVATE_SECRET/);
});
test('CLI rejects arbitrary error names codes and stage strings',async()=>{
 const r=await run('status',{status:async()=>{throw {name:'PRIVATE_SECRET_NAME',code:'PRIVATE_SECRET_CODE',stage:'PRIVATE_SECRET_STAGE'};}});
 assert.doesNotMatch(r.stderr,/PRIVATE_SECRET/);assert.equal(JSON.parse(r.stderr).code,'OPERATION_FAILED');
});
