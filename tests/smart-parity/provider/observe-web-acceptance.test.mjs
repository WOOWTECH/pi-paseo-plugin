import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('actual Web observer keeps read nonces private, verifies fresh resources and records writes idempotently', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'web-observer-'));
  const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
  const read = file => JSON.parse(fs.readFileSync(file));
  const plugin = path.join(temporary, 'plugin'), cli = path.join(temporary, 'cli'), shared = path.join(temporary, 'shared'), workspace = path.join(temporary, 'workspace');
  const agentsFile = path.join(temporary, 'agents.json'), timelinesFile = path.join(temporary, 'timelines.json'), memoriesFile = path.join(temporary, 'memories.json');
  const phase = 'woowtech', manifestFile = path.join(workspace, 'acceptance-manifest.json');
  const ids = ['claude','codex','pi'];
  const runtimeIdentity = 'image:sha256:' + '1'.repeat(64);
  const manifest = { runId: 'test-run', runtimeIdentity, hostLabel: 'hosta', root: shared, cliRoot: cli, workspaceRoot: workspace, skillName: 'acceptance-test', expectedSkill: 'PRIVATE_SKILL', fixtureMcpName: 'acceptance_test', expectedMcp: 'PRIVATE_MCP', providers: ids.map(id => ({ id, model: 'initial', alternateModel: 'alternate' })), writes: ids.map(id => ({ key: 'read-' + id, marker: 'PRIVATE_MEMORY_' + id, agentId: id, phase, provider: id })) };
  const report = { runId: manifest.runId, hostLabel: manifest.hostLabel, phase, runtimeIdentity, passed: true, agents: ids, workspaceId: 'owned-workspace', providers: ids.map(provider => ({ provider, agentId: provider, write: { key: 'read-' + provider } })) };
  try {
    write(path.join(plugin, 'src/state.mjs'), 'export const locations=()=>({paseoHome:"fixture"});');
    write(path.join(plugin, 'src/runtime-layout.mjs'), 'export const runtimeDirectory=()=>"fixture";');
    write(path.join(cli, 'package.json'), { type: 'module' });
    write(path.join(cli, 'dist/utils/client.js'), `import fs from 'node:fs'; export const connectToDaemon=async()=>({fetchAgent:async({agentId})=>({agent:JSON.parse(fs.readFileSync(${JSON.stringify(agentsFile)}))[agentId]}),close:async()=>{}});`);
    write(path.join(cli, 'dist/commands/agent/logs.js'), `import fs from 'node:fs'; export const fetchAgentTimelineItems=async(_client,id)=>JSON.parse(fs.readFileSync(${JSON.stringify(timelinesFile)}))[id];`);
    write(path.join(shared, 'src/common.mjs'), 'export const locations=()=>({});');
    write(path.join(shared, 'src/memory.mjs'), `import fs from 'node:fs'; export const memoryRead=(_loc,key)=>JSON.parse(fs.readFileSync(${JSON.stringify(memoriesFile)}))[key]??null;`);
    write(manifestFile, manifest); write(path.join(workspace, phase, 'provider-acceptance.json'), report);
    write(agentsFile, Object.fromEntries(ids.map(provider => [provider, { provider, status: 'idle', model: 'alternate', runtimeInfo: { model: 'alternate' } }])));
    write(timelinesFile, Object.fromEntries(ids.map(id => [id, [{ type: 'tool_call', callId: 'old-' + id }]])));
    const invoke = action => execFileSync(process.execPath, [fileURLToPath(new URL('./observe-web-acceptance.mjs', import.meta.url)), manifestFile, action, phase], { env: { ...process.env, PI_PASEO_PLUGIN_ROOT: plugin }, timeout: 20000, stdio: 'pipe' });
    invoke('prepare');
    const publicJobs = fs.readFileSync(path.join(workspace, phase, 'web-jobs.json'), 'utf8');
    for (const hidden of ['PRIVATE_SKILL', 'PRIVATE_MCP', ...manifest.writes.map(x => x.marker)]) assert.equal(publicJobs.includes(hidden), false);
    const checkpoint = read(path.join(workspace, phase, 'web-checkpoint.private.json'));
    assert.equal(checkpoint.runtimeIdentity, runtimeIdentity);
    assert.equal(JSON.parse(publicJobs).runtimeIdentity, runtimeIdentity);
    assert.equal(checkpoint.jobs.length, 3); assert.equal(read(manifestFile).attemptedWrites.length, 3);
    const memories = {}, timelines = {};
    const call = (id, name, input, output) => ({ type: 'tool_call', callId: id, status: 'completed', name, detail: { input, output } });
    for (const job of checkpoint.jobs) {
      const memory = { key: job.writeKey, content: job.expectedWrite, revision: 'revision-' + job.provider }; memories[job.writeKey] = memory;
      timelines[job.provider] = [
        call('skill', 'read', { path: '/skills/' + job.skillName + '/SKILL.md' }, job.expectedSkill),
        call('common', 'read', { path: '/skills/shared-host-memory/SKILL.md' }, job.expectedSharedMemorySkill),
        call('mcp', 'mcp__acceptance_test__read_marker', {}, job.expectedMcp),
        call('read', 'mcp__pi_shared_memory__read', { key: job.memoryKey }, { memory: { key: job.memoryKey, content: job.expectedMemory } }),
        call('absent', 'mcp__pi_shared_memory__read', { key: job.writeKey }, { memory: null }),
        call('write', 'mcp__pi_shared_memory__write', { key: job.writeKey, content: job.expectedWrite, expectedRevision: null }, { memory }),
        { type: 'assistant_message', text: job.replyMarker },
      ];
    }
    write(agentsFile, Object.fromEntries(ids.map(provider => [provider, { provider, status: 'idle', model: 'initial', runtimeInfo: { model: 'initial' } }])));
    write(timelinesFile, timelines); write(memoriesFile, memories);
    const memoryBytes = fs.readFileSync(memoriesFile);
    invoke('verify'); invoke('verify');
    assert.deepEqual(fs.readFileSync(memoriesFile), memoryBytes, 'verifier never writes memory');
    const verified = read(path.join(workspace, phase, 'web-verification.json'));
    assert.equal(verified.passed, true); assert.equal(verified.attempts.length, 2);
    assert.equal(verified.runtimeIdentity, runtimeIdentity);
    const writes = read(manifestFile).writes; assert.equal(writes.length, 6); assert.equal(writes.filter(x => x.source === 'public-web').length, 3);
    const verificationBytes = fs.readFileSync(path.join(workspace, phase, 'web-verification.json'));
    // All of these otherwise-valid files refer to the same host and run. A new
    // image must not reuse their prior tool/model evidence or mutate a receipt.
    for (const name of ['provider-acceptance.json','web-jobs.json','web-checkpoint.private.json','web-verification.json']) {
      const file = path.join(workspace, phase, name), original = fs.readFileSync(file), stale = JSON.parse(original);
      stale.runtimeIdentity = 'image:sha256:' + '2'.repeat(64); write(file, stale);
      assert.throws(() => invoke('verify'), /runtime identity mismatch/);
      fs.writeFileSync(file, original);
    }
    const current = read(manifestFile); write(manifestFile, { ...current, runtimeIdentity: 'image:sha256:' + '2'.repeat(64) });
    assert.throws(() => invoke('prepare'), /runtime identity mismatch/);
    assert.throws(() => invoke('verify'), /runtime identity mismatch/);
    assert.deepEqual(fs.readFileSync(path.join(workspace, phase, 'web-verification.json')), verificationBytes);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
