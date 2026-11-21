import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { assertWalkthrough } from './craft.mjs';

export function evidenceStore(directory) {
  const root = fs.realpathSync(directory);
  if ((fs.statSync(root).mode & 0o077) !== 0) throw new Error('Evidence directory must be private (mode 0700)');
  const resolve = relative => {
    if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw new Error('Invalid evidence path');
    const file = path.join(root, relative);
    if (fs.existsSync(file) && !fs.realpathSync(file).startsWith(root + path.sep)) throw new Error('Evidence escapes private root');
    return file;
  };
  const read = relative => {
    try { return JSON.parse(fs.readFileSync(resolve(relative), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const proof = files => [...new Set(files.filter(Boolean))].map(relative => {
    const file = resolve(relative);
    return fs.existsSync(file) ? { path: relative, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') } :
      { path: relative, sha256: null, missing: true };
  });
  // Never traverse persistent browser profiles or Craft's internal store.
  const exportedFiles = [];
  const collect = relative => {
    const dir = resolve(relative);
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.json') && !entry.name.endsWith('-schema.json')) exportedFiles.push(relative + '/' + entry.name);
    }
  };
  collect('web-live');
  const attempts = resolve('web-live/attempts');
  if (fs.existsSync(attempts)) for (const entry of fs.readdirSync(attempts, { withFileTypes: true })) {
    if (entry.isDirectory()) collect('web-live/attempts/' + entry.name);
  }
  const records = exportedFiles.map(file => ({ file, value: read(file) })).filter(x => x.value?.id);
  const craft = (ids, requiredSteps = []) => {
    if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length) throw new Error('Missing or duplicate Craft evidence IDs');
    const files = [], steps = new Set();
    for (const id of ids) {
      const matches = records.filter(x => x.value.id === id);
      if (typeof id !== 'string' || matches.length !== 1) throw new Error('Unresolved or ambiguous Craft evidence ID');
      const { file, value } = matches[0];
      const schemaFile = file.replace(/\.json$/, '-schema.json');
      if (read(schemaFile)?.result?.valid !== true || read(schemaFile)?.result?.steps !== value.result?.steps?.length || !value.result?.steps?.length) throw new Error('Missing Craft schema or action evidence');
      const actionIds = value.result.steps.map(step => step.step_id);
      if (actionIds.some(id => typeof id !== 'string' || !id) || new Set(actionIds).size !== actionIds.length) throw new Error('Invalid Craft step IDs');
      assertWalkthrough(value, actionIds);
      actionIds.forEach(step => steps.add(step)); files.push(file, schemaFile);
    }
    if (requiredSteps.some(step => !steps.has(step))) throw new Error('Required GUI actions missing from Craft evidence');
    return files;
  };
  return { root, read, proof, craft };
}

export function assertProviderIdentity({ backend, verifier, browser, provider, brand }) {
  if (!backend?.agentId || backend.agentId !== verifier?.agentId || backend.agentId !== browser?.agentId ||
    backend.provider !== provider || verifier.provider !== provider || browser.provider !== provider || backend.phase !== brand ||
    browser.targetModel !== verifier.targetModel) throw new Error('Mixed provider/browser evidence identities');
}
export function semanticWebPassed(verifier) {
  const required = ['actualProvider','completed','requestedModel','actualModel','modelChanged','freshMemoryRead','freshSkillRead',
    'freshSharedMemorySkillRead','freshGlobalMcpCall','freshMemoryWriteRead','freshMemoryWrite','persistedMemoryWrite','answered'];
  return verifier?.passed === true && required.every(key => verifier.checks?.[key] === true);
}

export function assertProviderRows(rows, providers) {
  if (rows == null) return;
  if (!Array.isArray(rows) || rows.some(row => !providers.includes(row.provider)) ||
    new Set(rows.map(row => row.provider)).size !== rows.length) throw new Error('Unknown or duplicate provider evidence');
}
