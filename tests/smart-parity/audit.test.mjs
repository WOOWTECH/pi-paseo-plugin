import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { audit } from './audit.mjs';

test('a complete matrix passes integrity checks but missing, blocked and tampered evidence fails', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-connect-matrix-'));
  try {
    const contract = JSON.parse(fs.readFileSync(new URL('./contract.json', import.meta.url)));
    const payload = 'Synthetic validator test only; not product acceptance';
    fs.writeFileSync(path.join(dir, 'fixture.txt'), payload);
    const evidence = [{ path: 'fixture.txt', sha256: crypto.createHash('sha256').update(payload).digest('hex') }];
    const matrix = { platform: 'k3s-paas', scope: 'isolated-candidate', hosts: ['a', 'b'].map(id => ({ id, dataIdentity: `volume-${id}`, runtimeIdentity: 'test-image' })), results: [] };
    for (const host of matrix.hosts) {
      for (const name of contract.requiredHostCases) matrix.results.push({ host: host.id, case: name, status: 'pass', evidence });
      for (const brand of Object.keys(contract.brands)) {
        for (const name of contract.requiredHostBrandCases) matrix.results.push({ host: host.id, brand, case: name, status: 'pass', evidence });
        for (const provider of contract.providers) for (const name of contract.requiredProviderCases) matrix.results.push({ host: host.id, brand, provider, case: name, status: 'pass', evidence, ...(name === 'model-switch' ? { models: { initial: 'model-a', alternate: 'model-b', actual: 'model-b' } } : {}) });
      }
    }
    assert.equal(audit(matrix, dir).passed, true);
    matrix.hosts[0].id = '';
    assert.equal(audit(matrix, dir).passed, false);
    matrix.hosts[0].id = 'a';
    const model = matrix.results.find(row => row.case === 'model-switch');
    model.models.actual = 'model-a';
    assert.equal(audit(matrix, dir).passed, false);
    model.models.actual = 'model-b';
    model.models.alternate = 'model-a';
    assert.equal(audit(matrix, dir).passed, false);
    model.models.alternate = 'model-b';
    matrix.results[0].status = 'blocked';
    assert.equal(audit(matrix, dir).passed, false);
    matrix.results[0].status = 'pass';
    const removed = matrix.results.pop();
    assert.equal(audit(matrix, dir).missing.length, 1);
    matrix.results.push(removed);
    fs.writeFileSync(path.join(dir, 'fixture.txt'), 'changed');
    assert.equal(audit(matrix, dir).passed, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
