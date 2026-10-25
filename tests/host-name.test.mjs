import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { readRecord, writeRecord } from '../src/onboarding.mjs';
import { RuntimeError } from '../src/state.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
// Optional installed-runtime integration; normal CI still asserts the strict
// daemon contract at the actual runtime writeConfig seam.
const actualConfig = process.env.PI_PASEO_TEST_PERSISTED_CONFIG
  ? await import(pathToFileURL(path.resolve(process.env.PI_PASEO_TEST_PERSISTED_CONFIG)).href) : null;
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'paseo-host-name-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const loc = { home, agentDir: path.join(home, 'agent'), stateDir: path.join(home, 'state'), paseoHome: path.join(home, 'daemon'), runtimeDir: path.join(home, 'runtime') };
  for (const dir of Object.values(loc)) fs.mkdirSync(dir, { recursive: true });
  const prefs = path.join(loc.stateDir, 'preferences.json');
  const configFile = path.join(loc.paseoHome, 'config.json');
  const calls = { status: 0, activate: 0, saves: 0 };
  const configRuntime = {
    locations: () => loc,
    status: async () => { calls.status++; throw Error('UNRELATED_DAEMON_FAILURE'); },
    activate: async () => { calls.activate++; throw Error('UNRELATED_ACTIVATION_FAILURE'); },
  };
  const providers = { claude: { enabled: true, command: ['/fixture/claude'], models: [{ id: 'gateway/model', label: 'gateway/model', isDefault: true }], additionalModels: [], env: { PI_PASEO_CLAUDE_GATEWAY_STATE: '{"version":1}' } } };
  const load = (relative, exposeWriteConfig = false) => {
    const file = path.join(root, relative);
    let source = fs.readFileSync(file, 'utf8').replaceAll('import.meta.url', JSON.stringify(pathToFileURL(file).href));
    if (exposeWriteConfig) source = source.replace('async function writeConfig(', 'export async function writeConfig(');
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: file + '.ts' }).outputText;
    const record = { exports: {} };
    const scopedRequire = spec => {
      if (spec === './runtime.mjs') return configRuntime;
      if (spec === './onboarding.mjs') return { readRecord, writeRecord, onboardingStatus: () => ({}) };
      if (spec === './state.mjs') return { locations: () => loc, RuntimeError, updateState: () => ({}) };
      if (spec === './provider-launchers.mjs') return { configureProviders: () => providers };
      if (spec === './runtime-layout.mjs') return { runtimeDirectory: () => loc.runtimeDir, RUNTIME_REVISION: 'fixture' };
      if (spec.endsWith('/config.js')) return { savePersistedConfig: (_home, config) => {
        // Paseo 0.11.2's daemon schema is strict and has no name/displayName key.
        // Exercise the actual writeConfig path, not a mock that accepts any JSON.
        assert.equal(Object.hasOwn(config.daemon, 'name'), false);
        assert.equal(Object.hasOwn(config.daemon, 'displayName'), false);
        calls.saves++;
        if (actualConfig) actualConfig.savePersistedConfig(_home, config);
        else writeRecord(configFile, config);
      } };
      if (spec.startsWith('./')) return {};
      return require(spec);
    };
    vm.runInNewContext(`(function(require,module,exports){${code}\n})`, { process: { env: {}, execPath: process.execPath }, setTimeout, clearTimeout }, { filename: file })(scopedRequire, record, record.exports);
    return record.exports;
  };
  return { loc, calls, prefs, configFile, providers, host: load('src/host-api.mjs'), runtime: load('src/runtime.mjs', true) };
}

test('display label saves independently of daemon health and is validated before writing', async t => {
  const f = fixture(t);
  for (const name of ['PI2', 'pi2', '中文 測試容器', 'A', '']) {
    const result = await f.host.saveConfig({ name });
    assert.equal(result.saved, true);
    assert.equal(readRecord(f.prefs).name, name || 'Pi Agent');
    assert.equal(fs.statSync(f.prefs).mode & 0o777, 0o600);
  }
  const previous = fs.readFileSync(f.prefs, 'utf8');
  for (const input of [{ name: 42 }, { name: null }, { name: [] }, { name: 'x'.repeat(101) }, { name: 'bad\nname' }, { name: 'bad\x7fname' }, { name: 'valid', unexpected: true }]) {
    await assert.rejects(f.host.saveConfig(input));
    assert.equal(fs.readFileSync(f.prefs, 'utf8'), previous);
  }
  assert.equal(f.calls.status, 0);
  assert.equal(f.calls.activate, 0);
});

test('every existing display name survives activation without entering the strict daemon schema', async t => {
  const f = fixture(t);
  for (const name of ['PI2', 'pi2', 'Pi Agent', '中文容器']) {
    writeRecord(f.prefs, { name, connection: 'relay' });
    await f.runtime.writeConfig(6769, {});
    const saved = readRecord(f.configFile);
    assert.equal(saved.daemon.listen, '127.0.0.1:6769');
    assert.deepEqual(saved.agents.providers, f.providers);
    assert.equal(readRecord(f.prefs).name, name);
  }
  assert.equal(f.calls.saves, 4);
});

test('activation repairs legacy daemon.name while preserving other daemon and preference settings', async t => {
  const f = fixture(t);
  writeRecord(f.configFile, { daemon: { name: 'LEGACY', appendSystemPrompt: 'keep', relay: { endpoint: 'relay.example.invalid:443' } } });
  writeRecord(f.prefs, { name: 'PI3', connection: 'relay' });
  await f.runtime.writeConfig(6769, {});
  const saved = readRecord(f.configFile);
  assert.equal(Object.hasOwn(saved.daemon, 'name'), false);
  assert.equal(saved.daemon.appendSystemPrompt, 'keep');
  assert.equal(saved.daemon.relay.endpoint, 'relay.example.invalid:443');
  assert.equal(readRecord(f.prefs).name, 'PI3');
});

test('malformed display preferences cannot poison provider activation and remain available for diagnosis', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.prefs, '{invalid-display-preferences', { mode: 0o600 });
  await f.runtime.writeConfig(6769, {});
  assert.equal(f.calls.saves, 1);
  assert.equal(fs.readFileSync(f.prefs, 'utf8'), '{invalid-display-preferences');
});
