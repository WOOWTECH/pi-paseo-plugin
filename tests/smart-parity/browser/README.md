# Public Web browser acceptance

These test runners operate the real Agent Connect GUI and public sites listed in `../contract.json`. They are excluded from the npm package. They do not provision hosts, grant provider-turn authorization, deploy images, or certify a production rollout.

First verify at least two isolated hosts externally: exact platform/runtime provenance, ownership labels, separate data identities and private loopback forwards. The manifest records that verification; it does not itself prove Docker/Kubernetes ownership. Production scope is refused.

## Configuration

Use Node 22.19+, a separately installed Playwright module and compatible Chromium, and the pinned Craft CLI from `../setup-craft.py`. Craft's checksum is checked at startup. Set absolute paths:

```sh
export SMART_PARITY_EVIDENCE_DIR=/private/acceptance
export SMART_PARITY_PLAYWRIGHT_MODULE=/private/tools/node_modules/playwright/index.mjs
export SMART_PARITY_CHROMIUM_EXECUTABLE_PATH=/private/tools/chromium
export SMART_PARITY_CRAFT_CLI=/private/tools/craft-anything-cli
```

The evidence directory must have mode `0700`. `SMART_PARITY_HOST_MANIFEST` optionally selects a manifest; its default is `$SMART_PARITY_EVIDENCE_DIR/browser-hosts.private.json`. Chromium uses its normal sandbox unless the already isolated environment requires `SMART_PARITY_NO_SANDBOX=1`.

Every manifest requires one explicit contract platform. For `k3s-paas` and `ha-addon`, use this manifest shape, replacing each image placeholder with the same inspected `sha256:` configuration ID. Ownership must reflect verified run/host labels. `providerTurnsAuthorized` records authorization already granted for these hosts and browser jobs.

```json
{
  "platform": "k3s-paas",
  "scope": "isolated-candidate",
  "runId": "release-test",
  "imageId": "sha256:<64 lowercase hex characters>",
  "productionMutations": false,
  "providerTurnsAuthorized": true,
  "hosts": [
    {
      "label": "hosta", "baseUrl": "http://127.0.0.1:26041",
      "imageId": "sha256:<64 lowercase hex characters>",
      "dataIdentity": "owned-volume-a",
      "ownership": {"runId": "release-test", "hostLabel": "hosta"}
    },
    {
      "label": "hostb", "baseUrl": "http://127.0.0.1:26042",
      "imageId": "sha256:<64 lowercase hex characters>",
      "dataIdentity": "owned-volume-b",
      "ownership": {"runId": "release-test", "hostLabel": "hostb"}
    }
  ]
}
```

Host labels, data identities and loopback origins must be distinct. Every host's runtime identity and ownership must match the manifest. Public addresses, URL credentials and extra URL paths are rejected. More than two hosts are supported; every host requires a job file and every contract provider.


### Native runtime provenance

For `windows-wsl2`, `macos` and `ubuntu`, omit every `imageId` field. Declare a native package set with the exact version and archive SHA256 of each runtime package. Include the complete package set installed on each host, not just the changed plugin. The compiler hashes this declaration; an external host inventory must independently verify that it describes the installed bytes.

```json
{
  "platform": "ubuntu",
  "runtime": {
    "kind": "package-set",
    "digest": "sha256:<computed package-set digest>",
    "packages": [
      {"name": "@woowtech/pi-paseo", "version": "0.1.17", "archiveSha256": "<64 lowercase hex characters>"},
      {"name": "@woowtech/pi-omnigent", "version": "0.3.33", "archiveSha256": "<64 lowercase hex characters>"}
    ]
  }
}
```

This excerpt describes the field shape, not a complete runtime inventory. Keep the scope/run/ownership/data/loopback fields from the full manifest. Each native host uses `runtimeIdentity: "package-set:sha256:<computed package-set digest>"` instead of `imageId`. Generate the digest with the exported `packageSetDigest(packages)` in `runtime.mjs`: it hashes compact UTF-8 JSON of the rows sorted by package name, with fields ordered `name`, `version`, `archiveSha256`. Missing archives, duplicate names, floating versions, changed bytes or a mismatched digest are rejected.

Container manifests can alternatively declare `runtime: {kind: "container-image", imageId: "sha256:..."}` and per-host `runtimeIdentity: "image:sha256:..."`. Existing image-based manifest fields remain supported after adding an explicit platform. New reports record the explicit platform, typed runtime and runtime identity. Native package digests are never labeled as image IDs. The compiler derives platform from the manifest and rejects a different optional CLI platform argument. These declarations do not grant provider turns or authorize production actions.

## Pair and use existing conversations

From the package checkout:

```sh
node tests/smart-parity/browser/pair.mjs woowtech pair
node tests/smart-parity/browser/pair.mjs woowtech inspect
```

Pairing selects/saves the target through the GUI, stops/restarts the service as needed, and verifies selected/active target and health. It obtains the private offer and uses the public confirmation controls with the Smart security prompt's delay and keyboard gesture. A removed URL fragment is insufficient: confirmation must close and each distinct server must appear in the public host picker. `inspect` checks the existing profile without switching the connector.

Run the provider observer's `prepare BRAND` action on each owned host, then copy its `web-jobs.json` into the private evidence directory. Keep checkpoints and expected read markers private. Provider acceptance, Web jobs, checkpoints and verifier reports must carry the manifest's exact `runtimeIdentity`; evidence from another image/package set is rejected even if host and agent IDs were retained. Run:

```sh
node tests/smart-parity/browser/conversations.mjs woowtech \
  /private/acceptance/hosta-web-jobs.json /private/acceptance/hostb-web-jobs.json
```

The runner binds pairing to the platform, run and exact runtime, opens the expected active agent, selects the prepared model in the public menu, sends the prepared prompt, and requires its unique assistant marker. After reload it verifies the same selected agent, assistant marker, origin and workspace path. The app deliberately consumes/removes the `open=agent:...` query.

Browser success remains `ui-completed-awaiting-tool-verification`. Afterwards run `../provider/observe-web-acceptance.mjs ... verify BRAND`: requested/actual model, successful new tools, shared skill/MCP/memory results and persisted writes must independently pass. Labels or assistant claims alone do not prove them. Repeat for `apporo` and `paseo` with their prepared jobs; external orchestration owns brand order, shared resources and cleanup.

## Private evidence and retries

`web-live/BRAND-profile/` contains persistent pairing credentials. Every invocation creates a distinct `web-live/attempts/` directory containing exported actions, screenshots, accessibility snapshots and report. All three brands retain their original Craft records in one private `web-live/shared.cany` project. A current report is also written under `web-live/`; previous attempts remain intact. Files use `0600`, directories `0700`.

Never commit or publish browser profiles, manifests, offers, screenshots, conversations, credentials, checkpoints or raw Craft output. Declared pairing values are hidden from Craft and masked in textual errors; that does not make authenticated captures public. Use the run owner's bounded cleanup after review. Run all browser and comparison processes sequentially. An exclusive `.craft-run.lock` refuses simultaneous writers across brands. The lock is released on normal closure or a handled failure; after a killed process, verify that its recorded PID is no longer active before the run owner removes only that stale lock. Never delete the retained project to clear a lock.

## Verification

```sh
node --test tests/smart-parity/browser/*.test.mjs
node --check tests/smart-parity/browser/pair.mjs
node --check tests/smart-parity/browser/conversations.mjs
```

Tests reject wrong scope/image/ownership, shared data, mismatched pairing/jobs, reused markers, a different active agent after reload, absent assistant evidence and wrong origins. They verify harness assertions, not actual public-site/provider acceptance.

## Compare the three full GUI flows

After pairing and completing each provider conversation for all three brands, use the same private evidence root and pinned Craft executable:

```sh
node tests/smart-parity/browser/compare.mjs
```

The command needs `SMART_PARITY_EVIDENCE_DIR` and `SMART_PARITY_CRAFT_CLI` (and optional manifest override); it does not launch a browser or send provider turns. It reads the current successful pairing/conversation reports, validates their platform/runtime/host bindings, and compares every corresponding saved action group for Woowtech–Apporo, Woowtech–Paseo and Apporo–Paseo. This covers target/save/start/connect, host picker, model selection, message send, completion and reconnect, plus any recorded stop/provider-menu steps.

All records must belong to `web-live/shared.cany`. The runner passes saved evidence IDs to Craft instead of reserializing captured browser values, which can change floating-point content hashes. Attempt exports remain untouched. Do not silently relabel an old separate project as the shared project or mix prior failed-image evidence into a new root. Preserve the shared project with the raw exports for reproducibility.

A missing action group is retained as `missing-corresponding-actions` and causes nonzero exit; it is not normalized away. Existing brand-only normalization leaves missing controls, errors, versions, tool results and undeclared volatile values visible. `complete: true` means all requested comparisons ran, not that the products are equivalent. Inspect each raw comparison and independently verified provider result. The report is stored in a unique comparison attempt directory and at `web-live/comparisons.json`.

## Compile retained evidence

Copy each host observer's unmodified reports and raw timelines into `hosts/HOST/evidence/BRAND/`. Keep `provider-acceptance.json`, `web-verification.json` and every timeline named by them. The compiler joins these reports to the browser reports and exported Craft records; filenames alone do not authorize a pass.

```sh
node tests/smart-parity/compile.mjs /private/acceptance k3s-paas
node --test tests/smart-parity/compile.test.mjs
```

The default manifest is `browser-hosts.private.json`. The compiler writes private `matrix.json` and `matrix-audit.json`, returns nonzero for incomplete or failing acceptance, and records absent cases as `unrun`. Missing files remain explicit evidence references so the integrity audit fails. It rejects stale platform/runtime/run/host/agent/model bindings, duplicate providers, unresolved or ambiguous Craft IDs, incomplete actions, invalid schema checks and reuse of one Craft record for different host/provider identities. Pair rows include each host's target/save/start/connect actions plus the public host-picker record. If a stop was performed, its record is retained too. Reconnect evidence requires the same selected agent and assistant marker after reload.

Compilation verifies evidence completeness and bindings. The provider observer must independently verify completed tools and persisted state; a status label or a successful click does not establish those facts. Preserve the observer checkpoint, actual raw timelines and exported Craft records for semantic review. Synthetic unit fixtures verify fail-closed assertions only and are never acceptance evidence. An isolated candidate matrix never certifies production deployment or another platform.
