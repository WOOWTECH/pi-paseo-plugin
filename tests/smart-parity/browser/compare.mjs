import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Craft } from '../craft.mjs';
import { evidenceStore } from '../evidence-store.mjs';
import { contract, validateManifest, validatePairingReport, privateDirectory, readJson, writePrivate, acquireCraftProject } from './common.mjs';
import { validateReportRuntime, runtimeBinding } from './runtime.mjs';

const conversationSteps = ['open-model-picker','select-provider-model','type-memory-probe','send-web-message','observe-completed-turn','observe-reconnected-conversation'];
export function comparisonPlan(manifest, reports, store) {
  validateManifest(manifest);
  const brands = Object.keys(contract.brands), maps = new Map(), owners = new Map();
  for (const brand of brands) {
    const { pairing, conversations } = reports[brand] || {};
    validatePairingReport(pairing, manifest, brand);
    validateReportRuntime(conversations, manifest);
    if (conversations.brand !== brand || conversations.scope !== manifest.scope || conversations.runId !== manifest.runId ||
      conversations.rows?.length !== manifest.hosts.length * contract.providers.length) throw Error('Incomplete conversation comparison scope');
    if ([pairing, conversations].some(report => report.craftProject !== 'web-live/shared.cany')) throw Error('Comparisons require the same retained shared Craft project');
    const map = new Map();
    const collect = (ids, required, flow) => {
      const files = store.craft(ids, required);
      for (const id of ids) {
        const owner = brand + '/' + flow;
        if (owners.has(id) && owners.get(id) !== owner) throw Error('Craft evidence reused across comparison flows');
        owners.set(id, owner);
      }
      for (const file of files) {
        const value = store.read(file);
        if (value.operation !== 'web_walkthrough_record') continue;
        const signature = value.result.steps.map(step => step.step_id).join('+'), key = flow + '/' + signature;
        if (map.has(key)) throw Error('Ambiguous GUI action group in comparison');
        map.set(key, { id: value.id, file });
      }
    };
    collect(pairing.hostListEvidence, ['list-connected-hosts'], 'pair/host-list');
    for (const host of manifest.hosts) {
      collect(pairing.hosts.find(row => row.host === host.label).evidence,
        ['select-target','save-target','start-selected-target','connect-host','verify-connected-host','verify-reconnected-host'], 'pair/' + host.label);
      for (const provider of contract.providers) {
        const rows = conversations.rows.filter(row => row.host === host.label && row.provider === provider);
        if (rows.length !== 1) throw Error('Missing or duplicate host/provider conversation');
        const row = rows[0];
        if (row.status !== 'ui-completed-awaiting-tool-verification' || !row.agentId || !row.workspaceId ||
          !['activeAgentVerified','completionVisible','reconnected','reconnectedAgentVerified','reconnectedAnswerVisible'].every(key => row[key] === true)) throw Error('Unverified GUI conversation comparison');
        collect(row.evidence, conversationSteps, 'conversation/' + host.label + '/' + provider);
      }
    }
    maps.set(brand, map);
  }
  const plan = [];
  for (let i = 0; i < brands.length; i++) for (let j = i + 1; j < brands.length; j++) {
    const left = brands[i], right = brands[j], a = maps.get(left), b = maps.get(right);
    for (const flow of [...new Set([...a.keys(), ...b.keys()])].sort()) {
      plan.push({ left, right, flow, before: a.get(flow) || null, after: b.get(flow) || null });
    }
  }
  return plan;
}

export async function compare(env = process.env) {
  if (!path.isAbsolute(env.SMART_PARITY_EVIDENCE_DIR || '') || !path.isAbsolute(env.SMART_PARITY_CRAFT_CLI || '')) throw Error('Absolute evidence root and Craft CLI paths are required');
  const root = privateDirectory(env.SMART_PARITY_EVIDENCE_DIR), output = privateDirectory(path.join(root, 'web-live'));
  const manifest = validateManifest(readJson(env.SMART_PARITY_HOST_MANIFEST || path.join(root, 'browser-hosts.private.json')));
  const store = evidenceStore(root), reports = Object.fromEntries(Object.keys(contract.brands).map(brand => [brand, {
    pairing: store.read(`web-live/${brand}-hosts.json`), conversations: store.read(`web-live/${brand}-web-conversations.json`),
  }]));
  const plan = comparisonPlan(manifest, reports, store);
  const attempt = 'compare-' + Date.now() + '-' + crypto.randomUUID();
  const directory = privateDirectory(path.join(privateDirectory(path.join(output, 'attempts')), attempt));
  const report = { runId: manifest.runId, scope: manifest.scope, ...runtimeBinding(manifest), craftProject: 'web-live/shared.cany', attempt,
    complete: false, rows: [], note: 'Comparison execution is not functional equivalence. Retain differences and review independent semantic provider verification.' };
  const save = () => { writePrivate(path.join(directory, 'comparisons.json'), report); writePrivate(path.join(output, 'comparisons.json'), report); };
  const shared = acquireCraftProject(output);
  try {
    const craft = new Craft({ cli: env.SMART_PARITY_CRAFT_CLI, project: shared.project, outputDir: directory });
    for (const [index, item] of plan.entries()) {
      const row = { ...item, status: 'missing-corresponding-actions' }; report.rows.push(row);
      if (item.before && item.after) {
        row.status = 'running'; save();
        const value = await craft.compare(item.before, item.after, `comparison-${index}`);
        row.status = 'compared'; row.evidenceId = value.id;
        row.evidence = store.proof([path.relative(root, path.join(directory, `comparison-${index}.json`)), item.before.file, item.after.file]);
      }
      save();
    }
    report.complete = report.rows.length > 0 && report.rows.every(row => row.status === 'compared'); save();
    return report;
  } catch (error) { report.error = error.message; save(); throw error; }
  finally { shared.release(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const report = await compare();
  console.log(JSON.stringify({ complete: report.complete, comparisons: report.rows.length, scope: report.scope, note: report.note }));
  if (!report.complete) process.exitCode = 1;
}
