import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {PASEO_VERSION} from '../src/runtime-layout.mjs';
import {applySmartTasksPatch,smartTasksPatchReady,SMART_TASKS_REGISTRY_PATH,SMART_TASKS_DIRECTORY} from '../src/smart-tasks-patch.mjs';
const source=fileURLToPath(new URL('./fixtures/paseo-'+PASEO_VERSION+'/builtin-index.js',import.meta.url));
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-paseo-tasks-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const registry=path.join(root,SMART_TASKS_REGISTRY_PATH);
 fs.mkdirSync(path.dirname(registry),{recursive:true});fs.copyFileSync(source,registry);
 return {root,registry,plugin:path.join(root,SMART_TASKS_DIRECTORY)};
}
test('Tasks install is idempotent and only adds the pinned builtin to the official registry',t=>{
 const f=fixture(t),before=fs.readFileSync(f.registry,'utf8');
 assert.equal(smartTasksPatchReady(f.root),false);applySmartTasksPatch(f.root);
 assert.equal(smartTasksPatchReady(f.root),true);applySmartTasksPatch(f.root);
 assert.equal(fs.readFileSync(f.registry,'utf8').replace('    "better-paseo",\n',''),before);
 assert.equal(smartTasksPatchReady(f.root),true);
});
for(const name of ['index.client.ts','server/builtin.js','LICENSE','provenance.json']){
 test(`Tasks readiness refuses a missing or changed ${name}`,t=>{
  const f=fixture(t);applySmartTasksPatch(f.root);const p=path.join(f.plugin,name);
  fs.appendFileSync(p,'tampered');assert.equal(smartTasksPatchReady(f.root),false);
  fs.unlinkSync(p);assert.equal(smartTasksPatchReady(f.root),false);
 });
}
test('an unknown daemon registry is refused before copying the plugin',t=>{
 const f=fixture(t);fs.appendFileSync(f.registry,'changed');
 assert.throws(()=>applySmartTasksPatch(f.root),e=>e.code==='SMART_TASKS_REGISTRY_MISMATCH');
 assert.equal(fs.existsSync(f.plugin),false);
});
test('redirected plugin destinations are refused before modifying the daemon registry',t=>{
 const f=fixture(t),before=fs.readFileSync(f.registry);
 const external=path.join(f.root,'external');fs.mkdirSync(external);
 fs.mkdirSync(path.dirname(f.plugin),{recursive:true});fs.symlinkSync(external,f.plugin,'dir');
 assert.throws(()=>applySmartTasksPatch(f.root),e=>e.code==='UNSAFE_SYMLINK');
 assert.deepEqual(fs.readFileSync(f.registry),before);assert.deepEqual(fs.readdirSync(external),[]);
});
