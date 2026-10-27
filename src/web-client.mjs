import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { assertSafePath, atomicJson, privateDirectory, RuntimeError } from './state.mjs';
import { runProcess } from './process.mjs';

export const WEB_BASE_PATH = '/paseo-web';
const MAX_ARCHIVE_BYTES = 192 * 1024 * 1024;
const manifestFile = new URL('../runtime/web-client.json', import.meta.url);
export function webClientManifest() { return JSON.parse(fs.readFileSync(manifestFile, 'utf8')); }
function releaseDirectory(loc, manifest) {
  if (!/^[a-f0-9]{64}$/.test(manifest.sha256)) throw new RuntimeError('WEB_CLIENT_MANIFEST_INVALID');
  return path.join(loc.stateDir, 'web-client', manifest.sha256);
}
function ready(root, manifest) {
  try {
    for (const name of ['index.html', 'pi-paseo-build.json', '.installed.json']) {
      if (!assertSafePath(path.join(root, name))?.isFile()) return false;
    }
    const receipt = JSON.parse(fs.readFileSync(path.join(root, '.installed.json'), 'utf8'));
    const build = JSON.parse(fs.readFileSync(path.join(root, 'pi-paseo-build.json'), 'utf8'));
    return receipt.sha256 === manifest.sha256 && build.sourceCommit === manifest.sourceCommit &&
      build.basePath === WEB_BASE_PATH && build.repairCommit === manifest.repairCommit;
  } catch { return false; }
}
export function webClientStatus(loc, manifest = webClientManifest()) {
  const installed = ready(releaseDirectory(loc, manifest), manifest);
  return { ready: installed, version: manifest.version, sourceCommit: manifest.sourceCommit, basePath: WEB_BASE_PATH };
}

// Activation already holds the runtime lock. Stage and validate the entire new
// release before publishing it; a failed download cannot replace an older one.
export async function ensureWebClient(loc, { manifest = webClientManifest(), fetchImpl = fetch } = {}) {
  const root = releaseDirectory(loc, manifest);
  if (ready(root, manifest)) return webClientStatus(loc, manifest);
  const url = new URL(manifest.url);
  if (url.origin !== 'https://github.com' || !url.pathname.startsWith('/WOOWTECH/paseo/releases/download/') || url.username || url.password || url.search || url.hash) throw new RuntimeError('WEB_CLIENT_ORIGIN_INVALID');
  const parent = path.dirname(root);
  privateDirectory(parent);
  const stage = path.join(parent, `.stage-${randomUUID()}`);
  privateDirectory(stage);
  const archive = path.join(stage, 'client.tar.gz');
  const content = path.join(stage, 'content');
  privateDirectory(content);
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(180000), redirect: 'follow' });
    if (!response.ok || !response.body) throw new RuntimeError('WEB_CLIENT_DOWNLOAD_FAILED');
    if (Number(response.headers.get('content-length')) > MAX_ARCHIVE_BYTES) throw new RuntimeError('WEB_CLIENT_TOO_LARGE');
    const fd = fs.openSync(archive, 'wx', 0o600), hash = createHash('sha256');
    let bytes = 0;
    try {
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > MAX_ARCHIVE_BYTES) throw new RuntimeError('WEB_CLIENT_TOO_LARGE');
        hash.update(chunk); fs.writeFileSync(fd, chunk);
      }
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    if (hash.digest('hex') !== manifest.sha256) throw new RuntimeError('WEB_CLIENT_CHECKSUM_FAILED');
    const names = await runProcess('tar', ['-tzf', archive], { timeoutMs: 30000 });
    const entries = names.trim().split('\n');
    if (entries.some(name => !name.startsWith('./') || /[\\\x00-\x1f\x7f]/.test(name) || name.split('/').includes('..'))) throw new RuntimeError('WEB_CLIENT_ARCHIVE_INVALID');
    const listing = await runProcess('tar', ['-tvzf', archive], { timeoutMs: 30000 });
    if (listing.trim().split('\n').some(line => !/^[-d]/.test(line))) throw new RuntimeError('WEB_CLIENT_ARCHIVE_INVALID');
    await runProcess('tar', ['-xzf', archive, '-C', content, '--no-same-owner', '--no-same-permissions'], { timeoutMs: 60000 });
    atomicJson(path.join(content, '.installed.json'), { sha256: manifest.sha256 });
    if (!ready(content, manifest)) throw new RuntimeError('WEB_CLIENT_BUILD_INVALID');
    // An incomplete cache at this exact digest is owned by this installer.
    assertSafePath(root);
    if (fs.existsSync(root)) fs.renameSync(root, path.join(stage, 'incomplete'));
    fs.renameSync(content, root);
    return webClientStatus(loc, manifest);
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError('WEB_CLIENT_INSTALL_FAILED');
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}

export function managedPairUrl(official) {
  let url;
  try { url = new URL(official); } catch { throw new RuntimeError('PAIRING_ORIGIN_INVALID'); }
  if (url.origin !== 'https://app.paseo.sh' || url.username || url.password || url.pathname !== '/' || url.search || !url.hash) throw new RuntimeError('PAIRING_ORIGIN_INVALID');
  return `${WEB_BASE_PATH}/welcome${url.hash}`;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg' };
const safeHeaders = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'SAMEORIGIN' };
function failure(status, message) { return new Response(message, { status, headers: safeHeaders }); }
export function serveWebClient(request, loc, manifest = webClientManifest()) {
  if (!['GET', 'HEAD'].includes(request.method)) return failure(405, 'Method not allowed');
  let pathname;
  try { pathname = decodeURIComponent(new URL(request.url).pathname); } catch { return failure(400, 'Invalid path'); }
  if (pathname !== WEB_BASE_PATH && !pathname.startsWith(WEB_BASE_PATH + '/')) return failure(404, 'Not found');
  const relative = pathname.slice(WEB_BASE_PATH.length).replace(/^\//, '');
  if (/[\\\x00-\x1f\x7f]/.test(relative) || relative.split('/').some(p => p === '..' || p.startsWith('.'))) return failure(400, 'Invalid path');
  const root = releaseDirectory(loc, manifest);
  if (!ready(root, manifest)) return failure(503, 'Paseo web client is preparing. Return to /paseo/setup to retry initialization.');
  try {
    let file = path.join(root, relative || 'index.html');
    let stat = assertSafePath(file);
    if (!stat?.isFile()) {
      if (/^(?:_expo|assets|_static)\//.test(relative) || path.extname(relative)) return failure(404, 'Not found');
      file = path.join(root, 'index.html'); stat = assertSafePath(file);
    }
    const extension = path.extname(file);
    if (!MIME[extension] && path.basename(file) !== 'PASEO-LICENSE') return failure(404, 'Not found');
    const headers = { ...safeHeaders, 'Content-Type': MIME[extension] || 'text/plain; charset=utf-8', 'Vary': 'Accept-Encoding' };
    if (/\bgzip\b(?!\s*;\s*q=0(?:\.0*)?(?:,|$))/.test(request.headers.get('accept-encoding') || '') && assertSafePath(file + '.gz')?.isFile()) {
      file += '.gz'; stat = fs.statSync(file); headers['Content-Encoding'] = 'gzip';
    }
    headers['Content-Length'] = String(stat.size);
    // Only content-hashed Expo assets are immutable; the shell must revalidate
    // after updates so old caches cannot silently select the previous client.
    if (relative.startsWith('_expo/static/') && /-[a-f0-9]{16,}\./.test(relative)) headers['Cache-Control'] = 'private, max-age=31536000, immutable';
    return new Response(request.method === 'HEAD' ? null : Readable.toWeb(fs.createReadStream(file)), { headers });
  } catch { return failure(404, 'Not found'); }
}
