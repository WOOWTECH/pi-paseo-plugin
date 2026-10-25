import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveProviderLaunchers, configureProviders } from '../src/provider-launchers.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paseo-claude-gateway-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const loc = { home: root, agentDir: path.join(root, 'agent') };
  fs.mkdirSync(path.join(root, '.omnigent'));
  fs.writeFileSync(path.join(root, '.omnigent/config.yaml'), 'providers: {}', { mode: 0o600 });
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  for (const name of ['claude', 'codex', 'pi', 'omnigent', 'python']) fs.writeFileSync(path.join(bin, name), '#!/bin/sh\n', { mode: 0o700 });
  const env = { PATH: bin, HOME: root };
  const models = { default: 'gateway/large', sonnet: 'gateway/large', haiku: 'gateway/small' };
  const calls = [];
  const run = async (command, args) => {
    calls.push({ command, args });
    if (args.includes('--version')) return '1.2.3';
    return JSON.stringify({ mode: 'gateway', models, fingerprint: 'a'.repeat(64) });
  };
  return { root, loc, env, models, calls, run };
}

test('selected Omnigent Claude gateway replaces official model catalog without resolving credentials', async t => {
  const f = fixture(t);
  const launchers = await resolveProviderLaunchers(f.loc, { env: f.env, run: f.run });
  const config = configureProviders({}, launchers, f.loc, f.env);
  assert.deepEqual(config.claude.models?.map(m => m.id), ['gateway/large', 'gateway/small']);
  assert.equal(config.claude.models[0].isDefault, true);
  assert.equal(config.claude.command.length, 1, 'Claude SDK only consumes command[0]');
  assert.ok(fs.readFileSync(config.claude.command[0], 'utf8').includes('/claude-gateway.mjs'));
  assert.equal(fs.statSync(config.claude.command[0]).mode & 0o777, 0o700);
  assert.deepEqual(config.codex.command, [path.join(f.env.PATH, 'codex')]);
  assert.equal(f.calls.filter(c => c.args.includes('inspect')).length, 1);
});

import { spawnSync } from 'node:child_process';
import { resolveClaudeGateway, configureClaudeGateway } from '../src/claude-gateway.mjs';

function runtimeFixture(t) {
  const f = fixture(t);
  const python = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).stdout.trim();
  assert.ok(python, 'Python 3 is required for the Omnigent bridge contract fixture');
  const modules = path.join(f.root, 'modules');
  const providerDir = path.join(modules, 'omnigent/onboarding');
  fs.mkdirSync(providerDir, { recursive: true });
  fs.writeFileSync(path.join(modules, 'yaml.py'), 'import json\ndef safe_load(source):\n    return json.load(source)\n');
  fs.writeFileSync(path.join(providerDir, 'provider_config.py'), `
from types import SimpleNamespace
# Fixture for Omnigent's public schema contract; production imports the installed
# Omnigent implementation under Python -I rather than reimplementing defaults.
def get_default_provider(config, family):
    selected = []
    for name, raw in config.get('providers', {}).items():
        default = raw.get('default')
        serves = family in raw or (raw.get('kind') == 'subscription' and raw.get('cli') == 'claude' and family == 'anthropic')
        if serves and (default is True or default == family or isinstance(default, list) and family in default):
            families = {family: SimpleNamespace(**raw[family])} if family in raw else {}
            selected.append(SimpleNamespace(name=name, kind=raw['kind'], families=families))
    if len(selected) > 1:
        raise ValueError('PRIVATE_INVALID_CONFIG_DETAIL')
    return selected[0] if selected else None
`);
  // The executable mimics a venv interpreter. Add fixture modules in isolated
  // Python, then execute the exact production code, stdio and argv unchanged.
  fs.writeFileSync(path.join(f.env.PATH, 'python'), `#!${process.execPath}\nimport { spawnSync } from 'node:child_process';\nconst a=process.argv.slice(2);\nconst r=spawnSync(${JSON.stringify(python)}, ['-I','-c', ${JSON.stringify('import sys; sys.path.insert(0, ' + JSON.stringify(modules) + '); ')} + a[2], ...a.slice(3)], {stdio:'inherit',env:process.env});\nprocess.exit(r.status ?? 1);\n`, { mode: 0o700 });
  const secret = 'FAKE_GATEWAY_SECRET';
  const credentialFile = path.join(f.root, 'credential-helper');
  const countFile = path.join(f.root, 'credential-count');
  fs.writeFileSync(credentialFile, '#!/bin/sh\nprintf x >> "$FIXTURE_AUTH_COUNT"\nprintf %s "$FIXTURE_SECRET"\n', { mode: 0o700 });
  const configFile = path.join(f.root, '.omnigent/config.yaml');
  const raw = { providers: {
    official: { kind: 'subscription', cli: 'claude' },
    'selected-gateway': { kind: 'gateway', default: ['anthropic'], anthropic: {
      base_url: 'https://gateway.example.invalid/anthropic', auth_command: JSON.stringify(credentialFile),
      models: { default: 'large', large: 'gateway/large', sonnet: 'large', haiku: 'gateway/small' },
    } },
  } };
  const save = () => fs.writeFileSync(configFile, JSON.stringify(raw), { mode: 0o600 }); save();
  const fakeClaude = path.join(f.root, 'fake-claude.mjs');
  fs.writeFileSync(fakeClaude, `#!${process.execPath}
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import readline from 'node:readline';
const args=process.argv.slice(2);
if(args.includes('--version')) { process.stdout.write('2.1.270\\n'); process.exit(0); }
const settings=JSON.parse(args[args.indexOf('--settings')+1]);
const cred=spawnSync('/bin/sh',['-c',settings.apiKeyHelper],{env:process.env,encoding:'utf8'});
if(cred.status!==0) { process.stderr.write(cred.stderr); process.exit(78); }
if(cred.stdout!==process.env.FIXTURE_SECRET) { process.stderr.write('WRONG_FAKE_CREDENTIAL'); process.exit(1); }
const clean=!['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN','CLAUDE_CODE_USE_BEDROCK'].some(k=>process.env[k]);
process.stdout.write(JSON.stringify({ready:true,clean,home:process.env.HOME,base:process.env.ANTHROPIC_BASE_URL,model:args[args.indexOf('--model')+1],haiku:process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,opus:process.env.ANTHROPIC_DEFAULT_OPUS_MODEL,settingsKeys:Object.keys(settings),hook:settings.hooks?.fixture})+'\\n');
let first;
for await(const line of readline.createInterface({input:process.stdin})) {
 const message=JSON.parse(line); first??=message.text;
 process.stdout.write(JSON.stringify({reply:message.followup?first:message.text})+'\\n');
}
`, { mode: 0o700 });
  Object.assign(f.env, { PATH: f.env.PATH + ':/usr/bin:/bin', FIXTURE_SECRET: secret, FIXTURE_AUTH_COUNT: countFile });
  return { ...f, raw, save, configFile, fakeClaude, secret, countFile, credentialFile };
}

async function launchFixture(f, args = [], input = '') {
  const gateway = await resolveClaudeGateway(f.loc, { env: f.env });
  const configured = configureClaudeGateway({ env: {} }, gateway, f.fakeClaude, f.loc);
  return { gateway, configured, result: spawnSync(configured.command[0], [...configured.command.slice(1), ...args], { input, env: { ...f.env, ANTHROPIC_API_KEY: 'OLD_API', ANTHROPIC_AUTH_TOKEN: 'OLD_TOKEN', CLAUDE_CODE_OAUTH_TOKEN: 'OLD_OAUTH', CLAUDE_CODE_USE_BEDROCK: '1' }, cwd: f.root, encoding: 'utf8', timeout: 15000 }) };
}

test('real wrapper resolves aliases and helper in memory, forwards two turns, preserves SDK settings and official files', async t => {
  const f = runtimeFixture(t);
  fs.mkdirSync(path.join(f.root, '.claude'));
  const credentials = path.join(f.root, '.claude/.credentials.json');
  const original = '{"fixture":"OFFICIAL_AUTH_UNCHANGED"}'; fs.writeFileSync(credentials, original, { mode: 0o600 });
  const configBefore = fs.readFileSync(f.configFile, 'utf8');
  const gateway = await resolveClaudeGateway(f.loc, { env: f.env });
  assert.equal(fs.existsSync(f.countFile), false, 'discovery must never mint credentials');
  assert.equal(gateway.models.default, 'gateway/large');
  const { configured, result } = await launchFixture(f, ['--settings', '{"hooks":{"fixture":"preserved"}}', '--model', 'haiku'], '{"text":"remember-this"}\n{"followup":true}\n');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const [ready, first, second] = result.stdout.trim().split('\n').map(s => JSON.parse(s));
  assert.equal(ready.clean, true);
  assert.equal(ready.home, f.loc.home);
  assert.equal(ready.model, 'gateway/small');
  assert.equal(ready.haiku, 'gateway/small');
  assert.equal(ready.opus, 'gateway/large');
  assert.equal(ready.hook, 'preserved');
  assert.deepEqual(first, { reply: 'remember-this' });
  assert.deepEqual(second, first);
  assert.equal(fs.readFileSync(f.countFile, 'utf8'), 'x');
  assert.equal(fs.readFileSync(credentials, 'utf8'), original);
  assert.equal(fs.readFileSync(f.configFile, 'utf8'), configBefore);
  for (const view of [configured, gateway, result.stdout, result.stderr]) assert.equal(JSON.stringify(view).includes(f.secret), false);
  assert.equal(JSON.stringify(configured).includes(f.credentialFile), false, 'configured auth command must never be persisted');
  const launcher = fs.readFileSync(configured.command[0], 'utf8');
  assert.equal(launcher.includes(f.secret), false);
  assert.equal(launcher.includes(f.credentialFile), false);
  assert.equal(launcher.includes('gateway.example.invalid'), false);
});

test('gateway-to-official switch restores original model overrides and native launcher with original auth env intact', async t => {
  const f = runtimeFixture(t);
  const before = { claude: { env: { CLAUDE_CODE_OAUTH_TOKEN: 'OWN_OFFICIAL_ENV' }, models: [{ id: 'official', label: 'Official' }], additionalModels: [{ id: 'extra', label: 'Extra' }] } };
  const gateway = await resolveClaudeGateway(f.loc, { env: f.env });
  const launchers = { claude: { startup: 'ready', command: f.fakeClaude, gateway }, codex: { startup: 'missing' }, pi: { startup: 'missing' } };
  const enabled = configureProviders(before, launchers, f.loc, f.env);
  assert.deepEqual(enabled.claude.models.map(m=>m.id), ['gateway/large', 'gateway/small']);
  assert.deepEqual(enabled.claude.additionalModels, []);
  assert.deepEqual(configureProviders(enabled, launchers, f.loc, f.env), enabled, 'activation must be idempotent');
  delete f.raw.providers['selected-gateway'].default;
  f.raw.providers.official.default = true; f.save();
  assert.equal(await resolveClaudeGateway(f.loc, { env: f.env }), null);
  delete launchers.claude.gateway;
  const official = configureProviders(enabled, launchers, f.loc, f.env);
  assert.deepEqual(official.claude.command, [f.fakeClaude]);
  assert.deepEqual(official.claude.models, before.claude.models);
  assert.deepEqual(official.claude.additionalModels, before.claude.additionalModels);
  assert.equal(official.claude.env.CLAUDE_CODE_OAUTH_TOKEN, 'OWN_OFFICIAL_ENV');
  assert.equal(official.claude.env.PI_PASEO_CLAUDE_GATEWAY_STATE, undefined);
  assert.equal(fs.existsSync(f.countFile), false);
});

test('stale selected provider fails closed before executing credential command or changing route', async t => {
  const f = runtimeFixture(t);
  const gateway = await resolveClaudeGateway(f.loc, { env: f.env });
  const configured = configureClaudeGateway({ env: {} }, gateway, f.fakeClaude, f.loc);
  f.raw.providers['selected-gateway'].anthropic.base_url = 'https://changed.example.invalid'; f.save();
  const result = spawnSync(configured.command[0], configured.command.slice(1), { env: f.env, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 78);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'OMNIGENT_GATEWAY_CHANGED\n');
  assert.equal(fs.existsSync(f.countFile), false);
});

test('auth failures redact stdout, stderr and underlying command error details', async t => {
  const f = runtimeFixture(t);
  fs.writeFileSync(f.credentialFile, '#!/bin/sh\nprintf %s "$FIXTURE_SECRET"\nprintf %s "$FIXTURE_SECRET" >&2\nexit 1\n', { mode: 0o700 });
  const { result } = await launchFixture(f);
  assert.equal(result.status, 78);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'OMNIGENT_GATEWAY_AUTH_FAILED\n');
});

test('gateway parser rejects ambiguous defaults, unsafe URL, cycles, absent model and world-writable config', async t => {
  for (const change of [
    f => { f.raw.providers.official.default = true; },
    f => { f.raw.providers['selected-gateway'].anthropic.base_url = 'http://remote.example.invalid'; },
    f => { f.raw.providers['selected-gateway'].anthropic.models = { default: 'a', a: 'b', b: 'a' }; },
    f => { f.raw.providers['selected-gateway'].anthropic.models = { sonnet: 'gateway/large' }; },
    f => { fs.chmodSync(f.configFile, 0o666); },
  ]) {
    const f = runtimeFixture(t); change(f); f.save();
    await assert.rejects(resolveClaudeGateway(f.loc, { env: f.env }), { code: 'OMNIGENT_GATEWAY_INVALID' });
    assert.equal(fs.existsSync(f.countFile), false);
  }
});

test('gateway with inline key is explicitly unsupported instead of copying a credential or claiming official authentication', async t => {
  const f = runtimeFixture(t);
  f.raw.providers['selected-gateway'].anthropic.auth_command = null;
  f.raw.providers['selected-gateway'].anthropic.api_key = f.secret;
  f.save();
  await assert.rejects(resolveClaudeGateway(f.loc, { env: f.env }), { code: 'OMNIGENT_GATEWAY_UNSUPPORTED' });
  assert.equal(fs.existsSync(f.countFile), false);
});

test('missing config preserves ordinary Claude launch and unselected gateway does not resolve secrets', async t => {
  const f = runtimeFixture(t);
  delete f.raw.providers['selected-gateway'].default;
  f.raw.providers.official.default = 'anthropic'; f.save();
  assert.equal(await resolveClaudeGateway(f.loc, { env: f.env }), null);
  fs.unlinkSync(f.configFile);
  assert.equal(await resolveClaudeGateway(f.loc, { env: f.env }), null);
  assert.equal(fs.existsSync(f.countFile), false);
});


test('single executable supports Paseo version probes without invoking the auth helper', async t => {
  const f = runtimeFixture(t);
  const { configured, result } = await launchFixture(f, ['--version']);
  assert.equal(configured.command.length, 1);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '2.1.270\n');
  assert.equal(fs.existsSync(f.countFile), false);
});

test('oversized credential output is rejected without forwarding any token bytes', async t => {
  const f = runtimeFixture(t);
  fs.writeFileSync(f.credentialFile, '#!/bin/sh\nprintf %05000d 0\n', { mode: 0o700 });
  const { result } = await launchFixture(f);
  assert.equal(result.status, 78);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'OMNIGENT_GATEWAY_AUTH_FAILED\n');
});

test('host command shims before the real Omnigent venv do not disable Claude after restart',async t=>{
 const f=fixture(t),shim=path.join(f.root,'host-shims');fs.mkdirSync(shim);
 fs.writeFileSync(path.join(shim,'omnigent'),'#!/bin/sh\nexit 91\n',{mode:0o700});
 const gateway=await resolveClaudeGateway(f.loc,{env:{...f.env,PATH:shim+path.delimiter+f.env.PATH},run:f.run});
 assert.equal(gateway.python,path.join(f.env.PATH,'python'));
 assert.equal(gateway.models.default,'gateway/large');
 assert.equal(f.calls.some(c=>c.command===path.join(shim,'omnigent')),false);
});
