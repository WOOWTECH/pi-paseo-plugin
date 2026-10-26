import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { ensureWebClient, managedPairUrl, serveWebClient, webClientStatus } from '../src/web-client.mjs';

function fixture(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'paseo-web-client-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const content = path.join(tmp, 'source'); fs.mkdirSync(content);
  const manifest = { version: 'test', sourceCommit: 'a'.repeat(40), repairCommit: 'b'.repeat(40), basePath: '/paseo-web', url: 'https://github.com/WOOWTECH/paseo/releases/download/test/client.tar.gz' };
  fs.writeFileSync(path.join(content, 'pi-paseo-build.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(content, 'index.html'), '<main>fixed client</main>');
  const asset = '_expo/static/js/web/entry-' + 'c'.repeat(32) + '.js';
  fs.mkdirSync(path.dirname(path.join(content, asset)), { recursive: true });
  fs.writeFileSync(path.join(content, asset), 'console.log("fixed");');
  fs.writeFileSync(path.join(content, asset + '.gz'), gzipSync('console.log("fixed");'));
  const pack = () => {
    execFileSync('tar', ['-czf', path.join(tmp, 'client.tgz'), '-C', content, '.']);
    const bytes = fs.readFileSync(path.join(tmp, 'client.tgz'));
    manifest.sha256 = createHash('sha256').update(bytes).digest('hex');
    return bytes;
  };
  let archive = pack(), fetches = 0;
  const loc = { stateDir: path.join(tmp, 'state') };
  const opts = { manifest, fetchImpl: async () => { fetches++; return new Response(archive); } };
  return { tmp, content, loc, manifest, opts, asset, fetches: () => fetches, repack: () => { archive = pack(); } };
}

test('installs a verified static release atomically and reuses it without downloading', async t => {
  const f = fixture(t);
  assert.equal(webClientStatus(f.loc, f.manifest).ready, false);
  assert.equal((await ensureWebClient(f.loc, f.opts)).ready, true);
  assert.equal((await ensureWebClient(f.loc, f.opts)).ready, true);
  assert.equal(f.fetches(), 1);
  assert.deepEqual(fs.readdirSync(path.join(f.loc.stateDir, 'web-client')), [f.manifest.sha256]);
});

test('a corrupt new download leaves the previously installed release usable', async t => {
  const f = fixture(t); await ensureWebClient(f.loc, f.opts);
  const previous = { ...f.manifest };
  await assert.rejects(ensureWebClient(f.loc, { manifest: { ...f.manifest, sha256: 'd'.repeat(64) }, fetchImpl: async () => new Response('corrupt') }), { code: 'WEB_CLIENT_CHECKSUM_FAILED' });
  assert.equal(webClientStatus(f.loc, previous).ready, true);
  assert.deepEqual(fs.readdirSync(path.join(f.loc.stateDir, 'web-client')), [previous.sha256]);
});

test('rejects archives containing links and removes incomplete staging data', async t => {
  const f = fixture(t); fs.symlinkSync('/etc/passwd', path.join(f.content, 'escape')); f.repack();
  await assert.rejects(ensureWebClient(f.loc, f.opts), { code: 'WEB_CLIENT_ARCHIVE_INVALID' });
  assert.equal(webClientStatus(f.loc, f.manifest).ready, false);
  assert.deepEqual(fs.readdirSync(path.join(f.loc.stateDir, 'web-client')), []);
});

test('serves deep routes as the app shell, hashed assets with gzip, and correct HEAD responses', async t => {
  const f = fixture(t); await ensureWebClient(f.loc, f.opts);
  const request = (route, options) => new Request('https://pi.example/paseo-web/' + route, options);
  const page = serveWebClient(request('hosts/host/workspaces/workspace/agents/agent'), f.loc, f.manifest);
  assert.equal(page.status, 200); assert.equal(page.headers.get('cache-control'), 'private, no-store');
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(await page.text(), '<main>fixed client</main>');
  const js = serveWebClient(request(f.asset, { headers: { 'Accept-Encoding': 'gzip' } }), f.loc, f.manifest);
  assert.equal(js.headers.get('content-encoding'), 'gzip');
  assert.match(js.headers.get('cache-control'), /immutable/);
  assert.equal(gunzipSync(Buffer.from(await js.arrayBuffer())).toString(), 'console.log("fixed");');
  const head = serveWebClient(request(f.asset, { method: 'HEAD' }), f.loc, f.manifest);
  assert.equal(head.status, 200); assert.equal(await head.text(), ''); assert.ok(Number(head.headers.get('content-length')) > 0);
  const identity = serveWebClient(request(f.asset, { headers: { 'Accept-Encoding': 'gzip;q=0' } }), f.loc, f.manifest);
  assert.equal(identity.headers.get('content-encoding'), null); await identity.text();
});

test('rejects traversal, private files, missing assets, and symlink escapes', async t => {
  const f = fixture(t); await ensureWebClient(f.loc, f.opts);
  const root = path.join(f.loc.stateDir, 'web-client', f.manifest.sha256);
  fs.symlinkSync('/etc/passwd', path.join(root, 'escape.js'));
  for (const route of ['%2e%2e%2fprivate', '%5cescape', '.installed.json', '_expo/missing.js', 'escape.js', 'pi-paseo-build.json%00', '%ZZ']) {
    const result = serveWebClient(new Request('https://pi.example/paseo-web/' + route), f.loc, f.manifest);
    assert.ok([400, 404].includes(result.status), route);
    assert.doesNotMatch(await result.text(), /root:/);
  }
});

test('pairing keeps the private fragment on the fixed same-origin client path', () => {
  assert.equal(managedPairUrl('https://app.paseo.sh/#opaque-secret'), '/paseo-web/#opaque-secret');
  for (const value of ['https://app.paseo.sh.evil/pair#secret', 'http://app.paseo.sh/pair#secret', 'https://user:password@app.paseo.sh/pair#secret', 'https://app.paseo.sh/?redirect=evil#secret', 'https://app.paseo.sh/other#secret', 'https://app.paseo.sh/']) assert.throws(() => managedPairUrl(value), { code: 'PAIRING_ORIGIN_INVALID' });
});
