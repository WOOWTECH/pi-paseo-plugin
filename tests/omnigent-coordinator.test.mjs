import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HostInstallError, resolveOmnigentPackageRoot } from '../bin/install-host.mjs';

const source = 'git:github.com/WOOWTECH/pi-omnigent-plugin@v0.3.27';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-paseo-omni-root-'));
  const agentDir = path.join(root, 'agent');
  const installed = path.join(agentDir, 'git/github.com/WOOWTECH/pi-omnigent-plugin');
  const bundled = path.join(root, 'old-image-omni');
  fs.mkdirSync(agentDir);
  fs.mkdirSync(bundled);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root, agentDir, installed, bundled,
    settings(packages) { fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ packages })); },
    manifest(name = '@woowtech/pi-omnigent-plugin') {
      fs.mkdirSync(installed, { recursive: true });
      fs.writeFileSync(path.join(installed, 'package.json'), JSON.stringify({ name }));
    },
  };
}

test('registered GitHub Omnigent coordinator wins over the old image root', t => {
  const f = fixture(t);
  f.settings([source]);
  f.manifest();
  assert.equal(resolveOmnigentPackageRoot({ agentDir: f.agentDir, env: { PI_OMNIGENT_PLUGIN_ROOT: f.bundled } }), f.installed);
});

test('registered coordinator fails closed when its installation is missing or has a wrong manifest', t => {
  const f = fixture(t);
  f.settings([source]);
  assert.throws(() => resolveOmnigentPackageRoot({ agentDir: f.agentDir, env: { PI_OMNIGENT_PLUGIN_ROOT: f.bundled } }),
    error => error instanceof HostInstallError && error.code === 'OMNIGENT_COORDINATOR_UNAVAILABLE');
  f.manifest('wrong-package');
  assert.throws(() => resolveOmnigentPackageRoot({ agentDir: f.agentDir, env: { PI_OMNIGENT_PLUGIN_ROOT: f.bundled } }),
    error => error instanceof HostInstallError && error.code === 'OMNIGENT_COORDINATOR_INVALID');
});

test('disabled coordinator leaves the image root available', t => {
  const f = fixture(t);
  f.settings([{ source, extensions: [] }]);
  f.manifest();
  assert.equal(resolveOmnigentPackageRoot({ agentDir: f.agentDir, env: { PI_OMNIGENT_PLUGIN_ROOT: f.bundled } }), f.bundled);
});

test('an explicit coordinator root remains authoritative for the caller', t => {
  const f = fixture(t);
  f.settings([source]);
  assert.equal(resolveOmnigentPackageRoot({ agentDir: f.agentDir, explicitRoot: f.bundled }), f.bundled);
});

test('registered coordinator cannot resolve through an external symlink', t => {
  const f = fixture(t);
  f.settings([source]);
  fs.mkdirSync(path.dirname(f.installed), { recursive: true });
  fs.symlinkSync(f.bundled, f.installed);
  assert.throws(() => resolveOmnigentPackageRoot({ agentDir: f.agentDir, env: { PI_OMNIGENT_PLUGIN_ROOT: f.bundled } }),
    error => error instanceof HostInstallError && error.code === 'OMNIGENT_COORDINATOR_UNAVAILABLE');
});
