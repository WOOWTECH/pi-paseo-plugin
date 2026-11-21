import { Craft, assertWalkthrough } from '../craft.mjs';
import { isServerMutation } from './production-guard.mjs';
import { conversationSelectors, bindConversationControls } from './conversation-controls.mjs';

const requireValue = (condition, message) => { if (!condition) throw Error('Guarded Craft: ' + message); };


const controlKind = kind => ({ 'conversation.model-open': 'model', 'conversation.prompt-fill': 'composer', 'conversation.send': 'send' })[kind];
export function assertBoundControlSelector(selector, operation) {
  const key = controlKind(operation?.kind);
  requireValue(key && typeof selector === 'string' && selector.length <= 10000, 'typed bounded conversation selector required');
  const match = selector.match(/^\[data-testid="(workspace-pane-[A-Za-z0-9_-]+)"\]:has\(\[data-testid="workspace-tab-agent_([A-Za-z0-9_-]+)"\]\[aria-selected="true"\]\)((?: > [a-z][a-z0-9]*:nth-child\([1-9][0-9]*\)){1,64})\[data-testid="message-input-root"\]/);
  requireValue(match && match[2] === operation.agentId, 'selector must bind the owned selected agent and bounded child path');
  requireValue(conversationSelectors(match[1], match[2], match[3])[key] === selector, 'selector tail or scope differs from operation');
  return key;
}

// Deliberately exact action shapes: a declared model operation cannot smuggle
// a second send, arbitrary selector, key press, script or URL into the batch.
export function assertCraftOperation(actions, operation, phase) {
  requireValue(Array.isArray(actions) && actions.length > 0, 'actions required');
  const writes = actions.filter(action => action.kind !== 'wait');
  for (const action of actions.filter(a => a.kind === 'wait')) requireValue(Object.keys(action).every(k => ['kind', 'step_id', 'ms'].includes(k)) &&
    Number.isSafeInteger(action.ms) && action.ms >= 0 && action.ms <= 1500, 'invalid observation step');
  if (!writes.length) { requireValue(!operation, 'mutation declaration without action'); return; }
  requireValue(writes.length === 1 && operation, 'one typed mutation per record required');
  const click = properties => ({ kind: 'click', ...properties });
  const control = controlKind(operation.kind);
  if (control) assertBoundControlSelector(writes[0].selector, operation);
  const expected = {
    'connector.select-target': { kind: 'select', selector: 'select[aria-label="連線標的"]', value: phase },
    'connector.save-target': click({ role: 'button', name: '儲存設定' }),
    'connector.stop': click({ role: 'button', name: '停止 Agent Connect 服務' }),
    'connector.start': click({ role: 'button', name: '啟動服務' }),
    'pair.focus': { kind: 'press', role: 'button', name: 'Cancel', key: 'Tab' },
    'pair.accept': click({ role: 'button', name: 'Connect' }),
    'hosts.open-picker': click({ test_id: 'settings-host-picker' }),
    'coordination.enable': click({ selector: '[data-testid="host-page-inject-mcp-card"] [role="switch"]' }),
    'conversation.model-open': click({ selector: writes[0].selector }),
    'conversation.provider-select': click({ test_id: `model-provider-${operation.provider}` }),
    'conversation.model-set': click({ test_id: `model-row-${operation.provider}-${operation.model}` }),
    'conversation.prompt-fill': { kind: 'fill', selector: writes[0].selector, value: operation.prompt },
    'conversation.send': click({ selector: writes[0].selector }),
  }[operation.kind];
  requireValue(expected, 'operation is not a supported Craft mutation');
  const { step_id, ...actual } = writes[0];
  requireValue(typeof step_id === 'string' && Object.keys(actual).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, value]) => actual[key] === value), 'Craft action differs from declared operation');
  // No wait before the mutation after acquiring the guard. Callers can record
  // a separate wait-only observation before this record instead.
  requireValue(actions[0] === writes[0], 'delay before guarded mutation');
}

export async function guardedRecordCall({ call, guard, page, operation, phase, tool, params, name, timeoutMs }) {
  if (tool !== 'web-walkthrough-record') return call(tool, params, name, timeoutMs);
  assertCraftOperation(params.actions, operation, phase);
  if (!operation) return call(tool, params, name, timeoutMs);
  return guard.run({ page, operation, execute: async ({ remainingMs }) => {
    const bindingStarted = performance.now();
    const control = controlKind(operation.kind);
    if (control) {
      const actual = await bindConversationControls(page, operation.agentId, Math.min(1000, remainingMs));
      requireValue(params.actions[0].selector === actual.selectors[control], 'actual visible composer path changed before dispatch');
    }
    // Only server writes have a transport deadline. Local UI validates its
    // route/job binding without acquiring an idle grant or writing a journal.
    const budget = isServerMutation(operation) ? Math.min(timeoutMs || 120000, remainingMs - Math.ceil(performance.now() - bindingStarted) - 250) : timeoutMs || 120000;
    requireValue(budget >= 1000, 'insufficient fresh dispatch window');
    const result = await call(tool, { ...params, timeout_secs: Math.max(1, Math.floor(budget / 1000)),
      action_timeout_ms: Math.min(params.action_timeout_ms, budget) }, name, budget);
    // A zero CLI exit can still contain an aborted/partial walkthrough. Validate
    // before closing the intent, so a lost/failed action remains uncertain.
    if (isServerMutation(operation)) assertWalkthrough(result, params.actions.map(action => action.step_id));
    return result;
  } });
}

export class GuardedCraft extends Craft {
  constructor(options, { guard, page, operation, phase }) {
    super(options);
    this.dispatch = { guard, page, operation, phase };
  }
  async call(tool, params, name, timeoutMs) {
    return guardedRecordCall({ ...this.dispatch, tool, params, name, timeoutMs,
      call: (...args) => super.call(...args) });
  }
}
