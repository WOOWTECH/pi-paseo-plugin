# Agent Connect Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Generalize the existing Pi connector so Windows (currently WSL2), macOS, Ubuntu, k3s, and HA users can select Woowtech Smart, Apporo Smart, or Paseo in the GUI.

**Architecture:** Keep the installed `@woowtech/pi-paseo` identity, tools, state directory, and compatibility routes. Introduce an allowlisted target contract shared by runtime settings and UI projections; select the relay and branded app URL together, invalidate old pairing state when changing targets, and require explicit restart if runtime configuration cannot reload safely. Existing installs default to Paseo.

**Confirmed user choices:** Agent Connect display name; preserve existing npm names; one active target, switchable; Windows scope is existing WSL2.

**Tech Stack:** Node ESM, TypeScript/React Pi Web adapter, HA HTML/Unix-socket bridge, shell/Docker distribution definitions.

---

## Evidence and source map

- Connector: WOOWTECH/pi-paseo-plugin main 42ed67b, v0.1.16; runtime @getpaseo/cli 0.11.2.
- Native desktop/Linux: WOOWTECH/Woow_native_os_pi_agent. Windows is currently WSL2, not a native installer.
- k3s authoritative source: https://git-prod.woowtech.io/woow-paas/Woow_k3s_pi_agent_package. The GitHub repo and paas/ subtree are mirrors; do not edit paas/.
- HA: WOOWTECH/Woow_ha_pi_agent_add_on; official Pi Web 0.12 and independent connection bridge; do not install the 0.10 overlay here.
- Native/k3s consume a combined Pi Web 0.10 adapter from pi-omnigent-plugin, which must incorporate the connector adapter changes.
- WOOWTECH/woowtech-smart main 9214c6ea87 brand manifests: smart.woowtech.io + relay.woowtech.io:443; smart.apporo.ai + relay.apporo.ai:443. Runtime schema uses daemon.relay.endpoint and app.baseUrl.

### Task 1: Target-aware connector runtime

Files: create src/connection-targets.mjs and tests/connection-targets.test.mjs; modify src/host-api.mjs, src/runtime.mjs, src/web-client.mjs, extensions/index.ts, and related behavioral tests.

1. Define exact target IDs paseo/woowtech/apporo, labels, app and relay endpoints; default absent preferences to Paseo.
2. Validate target and name independently before writing; preserve legacy name-only updates and any existing preferences.
3. Apply relay endpoint and app.baseUrl through the owned daemon's supported schema. Clear stale pairing/relay verification on target change. Serialize target changes against activation and pairing; do not silently interrupt active conversations.
4. Generate and validate target-specific pairing URLs, preserve the offer unchanged, and reject mismatched origins/relay endpoints.
5. Rename human-facing extension labels and package description to a generic connector name; retain API identifiers for compatibility.
6. Run `npm test`, `npm run typecheck`, and `node scripts/check-package.mjs` where applicable. Exercise actual installed runtime schema with temporary homes.

### Task 2: Pi Web target selector

Files in reconstructed pi-web-adapter: lib/paseo-ui.ts, components/PaseoPluginPanel.tsx, components/PluginsConfig.tsx, app/api/plugin-paseo/route.ts, matching tests and docs/agents/settings-ui.md. Regenerate pi-paseo-plugin/host/adapter.patch and adapter-meta.json.

1. Project only validated target, pending/restart state, and safe app URL into public status.
2. Add a labeled target select beside the display name, submitted in the existing config action. Keep unsaved target edits distinct from currently applied links and readiness.
3. Use generic headings and target-specific app/pairing labels. Invalidate visible pairing and model results after target saves.
4. Add behavioral coverage for valid targets, invalid origins, saved target restoration, failed saves, stale responses, and switching targets.
5. Run relevant Node tests, TypeScript check, and browser rendering at desktop/mobile widths if feasible.
6. Regenerate and validate adapter patch against the exact upstream base; update combined adapter consumer in pi-omnigent-plugin.

### Task 3: HA integration and distribution propagation

Files: HA rootfs/usr/local/share/pi-paseo-ha/index.html, rootfs bridge scripts, tests, Dockerfile/docs; native manifests/install scripts; k3s authoritative Dockerfile (leave paas/ mirrors untouched); pi-omnigent-plugin combined adapter metadata.

1. Use the same allowlisted target contract in HA projection and settings handling; add selector and generic titles to HA GUI.
2. Update relevant platform docs, pin candidate versions only when distributable artifacts exist, and avoid claiming unpublished npm artifacts are available.
3. Verify distribution contracts, shell syntax, HA bridge tests, patch checksums and mirrors. Preserve existing unrelated changes and production state.
4. Record exact source versions and unsupported platform verification (Windows/macOS hosts unavailable).

### Task 4: Review and handoff

1. Review requirements and code quality independently.
2. Fix findings, rerun affected verification, and record results and remaining live-environment checks.
3. Leave concrete reviewable source changes with explicit publication/deployment status. Do not infer that a local test proves branded production pairing.
