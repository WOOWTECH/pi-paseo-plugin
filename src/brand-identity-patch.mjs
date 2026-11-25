import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assertSafePath, RuntimeError } from './state.mjs';

// Frozen @getpaseo/server 0.17.4. The hello response is serialized as built, so the
// status envelope keeps extra fields; branded clients require this optional brand
// identity during hello. Releases built for 0.11.2 are never patched again: offline
// control of their daemons does not load this module.
export const ORIGINAL_BRAND_SERVER_SHA256 = 'bfc79901aa7768a51b98385b6f729dac69a1098f4480a66fd3d2be1d6af06b4b';
export const PATCHED_BRAND_SERVER_SHA256 = '17ea88357d2f25caab81ad63d32804fe41158c1d70e8e4f549c4fc7173fe8d68';
const helper = fs.readFileSync(new URL('./brand-identity.mjs', import.meta.url));
const sha = value => createHash('sha256').update(value).digest('hex');
export const BRAND_IDENTITY_PATCH_ID = sha(Buffer.concat([helper, Buffer.from(PATCHED_BRAND_SERVER_SHA256)]));
export const BRAND_SERVER_PATH = 'node_modules/@getpaseo/server/dist/server/server/websocket-server.js';
export function patchBrandIdentitySource(source) {
  if (sha(source) === PATCHED_BRAND_SERVER_SHA256) return source;
  if (sha(source) !== ORIGINAL_BRAND_SERVER_SHA256) throw new RuntimeError('BRAND_IDENTITY_SOURCE_MISMATCH');
  const result = 'import {agentConnectBrand} from "./pi-paseo-brand-identity.mjs";\n' + source.replace(
    '            status: "server_info",', '            status: "server_info",\n            brand: agentConnectBrand,');
  if (sha(result) !== PATCHED_BRAND_SERVER_SHA256) throw new RuntimeError('BRAND_IDENTITY_PATCH_MISMATCH');
  return result;
}
export function applyBrandIdentityPatch(root) {
  const file = path.join(root, BRAND_SERVER_PATH), target = path.join(path.dirname(file), 'pi-paseo-brand-identity.mjs');
  assertSafePath(file); assertSafePath(target);
  const before = fs.readFileSync(file, 'utf8'), after = patchBrandIdentitySource(before);
  if (!fs.existsSync(target) || !fs.readFileSync(target).equals(helper)) fs.writeFileSync(target, helper, { mode: 0o644 });
  if (before !== after) fs.writeFileSync(file, after);
}
export function brandIdentityPatchReady(root) {
  try {
    const file = path.join(root, BRAND_SERVER_PATH), target = path.join(path.dirname(file), 'pi-paseo-brand-identity.mjs');
    assertSafePath(file); assertSafePath(target);
    return sha(fs.readFileSync(file)) === PATCHED_BRAND_SERVER_SHA256 && fs.readFileSync(target).equals(helper);
  } catch { return false; }
}
