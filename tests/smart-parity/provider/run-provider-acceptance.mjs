import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { memoryResult, memoryWrite as memoryWriteEvidence, fixtureMcpResult, skillRead, sendAgentPrompt, assistantReplied, workspaceRows, agentRows, runPassed, requireRuntimeIdentity, requireEvidenceIdentity } from './acceptance-evidence.mjs';
const exec = promisify(execFile);
const [manifestPath, action = 'discover', phase = 'baseline'] = process.argv.slice(2);
if (!/^[a-zA-Z0-9_-]{1,30}$/.test(phase)) throw new Error('Invalid acceptance phase');
if (!['discover', 'run', 'cleanup', 'isolation'].includes(action)) throw new Error('Expected discover, run, isolation or cleanup');
const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const runtimeIdentity = requireRuntimeIdentity(m.runtimeIdentity);
const evidenceRoot = path.join(m.workspaceRoot, phase);
const reportFile = path.join(evidenceRoot, 'provider-acceptance.json');
const existingReport = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile)) : null;
if (existingReport) requireEvidenceIdentity(m, existingReport, phase);
if (['run','discover'].includes(action) && (existingReport?.agents?.length || existingReport?.createAttempts?.length)) throw new Error('Phase already owns agents; preserve evidence and clean up before selecting a new phase');
const root = m.root || '/opt/woow/pi-agent-shared-runtime';
const sdk = path.join(root, 'node_modules/@modelcontextprotocol/sdk/dist/esm');
const { Client } = await import(pathToFileURL(path.join(sdk, 'client/index.js')));
const { StreamableHTTPClientTransport } = await import(pathToFileURL(path.join(sdk, 'client/streamableHttp.js')));
let managedLocations, managedRuntime;
const paseoPluginRoot = process.env.PI_PASEO_PLUGIN_ROOT || '/opt/woow/pi-paseo-plugin';
if (fs.existsSync(path.join(paseoPluginRoot, 'src/runtime-layout.mjs'))) {
  const state = await import(pathToFileURL(path.join(paseoPluginRoot, 'src/state.mjs')));
  const layout = await import(pathToFileURL(path.join(paseoPluginRoot, 'src/runtime-layout.mjs')));
  managedLocations = state.locations(); managedRuntime = layout.runtimeDirectory(managedLocations);
}
const cliRoot = m.cliRoot || path.join(managedRuntime || path.join(process.env.HOME, '.local/share/pi-paseo/runtime'), 'node_modules/@getpaseo/cli');
const daemonHome = m.daemonHome || managedLocations?.paseoHome || '/data/pi-agent/pi-paseo/daemon';
const cli = path.join(cliRoot, 'bin/paseo');
fs.mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
const report = ['cleanup', 'isolation'].includes(action) && existingReport ? existingReport : { runId: m.runId, hostLabel: m.hostLabel, runtimeIdentity, phase, startedAt: new Date().toISOString(), agents: [], providers: [], workspaceId: null };
const save = () => fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
const command = async (args, timeout = 30000) => {
  const { stdout } = await exec(process.execPath, [cli, '--home', daemonHome, '--json', ...args], { timeout, maxBuffer: 8 * 1024 * 1024 });
  return JSON.parse(stdout);
};
const client = new Client({ name: 'agent-connect-acceptance', version: '1' });
const requestInit = process.env.PASEO_ACCEPTANCE_BEARER ? { headers: { Authorization: 'Bearer ' + process.env.PASEO_ACCEPTANCE_BEARER } } : undefined;
const url = m.mcpUrl || `http://127.0.0.1:${managedLocations?.port || 6769}/mcp/agents`;
const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit });
const call = async (name, args = {}) => {
  const value = await client.callTool({ name, arguments: args }, undefined, { timeout: 45000 });
  if (value.isError) throw Object.assign(new Error('MCP operation failed: ' + name), { code: 'MCP_OPERATION_FAILED' });
  if (value.structuredContent !== undefined) return value.structuredContent;
  const text = value.content?.find(c => c.type === 'text')?.text;
  return text ? JSON.parse(text) : {};
};
let observer;
try {
  await client.connect(transport);
  if (action === 'cleanup') {
    // Recover only IDs bearing a nonce persisted BEFORE a possibly timed-out
    // creation request. A failed response must not strand an untracked agent.
    const listed = await call('list_agents', { includeArchived: true, cwd: m.workspaceRoot, sinceHours: 48, limit: 200 });
    if (!Array.isArray(listed.agents)) throw new Error('Unknown MCP agent list response shape');
    const attempts = new Set((report.createAttempts || []).map(x => x.id));
    for (const row of listed.agents) {
      if (row.cwd === m.workspaceRoot && row.labels?.acceptance === m.runId && row.labels?.phase === phase && attempts.has(row.labels?.acceptanceAttempt) && !report.agents.includes(row.id)) report.agents.push(row.id);
    }
    save();
    report.mcpConversationLifecycle = [];
    for (const row of report.providers) {
      await call('archive_agent', { agentId: row.agentId });
      const active = await call('list_agents', { includeArchived: false, sinceHours: 48, limit: 200 });
      const all = await call('list_agents', { includeArchived: true, sinceHours: 48, limit: 200 });
      if (!Array.isArray(active.agents) || !Array.isArray(all.agents)) throw new Error('Unknown MCP agent list response shape');
      const retained = all.agents.find(x => (x.id || x.agentId) === row.agentId);
      report.mcpConversationLifecycle.push({ agentId: row.agentId, archived: !active.agents.some(x => (x.id || x.agentId) === row.agentId), retainedInArchive: Boolean(retained?.archivedAt) });
      save();
    }
    for (const id of report.agents) {
      try { await command(['delete', id]); report.deleted ||= []; report.deleted.push(id); save(); }
      catch { report.cleanupErrors ||= []; report.cleanupErrors.push({ agentId: id, code: 'OWNED_AGENT_DELETE_FAILED' }); }
    }
    if (report.workspaceId && !report.cleanupErrors?.length) {
      await call('archive_workspace', { workspaceId: report.workspaceId });
      report.workspaceArchived = !workspaceRows(await call('list_workspaces')).some(w => (w.workspaceId || w.id) === report.workspaceId);
      report.workspaceDirectoryRetained = fs.existsSync(m.workspaceRoot);
    }
    const remaining = await command(['ls', '--global', '--all']);
    const rows = agentRows(remaining);
    report.deletedAgentAbsence = report.agents.map(id => ({ id, absent: !rows.some(r => r.id === id || r.agentId === id) }));
    report.cleanupPass = !report.cleanupErrors?.length && report.mcpConversationLifecycle.every(x => x.archived && x.retainedInArchive) && report.deletedAgentAbsence.every(x => x.absent) && (!report.workspaceId || (report.workspaceArchived === true && report.workspaceDirectoryRetained === true));
    if (!report.cleanupPass) process.exitCode = 1;
    save(); console.log(JSON.stringify({ host: m.hostLabel, deleted: report.deleted?.length || 0, workspaceArchived: report.workspaceArchived || false, cleanupPass: report.cleanupPass, cleanupErrors: report.cleanupErrors || [] }));
  } else {
    const profiles = await call('list_profiles');
    const providers = await call('list_providers');
    const models = {};
    for (const provider of ['claude','codex','pi']) models[provider] = (await call('list_models', { provider })).models;
    report.discovery = { profiles: profiles.profiles, providers: providers.providers, models };
    save();
    if (action === 'isolation') {
      if (!Array.isArray(m.foreignWrittenKeys) || !m.foreignWrittenKeys.length || !report.agents.length) throw new Error('Need actual other-host written keys and an owned acceptance agent');
      if (report.providers.length !== 3) throw new Error('Isolation requires all three provider agents');
      const { connectToDaemon } = await import(pathToFileURL(path.join(cliRoot, 'dist/utils/client.js')));
      const { fetchAgentTimelineItems } = await import(pathToFileURL(path.join(cliRoot, 'dist/commands/agent/logs.js')));
      observer = await connectToDaemon({ target: { kind: 'instance', home: daemonHome }, timeout: 10000 });
      report.crossHostIsolation = { providers: [] };
      for (const provider of report.providers) {
        const id = provider.agentId;
        const before = await fetchAgentTimelineItems(observer, id, { timeoutMs: 15000 });
        const beforeCalls = new Set(before.filter(x => x.type === 'tool_call').map(x => x.callId));
        await command(['send', id, '--no-wait', 'Use pi_shared_memory MCP read for each exact key: ' + m.foreignWrittenKeys.join(', ') + '. Each belongs to the other isolated test host and must return memory:null here. Perform actual MCP reads, then report the missing keys. Do not read manifests or other files.']);
        const waited = await command(['wait', id, '--timeout', '150s'], 165000);
        if (waited.status !== 'idle') throw new Error('Isolation turn did not finish');
        const items = await fetchAgentTimelineItems(observer, id, { timeoutMs: 15000 });
        const freshItems = items.filter(x => x.type === 'tool_call' && !beforeCalls.has(x.callId));
        const evidenceFile = path.join(evidenceRoot, provider.provider + '-cross-host-isolation-timeline.json');
        fs.writeFileSync(evidenceFile, JSON.stringify(items, null, 2) + '\n', { mode: 0o600 });
        const row = { provider: provider.provider, agentId: id, evidenceFile, keys: m.foreignWrittenKeys.map(key => ({ key, absent: memoryResult(freshItems, key, null) })) };
        row.passed = row.keys.every(x => x.absent);
        report.crossHostIsolation.providers.push(row); save();
        console.log(JSON.stringify({ host: m.hostLabel, provider: provider.provider, isolationPass: row.passed }));
      }
      report.crossHostIsolation.passed = report.crossHostIsolation.providers.length === 3 && report.crossHostIsolation.providers.every(x => x.passed);
      if (!report.crossHostIsolation.passed) process.exitCode = 1;
      save();
    } else if (action === 'discover') {
      console.log(JSON.stringify({ host: m.hostLabel, reportFile, providers: providers.providers.map(p => ({ id: p.id, status: p.status, enabled: p.enabled })), models: Object.fromEntries(Object.entries(models).map(([k,v]) => [k,v.map(x => x.id)])), profiles: profiles.profiles }));
    } else {
      if (!Array.isArray(m.providers) || m.providers.length !== 3 || new Set(m.providers.map(p => p.id)).size !== 3) throw new Error('Manifest must select claude, codex and pi with explicit model choices after discovery');
      for (const p of m.providers) {
        if (!['claude','codex','pi'].includes(p.id) || !models[p.id]?.some(x => x.id === p.model) || !models[p.id]?.some(x => x.id === p.alternateModel) || p.model === p.alternateModel) throw new Error('Select two distinct discovered models for ' + p.id);
        const available = providers.providers.find(x => x.id === p.id);
        if (!available?.enabled || available.status !== 'available') throw new Error('Provider unavailable: ' + p.id);
      }
      const { memoryRead } = await import(pathToFileURL(path.join(root, 'src/memory.mjs')));
      const { locations } = await import(pathToFileURL(path.join(root, 'src/common.mjs')));
      const { connectToDaemon } = await import(pathToFileURL(path.join(cliRoot, 'dist/utils/client.js')));
      const { fetchAgentTimelineItems } = await import(pathToFileURL(path.join(cliRoot, 'dist/commands/agent/logs.js')));
      observer = await connectToDaemon({ target: { kind: 'instance', home: daemonHome }, timeout: 10000 });
      const evidence = async (agentId, label) => {
        const items = await fetchAgentTimelineItems(observer, agentId, { timeoutMs: 15000 });
        const file = path.join(evidenceRoot, label + '-timeline.json');
        fs.writeFileSync(file, JSON.stringify(items, null, 2) + '\n', { mode: 0o600 });
        return { items, tools: items.filter(x => x.type === 'tool_call' && x.status === 'completed'), assistant: items.filter(x => x.type === 'assistant_message').map(x => x.text).join('\n'), file };
      };
      const wait = async agentId => {
        const value = await command(['wait', agentId, '--timeout', '150s'], 165000);
        if (value.status !== 'idle') throw Object.assign(new Error('Acceptance turn did not finish'), { code: 'TURN_' + String(value.status).toUpperCase() });
      };
      const cliWorkspacePath = path.join(m.workspaceRoot, 'cli-workspace-' + phase);
      fs.mkdirSync(cliWorkspacePath, { recursive: true, mode: 0o700 });
      const cliWorkspace = await command(['workspace', 'create', '--isolation', 'local', '--path', cliWorkspacePath, '--title', 'Acceptance CLI ' + phase]);
      const cliWorkspaceId = cliWorkspace.workspaceId || cliWorkspace.id;
      if (!cliWorkspaceId) throw new Error('CLI workspace create did not return ID');
      await command(['workspace', 'archive', cliWorkspaceId]);
      const workspaceList = await call('list_workspaces');
      const activeWorkspaces = workspaceRows(workspaceList);
      report.cliWorkspaceLifecycle = { workspaceId: cliWorkspaceId, created: true, archived: !activeWorkspaces.some(w => (w.workspaceId || w.id) === cliWorkspaceId), directoryRetained: fs.existsSync(cliWorkspacePath) }; save();
      const workspace = await call('create_workspace', { isolation: 'local', path: m.workspaceRoot, title: 'Acceptance ' + m.runId + ' ' + m.hostLabel });
      report.workspaceId = workspace.workspaceId; save();
      let previous = m.writes?.at(-1);
      for (const p of m.providers) {
        const writeKey = m.localMemoryKey + '-' + phase + '-' + p.id;
        const writeMarker = 'PROVIDER_' + m.runId + '_' + crypto.randomUUID();
        const previousBrandWrite = m.writes?.findLast(w => w.phase !== phase);
        const priorProviderWrite = m.writes?.findLast(w => w.provider !== p.id);
        const reads = [...new Map([previous, previousBrandWrite, priorProviderWrite].filter(Boolean).map(w => [w.key, w])).values()];
        const prompt = `Run only this harmless acceptance probe. Load the shared-host-memory skill and the ${m.skillName} skill by reading their actual instructions. Use the configured global MCP server ${m.fixtureMcpName} read_marker tool. Use pi_shared_memory MCP to read key ${m.localMemoryKey}, then key ${m.foreignMemoryKey} (it must be absent on this host), then read key ${writeKey} and report its previous content if present. Save content ${writeMarker} to key ${writeKey}; use expectedRevision null only if absent, otherwise use the revision you just read.${reads.length ? ` Also use memory MCP to read these keys written by earlier providers or brands and report their exact content: ${reads.map(w => w.key).join(', ')}.` : ''} Return the exact values obtained from the skill and each read. Perform actual tool calls. Work only with these fixture resources. Do not read acceptance manifests, other memories, credentials or other files; do not change settings or launch subagents.`;
        const settings = { ...(p.modeId ? { modeId: p.modeId } : {}), ...(p.thinkingOptionId ? { thinkingOptionId: p.thinkingOptionId } : {}) };
        m.attemptedWrites ||= []; m.attemptedWrites.push({ key: writeKey, marker: writeMarker });
        fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2) + '\n', { mode: 0o600 });
        const attemptId = crypto.randomUUID();
        report.createAttempts ||= []; report.createAttempts.push({ id: attemptId, provider: p.id }); save();
        const agent = await call('create_agent', { title: 'Acceptance ' + p.id + ' ' + m.runId, provider: p.id + '/' + p.model, workspaceId: report.workspaceId, labels: { acceptance: m.runId, phase, acceptanceAttempt: attemptId }, settings, initialPrompt: prompt, background: true, notifyOnFinish: false });
        report.agents.push(agent.agentId); save();
        await wait(agent.agentId);
        const first = await evidence(agent.agentId, p.id + '-initial');
        const firstStatus = (await call('get_agent_status', { agentId: agent.agentId })).snapshot;
        const actual = { provider: firstStatus?.provider, snapshotModel: firstStatus?.model, runtimeModel: firstStatus?.runtimeInfo?.model };
        const checks = {
          actualProvider: actual.provider === p.id,
          initialModel: actual.snapshotModel === p.model && actual.runtimeModel === p.model,
          skillRead: skillRead(first.items, m.skillName, m.expectedSkill),
          sharedMemorySkillRead: skillRead(first.items, 'shared-host-memory', 'Memory belongs to this host.'),
          globalMcpCall: fixtureMcpResult(first.items, m.fixtureMcpName, m.expectedMcp),
          memoryRead: memoryResult(first.items, m.localMemoryKey, m.expectedMemory),
          memoryWrite: memoryWriteEvidence(first.items, writeKey, writeMarker) && memoryRead(locations(), writeKey)?.content === writeMarker,
          foreignRead: memoryResult(first.items, m.foreignMemoryKey, null),
          priorProviderRead: priorProviderWrite ? memoryResult(first.items, priorProviderWrite.key, priorProviderWrite.marker) : null,
          previousBrandRead: previousBrandWrite ? memoryResult(first.items, previousBrandWrite.key, previousBrandWrite.marker) : null,
        };
        const row = { phase, write: { key: writeKey, marker: writeMarker }, priorProviderWrite, previousBrandWrite, provider: p.id, agentId: agent.agentId, actual, model: p.model, alternateModel: p.alternateModel, initial: checks, evidenceFile: first.file, toolNames: [...new Set(first.tools.map(x => x.name))] };
        report.providers.push(row); save();
        if (Object.entries(checks).some(([,v]) => v === false)) { row.failed = 'RESOURCE_TOOL_EVIDENCE_MISSING'; save(); continue; }
        const written = { key: writeKey, marker: writeMarker, phase, provider: p.id, agentId: agent.agentId, writtenAt: new Date().toISOString() };
        m.writes ||= []; m.writes.push(written);
        fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2) + '\n', { mode: 0o600 });
        await call('update_agent', { agentId: agent.agentId, settings: { model: p.alternateModel } });
        await command(['send', agent.agentId, '--no-wait', 'Read shared memory key ' + writeKey + ' using its MCP tool, then reply with the retrieved value and MODEL_SWITCH_OK. Use no other resources.']);
        await wait(agent.agentId);
        const after = await evidence(agent.agentId, p.id + '-model-switched');
        const oldCalls = new Set(first.tools.map(x => x.callId));
        const newCalls = after.tools.filter(x => !oldCalls.has(x.callId));
        const status = await call('get_agent_status', { agentId: agent.agentId });
        row.modelSwitch = { evidenceFile: after.file, requested: p.alternateModel, snapshotModel: status.snapshot?.model, runtimeModel: status.snapshot?.runtimeInfo?.model, answered: after.assistant.includes('MODEL_SWITCH_OK'), memoryRead: memoryResult(newCalls, writeKey, writeMarker), completedToolCalls: newCalls.length };
        row.modelSwitch.passed = row.modelSwitch.answered && row.modelSwitch.memoryRead && row.modelSwitch.snapshotModel === p.alternateModel && row.modelSwitch.runtimeModel === p.alternateModel;
        previous = written;
        save(); console.log(JSON.stringify({ host: m.hostLabel, provider: p.id, checks: row.initial, modelSwitch: row.modelSwitch }));
      }
      // Close the first provider's sharing loop after a different provider has
      // actually written a nonce. The reader prompt contains the key, never value.
      for (const row of report.providers.filter(x => !x.failed && !x.priorProviderWrite)) {
        const foreignProviderWrite = m.writes?.findLast(w => w.provider !== row.provider);
        if (!foreignProviderWrite) { row.initial.priorProviderRead = false; row.failed = 'OTHER_PROVIDER_WRITE_UNAVAILABLE'; save(); continue; }
        const before = await evidence(row.agentId, row.provider + '-before-cross-provider');
        await command(['send', row.agentId, '--no-wait', 'Use pi_shared_memory MCP read to retrieve key ' + foreignProviderWrite.key + '. Report its exact content from the real tool result. Do not read manifests or other files.']);
        await wait(row.agentId);
        const after = await evidence(row.agentId, row.provider + '-cross-provider');
        const priorCalls = new Set(before.tools.map(x => x.callId));
        row.initial.priorProviderRead = memoryResult(after.tools.filter(x => !priorCalls.has(x.callId)), foreignProviderWrite.key, foreignProviderWrite.marker);
        row.priorProviderWrite = foreignProviderWrite; row.priorProviderEvidenceFile = after.file;
        if (!row.initial.priorProviderRead) row.failed = 'OTHER_PROVIDER_READ_EVIDENCE_MISSING';
        save();
      }
      // Three CLI-created senders exercise the full cross-provider cycle, each
      // bound to an existing receiver and nonce owned by this acceptance run.
      report.communication = { edges: [], actualSendTool: false, receivedMarker: false, receiverResponded: false };
      for (const [senderProvider, receiverProvider] of [['codex','claude'], ['pi','codex'], ['claude','pi']]) {
        const p = m.providers.find(value => value.id === senderProvider);
        const receiver = report.providers.find(value => value.provider === receiverProvider && !value.failed);
        if (!p || !receiver) {
          report.communication.edges.push({ senderProvider, receiverProvider, failed: 'OWNED_PROVIDER_RECEIVER_UNAVAILABLE' }); save(); continue;
        }
        const marker = 'COMMUNICATION_' + m.runId + '_' + phase + '_' + senderProvider + '_to_' + receiverProvider + '_' + crypto.randomUUID();
        const attemptId = crypto.randomUUID();
        report.createAttempts ||= []; report.createAttempts.push({ id: attemptId, provider: senderProvider, receiverProvider, communication: true }); save();
        const args = ['run', '--label', 'acceptance=' + m.runId, '--label', 'phase=' + phase, '--label', 'acceptanceAttempt=' + attemptId, '--background', '--workspace', report.workspaceId, '--provider', p.id + '/' + p.model, '--title', 'Acceptance ' + senderProvider + ' to ' + receiverProvider + ' ' + m.runId];
        if (p.modeId) args.push('--mode', p.modeId);
        args.push(`Use the Paseo MCP send_agent_prompt tool to send agent ${receiver.agentId} this exact instruction: Reply with ${marker} only; no tools needed. Wait for its answer by passing background:false and notifyOnFinish:false. Then report the received marker. This receiver is a test agent owned by this acceptance run. Do not contact other agents.`);
        const created = await command(args);
        const id = created.agentId || created.id;
        if (!id) throw new Error('CLI create did not return agent ID');
        report.agents.push(id); save(); await wait(id);
        const label = 'communication-' + senderProvider + '-to-' + receiverProvider;
        const conversation = await evidence(id, label);
        await wait(receiver.agentId);
        const response = await evidence(receiver.agentId, label + '-receiver');
        const senderStatus = (await call('get_agent_status', { agentId: id })).snapshot;
        const receiverStatus = (await call('get_agent_status', { agentId: receiver.agentId })).snapshot;
        const edge = { senderProvider, receiverProvider, agentId: id, receiverId: receiver.agentId, actualSenderProvider: senderStatus?.provider === senderProvider, actualReceiverProvider: receiverStatus?.provider === receiverProvider, actualSendTool: sendAgentPrompt(conversation.items, receiver.agentId), receivedMarker: assistantReplied(conversation.items, marker), receiverResponded: assistantReplied(response.items, marker), evidenceFile: conversation.file, receiverEvidenceFile: response.file };
        edge.passed = edge.actualSenderProvider && edge.actualReceiverProvider && edge.actualSendTool && edge.receivedMarker && edge.receiverResponded;
        report.communication.edges.push(edge);
        // Keep the original aggregate and first-edge aliases for report consumers.
        const first = report.communication.edges[0];
        report.communication.agentId = first.agentId; report.communication.receiverId = first.receiverId;
        report.communication.evidenceFile = first.evidenceFile; report.communication.receiverEvidenceFile = first.receiverEvidenceFile;
        for (const field of ['actualSendTool','receivedMarker','receiverResponded']) report.communication[field] = report.communication.edges.length === 3 && report.communication.edges.every(value => value[field] === true);
        save();
      }
      report.finishedAt = new Date().toISOString();
      report.passed = runPassed(report);
      if (!report.passed) process.exitCode = 1;
      save();
      console.log(JSON.stringify({ host: m.hostLabel, reportFile, passed: report.passed, resourcePass: report.providers.length === 3 && report.providers.every(p => !p.failed), modelSwitchPass: report.providers.every(p => p.modelSwitch?.passed), communication: report.communication }));
    }
  }
} catch (error) {
  report.error = { code: typeof error.code === 'string' ? error.code : 'ACCEPTANCE_FAILED', message: String(error.message).replace(/https?:\/\/\S+/g, '[endpoint]').slice(0, 250) }; save();
  console.error(JSON.stringify({ host: m.hostLabel, error: report.error, ownedAgentCount: report.agents.length, reportFile })); process.exitCode = 1;
} finally { await observer?.close().catch(() => {}); await client.close().catch(() => {}); }
