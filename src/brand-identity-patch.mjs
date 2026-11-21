import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assertSafePath, RuntimeError } from './state.mjs';

// Frozen @getpaseo/server 0.11.2. The upstream status envelope preserves extra
// fields; branded clients require this optional brand identity during hello.
export const ORIGINAL_BRAND_SERVER_SHA256 = 'ba8122d01dd17533231a573097ec4e9f91f4fd12caada107adb9f6706f5f8950';
export const PATCHED_BRAND_SERVER_SHA256 = '8315add9226617d4c2c09d1481c750eff7a34fa83670725914c69892f1cd1561';
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
