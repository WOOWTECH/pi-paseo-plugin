import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const contract = JSON.parse(fs.readFileSync(new URL('./contract.json', import.meta.url)));
const key = row => [row.host, row.brand || '', row.provider || '', row.case].join('/');

export function audit(manifest, evidenceDirectory) {
  const problems = [];
  if (!contract.platforms.includes(manifest.platform)) problems.push('Unknown declared platform');
  const hosts = manifest.hosts || [];
  if (hosts.length < contract.minimumIndependentHosts || new Set(hosts.map(h => h.id)).size !== hosts.length) problems.push('At least two distinct hosts are required');
  if (hosts.some(h => !h.dataIdentity || !h.runtimeIdentity) || new Set(hosts.map(h => h.dataIdentity)).size !== hosts.length) problems.push('Hosts need independent data identities and recorded runtimes');
  if (!['isolated-candidate', 'existing-production'].includes(manifest.scope)) problems.push('Declare isolated-candidate or existing-production scope');
  const base = fs.realpathSync(evidenceDirectory);
  const rows = new Map();
  for (const row of manifest.results || []) {
    const id = key(row);
    if (rows.has(id)) { problems.push(`Duplicate result: ${id}`); continue; }
    rows.set(id, row);
    if (!contract.resultStates.includes(row.status)) problems.push(`Invalid result state: ${id}`);
    if (row.status !== 'pass') continue;
    if (!Array.isArray(row.evidence) || !row.evidence.length) { problems.push(`No evidence: ${id}`); continue; }
    for (const item of row.evidence) {
      try {
        if (!item.path || path.isAbsolute(item.path) || item.path.split(/[\\/]/).includes('..')) throw new Error('invalid path');
        const file = fs.realpathSync(path.join(base, item.path));
        if (!file.startsWith(base + path.sep)) throw new Error('outside evidence directory');
        const digest = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
        if (digest !== item.sha256) throw new Error('checksum mismatch');
      } catch {
        problems.push(`Missing or changed evidence for ${id}`);
      }
    }
  }
  const required = [];
  for (const host of hosts) {
    for (const test of contract.requiredHostCases) required.push({ host: host.id, case: test });
    for (const brand of Object.keys(contract.brands)) {
      for (const test of contract.requiredHostBrandCases) required.push({ host: host.id, brand, case: test });
      for (const provider of contract.providers) {
        for (const test of contract.requiredProviderCases) required.push({ host: host.id, brand, provider, case: test });
      }
    }
  }
  const missing = required.filter(row => !rows.has(key(row))).map(key);
  const unsuccessful = required.filter(row => rows.has(key(row)) && rows.get(key(row)).status !== 'pass').map(row => ({ id: key(row), status: rows.get(key(row)).status }));
  const expected = new Set(required.map(key));
  for (const id of rows.keys()) if (!expected.has(id)) problems.push(`Unknown case: ${id}`);
  return {
    platform: manifest.platform, scope: manifest.scope,
    passed: problems.length === 0 && missing.length === 0 && unsuccessful.length === 0,
    requiredCases: required.length, recordedCases: rows.size, problems, missing, unsuccessful,
    note: 'This checks completeness and evidence integrity. Review actual semantic assertions and tool events; it does not establish their truth from a status label.',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const file = process.argv[2];
  if (!file) throw new Error('Usage: audit.mjs PRIVATE_EVIDENCE_DIRECTORY/matrix.json');
  const result = audit(JSON.parse(fs.readFileSync(file)), path.dirname(path.resolve(file)));
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
}
