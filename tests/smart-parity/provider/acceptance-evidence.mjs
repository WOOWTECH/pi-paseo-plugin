// Fail-closed checks of completed provider tool results, never assistant claims or tool inputs.
export function requireRuntimeIdentity(value) {
  if (typeof value !== 'string' || !/^(image|package-set):sha256:[a-f0-9]{64}$/.test(value)) throw new Error('Missing or invalid acceptance runtime identity');
  return value;
}
export function requireEvidenceIdentity(manifest, evidence, phase) {
  const identity = requireRuntimeIdentity(manifest.runtimeIdentity);
  if (requireRuntimeIdentity(evidence?.runtimeIdentity) !== identity) throw new Error('Acceptance runtime identity mismatch');
  if (!manifest.runId || !manifest.hostLabel || evidence.runId !== manifest.runId || evidence.hostLabel !== manifest.hostLabel || evidence.phase !== phase) throw new Error('Acceptance evidence ownership mismatch');
  return identity;
}
const decode = value => {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
};
export const completedCalls = items => items.filter(x => x.type === 'tool_call' && x.status === 'completed' && !x.error);
function input(call) { return decode(call.detail?.input) || {}; }
function output(call) { return call.detail?.output ?? call.detail?.content; }
function resultValues(value, depth = 0) {
  if (depth > 8) return [];
  value = decode(value);
  if (!value || typeof value !== 'object') return [value];
  if (value.isError === true) return [];
  if (Array.isArray(value)) return value.flatMap(x => resultValues(x, depth + 1));
  const values = [value];
  for (const name of ['result', 'output', 'structuredContent', 'content', 'text']) {
    if (Object.hasOwn(value, name)) values.push(...resultValues(value[name], depth + 1));
  }
  return values;
}
function toolName(call) {
  return String(call.name).replace(/^mcp__pi_shared_runtime__/, '').replace(/^(?:mcp\.)?pi_shared_runtime\./, '').replace(/^pi_global_/, '');
}
export function invokes(call, server, tool, fields = {}) {
  const name = toolName(call), args = input(call);
  let actual;
  if ([`${server}_${tool}`, `${server}__${tool}`, `${server}.${tool}`, `mcp__${server}__${tool}`, `mcp.${server}.${tool}`].includes(name)) actual = args;
  else if (name === 'mcp' && (args.tool === `${server}_${tool}` || (args.server === server && args.tool === tool))) actual = decode(args.args);
  // The adapter also exposes one dispatcher per server. Bind both the outer
  // namespace and the exact underlying tool; never infer a server from args.
  else if (name === `mcp__${server}` && [tool, `${server}_${tool}`].includes(args.tool) &&
    (!Object.hasOwn(args, 'server') || args.server === server)) actual = decode(args.args);
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
  return Object.entries(fields).every(([key, value]) => actual[key] === value);
}
export function memoryResult(items, key, expected) {
  return completedCalls(items).some(call => invokes(call, 'pi_shared_memory', 'read', { key }) && resultValues(output(call)).some(value =>
    value && typeof value === 'object' && Object.hasOwn(value, 'memory') &&
    (expected === null ? value.memory === null : value.memory?.key === key && value.memory?.content === expected)));
}
export function memoryWrite(items, key, content) {
  return completedCalls(items).some(call => invokes(call, 'pi_shared_memory', 'write', { key, content }) && resultValues(output(call)).some(value =>
    value?.memory?.key === key && value.memory.content === content && typeof value.memory.revision === 'string'));
}
export function fixtureMcpResult(items, server, marker) {
  return completedCalls(items).some(call => invokes(call, server, 'read_marker') && resultValues(output(call)).some(value => value === marker));
}
export function skillRead(items, name, marker) {
  return completedCalls(items).some(call => {
    const detail = call.detail || {}, args = input(call), tool = toolName(call);
    const matchingPath = value => typeof value === 'string' && value.replaceAll('\\', '/').endsWith('/' + name + '/SKILL.md');
    const source = (detail.type === 'read' && matchingPath(detail.filePath)) ||
      (['read', 'Read', 'read_file'].includes(tool) && [args.path, args.file_path, args.filePath].some(matchingPath)) ||
      (['Skill', 'skill'].includes(tool) && args.skill === name) ||
      (detail.type === 'shell' && typeof detail.command === 'string' && detail.command.includes('/' + name + '/SKILL.md') && !detail.command.includes('manifest'));
    return source && resultValues(output(call)).some(value => typeof value === 'string' && value.includes(marker));
  });
}
export function sendAgentPrompt(items, receiverId) {
  return completedCalls(items).some(call => {
    const name = String(call.name), args = input(call);
    if (/^(?:mcp__paseo__|(?:mcp\.)?paseo\.)?send_agent_prompt$/.test(name)) return args.agentId === receiverId;
    return invokes(call, 'paseo', 'send_agent_prompt', { agentId: receiverId });
  });
}
export function assistantReplied(items, marker) {
  return items.some(x => x.type === 'assistant_message' && typeof x.text === 'string' && x.text.includes(marker));
}
export function workspaceRows(value) {
  const rows = Array.isArray(value) ? value : value?.workspaces;
  if (!Array.isArray(rows)) throw new Error('Unknown workspace list response shape');
  return rows;
}
export function agentRows(value) {
  if (!Array.isArray(value)) throw new Error('Unknown CLI agent list response shape');
  return value;
}
export function communicationCyclePassed(communication) {
  const expected = ['codex>claude', 'pi>codex', 'claude>pi'];
  const edges = communication?.edges;
  return Array.isArray(edges) && edges.length === 3 && expected.every(pair => edges.filter(edge => edge.senderProvider + '>' + edge.receiverProvider === pair).length === 1) &&
    new Set(edges.map(edge => edge.agentId)).size === 3 && new Set(edges.map(edge => edge.receiverId)).size === 3 &&
    edges.every(edge => typeof edge.agentId === 'string' && edge.agentId.length > 0 && typeof edge.receiverId === 'string' && edge.receiverId.length > 0 && edge.agentId !== edge.receiverId &&
      edge.actualSenderProvider === true && edge.actualReceiverProvider === true && edge.actualSendTool === true && edge.receivedMarker === true && edge.receiverResponded === true);
}
export function runPassed(report) {
  return report.providers.length === 3 && report.providers.every(row => !row.failed && Object.values(row.initial).every(x => x !== false) && row.modelSwitch?.passed === true) &&
    report.cliWorkspaceLifecycle?.created === true && report.cliWorkspaceLifecycle?.archived === true && report.cliWorkspaceLifecycle?.directoryRetained === true &&
    report.communication?.actualSendTool === true && report.communication?.receivedMarker === true && report.communication?.receiverResponded === true && communicationCyclePassed(report.communication);
}
export function webTurnChecks(agent, job, items, storedMemory) {
  const before = new Set(job.beforeToolIds);
  const fresh = items.filter(x => x.type === 'tool_call' && typeof x.callId === 'string' && x.callId.length > 0 && !before.has(x.callId));
  const text = value => typeof value === 'string' && value.length > 0;
  const persisted = text(job.expectedWrite) && storedMemory?.key === job.writeKey && storedMemory.content === job.expectedWrite && text(storedMemory.revision);
  // Bind a successful create to its prior absent read and the independently
  // observed persisted revision. A final answer or configured model is not proof.
  const freshCreate = persisted && completedCalls(fresh).some(call => {
    const index = fresh.indexOf(call);
    return invokes(call, 'pi_shared_memory', 'write', { key: job.writeKey, content: job.expectedWrite, expectedRevision: null }) &&
      memoryResult(fresh.slice(0, index), job.writeKey, null) && resultValues(output(call)).some(value =>
        value?.memory?.key === job.writeKey && value.memory.content === job.expectedWrite && value.memory.revision === storedMemory.revision);
  });
  return { actualProvider: agent?.provider === job.provider, completed: agent?.status === 'idle',
    requestedModel: agent?.model === job.targetModel, actualModel: agent?.runtimeInfo?.model === job.targetModel,
    modelChanged: job.beforeModel.runtime !== job.targetModel,
    freshMemoryRead: text(job.expectedMemory) && memoryResult(fresh, job.memoryKey, job.expectedMemory),
    freshSkillRead: text(job.skillName) && text(job.expectedSkill) && skillRead(fresh, job.skillName, job.expectedSkill),
    freshSharedMemorySkillRead: text(job.sharedMemorySkillName) && text(job.expectedSharedMemorySkill) && skillRead(fresh, job.sharedMemorySkillName, job.expectedSharedMemorySkill),
    freshGlobalMcpCall: text(job.fixtureMcpName) && text(job.expectedMcp) && fixtureMcpResult(fresh, job.fixtureMcpName, job.expectedMcp),
    freshMemoryWriteRead: memoryResult(fresh, job.writeKey, null), freshMemoryWrite: Boolean(freshCreate), persistedMemoryWrite: Boolean(persisted),
    answered: text(job.replyMarker) && assistantReplied(items, job.replyMarker) };
}
export function appendVerifiedWebWrite(manifest, record) {
  manifest.writes ||= [];
  const previous = manifest.writes.find(value => value.key === record.key);
  if (previous) {
    if (!['marker','provider','agentId','phase','source','revision'].every(field => previous[field] === record[field])) throw new Error('Verified Web write ownership conflict');
    return false;
  }
  manifest.writes.push(record);
  return true;
}
