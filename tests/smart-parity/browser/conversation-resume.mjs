import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { evidenceStore } from '../evidence-store.mjs';
import { contract, validateManifest, validateJobs } from './common.mjs';
import { runtimeBinding, validateReportRuntime } from './runtime.mjs';

const requiredSteps = ['open-model-picker', 'select-provider-model', 'type-memory-probe',
  'send-web-message', 'observe-completed-turn', 'observe-reconnected-conversation'];
const completedFlags = ['activeAgentVerified', 'completionVisible', 'reconnected',
  'reconnectedAgentVerified', 'reconnectedAnswerVisible'];
const identityFields = ['host', 'provider', 'agentId', 'workspaceId', 'targetModel'];
const preMutationErrors = new Set([
  'Ambiguous model selector DOM; bind the active agent before recording',
  'Ambiguous composer DOM; bind the active agent before recording',
]);
const requireValue = (condition, message) => { if (!condition) throw Error('Unsafe conversation resume: ' + message); };
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

// Read-only checks: never chmod, rewrite, or follow an evidence symlink.
function privatePath(root, file, directory = false) {
  const relative = path.relative(root, file);
  requireValue(relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative), 'path escapes evidence root');
  const paths = [root];
  for (const part of relative.split(path.sep).filter(Boolean)) paths.push(path.join(paths.at(-1), part));
  for (const [index, current] of paths.entries()) {
    const stat = fs.lstatSync(current), isDirectory = index < paths.length - 1 || directory;
    requireValue(!stat.isSymbolicLink() && (isDirectory ? stat.isDirectory() : stat.isFile()), 'evidence must be real files/directories');
    requireValue((stat.mode & 0o077) === 0 && (typeof process.getuid !== 'function' || stat.uid === process.getuid()), 'evidence must be private and owned');
    if (!isDirectory) requireValue(stat.nlink === 1 && (stat.mode & 0o111) === 0, 'evidence file must not be linked or executable');
  }
}
function readPrivate(root, file) {
  privatePath(root, file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd), raw = fs.readFileSync(fd), after = fs.fstatSync(fd);
    requireValue(before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs, 'evidence changed while reading');
    return raw;
  } finally { fs.closeSync(fd); }
}

export function loadConversationResume(config, jobs, resumeFile) {
  if (resumeFile === undefined || resumeFile === null || resumeFile === '') return { rows: [], resumeFrom: null };
  requireValue(typeof resumeFile === 'string' && !resumeFile.split(/[\\/]/).includes('..'), 'invalid resume file');
  requireValue(path.isAbsolute(config.root) && path.resolve(config.root) === fs.realpathSync(config.root), 'evidence root must be a real absolute directory');
  const root = path.resolve(config.root), output = path.join(root, 'web-live');
  requireValue(config.output === output && Object.hasOwn(contract.brands, config.brand), 'unexpected output directory or brand');
  validateManifest(config.manifest);
  validateJobs(jobs, config.manifest, config.brand);
  const file = path.resolve(root, resumeFile), raw = readPrivate(root, file), report = JSON.parse(raw);
  requireValue(report && typeof report === 'object' && !Array.isArray(report), 'invalid original report');
  requireValue(typeof report.attempt === 'string' && new RegExp(`^${config.brand}-conversations-[0-9]+-[a-f0-9-]{36}$`).test(report.attempt), 'invalid original attempt');
  const attemptDirectory = path.join(output, 'attempts', report.attempt);
  requireValue(file === path.join(attemptDirectory, config.brand + '-web-conversations.json') &&
    report.attemptDirectory === path.relative(root, attemptDirectory), 'resume must use the immutable original attempt report');
  requireValue(report.brand === config.brand && report.runId === config.manifest.runId && report.scope === config.manifest.scope, 'stale brand/run/scope');
  validateReportRuntime(report, config.manifest);
  requireValue(report.runtime && report.runtimeIdentity === runtimeBinding(config.manifest).runtimeIdentity &&
    JSON.stringify(runtimeBinding(report)) === JSON.stringify(runtimeBinding(config.manifest)), 'stale runtime');
  requireValue(report.craftProject === 'web-live/shared.cany', 'resume needs the retained shared Craft project');
  privatePath(root, path.join(root, report.craftProject), true);
  requireValue(!Object.hasOwn(report, 'resumeFrom'), 'recursive resume is forbidden');
  requireValue(report.uiCompleted !== true && Array.isArray(report.rows) && report.rows.length > 0, 'no unfinished original prefix');
  const expected = jobs.flatMap(group => group.jobs.map(job => ({ host: group.hostLabel,
    provider: job.provider, agentId: job.agentId, workspaceId: group.workspaceId, targetModel: job.targetModel })));
  requireValue(new Set(expected.map(row => row.agentId)).size === expected.length && report.rows.length <= expected.length, 'duplicate agents or excess rows');
  const store = evidenceStore(root), usedEvidence = new Set(), completed = [];
  let running = false;
  for (const [index, row] of report.rows.entries()) {
    requireValue(row && identityFields.every(key => row[key] === expected[index][key]), 'job order/identity changed');
    if (row.status === 'running') {
      const allowed = new Set([...identityFields, 'status', 'evidence', 'activeAgentVerified']);
      requireValue(index === report.rows.length - 1 && !running && preMutationErrors.has(report.error) &&
        Array.isArray(row.evidence) && row.evidence.length === 0 && Object.keys(row).every(key => allowed.has(key)) &&
        (!Object.hasOwn(row, 'activeAgentVerified') || row.activeAgentVerified === true), 'partial row may have mutated the conversation');
      running = true;
      continue;
    }
    requireValue(!running && row.status === 'ui-completed-awaiting-tool-verification' &&
      completedFlags.every(key => row[key] === true) && nonempty(row.beforeLabel) && nonempty(row.afterLabel) &&
      row.beforeLabel.trim() !== row.afterLabel.trim(), 'completed prefix lacks GUI proof');
    const files = store.craft(row.evidence, requiredSteps), actualSteps = [];
    for (const id of row.evidence) {
      requireValue(!usedEvidence.has(id), 'Craft evidence reused across rows');
      usedEvidence.add(id);
    }
    for (const relative of files) {
      const proof = path.join(root, relative);
      requireValue(path.dirname(proof) === attemptDirectory &&
        path.basename(proof).startsWith(`${config.brand}-${row.host}-${row.provider}-`), 'Craft proof belongs to another attempt/job');
      const value = JSON.parse(readPrivate(root, proof));
      if (value.operation === 'web_walkthrough_record') actualSteps.push(...value.result.steps.map(step => step.step_id).filter(id => requiredSteps.includes(id)));
    }
    requireValue(JSON.stringify(actualSteps) === JSON.stringify(requiredSteps), 'Craft actions missing, duplicated or reordered');
    completed.push(structuredClone(row));
  }
  requireValue(completed.length < expected.length, 'all jobs completed; replay is forbidden');
  requireValue(running || !Object.hasOwn(report, 'error'), 'unknown interruption cannot be resumed');
  return { rows: completed, resumeFrom: { attempt: report.attempt, file: path.relative(root, file),
    sha256: crypto.createHash('sha256').update(raw).digest('hex') } };
}
