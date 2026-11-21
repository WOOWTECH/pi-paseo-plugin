#!/usr/bin/env python3
"""Install the pinned upstream Linux x86_64 CLI into a private test-tool directory."""
import hashlib
import io
import os
from pathlib import Path
import platform
import sys
import tarfile
import tempfile
import urllib.request

VERSION = '0.6.1'
URL = f'https://github.com/storytold/craft-anything/releases/download/v{VERSION}/craft-anything-{VERSION}-linux-x86_64.tar.gz'
ARCHIVE_SHA = '83ec0730c9117f399122b315c63ed4c3a8d31ac55bddd74cb8b33cd2f76ef704'
CLI_SHA = '48272fc45ba816c773eaf3d4bf82105d3157c3a61f53be640d949d95ddccf99b'

def install(directory):
    if platform.system() != 'Linux' or platform.machine() not in ('x86_64', 'amd64'):
        raise SystemExit('Run this verifier from the Linux x86_64 acceptance runner; target hosts may use any supported platform.')
    destination = Path(directory).resolve()
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    binary = destination / 'craft-anything-cli'
    if binary.exists() and hashlib.sha256(binary.read_bytes()).hexdigest() == CLI_SHA:
        print(binary)
        return
    with urllib.request.urlopen(URL, timeout=120) as response:
        archive = response.read(128 * 1024 * 1024 + 1)
    if hashlib.sha256(archive).hexdigest() != ARCHIVE_SHA:
        raise SystemExit('Upstream archive checksum mismatch; refusing installation')
    with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as package:
        matches = [m for m in package.getmembers() if m.isfile() and Path(m.name).name == 'craft-anything-cli']
        if len(matches) != 1 or matches[0].size > 128 * 1024 * 1024:
            raise SystemExit('Unexpected upstream archive layout')
        payload = package.extractfile(matches[0]).read()
    if hashlib.sha256(payload).hexdigest() != CLI_SHA:
        raise SystemExit('Upstream CLI checksum mismatch')
    with tempfile.NamedTemporaryFile(dir=destination, delete=False) as staged:
        staged.write(payload)
        temporary = staged.name
    try:
        os.chmod(temporary, 0o700)
        os.replace(temporary, binary)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    print(binary)

if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('Usage: setup-craft.py PRIVATE_TOOL_DIRECTORY')
    install(sys.argv[1])
