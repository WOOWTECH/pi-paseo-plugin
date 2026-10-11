#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from '../bin/install-host.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-paseo-production-install-'));
try {
  const env = { ...process.env, NODE_ENV: 'production', PI_PASEO_SKIP_POSTINSTALL: '1',
    PI_PASEO_DISCOVERY_ONLY: '1', PI_CODING_AGENT_DIR: path.join(temp, 'agent'),
    PI_AGENT_DATA_DIR: path.join(temp, 'agent'), PI_PASEO_STATE_DIR: path.join(temp, 'state'),
    PI_PASEO_RUNTIME_DIR: path.join(temp, 'runtime') };
  const [pack] = JSON.parse(await runCommand('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temp], { cwd: root, env }));
  fs.writeFileSync(path.join(temp, 'package.json'), '{"private":true}\n');
  // Run postinstall with its opt-out: module imports still exercise runtime peers.
  await runCommand('npm', ['install', '--omit=dev', '--legacy-peer-deps', '--no-audit', '--no-fund', path.join(temp, pack.filename)], { cwd: temp, env });
  const output = await runCommand(process.execPath, ['--input-type=module', '-e',
    'const api=await import("@woowtech/pi-paseo/host-api"); const s=await api.status(); if(s.installed||s.daemon.running||typeof api.listModels!=="function")process.exit(1); const {createRequire}=await import("node:module");const fs=await import("node:fs");const path=await import("node:path");const req=createRequire(import.meta.resolve("@woowtech/pi-paseo/host-api"));const sdk=req.resolve.paths("@earendil-works/pi-coding-agent").map(p=>path.join(p,"@earendil-works/pi-coding-agent")).find(p=>fs.existsSync(path.join(p,"package.json")));const sr=createRequire(path.join(sdk,"package.json"));const br=createRequire(sr.resolve("minimatch"));if(JSON.parse(fs.readFileSync(br.resolve("brace-expansion/package.json"))).version!=="5.0.12"||sr("minimatch").braceExpand("{a,b}").join()!=="a,b")process.exit(1);console.log("PRODUCTION_PACKAGE_OK");'], { cwd: temp, env });
  if (output !== 'PRODUCTION_PACKAGE_OK') throw new Error('PRODUCTION_PACKAGE_CHECK_FAILED');
  console.log(JSON.stringify({ passed: true, installation: 'production-without-dev-dependencies', daemonStarted: false }));
} catch {
  console.error(JSON.stringify({ passed: false, code: 'PRODUCTION_PACKAGE_CHECK_FAILED' }));
  process.exitCode = 1;
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
