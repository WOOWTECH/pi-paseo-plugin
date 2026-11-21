// Explicit production entry. Ordinary pair/coordination/conversations CLIs
// continue to accept isolated-candidate only. Default check is entirely local.
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { openProductionSession, productionSessionState } from './production-parent.mjs';
import { launch } from './common.mjs';
import { runPair } from './pair.mjs';
import { runCoordination } from './coordination.mjs';
import { runConversations } from './conversations.mjs';

export async function runProduction(options) {
  const session = await openProductionSession(options);
  const { config, guard, jobs, ready } = productionSessionState(session);
  let browser, closed = false;
  const closeBrowser = async () => { if (browser) await browser.close(); };
  const interrupt = () => { closeBrowser().finally(() => session.close()).catch(() => {}); };
  const open = async (actual, action) => {
    if (actual !== config || browser) throw Error('One browser lifetime per managed session required');
    browser = await launch(config, action, { productionGuard:guard });
    const close = browser.close; browser.close = async () => { if (!closed) { closed = true; await close(); } };
    session.onFailure(() => { browser.close().catch(() => {}); });
    return browser;
  };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    console.log(JSON.stringify({ status:'authenticated-parent-ready', phase:config.brand,
      browserManifest:ready.browserManifest, evidenceDirectory:ready.evidenceDirectory }));
    if (options.action === 'pair') await runPair(config, 'pair', open);
    else if (options.action === 'coordination') await runCoordination(config, open);
    else await runConversations(config, jobs, open);
    session.assertAlive();
  } finally {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    try { if (browser) await browser.close(); } finally { await session.close(); }
  }
}

export async function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args:argv, allowPositionals:true,
    options:{ receipts:{type:'string'}, evidence:{type:'string'}, brand:{type:'string'}, seconds:{type:'string'} } });
  const [action = 'check'] = positionals;
  if (positionals.length > 1) throw Error('One explicit action required');
  if (action === 'check') {
    console.log(JSON.stringify({ scope:'production-canary', actions:['pair','coordination','conversations'],
      parent:'live-acceptance/canary_browser_transport.py serve', perMutationGuard:true, maxSessionSeconds:1800, productionMutations:false })); return;
  }
  await runProduction({ action, receipts:values.receipts, root:values.evidence, brand:values.brand,
    seconds:values.seconds === undefined ? 1800 : Number(values.seconds) });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
