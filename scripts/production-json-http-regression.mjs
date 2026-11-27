#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const root = fs.realpathSync(path.resolve(process.argv[3] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')));
const route = path.join(root, 'app/api/agent-connect-http-json-probe/route.ts');
const marker = 'agent-connect-rc6-http-json-probe';
const routeSource = `import { jsonResponse } from "@/lib/json-response";\n\nexport const dynamic = "force-dynamic";\n\nexport function GET(request: Request) {\n  return jsonResponse(request, { marker: "${marker}", payload: "json-data-".repeat(512) });\n}\n`;
const mode = process.argv[2];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const expectedPayload = { marker, payload: 'json-data-'.repeat(512) };

if (!['prepare', 'verify', 'cleanup'].includes(mode)) throw new Error('Expected prepare, verify, or cleanup');
if (mode === 'prepare') {
  fs.mkdirSync(path.dirname(route), { recursive: true });
  if (fs.existsSync(route)) throw new Error('Probe route already exists');
  fs.writeFileSync(route, routeSource, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ productionHttp: 'prepared', route: '/api/agent-connect-http-json-probe' }));
} else if (mode === 'cleanup') {
  if (fs.existsSync(route)) {
    if (fs.readFileSync(route, 'utf8') !== routeSource) throw new Error('Probe route changed; refusing cleanup');
    fs.unlinkSync(route);
    try { fs.rmdirSync(path.dirname(route)); } catch {}
  }
  console.log(JSON.stringify({ productionHttp: 'cleaned' }));
} else {
  if (fs.readFileSync(route, 'utf8') !== routeSource) throw new Error('Expected probe route missing or changed');
  const next = path.join(root, 'node_modules/next/dist/bin/next');
  if (!fs.existsSync(next) || !fs.existsSync(path.join(root, '.next/BUILD_ID'))) throw new Error('Production build is missing');
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', error => error ? reject(error) : resolve()));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-connect-http-home-'));
  const agentDir = path.join(isolatedHome, '.pi/agent');
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  const child = spawn(process.execPath, [next, 'start', '-H', '127.0.0.1', '-p', String(port)], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: isolatedHome,
      TMPDIR: isolatedHome,
      XDG_CONFIG_HOME: path.join(isolatedHome, '.config'),
      XDG_CACHE_HOME: path.join(isolatedHome, '.cache'),
      PI_CODING_AGENT_DIR: agentDir,
      PI_AGENT_DATA_DIR: agentDir,
      PI_PASEO_SKIP_POSTINSTALL: '1',
      NODE_ENV: 'production',
      NEXT_TELEMETRY_DISABLED: '1',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error(`next start exited early (${child.exitCode})`);
      try {
        await new Promise((resolve, reject) => {
          const req = http.get({ host: '127.0.0.1', port, path: '/api/agent-connect-http-json-probe', headers: { 'Accept-Encoding': 'identity' } }, response => { response.resume(); resolve(); });
          req.setTimeout(500, () => req.destroy(new Error('probe timeout')));
          req.on('error', reject);
        });
        ready = true;
        break;
      } catch { await delay(100); }
    }
    assert.ok(ready, 'next start did not become ready');
    const fetchGzip = await fetch(`http://127.0.0.1:${port}/api/agent-connect-http-json-probe`, { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(fetchGzip.status, 200, 'fetch() status for gzip negotiation');
    assert.match(fetchGzip.headers.get('content-type') ?? '', /^application\/json\b/i);
    assert.deepEqual(await fetchGzip.json(), expectedPayload, 'fetch().json() must transparently decode the production response');

    const fetchIdentity = await fetch(`http://127.0.0.1:${port}/api/agent-connect-http-json-probe`, { headers: { 'Accept-Encoding': 'identity' } });
    assert.equal(fetchIdentity.status, 200, 'fetch() status for identity negotiation');
    assert.equal(fetchIdentity.headers.get('content-encoding'), null, 'identity response must not be compressed');
    assert.deepEqual(await fetchIdentity.json(), expectedPayload, 'identity response remains JSON');

    const response = await new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/agent-connect-http-json-probe', headers: { 'Accept-Encoding': 'gzip' } }, res => {
        const chunks = [];
        let size = 0;
        res.on('data', chunk => {
          size += chunk.length;
          if (size > 65536) { req.destroy(new Error('response body exceeds 64 KiB')); return; }
          chunks.push(chunk);
        });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.setTimeout(5000, () => req.destroy(new Error('response timeout')));
      req.on('error', reject);
    });
    assert.equal(response.status, 200, 'production HTTP status');
    assert.match(response.headers['content-type'] ?? '', /^application\/json\b/i, 'production content type');
    assert.equal(response.headers['content-encoding'], 'gzip', 'Next production server must own compression');
    assert.deepEqual([...response.body.subarray(0, 2)], [0x1f, 0x8b], 'wire body must contain one gzip layer');
    const decoded = gunzipSync(response.body);
    assert.notDeepEqual([...decoded.subarray(0, 2)], [0x1f, 0x8b], 'decoded body must not still be gzip');
    const payload = JSON.parse(decoded.toString('utf8'));
    assert.deepEqual(payload, expectedPayload);
    console.log(JSON.stringify({ productionHttp: 'pass', status: response.status, contentType: 'application/json', contentEncoding: response.headers['content-encoding'], gzipLayers: 1, fetchJson: 'pass', identityJson: 'pass', payload: 'valid-json' }));
  } catch (error) {
    console.error(JSON.stringify({ productionHttp: 'fail', error: error.message, stderr: stderr.slice(-1200) }));
    process.exitCode = 1;
  } finally {
    const exited = child.exitCode !== null ? Promise.resolve() : new Promise(resolve => child.once('exit', resolve));
    if (child.exitCode === null) child.kill('SIGTERM');
    if (await Promise.race([exited.then(() => true), delay(3000).then(() => false)]) === false) {
      child.kill('SIGKILL');
      await exited;
    }
    fs.rmSync(isolatedHome, { recursive: true, force: true });
  }
}
