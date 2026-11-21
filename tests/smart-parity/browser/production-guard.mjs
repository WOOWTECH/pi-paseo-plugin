import crypto from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';
import { validateProductionManifest } from '../production-scope.mjs';
import { controlledStopObservation } from './controlled-stop-observation.mjs';
import { bindConversationControls } from './conversation-controls.mjs';

export const guardProtocol = 'agent-connect-browser-guard/v1';
const brands = { woowtech: 'https://smart.woowtech.io', apporo: 'https://smart.apporo.ai', paseo: 'https://app.paseo.sh' };
const check = (condition, message) => { if (!condition) throw Error('Browser guard: ' + message); };
const same = (actual, expected, message) => check(equal(actual, expected), message);
export const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const text = value => typeof value === 'string' && value.length > 0;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const conversation = operation => operation.kind.startsWith('conversation.');
const connectorKinds = new Set(['connector.open', 'connector.select-target', 'connector.save-target', 'connector.stop', 'connector.start', 'connector.pair']);
const mutations = new Set(['connector.save-target', 'connector.stop', 'connector.start', 'connector.pair',
  'pair.accept', 'coordination.enable', 'conversation.model-set', 'conversation.send']);
export const isServerMutation = operation => mutations.has(operation?.kind);
const noPayload = new Set(['connector.open', 'connector.select-target', 'connector.save-target', 'connector.stop', 'connector.start', 'connector.pair',
  'pair.focus', 'pair.accept', 'pair.skip-setup', 'hosts.open-picker', 'coordination.enable', 'conversation.model-open', 'conversation.provider-select', 'conversation.reload']);

function operationValid(operation) {
  check(operation && text(operation.kind), 'typed operation required');
  const extra = {
    'pair.navigate': ['url'], 'conversation.navigate': ['url'], 'conversation.model-set': ['model'],
    'conversation.prompt-fill': ['prompt'], 'conversation.send': ['prompt'],
  }[operation.kind];
  check(noPayload.has(operation.kind) || extra, 'unsupported operation');
  const keys = ['kind', 'hostLabel', ...(conversation(operation) ? ['agentId', 'workspaceId', 'provider'] : []),
    ...(connectorKinds.has(operation.kind) && isServerMutation(operation) ? ['expectedConnector'] : []), ...(extra || [])];
  same(Object.keys(operation).sort(), keys.sort(), 'unexpected or missing operation fields');
  check(text(operation.hostLabel), 'host required');
  if (conversation(operation)) check(text(operation.agentId) && text(operation.workspaceId) && ['claude', 'codex', 'pi'].includes(operation.provider), 'owned agent/workspace/provider required');
  for (const key of extra || []) check(text(operation[key]), 'missing ' + key);
  if ('prompt' in operation) check(operation.prompt.length <= 16000, 'prompt too long');
  if (connectorKinds.has(operation.kind) && isServerMutation(operation)) {
    const state = operation.expectedConnector;
    check(state && Object.hasOwn(brands, state.selectedTarget) && (state.activeTarget === null || Object.hasOwn(brands, state.activeTarget)) &&
      typeof state.configurationPending === 'boolean' && typeof state.daemonRunning === 'boolean', 'exact observed connector precondition required');
    same(Object.keys(state).sort(), ['activeTarget', 'configurationPending', 'daemonRunning', 'selectedTarget'], 'unexpected connector precondition');
  }
}

function workspacePath(host, operation) {
  const id = operation.workspaceId;
  const workspace = /^[A-Za-z0-9._~-]+$/.test(id) ? id : 'b64_' + Buffer.from(id).toString('base64url');
  return `/h/${encodeURIComponent(host.serverId)}/workspace/${workspace}`;
}

export async function assertBrowserTarget(page, host, phase, operation) {
  const url = new URL(page.url());
  if (connectorKinds.has(operation.kind)) {
    check(url.origin === host.baseUrl && url.pathname === '/omnigent' && !url.hash, 'connector page escaped owned tunnel');
    if (operation.kind === 'connector.save-target') check(await page.getByRole('combobox', { name: '連線標的' }).inputValue() === phase, 'local target changed before save');
  } else if (operation.kind === 'pair.navigate') {
    const destination = new URL(operation.url);
    check(destination.origin === brands[phase] && destination.pathname === '/' && !destination.search && destination.hash.startsWith('#offer='), 'pair route mismatch');
    let offer; try { offer = JSON.parse(Buffer.from(destination.hash.slice(7), 'base64url').toString()); } catch { throw Error('Browser guard: invalid pairing offer'); }
    check(offer.serverId === host.serverId, 'pair offer has foreign server');
  } else if (operation.kind.startsWith('pair.')) {
    check(url.origin === brands[phase], 'pair origin mismatch');
    if (operation.kind === 'pair.accept') {
      const dialog = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: 'Connect', exact: true }) });
      check(await dialog.getByText(host.serverId, { exact: true }).isVisible(), 'pair confirmation has foreign server');
    } else if (operation.kind !== 'pair.skip-setup') check(await page.getByText(host.serverId, { exact: true }).isVisible(), 'pair confirmation server absent');
  } else if (operation.kind === 'hosts.open-picker') {
    check(url.origin === brands[phase] && url.pathname === '/settings', 'host picker route mismatch');
  } else if (operation.kind === 'coordination.enable') {
    check(url.origin === brands[phase] && url.pathname === `/settings/hosts/${encodeURIComponent(host.serverId)}/agents`, 'coordination host route mismatch');
    check(await page.getByTestId('host-page-inject-mcp-card').getByRole('switch').getAttribute('aria-checked') === 'false', 'coordination precondition changed');
  } else if (conversation(operation)) {
    const destination = operation.kind === 'conversation.navigate' ? new URL(operation.url) : url;
    check(destination.origin === brands[phase] && destination.pathname === workspacePath(host, operation) && !destination.hash, 'conversation host/workspace route mismatch');
    if (operation.kind === 'conversation.navigate') {
      check(destination.searchParams.get('open') === 'agent:' + operation.agentId && [...destination.searchParams].length === 1, 'conversation navigation agent mismatch');
    } else {
      const tab = page.getByTestId(`workspace-tab-agent_${operation.agentId}`);
      check(await tab.isVisible() && await tab.getAttribute('aria-selected') === 'true', 'active agent changed');
      if (operation.kind === 'conversation.send') {
        const { composer } = await bindConversationControls(page, operation.agentId, 1000);
        check(await composer.inputValue() === operation.prompt, 'send draft differs from owned job');
      }
    }
  }
}

function binding(value, request) {
  for (const key of ['scope', 'runId', 'sourceManifestSha256', 'release', 'phase', 'runtimeIdentity', 'dataIdentity', 'serverId']) same(value?.[key], request[key], 'receipt binding changed: ' + key);
}

// The transport must independently authenticate CI, recheck current Kubernetes
// identity/idle state and journal before replying. These checks defend against
// stale/misrouted responses; they do not turn static proof files into authority.
function validateBegin(context, request, requestHash, reply, now) {
  check(reply?.protocol === guardProtocol && reply.method === 'begin' && reply.requestSha256 === requestHash &&
    reply.attemptId === request.attemptId && reply.status === 'dispatching_do_not_retry', 'missing live dispatch response');
  const host = context.manifest.hosts.find(h => h.label === request.hostLabel);
  const original = context.transport.hosts[host.release];
  const read = reference => { check(reference && digest(reference.sha256), 'hash-bound evidence reference required'); return context.reader.read(reference); };
  const current = read(reply.current), canonical = read(reply.canonical), journal = read(reply.journal);
  const value = current.value, activity = value.activity;
  let observation, controlledReference;
  check(value.scope === request.scope && value.productionMutations === false, 'actual read-only observation required');
  for (const key of ['identity', 'runtime', 'runtimeIdentity', 'dataIdentity', 'ledger']) same(value[key], original.baseline[key], 'current runtime/host/PVC epoch changed: ' + key);
  if (request.operation.kind === 'connector.start') check(reply.controlledStop, 'actual returned controlled stop required');
  if (reply.controlledStop) {
    const stopped = read(reply.controlledStop), checkpoint = read(journal.value.preStopReference);
    observation = controlledStopObservation({ value, proof: stopped.value, checkpoint: checkpoint.value,
      checkpointHash: checkpoint.canonical(), journal: journal.value, request, original, now,
      returnedBytes: read(reply.controlledStopJournals).value,
      canonicalHash: context.reader.read(context.transportProof).canonical(['hosts', host.release, 'canonical']) });
    controlledReference = stopped.proof;
    check(reply.expiresAt <= observation.deadline, 'dispatch exceeds controlled-stop observation');
  } else {
    same(activity?.mount, original.baseline.activity.mount, 'actual mount changed');
    check(activity?.snapshot?.complete === true && activity.snapshot.serverId === host.serverId, 'complete current host snapshot required');
    if (['connector.stop', 'connector.save-target'].includes(request.operation.kind))
      check(activity.connector?.daemonRunning === true && activity.connector.enabled === true, 'stopped save requires controlled observation');
    observation = { state: activity.connector, startedAt: activity.startedAt, observedAt: activity.observedAt };
  }
  for (const key of ['paseoKeypairSha256', 'wrapperCli']) same(value.ui?.[key], original.baseline.ui[key], 'persistent identity changed');
  same(value.ui?.omnigent?.hostIdSha256, original.baseline.ui.omnigent.hostIdSha256, 'Omnigent identity changed');
  const times = [observation.startedAt, observation.observedAt, value.observedAt, reply.checkedAt, reply.expiresAt];
  check(times.every(Number.isFinite) && observation.startedAt <= observation.observedAt && observation.observedAt <= value.observedAt &&
    value.observedAt <= reply.checkedAt && reply.checkedAt <= now && now < reply.expiresAt &&
    reply.expiresAt <= observation.startedAt + 30 && reply.expiresAt <= host.productionBinding.tunnel.expiresAt, 'stale, future or oversized dispatch window');
  const { verifiedAt, ...proof } = canonical.value;
  same(proof, original.canonical, 'canonical CI proof changed');
  // CI proof is immutable and authenticated once by the current live transport
  // session. Activity/identity above is fresh per mutation; a persisted caller
  // proof must never replace the transport's in-memory canonical authority.
  check(Number.isFinite(verifiedAt) && verifiedAt <= reply.checkedAt, 'canonical verification time is invalid');
  binding(journal.value, request);
  check(journal.value.attemptId === request.attemptId && journal.value.requestSha256 === requestHash &&
    journal.value.status === 'dispatching_do_not_retry', 'dispatch intent is not bound to this operation');
  same(journal.value.identity, request.identity, 'journal epoch changed');
  same(journal.value.tunnel, request.tunnel, 'owned live tunnel changed');
  const state = observation.state;
  if (connectorKinds.has(request.operation.kind)) {
    for (const [key, expected] of Object.entries(request.operation.expectedConnector)) same(state[key], expected, 'connector changed before dispatch: ' + key);
    if (request.operation.kind !== 'connector.save-target') check(state.selectedTarget === request.phase, 'connector mutation has wrong selected brand');
    if (request.operation.kind === 'connector.pair') check(state.activeTarget === request.phase && state.configurationPending === false && state.daemonRunning === true, 'pair request requires ready active brand');
  } else check(state?.selectedTarget === request.phase && state.activeTarget === request.phase && state.configurationPending === false &&
    state.daemonRunning === true, 'selected/active brand is not ready');
  if (conversation(request.operation)) {
    const owned = read(reply.ownership).value;
    binding(owned, request);
    check(Array.isArray(owned.agents) && Array.isArray(owned.workspaces), 'complete ownership receipt required');
    const op = request.operation, agent = owned.agents.filter(a => a.id === op.agentId);
    check(agent.length === 1 && agent[0].provider === op.provider && agent[0].workspaceId === op.workspaceId &&
      owned.workspaces.filter(w => w.id === op.workspaceId).length === 1, 'agent/workspace is not owned by this run and phase');
    const baselineIds = [...original.baseline.activity.snapshot.agents, ...original.baseline.activity.snapshot.availableAgents, ...original.baseline.activity.piSessions].map(a => a.id);
    check(!baselineIds.includes(op.agentId), 'baseline user agent can never be owned');
    const checkpoint = read(owned.checkpoint).value;
    binding(checkpoint, request);
    const jobs = checkpoint.jobs?.filter(j => j.agentId === op.agentId && j.provider === op.provider);
    check(checkpoint.workspaceId === op.workspaceId && jobs?.length === 1, 'immutable job ownership mismatch');
    if (op.kind === 'conversation.model-set') check(agent[0].discoveredModels?.includes(op.model) && jobs[0].targetModel === op.model, 'model differs from discovered checkpoint');
    if ('prompt' in op) same(op.prompt, jobs[0].prompt, 'prompt differs from immutable checkpoint');
  }
  return { expiresAt: reply.expiresAt, refs: { current: current.proof, canonical: canonical.proof, journal: journal.proof, ...(reply.ownership ? { ownership: reply.ownership } : {}), ...(controlledReference ? { controlledStop: controlledReference, controlledStopJournals: reply.controlledStopJournals } : {}) } };
}

export function createProductionGuard({ context, phase, exchange, jobs = [], now = () => Date.now() / 1000, timeoutMs = 45000 }) {
  check(context?.manifest?.scope === 'production-canary' && Object.hasOwn(brands, phase) && typeof exchange === 'function', 'live transport bridge required');
  // Revalidate bytes, including canonical Python hashes, before accepting the
  // context. Do not accept a hand-made { authorized: true } capability object.
  const fresh = validateProductionManifest(structuredClone(context.manifest), { evidenceDirectory: context.reader.root, manifestName: context.manifestProof.path });
  same(fresh.manifestSha256, context.manifestSha256, 'source manifest changed');
  context = fresh;
  jobs = structuredClone(jobs);
  let busy = false, blocked = false;
  const completed = new Set();
  const call = async envelope => {
    const abort = new AbortController();
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(() => exchange(envelope, { signal: abort.signal })),
        new Promise((_, reject) => { timer = setTimeout(() => { abort.abort(); reject(Error('Browser guard: transport timeout; no retry')); }, timeoutMs); })]);
    } finally { clearTimeout(timer); }
  };
  return {
    async run({ page, operation, execute }) {
      operation = structuredClone(operation);
      operationValid(operation);
      if (isServerMutation(operation)) check(!blocked && !busy, 'pending, uncertain or concurrent action; no retry');
      const intent = sha256(JSON.stringify(operation));
      if (isServerMutation(operation)) check(!completed.has(intent), 'completed mutation cannot be replayed');
      const host = context.manifest.hosts.find(h => h.label === operation.hostLabel);
      check(host, 'host outside manifest');
      check(typeof execute === 'function', 'dispatch function required');
      if (!isServerMutation(operation)) {
        context.reader.read(context.manifestProof); context.reader.read(context.transportProof);
        if (conversation(operation)) {
          const group = jobs.find(j => j.hostLabel === host.label && j.phase === phase && j.workspaceId === operation.workspaceId);
          check(group?.scope === context.manifest.scope && group.runId === context.manifest.runId &&
            group.runtimeIdentity === host.runtimeIdentity && group.sourceManifestSha256 === context.manifestSha256, 'local job binding mismatch');
          const job = group.jobs?.filter(j => j.agentId === operation.agentId && j.provider === operation.provider);
          check(job?.length === 1, 'local agent/job binding mismatch');
          if (operation.kind === 'conversation.prompt-fill') same(operation.prompt, job[0].prompt, 'local draft differs from job');
        }
        await assertBrowserTarget(page, host, phase, operation);
        // Navigation, menus, focus and drafts are local observations. They do
        // not consume authority, assert idle, or create mutation journal entries.
        return execute({ remainingMs: 45000 });
      }
      busy = true;
      let began = false, dispatched = false, request, requestHash;
      try {
        context.reader.read(context.manifestProof); context.reader.read(context.transportProof);
        await assertBrowserTarget(page, host, phase, operation);
        request = { schema: 1, scope: 'production-canary', runId: context.manifest.runId,
          sourceManifestSha256: context.manifestSha256, transportManifestSha256: context.transportProof.sha256,
          attemptId: crypto.randomUUID(), hostLabel: host.label, release: host.release, phase,
          runtimeIdentity: host.runtimeIdentity, dataIdentity: host.dataIdentity, serverId: host.serverId,
          identity: host.productionBinding.identity, tunnel: host.productionBinding.tunnel, operation };
        const requestJson = JSON.stringify(request); requestHash = sha256(requestJson);
        // Any lost/malformed begin may already have persisted an intent.
        began = true;
        const reply = await call({ protocol: guardProtocol, method: 'begin', requestJson, requestSha256: requestHash });
        const checked = validateBegin(context, request, requestHash, reply, now());
        await assertBrowserTarget(page, host, phase, operation);
        check(now() < checked.expiresAt, 'guard expired during DOM recheck');
        dispatched = true;
        const result = await execute({ expiresAt: checked.expiresAt, remainingMs: Math.floor((checked.expiresAt - now()) * 1000) });
        const summary = result === undefined ? { completion: 'client-returned' } :
          { ...(result?.id ? { craftEvidenceId: result.id } : {}), resultSha256: sha256(JSON.stringify(result)) };
        const finish = await call({ protocol: guardProtocol, method: 'finish', requestSha256: requestHash,
          attemptId: request.attemptId, outcome: 'returned', result: summary });
        check(finish?.protocol === guardProtocol && finish.method === 'finish' && finish.attemptId === request.attemptId &&
          finish.requestSha256 === requestHash && finish.status === 'returned', 'completion not acknowledged; no retry');
        const done = context.reader.read(finish.journal).value;
        binding(done, request);
        same(done.identity, request.identity, 'completion epoch changed');
        same(done.tunnel, request.tunnel, 'completion tunnel changed');
        check(done.attemptId === request.attemptId && done.requestSha256 === requestHash && done.status === 'returned', 'completion journal mismatch');
        completed.add(intent);
        return result;
      } catch (error) {
        if (began) {
          blocked = true;
          // Best effort record only. It never grants a retry or clears the local
          // block. Build must retain an unresolved intent after any uncertainty.
          await call({ protocol: guardProtocol, method: 'finish', requestSha256: requestHash,
            attemptId: request.attemptId, outcome: dispatched ? 'uncertain' : 'not-dispatched', result: {} }).catch(() => {});
        }
        throw error;
      } finally { busy = false; }
    },
  };
}
