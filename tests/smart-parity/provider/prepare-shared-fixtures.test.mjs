import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

for (const recover of [true, false]) test(`fixture preparation ${recover ? 'records and recovers transient discovery' : 'fails after bounded discovery attempts'}`, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prepare-fixtures-'));
  const write = (name, source) => { const p = path.join(root, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, source); };
  try {
    const home = path.join(root, 'home'), data = path.join(root, 'data'); fs.mkdirSync(home); fs.mkdirSync(data);
    write('src/common.mjs', `import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';export const locations=()=>(${JSON.stringify({ home, data })});export const digest=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');export const readJSON=f=>fs.existsSync(f)?JSON.parse(fs.readFileSync(f)):{};export const saveJSON=(f,v)=>{fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,JSON.stringify(v));};`);
    write('src/memory.mjs', 'export const memoryWrite=async()=>({revision:"fixture-revision"});');
    write('src/sync.mjs', `let calls=0;export const synchronize=async()=>({skills:[{name:'acceptance-run'},...(${recover}&&++calls>1?[{name:'shared-host-memory'}]:[])],conflicts:[]});`);
    const runtimeIdentity = 'package-set:sha256:' + 'a'.repeat(64);
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./prepare-shared-fixtures.mjs', import.meta.url)), 'run', 'hosta', 'hostb', '--execute'], { env: { ...process.env, PI_SHARED_PACKAGE_ROOT: root, PASEO_ACCEPTANCE_RUNTIME_IDENTITY: runtimeIdentity }, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, recover ? 0 : 1);
    const manifest = JSON.parse(fs.readFileSync(path.join(home, 'work/agent-connect-acceptance-run/acceptance-manifest.json')));
    assert.equal(manifest.runtimeIdentity, runtimeIdentity);
    assert.equal(manifest.discoveryAttempts.length, recover ? 2 : 4);
    assert.equal(manifest.discoveryAttempts[0].sharedMemorySkillDiscovered, false);
    assert.equal(manifest.sharedMemorySkillDiscovered, recover);
    assert.equal(typeof manifest.mcpEntryHash, 'string');
    assert.equal(typeof manifest.expectedMemory, 'string');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
