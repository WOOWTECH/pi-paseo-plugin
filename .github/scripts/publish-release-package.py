"""Publish immutable npm assets for an existing public release at its exact tag."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import urllib.parse
import urllib.request


def main():
    tag = os.environ['RELEASE_TAG']
    if not re.fullmatch(r'v[0-9]+\.[0-9]+\.[0-9]+', tag):
        raise ValueError('A stable semantic version tag is required')
    repo = os.environ['GITHUB_REPOSITORY']
    if repo != 'WOOWTECH/pi-paseo-plugin':
        raise ValueError('Unexpected release repository')
    root = Path(os.environ['RELEASE_SOURCE']).resolve()
    package = json.loads((root / 'package.json').read_text())
    if package['name'] != '@woowtech/pi-paseo' or 'v' + package['version'] != tag:
        raise ValueError('Package version does not match the tag')
    headers = {'Authorization': 'Bearer ' + os.environ['GITHUB_TOKEN'],
               'Accept': 'application/vnd.github+json'}
    base = 'https://api.github.com/repos/' + repo

    def api(path, data=None):
        request = urllib.request.Request(base + path, headers=headers, data=data)
        with urllib.request.urlopen(request, timeout=45) as response:
            return json.load(response)

    commit = api('/commits/' + tag)['sha']
    checked_out = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
    if checked_out != commit:
        raise ValueError('Checkout does not match the published tag')
    release = api('/releases/tags/' + tag)
    if release['draft'] or release['prerelease'] or release['tag_name'] != tag:
        raise ValueError('A published stable release is required')
    subprocess.run(['node', 'scripts/check-package.mjs'], cwd=root, check=True)
    with tempfile.TemporaryDirectory(prefix='paseo-release-') as directory:
        pack = json.loads(subprocess.check_output([
            'npm', 'pack', '--ignore-scripts', '--json', '--pack-destination', directory,
        ], cwd=root, text=True))[0]
        expected = 'woowtech-pi-paseo-' + package['version'] + '.tgz'
        if pack['filename'] != expected:
            raise ValueError('Unexpected package archive name')
        data = (Path(directory) / expected).read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        checksum = (digest + '  ' + expected + '\n').encode()
        assets = [(expected, data), ('SHA256SUMS', checksum)]
        # Validate every existing asset before attempting any upload. Never
        # delete, replace or silently accept conflicting release content.
        missing = []
        for name, body in assets:
            existing = next((item for item in release['assets'] if item['name'] == name), None)
            if existing:
                with urllib.request.urlopen(existing['browser_download_url'], timeout=45) as response:
                    if response.read() != body:
                        raise ValueError('Existing release asset differs: ' + name)
            else:
                missing.append((name, body))
        dry_run = os.environ.get('PUBLISH_DRY_RUN') == '1'
        for name, body in missing:
            if dry_run:
                continue
            url = release['upload_url'].split('{')[0] + '?name=' + urllib.parse.quote(name)
            request = urllib.request.Request(url, data=body, method='POST', headers={
                **headers, 'Content-Type': 'application/octet-stream',
            })
            with urllib.request.urlopen(request, timeout=45) as response:
                result = json.load(response)
                if result['size'] != len(body):
                    raise ValueError('Uploaded asset size differs')
        if not dry_run:
            for name, body in assets:
                url = 'https://github.com/' + repo + '/releases/download/' + tag + '/' + name
                with urllib.request.urlopen(url, timeout=45) as response:
                    if response.read() != body:
                        raise ValueError('Public download differs: ' + name)
        print(json.dumps({'tag': tag, 'sourceCommit': commit, 'sha256': digest,
                          'archive': expected, 'bytes': len(data), 'dryRun': dry_run,
                          'missingAssets': [name for name, _ in missing],
                          'publicDownloadsVerified': not dry_run}))


if __name__ == '__main__':
    main()
