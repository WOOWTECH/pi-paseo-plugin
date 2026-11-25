import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONNECTION_TARGETS, connectionTarget, connectionPreferences, targetConfiguration, targetEnvironment, targetPairUrl } from '../src/connection-targets.mjs';
import { readRecord, writeRecord } from '../src/onboarding.mjs';
import { locations, readState, updateState, withRuntimeLock } from '../src/state.mjs';
import { saveConfig } from '../src/host-api.mjs';
import { pair } from '../src/runtime.mjs';
import { PASEO_VERSION } from '../src/runtime-layout.mjs';
import { loadPersistedConfig } from './helpers/paseo-config.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-connect-'));
  const old = process.env.PI_PASEO_STATE_DIR;
  process.env.PI_PASEO_STATE_DIR = dir;
  t.after(() => { if (old === undefined) delete process.env.PI_PASEO_STATE_DIR; else process.env.PI_PASEO_STATE_DIR = old; fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, preferences: path.join(dir, 'preferences.json'), pairing: path.join(dir, 'pairing.private.json') };
}

const offerFor = target => ({ v: 2, serverId: 'srv_test12345678', daemonPublicKeyB64: 'test-public-key', relay: { endpoint: target.relayEndpoint, useTls: true } });
const fragmentFor = offer => '#offer=' + Buffer.from(JSON.stringify(offer)).toString('base64url');

test('targets bind each trusted web app to its own TLS relay', () => {
  assert.equal(connectionTarget().id, 'paseo');
  for (const target of CONNECTION_TARGETS) {
    const env = targetEnvironment(target.id);
    const config = targetConfiguration({ daemon: { relay: { endpoint: 'wrong:443' }, cors: { allowedOrigins: ['https://local.example', 'https://smart.apporo.ai/'] } }, app: { baseUrl: 'https://wrong.example' } }, target.id);
    assert.equal(config.app.baseUrl, target.appUrl);
    assert.equal(config.daemon.relay.endpoint, target.relayEndpoint);
    assert.equal(config.daemon.relay.publicEndpoint, target.relayEndpoint);
    assert.equal(config.daemon.relay.useTls, true);
    assert.equal(env.PASEO_RELAY_ENDPOINT, target.relayEndpoint);
    assert.equal(env.PASEO_RELAY_PUBLIC_ENDPOINT, target.relayEndpoint);
    assert.equal(env.PASEO_RELAY_PUBLIC_USE_TLS, 'true');
    assert.equal(env.PASEO_APP_BASE_URL, target.appUrl);
    assert.equal(env.PI_PASEO_CONNECTION_TARGET, target.id);
    assert.deepEqual(config.daemon.cors.allowedOrigins, ['https://local.example', target.appUrl]);
  }
  for (const value of ['custom', '', 'Paseo', '__proto__', null, 1]) assert.throws(() => connectionTarget(value), { code: 'INVALID_TARGET' });
});

test('protected relay security stays the Paseo clients\' choice and is turned off for the Smart apps', () => {
  // A paired official client or `paseo daemon config` may have turned it on while Paseo was the target.
  for (const requireProtectedSecurity of [true, false, undefined]) {
    const config = { daemon: { relay: { enabled: true, ...(requireProtectedSecurity === undefined ? {} : { requireProtectedSecurity }) } } };
    assert.equal(targetConfiguration(config, 'paseo').daemon.relay.requireProtectedSecurity, requireProtectedSecurity);
    for (const target of ['woowtech', 'apporo']) assert.equal(targetConfiguration(config, target).daemon.relay.requireProtectedSecurity, false, target);
  }
  assert.deepEqual(CONNECTION_TARGETS.map(target => [target.id, target.protectedRelay]), [['paseo', true], ['woowtech', false], ['apporo', false]]);
});

test('pair links preserve the offer exactly and reject wrong brand, relay or TLS', () => {
  for (const target of CONNECTION_TARGETS) {
    const hash = fragmentFor(offerFor(target));
    assert.equal(targetPairUrl(target.appUrl + '/' + hash, target.id), target.appUrl + '/' + hash);
    for (const url of [target.appUrl + '.evil/' + hash, target.appUrl + '/welcome' + hash, target.appUrl + '/?redirect=evil' + hash, target.appUrl.replace('https:', 'http:') + '/' + hash, target.appUrl + '/#opaque']) assert.throws(() => targetPairUrl(url, target.id), { code: 'PAIRING_ORIGIN_INVALID' });
    for (const relay of [{ endpoint: 'other.example:443', useTls: true }, { endpoint: target.relayEndpoint, useTls: false }]) assert.throws(() => targetPairUrl(target.appUrl + '/' + fragmentFor({ ...offerFor(target), relay }), target.id), { code: 'PAIRING_TARGET_MISMATCH' });
    assert.throws(() => targetPairUrl(target.appUrl + '/#offer=e30', target.id), { code: 'PAIRING_TARGET_MISMATCH' });
  }
});

test('an offer that requires protected relay security is handed out for Paseo and refused for the Smart apps', () => {
  for (const target of CONNECTION_TARGETS) {
    for (const minimumSecurityMode of ['protected', 'future-mode']) {
      const url = target.appUrl + '/' + fragmentFor({ ...offerFor(target), minimumSecurityMode });
      if (target.id === 'paseo') assert.equal(targetPairUrl(url, target.id), url);
      else assert.throws(() => targetPairUrl(url, target.id), { code: 'PAIRING_SECURITY_UNSUPPORTED' });
    }
    // The other checks still come first: a wrong relay is a target mismatch whatever the security mode.
    assert.throws(() => targetPairUrl(target.appUrl + '/' + fragmentFor({ ...offerFor(target), relay: { endpoint: 'other.example:443', useTls: true }, minimumSecurityMode: 'protected' }), target.id), { code: 'PAIRING_TARGET_MISMATCH' });
  }
});

test('target saves preserve legacy preferences and invalidate stale pair and relay evidence', async t => {
  const f = fixture(t);
  writeRecord(f.preferences, { name: 'Existing', connection: 'relay', futurePreference: 42 });
  writeRecord(f.pairing, { url: 'private old offer' });
  updateState({ relayVerification: { verified: true }, pairingCreatedAt: 'old', activeTarget: 'paseo' });
  assert.equal(connectionPreferences(locations()).target, 'paseo');
  const saved = await saveConfig({ target: 'woowtech' });
  assert.deepEqual(saved, { saved: true, target: 'woowtech', configurationPending: true });
  assert.equal(readRecord(f.preferences).name, 'Existing');
  assert.equal(readRecord(f.preferences).futurePreference, 42);
  assert.equal(fs.existsSync(f.pairing), false);
  assert.equal(readState().relayVerification, null);
  assert.equal(readState().activeTarget, 'paseo');
  assert.equal(readState().configurationPending, true);
  await assert.rejects(pair(), { code: 'CONFIGURATION_PENDING' });
  await saveConfig({ name: 'Renamed' });
  assert.equal(readRecord(f.preferences).target, 'woowtech');
  assert.equal(readRecord(f.preferences).name, 'Renamed');
  assert.equal(fs.statSync(f.preferences).mode & 0o777, 0o600);
});

test('invalid target or name does not partially save settings or clear a pairing', async t => {
  const f = fixture(t);
  writeRecord(f.preferences, { name: 'Keep', target: 'apporo' });
  writeRecord(f.pairing, { url: 'keep-private' });
  const before = fs.readFileSync(f.preferences, 'utf8');
  for (const input of [{ target: 'custom', name: 'Changed' }, { target: null }, { target: undefined }, { target: 'paseo', name: 'bad\nname' }, { target: 'paseo', unknown: true }]) {
    await assert.rejects(saveConfig(input));
    assert.equal(fs.readFileSync(f.preferences, 'utf8'), before);
    assert.equal(fs.existsSync(f.pairing), true);
  }
});

test('settings save waits for the same runtime lock used by activation and pairing', async t => {
  const f = fixture(t);
  let release, entered;
  const blocked = new Promise(resolve => { release = resolve; });
  const held = new Promise(resolve => { entered = resolve; });
  const operation = withRuntimeLock(async () => { entered(); await blocked; });
  await held;
  let saved = false;
  const save = saveConfig({ target: 'apporo' }).then(result => { saved = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(saved, false);
  assert.equal(fs.existsSync(f.preferences), false);
  release(); await operation;
  assert.equal((await save).target, 'apporo');
});

// The vendored 0.17.4 persisted-config module, or an installed runtime's config.js / persisted-config.js
// named by PI_PASEO_TEST_PERSISTED_CONFIG (resolveConfigFromPersisted is checked when the module has it).
test('target config validates and resolves through the Paseo 0.17.4 config module', async t => {
  const f = fixture(t);
  const actual = process.env.PI_PASEO_TEST_PERSISTED_CONFIG
    ? await import(pathToFileURL(path.resolve(process.env.PI_PASEO_TEST_PERSISTED_CONFIG)).href) : await loadPersistedConfig(PASEO_VERSION);
  for (const target of CONNECTION_TARGETS) {
    const home = path.join(f.dir, target.id);
    fs.mkdirSync(home);
    actual.savePersistedConfig(home, targetConfiguration({ version: 1, daemon: { relay: { requireProtectedSecurity: true } } }, target.id));
    const config = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    assert.equal(config.daemon.relay.endpoint, target.relayEndpoint);
    assert.equal(config.daemon.relay.requireProtectedSecurity, target.protectedRelay);
    assert.equal(config.app.baseUrl, target.appUrl);
    if (actual.resolveConfigFromPersisted) {
      const resolved = actual.resolveConfigFromPersisted(home, config, { env: targetEnvironment(target.id) });
      assert.equal(resolved.relayEndpoint, target.relayEndpoint);
      assert.equal(resolved.relayPublicUseTls, true);
      assert.equal(resolved.appBaseUrl, target.appUrl);
    }
  }
});

test('agent collaboration is an explicit opt-in that leaves target, pairing and relay evidence alone', async t => {
  const f = fixture(t);
  writeRecord(f.preferences, { name: 'Existing', target: 'apporo', futurePreference: 7 });
  writeRecord(f.pairing, { url: 'keep-private' });
  updateState({ relayVerification: { verified: true }, activeTarget: 'apporo' });
  assert.equal(connectionPreferences(locations()).agentCollaboration, false);
  const saved = await saveConfig({ agentCollaboration: true });
  assert.deepEqual(saved, { saved: true, target: 'apporo', agentCollaboration: true, agentCollaborationApplied: 'next-start', configurationPending: false });
  assert.equal(connectionPreferences(locations()).agentCollaboration, true);
  assert.equal(readRecord(f.preferences).target, 'apporo');
  assert.equal(readRecord(f.preferences).futurePreference, 7);
  assert.equal(fs.existsSync(f.pairing), true);
  assert.deepEqual(readState().relayVerification, { verified: true });
  const before = fs.readFileSync(f.preferences, 'utf8');
  for (const agentCollaboration of ['true', 1, null, {}]) await assert.rejects(saveConfig({ agentCollaboration }));
  await assert.rejects(saveConfig({ agentCollaboration: false, target: 'custom' }));
  assert.equal(fs.readFileSync(f.preferences, 'utf8'), before);
});
