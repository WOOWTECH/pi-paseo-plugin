import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { findExecutable, runProcess } from './process.mjs';
import { RuntimeError, privateDirectory, assertSafePath } from './state.mjs';

const entry = fileURLToPath(import.meta.url);
const marker = 'PI_PASEO_CLAUDE_GATEWAY_STATE';
const codes = new Set(['OMNIGENT_GATEWAY_INVALID', 'OMNIGENT_GATEWAY_UNSUPPORTED', 'OMNIGENT_GATEWAY_CHANGED', 'OMNIGENT_GATEWAY_AUTH_FAILED']);

// Use Omnigent's own schema and interpreter. Inspection never expands credentials
// or runs auth_command. Only the invocation-local apiKeyHelper emits a credential,
// directly into Claude's private pipe; the command and token never enter config.
export const gatewayPython = String.raw`
import hashlib, json, os, selectors, shlex, signal, stat, subprocess, sys, time
from urllib.parse import urlsplit

def fail(code):
    raise RuntimeError(code)

def selected(config_file):
    import yaml
    from omnigent.onboarding.provider_config import get_default_provider
    info = os.stat(config_file)
    if not stat.S_ISREG(info.st_mode) or info.st_size > 1048576 or info.st_mode & 0o022 or info.st_uid not in (0, os.getuid()):
        fail('OMNIGENT_GATEWAY_INVALID')
    with open(config_file) as source:
        raw = yaml.safe_load(source) or {}
    if not isinstance(raw, dict):
        fail('OMNIGENT_GATEWAY_INVALID')
    provider = get_default_provider(raw, 'anthropic')
    if provider is None or provider.kind != 'gateway':
        return None
    family = provider.families.get('anthropic')
    if family is None or not family.auth_command:
        fail('OMNIGENT_GATEWAY_UNSUPPORTED')
    models = {}
    for tier, value in family.models.items():
        seen = set()
        while value in family.models and family.models[value] != value:
            if value in seen or len(seen) >= 32:
                fail('OMNIGENT_GATEWAY_INVALID')
            seen.add(value)
            value = family.models[value]
        if not isinstance(value, str) or not value or len(value) > 256 or any(ord(c) < 33 for c in value):
            fail('OMNIGENT_GATEWAY_INVALID')
        models[tier] = value
    if not models.get('default') or len(models) > 100:
        fail('OMNIGENT_GATEWAY_INVALID')
    base = os.path.expandvars(family.base_url)
    url = urlsplit(base)
    if url.scheme not in ('http', 'https') or not url.hostname or url.username or url.password or url.query or url.fragment or '$' in base or any(ord(c) < 33 for c in base):
        fail('OMNIGENT_GATEWAY_INVALID')
    if url.scheme != 'https' and url.hostname not in ('localhost', '127.0.0.1', '::1'):
        fail('OMNIGENT_GATEWAY_INVALID')
    # Hash routing inputs so changed defaults/endpoints cannot reuse stale picker
    # models or a helper attached to a previous provider. No secret is serialized.
    digest = hashlib.sha256(json.dumps([provider.name, base, family.auth_command, models], sort_keys=True).encode()).hexdigest()
    return {'mode': 'gateway', 'models': models, 'fingerprint': digest}, base, family.auth_command

def credential(command):
    # The existing, owner-controlled Omnigent shell command is the trust boundary.
    # Bound output/time, suppress stderr, and kill the whole helper group on error.
    child = subprocess.Popen(command, shell=True, executable='/bin/sh', cwd=os.environ['HOME'], env=os.environ.copy(), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
    data = bytearray()
    deadline = time.monotonic() + 20
    poller = selectors.DefaultSelector()
    poller.register(child.stdout, selectors.EVENT_READ)
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                fail('OMNIGENT_GATEWAY_AUTH_FAILED')
            if not poller.select(remaining):
                fail('OMNIGENT_GATEWAY_AUTH_FAILED')
            part = os.read(child.stdout.fileno(), 4097)
            if not part:
                break
            data.extend(part)
            if len(data) > 4096:
                fail('OMNIGENT_GATEWAY_AUTH_FAILED')
        if child.wait(timeout=max(0.01, deadline-time.monotonic())) != 0:
            fail('OMNIGENT_GATEWAY_AUTH_FAILED')
        token = bytes(data).decode().strip()
        if not token or any(c.isspace() or ord(c) < 33 for c in token):
            fail('OMNIGENT_GATEWAY_AUTH_FAILED')
        return token
    finally:
        poller.close()
        child.stdout.close()
        # Also reap descendants that inherited no stdout but outlived the helper.
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait()

def launch(binary, args, route, helper):
    metadata, base, _ = route
    models = metadata['models']
    env = os.environ.copy()
    for key in list(env):
        if key in ('ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'PI_PASEO_CLAUDE_GATEWAY_STATE') or key.startswith('ANTHROPIC_DEFAULT_'):
            env.pop(key, None)
    env['ANTHROPIC_BASE_URL'] = base
    env['ANTHROPIC_MODEL'] = models['default']
    env['CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS'] = '1'
    env['CLAUDE_CODE_API_KEY_HELPER_TTL_MS'] = '900000'
    for alias in ('opus', 'sonnet', 'haiku', 'fable'):
        env['ANTHROPIC_DEFAULT_' + alias.upper() + '_MODEL'] = models.get(alias, models['default'])
    # Merge the SDK's invocation-local settings instead of dropping tools/hooks.
    output, settings, has_model = [], {}, False
    index = 0
    while index < len(args):
        arg = args[index]
        if arg in ('--settings', '--model') or arg.startswith('--settings=') or arg.startswith('--model='):
            flag = arg.split('=', 1)[0]
            if '=' in arg:
                value = arg.split('=', 1)[1]
            else:
                index += 1
                if index >= len(args):
                    fail('OMNIGENT_GATEWAY_INVALID')
                value = args[index]
            if flag == '--settings':
                if not value.lstrip().startswith('{'):
                    with open(value) as source:
                        value = source.read(1048577)
                parsed = json.loads(value)
                if not isinstance(parsed, dict) or len(value) > 1048576:
                    fail('OMNIGENT_GATEWAY_INVALID')
                settings.update(parsed)
            else:
                value = models.get(value, value)
                if value not in models.values():
                    fail('OMNIGENT_GATEWAY_CHANGED')
                output.extend(['--model', value])
                has_model = True
        else:
            output.append(arg)
        index += 1
    if not has_model:
        output.extend(['--model', models['default']])
    settings['apiKeyHelper'] = helper
    output.extend(['--settings', json.dumps(settings, separators=(',', ':'))])
    os.execve(binary, [binary, *output], env)

def main():
    mode, config_file = sys.argv[1:3]
    route = selected(config_file)
    if mode == 'inspect':
        print(json.dumps(route[0] if route else {'mode': 'native'}))
        return
    if route is None or route[0]['fingerprint'] != sys.argv[3]:
        fail('OMNIGENT_GATEWAY_CHANGED')
    if mode == 'auth':
        sys.stdout.write(credential(route[2]))
    elif mode == 'launch':
        launch(sys.argv[4], sys.argv[6:], route, sys.argv[5])
    else:
        fail('OMNIGENT_GATEWAY_INVALID')

try:
    main()
except Exception as error:
    code = str(error) if isinstance(error, RuntimeError) and str(error) in ('OMNIGENT_GATEWAY_INVALID', 'OMNIGENT_GATEWAY_UNSUPPORTED', 'OMNIGENT_GATEWAY_CHANGED', 'OMNIGENT_GATEWAY_AUTH_FAILED') else 'OMNIGENT_GATEWAY_INVALID'
    if sys.argv[1] == 'inspect':
        print(json.dumps({'error': code}))
    else:
        print(code, file=sys.stderr)
        sys.exit(78)
`;

function interpreter(env) {
  // Pi Web prepends host command shims. A shim has no adjacent interpreter;
  // inspect later PATH entries for the installed uv/pip/venv entrypoint.
  for (const component of (env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const omnigent = findExecutable(path.resolve(component, 'omnigent'), env);
    if (!omnigent) continue;
    const directory = path.dirname(fs.realpathSync(omnigent));
    const python = findExecutable(path.join(directory, 'python'), env) || findExecutable(path.join(directory, 'python3'), env);
    if (python) return python;
  }
  throw new RuntimeError('OMNIGENT_GATEWAY_UNSUPPORTED');
}
export async function resolveClaudeGateway(loc, { env = process.env, run = runProcess } = {}) {
  const config = path.resolve(env.OMNIGENT_CONFIG_HOME || path.join(loc.home, '.omnigent'), 'config.yaml');
  if (!fs.existsSync(config)) return null;
  try {
    const python = interpreter(env);
    const metadata = JSON.parse(await run(python, ['-I', '-c', gatewayPython, 'inspect', config], { env, cwd: loc.home, timeoutMs: 15000, maxBytes: 65536 }));
    if (codes.has(metadata.error)) throw new RuntimeError(metadata.error);
    if (metadata.mode === 'native') return null;
    if (metadata.mode !== 'gateway' || !/^[a-f0-9]{64}$/.test(metadata.fingerprint) || !metadata.models?.default || Object.values(metadata.models).some(model => typeof model !== 'string' || !model || model.length > 256 || /\s|[\x00-\x1f]/.test(model))) throw new RuntimeError('OMNIGENT_GATEWAY_INVALID');
    return { python, config, fingerprint: metadata.fingerprint, models: metadata.models };
  } catch (error) {
    throw new RuntimeError(codes.has(error?.code) ? error.code : 'OMNIGENT_GATEWAY_INVALID');
  }
}
export function configureClaudeGateway(previous, gateway, binary, loc) {
  const config = { ...previous, env: { ...previous.env } };
  const saved = config.env[marker];
  if (saved) {
    let original;
    try { original = JSON.parse(saved); } catch { throw new RuntimeError('OMNIGENT_GATEWAY_INVALID'); }
    if (original.version !== 1) throw new RuntimeError('OMNIGENT_GATEWAY_INVALID');
    for (const key of ['models', 'additionalModels']) {
      if (Object.hasOwn(original, key)) config[key] = original[key];
      else delete config[key];
    }
    delete config.env[marker];
  }
  if (!gateway) return config;
  const original = { version: 1 };
  for (const key of ['models', 'additionalModels']) if (Object.hasOwn(config, key)) original[key] = config[key];
  config.env[marker] = JSON.stringify(original);
  config.models = [...new Set([gateway.models.default, ...Object.values(gateway.models)])].map(id => ({ id, label: id, description: 'Omnigent Claude gateway', isDefault: id === gateway.models.default }));
  config.additionalModels = [];
  config.command = [writeGatewayLauncher(gateway, binary, loc)];
  return config;
}

// Paseo's Claude SDK resolves only command[0] when launching a conversation.
// A single executable is required; argv prefixes work for probes but not chats.
function writeGatewayLauncher(gateway, binary, loc) {
  const argv = [process.execPath, entry, 'launch', gateway.python, gateway.config, gateway.fingerprint, path.resolve(binary)];
  const body = '#!/bin/sh\nexec ' + argv.map(quoteShell).join(' ') + ' "$@"\n';
  const digest = createHash('sha256').update(body).digest('hex');
  const directory = path.join(loc.home, '.local/share/pi-paseo/provider-gateways');
  privateDirectory(directory);
  const file = path.join(directory, `claude-${digest}.sh`);
  assertSafePath(file);
  if (fs.existsSync(file)) {
    if (fs.readFileSync(file, 'utf8') !== body) throw new RuntimeError('OMNIGENT_GATEWAY_INVALID');
  } else {
    const temp = file + '.' + randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temp, body, { mode: 0o700, flag: 'wx' });
      fs.renameSync(temp, file);
    } finally { fs.rmSync(temp, { force: true }); }
  }
  fs.chmodSync(file, 0o700);
  return file;
}

function quoteShell(value) { return "'" + value.replaceAll("'", "'\\''") + "'"; }
if (process.argv[1] && path.resolve(process.argv[1]) === entry) {
  try {
    const [mode, python, config, fingerprint, binary, ...args] = process.argv.slice(2);
    if (!['auth', 'launch'].includes(mode) || !path.isAbsolute(python || '') || !path.isAbsolute(config || '') || !/^[a-f0-9]{64}$/.test(fingerprint || '') || (mode === 'launch' && !path.isAbsolute(binary || ''))) throw new Error();
    const helper = [process.execPath, entry, 'auth', python, config, fingerprint].map(quoteShell).join(' ');
    const argv = ['-I', '-c', gatewayPython, mode, config, fingerprint, ...(mode === 'launch' ? [binary, helper, ...args] : [])];
    // Keep the provider PID, stdin/stdout protocol and Unix signals intact.
    process.execve(python, [python, ...argv], process.env);
  } catch {
    process.stderr.write('OMNIGENT_GATEWAY_INVALID\n');
    process.exitCode = 78;
  }
}
