import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { webTurnChecks, appendVerifiedWebWrite, requireRuntimeIdentity, requireEvidenceIdentity } from './acceptance-evidence.mjs';

const [manifestFile, action, phase] = process.argv.slice(2);
if (!['prepare','verify'].includes(action) || !/^[a-zA-Z0-9_-]{1,30}$/.test(phase || '')) throw new Error('Usage: observe-web-acceptance.mjs MANIFEST prepare|verify PHASE');
const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
const runtimeIdentity = requireRuntimeIdentity(m.runtimeIdentity);
const directory = path.join(m.workspaceRoot, phase);
const report = JSON.parse(fs.readFileSync(path.join(directory, 'provider-acceptance.json'), 'utf8'));
requireEvidenceIdentity(m, report, phase);
const jobsFile = path.join(directory, 'web-jobs.json'), checkpointFile = path.join(directory, 'web-checkpoint.private.json');
const verificationFile = path.join(directory, 'web-verification.json');
let checkpoint, attempts = [];
if (action === 'verify') {
  checkpoint = JSON.parse(fs.readFileSync(checkpointFile, 'utf8'));
  const jobs = JSON.parse(fs.readFileSync(jobsFile, 'utf8'));
  requireEvidenceIdentity(m, checkpoint, phase);
  requireEvidenceIdentity(m, jobs, phase);
  if (checkpoint.jobsSha256 !== crypto.createHash('sha256').update(fs.readFileSync(jobsFile)).digest('hex')) throw new Error('Browser job file changed after preparation');
  if (checkpoint.workspaceId !== report.workspaceId || jobs.workspaceId !== report.workspaceId) throw new Error('Web checkpoint ownership mismatch');
  if (fs.existsSync(verificationFile)) {
    const previous = JSON.parse(fs.readFileSync(verificationFile, 'utf8'));
    requireEvidenceIdentity(m, previous, phase);
    attempts = previous.attempts || [];
    for (const attempt of attempts) requireEvidenceIdentity(m, attempt, phase);
  }
}
const write = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
const pluginRoot = process.env.PI_PASEO_PLUGIN_ROOT || '/opt/woow/pi-paseo-plugin';
const state = await import(pathToFileURL(path.join(pluginRoot, 'src/state.mjs')));
const layout = await import(pathToFileURL(path.join(pluginRoot, 'src/runtime-layout.mjs')));
const loc = state.locations(), runtime = layout.runtimeDirectory(loc);
const cliRoot = m.cliRoot || path.join(runtime, 'node_modules/@getpaseo/cli');
const { connectToDaemon } = await import(pathToFileURL(path.join(cliRoot, 'dist/utils/client.js')));
const { fetchAgentTimelineItems } = await import(pathToFileURL(path.join(cliRoot, 'dist/commands/agent/logs.js')));
const client = await connectToDaemon({ target: { kind: 'instance', home: m.daemonHome || loc.paseoHome }, timeout: 10000 });
try {
  if (action === 'prepare') {
    if (fs.existsSync(checkpointFile)) throw new Error('Web checkpoint exists; preserve its baseline and verify this run');
    if (report.passed !== true || report.providers.length !== 3 || !report.workspaceId) throw new Error('Three passing owned provider agents are required before Web acceptance');
    const jobs = { runId: m.runId, hostLabel: m.hostLabel, runtimeIdentity, phase, workspaceId: report.workspaceId, jobs: [] };
    const checkpoint = { runId: m.runId, hostLabel: m.hostLabel, runtimeIdentity, phase, workspaceId: report.workspaceId, preparedAt: new Date().toISOString(), jobs: [] };
    for (const row of report.providers) {
      const selection = m.providers.find(p => p.id === row.provider);
      const written = m.writes?.find(w => w.agentId === row.agentId && w.key === row.write.key && w.phase === phase);
      if (!selection || !written || !report.agents.includes(row.agentId)) throw new Error('Agent or written memory is not owned by this run');
      const agent = (await client.fetchAgent({ agentId: row.agentId }))?.agent;
      if (!agent || agent.status !== 'idle' || agent.provider !== row.provider) throw new Error('Web preparation requires an idle owned provider');
      const items = await fetchAgentTimelineItems(client, row.agentId, { timeoutMs: 15000 });
      const replyMarker = 'WEB_UI_OK_' + crypto.randomUUID();
      const writeKey = 'acceptance-web-' + m.hostLabel + '-' + crypto.randomUUID();
      const expectedWrite = 'WEB_WRITE_' + crypto.randomUUID();
      m.attemptedWrites ||= []; m.attemptedWrites.push({ key: writeKey, marker: expectedWrite });
      const skillDiscovery = row.provider === 'claude' ? ' For Claude Code, first use ToolSearch to discover select:mcp__pi_shared_runtime__Skill, then invoke that registered Skill tool once for each exact skill name. Do not guess workspace skill paths.' : '';
      const job = { provider: row.provider, agentId: row.agentId, model: selection.model, alternateModel: selection.alternateModel, targetModel: selection.model, memoryKey: written.key,
        prompt: `Read the actual shared-host-memory skill instructions and the ${m.skillName} skill instructions again, even if previously loaded.${skillDiscovery} If any required skill or MCP tool is unavailable, stop immediately and report REQUIRED_RESOURCE_UNAVAILABLE with its name; do not skip it or attempt repairs. Call the configured global MCP server ${m.fixtureMcpName} read_marker tool. Use pi_shared_memory MCP read to retrieve the exact key ${written.key}. Also use memory MCP read for the new owned key ${writeKey}; if absent, create it with content ${expectedWrite} using expectedRevision:null. If it already exists, do not overwrite it and report the conflict. Reply with the exact values obtained from the skill, MCP and memory read, and ${replyMarker}. Perform fresh actual tool calls for every step. Work only with these named fixture resources. Do not read manifests, harness/report files, provider internals, other memories, credentials or other files; do not change settings, invoke direct SDK/HTTP substitutes, install tools or send messages to other agents.` };
      jobs.jobs.push(job);
      checkpoint.jobs.push({ ...job, expectedMemory: written.marker, skillName: m.skillName, expectedSkill: m.expectedSkill, sharedMemorySkillName: 'shared-host-memory', expectedSharedMemorySkill: 'Memory belongs to this host.', fixtureMcpName: m.fixtureMcpName, expectedMcp: m.expectedMcp, writeKey, expectedWrite, replyMarker, beforeModel: { configured: agent.model, runtime: agent.runtimeInfo?.model }, beforeToolIds: items.filter(x => x.type === 'tool_call').map(x => x.callId) });
    }
    // Existing read, skill and MCP nonces stay private. Only the new write nonce
    // is necessarily included in its browser instruction. Register cleanup first.
    write(manifestFile, m);
    write(jobsFile, jobs);
    checkpoint.jobsSha256 = crypto.createHash('sha256').update(fs.readFileSync(jobsFile)).digest('hex');
    write(checkpointFile, checkpoint);
    console.log(JSON.stringify({ hostLabel: m.hostLabel, phase, jobsFile, jobs: jobs.jobs.length }));
  } else {
    const result = { checkedAt: new Date().toISOString(), attempt: attempts.length + 1, runId: m.runId, hostLabel: m.hostLabel, runtimeIdentity, phase, providers: [] };
    const { memoryRead } = await import(pathToFileURL(path.join(m.root, 'src/memory.mjs')));
    const { locations } = await import(pathToFileURL(path.join(m.root, 'src/common.mjs')));
    const memoryLocations = locations();
    for (const job of checkpoint.jobs) {
      if (!report.agents.includes(job.agentId)) throw new Error('Web verification agent is not owned');
      const agent = (await client.fetchAgent({ agentId: job.agentId }))?.agent;
      const items = await fetchAgentTimelineItems(client, job.agentId, { timeoutMs: 15000 });
      const before = new Set(job.beforeToolIds), fresh = items.filter(x => x.type === 'tool_call' && !before.has(x.callId));
      const evidenceFile = path.join(directory, `${job.provider}-web-attempt-${result.attempt}-timeline.json`);
      write(evidenceFile, items);
      const storedMemory = memoryRead(memoryLocations, job.writeKey);
      const checks = webTurnChecks(agent, job, items, storedMemory);
      if (Object.values(checks).every(Boolean)) {
        const record = { key: job.writeKey, marker: job.expectedWrite, phase, provider: job.provider, agentId: job.agentId, source: 'public-web', revision: storedMemory.revision, writtenAt: new Date().toISOString() };
        if (appendVerifiedWebWrite(m, record)) write(manifestFile, m);
      }
      result.providers.push({ provider: job.provider, agentId: job.agentId, targetModel: job.targetModel, actualModel: agent?.runtimeInfo?.model, snapshotModel: agent?.model, beforeModel: job.beforeModel, memoryKey: job.memoryKey, writeKey: job.writeKey, checks, passed: Object.values(checks).every(Boolean), evidenceFile, freshToolIds: fresh.map(x => x.callId) });
    }
    result.passed = result.providers.length === 3 && result.providers.every(x => x.passed);
    attempts.push(result); write(verificationFile, { ...result, attempts });
    console.log(JSON.stringify({ hostLabel: m.hostLabel, phase, verificationFile, passed: result.passed, providers: result.providers.map(x => ({ provider: x.provider, passed: x.passed, checks: x.checks, actualModel: x.actualModel })) }));
    if (!result.passed) process.exitCode = 1;
  }
} finally { await client.close().catch(() => {}); }
