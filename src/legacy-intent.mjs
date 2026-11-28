import fs from 'node:fs';
import path from 'node:path';
import { assertSafePath } from './state.mjs';

// The Paseo runtime of Agent Connect 0.1.4-0.1.23: LEGACY_PASEO_VERSION in runtime-layout.mjs, written out here so
// this module stays free of the runtime layout and its patch modules (tests/legacy-intent.test.mjs pins the two).
export const LEGACY_INTENT_PASEO_VERSION = '0.11.2';

/**
 * A user's "off" recorded by Agent Connect 0.1.4-0.1.23, the releases that ran the Paseo 0.11.2 runtime (#29).
 *
 * Those releases kept the off only in state.json (desiredEnabled: false, phase "disabled"). Their
 * host-registration.json still says enabled: true: it was written when the package host was registered and changed
 * only by an explicit `cli.mjs disable`. 0.1.24 and later decide from the registration alone, and activate() records
 * desiredEnabled: true, so an image upgrade switched on a Paseo the owner had never turned on.
 *
 * True only while the state still comes from that era. The first activate() of a newer release records its own
 * installedVersion, so a later "off" of a newer release (for example Pi no longer configuring the package) keeps its
 * current meaning. An unreadable or unsafe state answers false: it cannot tell, and the behaviour stays as before.
 */
export function legacyDesiredOff(loc) {
  try {
    const file = path.join(loc.stateDir, 'state.json');
    assertSafePath(file);
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    return !!state && typeof state === 'object' && state.desiredEnabled === false && state.installedVersion === LEGACY_INTENT_PASEO_VERSION;
  } catch { return false; }
}
