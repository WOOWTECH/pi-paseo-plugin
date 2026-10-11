# Commercial deployment validation plan

**Goal:** Exercise the deployed Pi Web / Paseo plugin, reproduce deployment and recovery defects, repair verified defects, and publish an auditable release with operational checks.

**Architecture:** Keep Pi 5 available while fault injection uses isolated HOME/state directories and a dedicated host checkout. Preserve current provider accounts and manual service intent. Use explicit readiness and bounded subprocess execution; keep pairing material out of reports and logs.

**Tech Stack:** Node 22, npm, Pi SDK, pinned Pi Web adapter, Paseo 0.11.2, node:test, Playwright, Kubernetes read-only inventory.

## 1. Baseline and production inventory

- Pin source `471bbbb93f1b186cd25caa99769cf4778a2e86a4` in an isolated git worktree.
- Check Pi 5 readiness, restart reasons, daemon reachability, provider catalogs, onboarding identity and resource usage using redacted metadata.
- Re-run the existing plugin, installer, host and package checks once. Fetch current official connectivity and provider documentation.

## 2. Installation, upgrade and rollback

Files: `bin/install-host.mjs`, `scripts/install.sh`, `scripts/install-host.test.mjs`, release documentation.

- Reproduce interrupted child builds, output overflow, install locks, existing routing and failed publication with isolated fixtures.
- Verify atomic publication and rollback across adapter release and routing changes.
- Validate resource limits, immutable installs and repeat installation. Add tests at the failing call site, fix, then re-run them.

## 3. Service and onboarding recovery

Files: `src/onboarding.mjs`, `src/state.mjs`, `src/supervisor.mjs`, `src/host-api.mjs`, runtime and lifecycle tests.

- Exercise crash recovery, recycled PIDs, concurrent enable/disable, stale locks and partially created onboarding sessions.
- Verify private files, safe error categories, manual-stop persistence and one onboarding conversation.
- Use an isolated real daemon for stop/start and fault recovery; avoid terminating any production daemon to inject faults.

## 4. Protected UI and real provider functions

Files: host API, host UI/tests, reusable verification scripts.

- Test unauthenticated access, cross-origin POST, malformed input, safe pairing responses and no-store headers.
- Measure repeated status/model requests for latency and avoid unnecessary daemon connections.
- Test desktop/mobile setting screens and official relay pairing. Send two small validation turns per authorized provider, recording only success, model, elapsed time and fixed error codes.

## 5. Release and operations

Files: CI workflow, `docs/commercial-readiness.md`, README, package manifest.

- Add host adapter verification to CI and publish an operator health check and concrete deployment/rollback instructions.
- Review changes independently; run applicable regression tests, typecheck, host build and production package install.
- Publish the reviewed release to the public GitHub repository and verify CI and anonymous download. Deploy necessary fixes to Pi 5 while preserving service accounts and onboarding identity.
- Report measured results and remaining limits. A healthy container, model list or historical acceptance record alone does not imply every commercial requirement is satisfied.
