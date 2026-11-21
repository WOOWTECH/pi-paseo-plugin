import crypto from 'node:crypto';
import fs from 'node:fs';

const platforms = JSON.parse(fs.readFileSync(new URL('../contract.json', import.meta.url))).platforms;
const imagePlatforms = new Set(['k3s-paas', 'ha-addon']);
const digest = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };

function canonicalPackages(packages) {
  requireValue(Array.isArray(packages) && packages.length > 0, 'Native runtime needs an exact package set');
  const names = new Set();
  const rows = packages.map(row => {
    requireValue(typeof row?.name === 'string' && /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(row.name) && !names.has(row.name) &&
      typeof row.version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(row.version) &&
      typeof row.archiveSha256 === 'string' && /^[a-f0-9]{64}$/.test(row.archiveSha256), 'Native package provenance requires unique names, exact versions and archive SHA256');
    names.add(row.name);
    return { name: row.name, version: row.version, archiveSha256: row.archiveSha256 };
  });
  return rows.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

// Canonical JSON is sorted by package name; each object's key order is fixed above.
export function packageSetDigest(packages) {
  return 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(canonicalPackages(packages))).digest('hex');
}

export function runtimeBinding(manifest) {
  requireValue(platforms.includes(manifest?.platform), 'Explicit valid contract platform is required');
  if (imagePlatforms.has(manifest.platform)) {
    const runtime = manifest.runtime || { kind: 'container-image', imageId: manifest.imageId };
    requireValue(runtime.kind === 'container-image' && digest(runtime.imageId) &&
      (manifest.imageId === undefined || manifest.imageId === runtime.imageId), 'Container platform needs an exact image identity');
    return { platform: manifest.platform, runtime: { kind: 'container-image', imageId: runtime.imageId },
      runtimeIdentity: 'image:' + runtime.imageId, imageId: runtime.imageId };
  }
  requireValue(manifest.imageId === undefined && manifest.runtime?.kind === 'package-set', 'Native platform requires package-set provenance, never an image ID');
  const packages = canonicalPackages(manifest.runtime.packages), expected = packageSetDigest(packages);
  requireValue(digest(manifest.runtime.digest) && manifest.runtime.digest === expected, 'Native package-set digest does not match its exact package provenance');
  return { platform: manifest.platform, runtime: { kind: 'package-set', digest: expected, packages }, runtimeIdentity: 'package-set:' + expected };
}

export function validateHostRuntime(host, binding) {
  if (binding.runtime.kind === 'container-image') {
    requireValue((host.runtimeIdentity === binding.runtimeIdentity || (host.runtimeIdentity === undefined && host.imageId === binding.imageId)) &&
      (host.imageId === undefined || host.imageId === binding.imageId), 'Host image/runtime identity mismatch');
  } else {
    requireValue(host.imageId === undefined && host.runtimeIdentity === binding.runtimeIdentity, 'Native host package-set identity mismatch');
  }
}

export function validateReportRuntime(report, manifest) {
  const binding = runtimeBinding(manifest);
  requireValue(report?.platform === binding.platform, 'Evidence platform mismatch');
  validateHostRuntime(report, binding);
  if (report.runtime) requireValue(runtimeBinding(report).runtimeIdentity === binding.runtimeIdentity, 'Evidence runtime provenance mismatch');
  return binding;
}

export function validateInitialRuntime(row, binding) {
  validateHostRuntime({ runtimeIdentity: row.initialRuntimeIdentity, imageId: row.initialImage }, binding);
}
