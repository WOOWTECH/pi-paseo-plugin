# Settings > Paseo on a fresh install (v0.1.13)

## Problem
On a brand-new Pi Web install — no conversation and no project picked — `GET /api/plugin-paseo` answered 404
("install Paseo in plugin settings and choose an accessible working directory"). Every status row stayed "not
obtained" and *Generate pairing link* stayed disabled, so the container could not be paired from Settings.

## Root cause
The Settings > Paseo section mounts the panel with `cwd=""`, so the route falls back to `PI_PASEO_CWD || homedir()`.
That directory then had to lie inside Pi Web's allowed roots: the cwd/projectRoot of existing sessions plus an in-memory
set the project picker fills. With no session and no picked project the set is empty. Picking *Use default directory*
registers `~/pi-cwd/<date>`, a child of home, so it did not help either; only a custom project at home did. The setup
conversation that older releases created sat at `cwd=home`, which hid the problem until it was removed.

## Change (`host/adapter.patch`, route `app/api/plugin-paseo/route.ts`)
- A directory the **client** names must still be inside the allowed roots (unchanged; escaping links, files and
  unserved directories stay 404).
- The **server's own** fallback (`PI_PASEO_CWD`, else the user's home) is trusted, as it already was in the managed Web
  client route and in startup recovery. A fallback that is missing, a file or relative is a 404, not a 503.
- Outside the served roots the home fallback reads **global packages only**; an explicit `PI_PASEO_CWD` keeps
  project-aware discovery. Inside the served roots behaviour is exactly as before.

## Verification
- `app/api/plugin-paseo/route.test.mjs`: three new tests (fresh install, `PI_PASEO_CWD` and unusable fallbacks, served
  directories and missing home). Two fail on the old route, all pass on the new one; the existing authorization test
  for files, escaping links and unserved directories is unchanged and passes.
- `node scripts/verify-host.mjs`: 92 host tests and a production build against Pi Web 0.10.0 at
  `6fcd7d44981ab51a21d6cd6eb06d361d0e3d3068`.
- The combined (Omnigent + Paseo) browser regression `e2e/fresh-install-zero-conversation.mjs` lives in
  pi-omnigent-plugin v0.3.29 because it needs both sections.
