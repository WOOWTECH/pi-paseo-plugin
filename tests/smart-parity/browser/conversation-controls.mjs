import { until, verifyActiveAgent } from './common.mjs';

// The public web app may mount controls outside the selected workspace pane.
// Craft uses native CSS, so Playwright's :visible is not a recording selector.
export function conversationSelectors(paneId, agentId) {
  if (!/^workspace-pane-[A-Za-z0-9_-]+$/.test(paneId || '') || !/^[A-Za-z0-9_-]+$/.test(agentId || ''))
    throw Error('Invalid active conversation DOM identity');
  const pane = `[data-testid="${paneId}"]:has([data-testid="workspace-tab-agent_${agentId}"][aria-selected="true"])`;
  const root = `${pane} [data-testid="message-input-root"]`;
  return { pane, root, model: `${root} [data-testid="combined-model-selector"]`,
    composer: `${root} textarea`, send: `${root} [role="button"][aria-label="Send message"]` };
}

export async function bindConversationControls(page, agentId, timeout = 30000) {
  await verifyActiveAgent(page, agentId, timeout);
  const paneId = await page.getByTestId(`workspace-tab-agent_${agentId}`).evaluate(
    node => node.closest('[data-testid^="workspace-pane-"]')?.getAttribute('data-testid'));
  const selectors = conversationSelectors(paneId, agentId);
  const model = page.locator(selectors.model), composer = page.locator(selectors.composer), send = page.locator(selectors.send);
  // Wait for hydration/transient duplicate mounts before any recorded mutation.
  await until(async () => {
    if (await page.locator(selectors.pane).count() !== 1 || await page.locator(selectors.root).count() !== 1 ||
      await model.count() !== 1 || await composer.count() !== 1) return false;
    if (!await model.isVisible() || !await model.isEnabled() || !await composer.isVisible()) return false;
    const label = (await model.innerText()).trim();
    return Boolean(label) && label !== 'Select model';
  }, timeout);
  return { selectors, model, composer, send };
}
