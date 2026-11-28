import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { legacyDesiredOff, LEGACY_INTENT_PASEO_VERSION } from '../src/legacy-intent.mjs';
import { LEGACY_PASEO_VERSION } from '../src/runtime-layout.mjs';

function stateDir(t, state) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-paseo-legacy-intent-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (state !== undefined) fs.writeFileSync(path.join(dir, 'state.json'), typeof state === 'string' ? state : JSON.stringify(state));
  return { stateDir: dir };
}

test('the legacy runtime version is the one runtime-layout knows', () => {
  assert.equal(LEGACY_INTENT_PASEO_VERSION, LEGACY_PASEO_VERSION);
});

test('#29: only an off recorded by a 0.11.2-era release counts as a legacy off', t => {
  assert.equal(legacyDesiredOff(stateDir(t, { version: 1, phase: 'disabled', desiredEnabled: false, installedVersion: '0.11.2' })), true);
  assert.equal(legacyDesiredOff(stateDir(t, { version: 1, phase: 'running', desiredEnabled: true, installedVersion: '0.11.2' })), false, 'enabled before the upgrade');
  assert.equal(legacyDesiredOff(stateDir(t, { version: 1, phase: 'disabled', desiredEnabled: false, installedVersion: '0.17.5' })), false, 'an off of a newer release');
  assert.equal(legacyDesiredOff(stateDir(t, { version: 1, phase: 'disabled', installedVersion: '0.11.2' })), false, 'no recorded wish');
  assert.equal(legacyDesiredOff(stateDir(t)), false, 'a fresh host has no state');
  assert.equal(legacyDesiredOff(stateDir(t, '{not json')), false, 'an unreadable state cannot tell');
  assert.equal(legacyDesiredOff(stateDir(t, 'null')), false);
});

test('#29: a state file that is a link is not read', t => {
  const target = stateDir(t, { version: 1, phase: 'disabled', desiredEnabled: false, installedVersion: '0.11.2' });
  const linked = stateDir(t);
  fs.symlinkSync(path.join(target.stateDir, 'state.json'), path.join(linked.stateDir, 'state.json'));
  assert.equal(legacyDesiredOff(linked), false);
});
