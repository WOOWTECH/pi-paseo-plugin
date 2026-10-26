#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAdapter } from '../bin/install-host.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  readAdapter(root);
  const pack = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8', env: { ...process.env, PI_PASEO_SKIP_POSTINSTALL: '1' } });
  if (pack.status !== 0) throw new Error('PACK_FAILED');
  const [record] = JSON.parse(pack.stdout);
  const files = new Set(record.files.map(file => file.path));
  const required = ['package.json', 'LICENSE', 'README.md', 'bin/cli.mjs', 'bin/install-host.mjs', 'extensions/index.ts', 'src/runtime.mjs', 'src/host-api.mjs', 'src/web-client.mjs', 'runtime/web-client.json', 'host/adapter.patch', 'host/adapter-meta.json', 'scripts/install.sh'];
  if (required.some(file => !files.has(file))) throw new Error('PACK_MISSING_REQUIRED_FILES');
  if ([...files].some(file => /(^|\/)(node_modules|\.git|\.next|artifacts|\.env(?:\..*)?)(\/|$)/.test(file) || file.startsWith('host/pi-web/') || /(^|\/)(auth|credentials|pairing\.private|config)\.json$/.test(file))) throw new Error('PACK_CONTAINS_LOCAL_DATA');
  console.log(JSON.stringify({ passed: true, fileCount: files.size, adapter: 'metadata-and-sha256-verified', requiredFiles: required }));
} catch (error) {
  console.error(JSON.stringify({ passed: false, code: /^[A-Z_]+$/.test(error.message) ? error.message : 'PACKAGE_CHECK_FAILED' }));
  process.exitCode = 1;
}
