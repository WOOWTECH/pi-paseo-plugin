import path from 'node:path';
import { readRecord } from './onboarding.mjs';
import { RuntimeError } from './state.mjs';

// Verified against WOOWTECH/woowtech-smart 9214c6ea87 brand manifests.
// These are connection profiles, not replacements for the branded push sender.
export const CONNECTION_TARGETS = Object.freeze([
  Object.freeze({ id: 'paseo', label: 'Paseo', appUrl: 'https://app.paseo.sh', relayEndpoint: 'relay.paseo.sh:443', openUrl: '/paseo-web' }),
  Object.freeze({ id: 'woowtech', label: 'Woowtech Smart', appUrl: 'https://smart.woowtech.io', relayEndpoint: 'relay.woowtech.io:443', openUrl: 'https://smart.woowtech.io/' }),
  Object.freeze({ id: 'apporo', label: 'Apporo Smart', appUrl: 'https://smart.apporo.ai', relayEndpoint: 'relay.apporo.ai:443', openUrl: 'https://smart.apporo.ai/' }),
]);

export function connectionTarget(id = 'paseo') {
  const target = CONNECTION_TARGETS.find(row => row.id === id);
  if (!target) throw new RuntimeError('INVALID_TARGET');
  return target;
}

export function connectionPreferences(loc) {
  const preferences = readRecord(path.join(loc.stateDir, 'preferences.json'));
  return { ...preferences, name: typeof preferences.name === 'string' ? preferences.name : 'Pi Agent', target: connectionTarget(preferences.target).id };
}

export function targetEnvironment(target) {
  const profile = connectionTarget(target);
  return {
    PASEO_APP_BASE_URL: profile.appUrl,
    PASEO_RELAY_ENABLED: 'true',
    PASEO_RELAY_ENDPOINT: profile.relayEndpoint,
    PASEO_RELAY_PUBLIC_ENDPOINT: profile.relayEndpoint,
    PASEO_RELAY_USE_TLS: 'true',
    PASEO_RELAY_PUBLIC_USE_TLS: 'true',
    PASEO_CORS_ORIGINS: profile.appUrl,
  };
}

export function targetConfiguration(config, target) {
  const profile = connectionTarget(target);
  const origins = config.daemon?.cors?.allowedOrigins || [];
  if (!Array.isArray(origins) || origins.some(origin => typeof origin !== 'string')) throw new RuntimeError('CONFIG_INVALID');
  const managedOrigins = new Set(CONNECTION_TARGETS.map(row => row.appUrl));
  return {
    ...config,
    app: { ...config.app, baseUrl: profile.appUrl },
    daemon: {
      ...config.daemon,
      relay: { ...config.daemon?.relay, enabled: true, endpoint: profile.relayEndpoint, publicEndpoint: profile.relayEndpoint, useTls: true, publicUseTls: true },
      cors: { ...config.daemon?.cors, allowedOrigins: [...origins.filter(origin => !managedOrigins.has(origin.replace(/\/$/, ''))), profile.appUrl] },
    },
  };
}

export function targetPairUrl(official, target = 'paseo') {
  const profile = connectionTarget(target);
  let url;
  try { url = new URL(official); } catch { throw new RuntimeError('PAIRING_ORIGIN_INVALID'); }
  if (url.origin !== profile.appUrl || url.username || url.password || url.pathname !== '/' || url.search || !/^#offer=[A-Za-z0-9_-]+$/.test(url.hash)) throw new RuntimeError('PAIRING_ORIGIN_INVALID');
  let offer;
  try { offer = JSON.parse(Buffer.from(url.hash.slice(7), 'base64url').toString('utf8')); }
  catch { throw new RuntimeError('PAIRING_OFFER_INVALID'); }
  if (offer?.v !== 2 || typeof offer.serverId !== 'string' || !offer.serverId || typeof offer.daemonPublicKeyB64 !== 'string' || !offer.daemonPublicKeyB64 || offer.relay?.endpoint !== profile.relayEndpoint || offer.relay?.useTls !== true) throw new RuntimeError('PAIRING_TARGET_MISMATCH');
  return target === 'paseo' ? `/paseo-web/welcome${url.hash}` : `${profile.appUrl}/${url.hash}`;
}
