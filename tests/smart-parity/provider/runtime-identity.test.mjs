import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireRuntimeIdentity, requireEvidenceIdentity } from './acceptance-evidence.mjs';

const current = 'image:sha256:' + 'a'.repeat(64), stale = 'image:sha256:' + 'b'.repeat(64);
test('runtime identity requires typed full SHA256 provenance', () => {
  for (const value of [current, 'package-set:sha256:' + 'c'.repeat(64)]) assert.equal(requireRuntimeIdentity(value), value);
  for (const value of [undefined, null, '', 'latest', 'sha256:' + 'a'.repeat(64), 'image:sha256:abc', 'image:sha256:' + 'A'.repeat(64)]) assert.throws(() => requireRuntimeIdentity(value), /runtime identity/);
});
test('evidence requires the exact runtime, run, host and phase tuple', () => {
  const manifest = { runtimeIdentity: current, runId: 'run', hostLabel: 'hosta' }, evidence = { ...manifest, phase: 'woowtech' };
  assert.equal(requireEvidenceIdentity(manifest, evidence, 'woowtech'), current);
  for (const [field, value] of [['runtimeIdentity', stale], ['runtimeIdentity', undefined], ['runId', 'old-run'], ['hostLabel', 'hostb'], ['phase', 'paseo']]) assert.throws(() => requireEvidenceIdentity(manifest, { ...evidence, [field]: value }, 'woowtech'), /identity|ownership/);
});
test('provider entry points reject prior-image reports before connecting or writing', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-identity-'));
  try {
    fs.mkdirSync(path.join(home, 'woowtech'));
    const manifest = { runtimeIdentity: current, runId: 'run', hostLabel: 'hosta', workspaceRoot: home, root: '/sdk-must-not-be-loaded' };
    const file = path.join(home, 'manifest.json'), reportFile = path.join(home, 'woowtech/provider-acceptance.json');
    fs.writeFileSync(file, JSON.stringify(manifest));
    for (const runtimeIdentity of [stale, undefined]) {
      const report = JSON.stringify({ ...manifest, runtimeIdentity, phase: 'woowtech', agents: [], providers: [] });
      fs.writeFileSync(reportFile, report);
      for (const action of ['discover','run','isolation','cleanup']) {
        const result = spawnSync(process.execPath, [fileURLToPath(new URL('./run-provider-acceptance.mjs', import.meta.url)), file, action, 'woowtech'], { encoding: 'utf8', timeout: 10000 });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /runtime identity/);
        assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND/);
        assert.equal(fs.readFileSync(reportFile, 'utf8'), report);
      }
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
