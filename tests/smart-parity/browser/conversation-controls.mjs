import { until, verifyActiveAgent } from './common.mjs';

// Craft uses native CSS; Playwright's :visible is not a recording selector.
export function conversationSelectors(paneId, agentId, composerPath = '') {
  if (!/^workspace-pane-[A-Za-z0-9_-]+$/.test(paneId || '') || !/^[A-Za-z0-9_-]+$/.test(agentId || '') ||
    !/^(?: > [a-z][a-z0-9]*:nth-child\([1-9][0-9]*\)){0,64}$/.test(composerPath))
    throw Error('Invalid active conversation DOM identity');
  const pane = `[data-testid="${paneId}"]:has([data-testid="workspace-tab-agent_${agentId}"][aria-selected="true"])`;
  const root = composerPath ? `${pane}${composerPath}[data-testid="message-input-root"]` : `${pane} [data-testid="message-input-root"]`;
  return { pane, root, model: `${root} [data-testid="combined-model-selector"]`,
    composer: `${root} textarea`, send: `${root} [role="button"][aria-label="Send message"]` };
}

export async function bindConversationControls(page, agentId, timeout = 30000) {
  await verifyActiveAgent(page, agentId, timeout);
  let controls;
  await until(async () => {
    const paneId = await page.getByTestId(`workspace-tab-agent_${agentId}`).evaluate(
      node => node.closest('[data-testid^="workspace-pane-"]')?.getAttribute('data-testid'));
    const pane = page.locator(conversationSelectors(paneId, agentId).pane);
    if (await pane.count() !== 1) return false;
    // Paseo keeps previous agents' composers mounted under display:none inside
    // the SAME pane. Resolve the single visible root, then derive its exact native
    // CSS path. Never select an arbitrary first/nth matching conversation.
    const composerPath = await pane.evaluate(node => {
      const roots = [...node.querySelectorAll('[data-testid="message-input-root"]')].filter(root => {
        const box = root.getBoundingClientRect(), visibility = getComputedStyle(root).visibility;
        return box.width > 0 && box.height > 0 && visibility !== 'hidden' && visibility !== 'collapse';
      });
      if (roots.length !== 1) return null;
      let current = roots[0]; const segments = [];
      while (current !== node) {
        const parent = current.parentElement;
        if (!parent || segments.length >= 64) return null;
        segments.unshift(` > ${current.localName}:nth-child(${[...parent.children].indexOf(current) + 1})`);
        current = parent;
      }
      return segments.join('');
    });
    if (!composerPath) return false;
    const selectors = conversationSelectors(paneId, agentId, composerPath);
    const model = page.locator(selectors.model), composer = page.locator(selectors.composer), send = page.locator(selectors.send);
    if (await page.locator(selectors.root).count() !== 1 || await model.count() !== 1 || await composer.count() !== 1) return false;
    if (!await model.isVisible() || !await model.isEnabled() || !await composer.isVisible()) return false;
    const label = (await model.innerText()).trim();
    if (!label || label === 'Select model') return false;
    controls = { selectors, model, composer, send };
    return true;
  }, timeout);
  return controls;
}
