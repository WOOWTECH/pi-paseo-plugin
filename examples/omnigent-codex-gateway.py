#!/usr/bin/env python3
"""Run Codex for Paseo with an existing Omnigent OpenAI Responses route.

The gateway credential stays in the child process environment. Only the
endpoint and model name are written to the dedicated Codex configuration.
"""

import json
import os
import pathlib
import re
import shlex
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit

import yaml


CONFIG_FILE = os.environ.get('PI_PASEO_OMNIGENT_CONFIG')
PROVIDER = os.environ.get('PI_PASEO_OMNIGENT_PROVIDER')
CODEX_BINARY = os.environ.get('PI_PASEO_CODEX_BINARY')
CODEX_HOME = pathlib.Path(os.environ.get('PI_PASEO_CODEX_HOME', str(pathlib.Path.home() / '.local/share/pi-paseo/codex-gateway-home')))
KEY_ENV = 'PI_PASEO_CODEX_GATEWAY_KEY'


def credential(command):
    args = shlex.split(command)
    env = os.environ.copy()
    while args and '=' in args[0] and not args[0].startswith('/'):
        name, value = args.pop(0).split('=', 1)
        if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', name):
            raise ValueError('invalid environment name')
        env[name] = value
    if not args or pathlib.Path(args[0]).name != 'pi' or args[1:3] != ['auth', 'print-api-key']:
        raise ValueError('unexpected credential command')
    result = subprocess.run(args, env=env, capture_output=True, text=True, timeout=20)
    key = result.stdout.strip()
    if result.returncode or not key or len(key) > 4096 or any(c.isspace() for c in key):
        raise ValueError('credential unavailable')
    return key


def write_config(base_url, model):
    parsed = urlsplit(base_url)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError('invalid gateway URL')
    if not isinstance(model, str) or not model or any(ord(c) < 32 for c in model):
        raise ValueError('invalid model')
    if not CODEX_HOME.is_absolute() or any(part.is_symlink() for part in (CODEX_HOME, *CODEX_HOME.parents)):
        raise ValueError('unsafe Codex home')
    CODEX_HOME.mkdir(parents=True, exist_ok=True, mode=0o700)
    CODEX_HOME.chmod(0o700)
    body = (
        'model_provider = "pi_paseo_gateway"\n'
        f'model = {json.dumps(model)}\n'
        '[model_providers.pi_paseo_gateway]\n'
        'name = "Pi Paseo gateway"\n'
        f'base_url = {json.dumps(base_url)}\n'
        f'env_key = "{KEY_ENV}"\n'
        'wire_api = "responses"\n'
        'requires_openai_auth = false\n'
        'supports_websockets = false\n'
    )
    target = CODEX_HOME / 'config.toml'
    if target.is_symlink():
        raise ValueError('unsafe Codex config')
    if target.exists() and target.read_text() == body:
        return
    with tempfile.NamedTemporaryFile(mode='w', dir=CODEX_HOME, prefix='.config-', delete=False) as temp:
        os.chmod(temp.name, 0o600)
        temp.write(body)
        temp.flush()
        os.fsync(temp.fileno())
        source = temp.name
    os.replace(source, target)


def main():
    if not CONFIG_FILE or not PROVIDER or not CODEX_BINARY:
        raise ValueError('gateway configuration missing')
    codex = pathlib.Path(CODEX_BINARY)
    if not codex.is_absolute() or not codex.is_file():
        raise ValueError('Codex executable unavailable')
    if sys.argv[1:] in (['--version'], ['--help']):
        os.execv(codex, [str(codex), *sys.argv[1:]])
    data = yaml.safe_load(pathlib.Path(CONFIG_FILE).read_text())
    route = data['providers'][PROVIDER]['openai']
    if route.get('wire_api') != 'responses':
        raise ValueError('expected Responses route')
    model = route['models']['default']
    key = credential(route['auth_command'])
    write_config(route['base_url'], model)
    env = os.environ.copy()
    env['CODEX_HOME'] = str(CODEX_HOME)
    env[KEY_ENV] = key
    os.execve(codex, [str(codex), *sys.argv[1:]], env)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('PASEO_CODEX_GATEWAY_UNAVAILABLE', file=sys.stderr)
        sys.exit(1)
