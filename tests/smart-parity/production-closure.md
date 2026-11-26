# Pi3 / Pi4 production operating sequence — prepared, not executed

This is the Pi3/Pi4 operator sequence for the separately reviewed site adapter bundle. This repository provides the JavaScript standard, guarded browser launcher and offline validators. **An npm install or a standalone checkout does not install the production Python transport.** Source readiness and synthetic tests are not production PASS. Genuine canonical promotion, actual deployment/migration preservation and per-action admission remain required. The ordinary isolated 178-case standard remains self-contained and retains its existing CLI and safe pre-mutation resume.

Use the existing genuine canonical/human gate and exact published/deployed digest. A pending tag is rejected. Pi3 is `svc-febb366b` / service173; Pi4 is `svc-966321b4` / service172. Pi7 remains outside this adapter. All working directories below are new absolute private0700 directories; JSON inputs are0600. Run Python commands from the external `live-acceptance` directory specified below. These are explicit operator actions; none are run by installing this package or by the default local browser `check`.

## External adapter prerequisites and exact command location

[production-adapters.json](production-adapters.json) inventories the required nonsecret external source bytes. It is a source lock, **not** a distribution archive, approval receipt or replacement for authenticated CI/human verification. Obtain the reviewed source bundle from the coordinating workspace/operator; it is not shipped in this repository or the npm package. Do not substitute handwritten adapter stubs or use the test fixture parent in production.

The reviewed deployment layout is:

```text
/data/pi-agent/home/work/pi-smart-connectors-20261121/
  live-acceptance/                         # Python/mjs files in the source lock
    canary-validation-sidecar-20261121-r3/  # real Pi Web locked MCP editor bundle
    paas-odoo-ci/                          # canonical source checkout/verifier inputs
  Woow_k3s_pi_agent_package/               # canonical root publication verifier
  pi-paseo-production-multisession-20261121/ # reviewed standard 1b5a8765...
  pi-paseo-provider-canary-sidecar-20261121/ # guarded five-file harness de09f3fd...
```

The production launcher resolves its parent at the fixed sibling path `../live-acceptance/canary_browser_transport.py`. The external assembly code also resolves the reviewed standard directory above, and the provider transport verifies the five-file harness against commit `de09f3fddbb5bef3a7468dec13fbbabbc5893e59`. Installing only this PR in an arbitrary directory does not satisfy those dependencies. Changing that layout or source pin requires updating and testing the adapter bundle; no arbitrary parent-command switch is provided.

Other prerequisites are Python3 with PyYAML, Node22.19+, the site's existing authenticated canonical/registry/Odoo access, kube context `woow-k3s`, and installed kubectl/Helm at `/data/pi-agent/home/.local/bin/`. The adapter reads the canonical PaaS workflow and approval scripts plus `tools/pi-tenant/inspect_ui_state.py`; the root verifier is `Woow_k3s_pi_agent_package/scripts/image-publication.py` (pinned SHA256 `93ac8618fe64329872681f1eb6a94146c249e101458ed8e8af72dc0bca19abd8`). The existing verifier checks these against authenticated workflow source. Credentials, live approvals, baselines, tokens, browser profiles and private evidence must never be committed here. No local HMAC secret export is needed.

Check the adapter source lock locally before using that fixed deployment:

```bash
CANARY_STANDARD=/data/pi-agent/home/work/pi-smart-connectors-20261121/pi-paseo-production-multisession-20261121
CANARY_ADAPTER_DIR=/data/pi-agent/home/work/pi-smart-connectors-20261121/live-acceptance
# CANARY_SOURCE_LOCK is this checkout's absolute tests/smart-parity/production-adapters.json.
python3 - "$CANARY_SOURCE_LOCK" "$CANARY_ADAPTER_DIR" <<'PYTHON'
import hashlib,json,sys
from pathlib import Path
lock=json.loads(Path(sys.argv[1]).read_text());root=Path(sys.argv[2])
for name,expected in lock['files'].items():
    file=root/name
    assert file.is_file() and not file.is_symlink(), name
    assert hashlib.sha256(file.read_bytes()).hexdigest()==expected, name
print('External adapter source bytes match; this grants no production authority')
PYTHON
cd "$CANARY_ADAPTER_DIR"
```

Set the actual installed Playwright, Chromium and pinned Craft paths; these paths are operator dependencies, not bundled executables:

```bash
export SMART_PARITY_PLAYWRIGHT_MODULE=/data/pi-agent/home/work/pi-smart-connectors-20261121/pi-web-adapter/node_modules/playwright/index.mjs
export SMART_PARITY_CHROMIUM_EXECUTABLE_PATH=/data/pi-agent/home/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell
export SMART_PARITY_CRAFT_CLI=/data/pi-agent/home/work/pi-smart-connectors-20261121/live-acceptance/tools/craft-anything-cli
CANARY_CRAFT_CLI="$SMART_PARITY_CRAFT_CLI"
# Set SMART_PARITY_NO_SANDBOX=1 only in the site's existing container setup that requires it.
node "$CANARY_STANDARD/tests/smart-parity/browser/production.mjs" check
```

The local `check` opens no parent, tunnel or browser and does not verify installation/authentication. Live actions start the actual fixed Python parent and must pass its canonical and fresh runtime/activity checks. The repository's normal Node tests do not require this external bundle. The optional `production-launcher.browser-check.mjs` additionally requires the external `test_canary_browser_launcher_fixture.py` and its Python test dependencies; it is an offline operator integration test, not an installed CLI.

See [session and completion schema](production-sessions.md), [parent protocol](browser/production-guard-parent-contract.md), and [observer semantics](provider/observer-contract.md). The sequence below describes live actions only after the existing genuine gate; it is not evidence that they ran.

## 1. Genuine promotion, then deployment, one host at a time

After the controller's existing gate is satisfied, use a separate deployment receipt directory for each host. Capture → plan → inspect the returned exact plan → apply ONCE using **the printed canonical `planSha256`**, not a raw file SHA. Do not batch/retry apply. Verify actual rollout/image/PVC/runtime/identity/idle before moving to the next host; `submitted` alone is not successful rollout.

```bash
python3 canary_pin.py capture "$CANARY_RELEASE" --receipts "$CANARY_DEPLOY_RECEIPTS"
python3 canary_pin.py plan "$CANARY_RELEASE" --receipts "$CANARY_DEPLOY_RECEIPTS" --image "$CANARY_PUBLISHED_IMAGE" --chart 0.1.20 --canonical-selector "$CANARY_SELECTOR"
python3 canary_pin.py apply "$CANARY_RELEASE" --receipts "$CANARY_DEPLOY_RECEIPTS" --plan-sha256 "$CANARY_PLAN_SHA"
```

Selector fields are the real `buildRunId`, `promotionRunId`, `approvalIssue`, `approvalCommentId`, `rootPublicationRunId`. No new approval, fake boolean, or HMAC export is introduced. Existing concurrent activity, changed identity/CAS, expired plan or uncertain dispatch means stop/inspect, never automatic replay.

## 2. One shared validation run, original baselines before any fixture writes

Both hosts must already run the exact accepted published image. This read-only prepare saves original immutable host/transport bytes plus full resource baselines before staging journals:

```bash
python3 canary_validation.py prepare --receipts "$CANARY_RUN_DIR" --image "$CANARY_PUBLISHED_IMAGE" --canonical-selector "$CANARY_SELECTOR"
```

For EACH release (`svc-febb366b`, then `svc-966321b4`), use the following actual external adapter commands:

```bash
python3 canary_validation.py check --receipts "$CANARY_RUN_DIR" --release "$CANARY_RELEASE" --phase woowtech
python3 canary_validation.py stage-editor --receipts "$CANARY_RUN_DIR" --release "$CANARY_RELEASE" --phase woowtech
python3 canary_validation.py fixture --receipts "$CANARY_RUN_DIR" --release "$CANARY_RELEASE" --phase woowtech --request "$CANARY_PREPARE_REQUEST"
python3 canary_validation.py fixture-snapshot --receipts "$CANARY_RUN_DIR" --release "$CANARY_RELEASE" --phase woowtech
```
 Prepare request is `{"action":"prepare"}`. Derive and stage the five-file harness ONCE per host; never restage/recreate between brands. The separate local output filename must be `acceptance-manifest.json` in that host's private directory.

The following shell helper only supplies repeated arguments; defining it performs no action:

```bash
canary_harness() {
  python3 canary_provider_harness.py "$@" \
    --validation-manifest "$CANARY_RUN_DIR/validation-manifest.json" \
    --receipts "$CANARY_RUN_DIR" --release "$CANARY_RELEASE" --phase "$CANARY_PHASE"
}
CANARY_PHASE=woowtech
canary_harness derive --output "$CANARY_DERIVED_MANIFEST"
canary_harness stage --output "$CANARY_DERIVED_MANIFEST"
```

## 3. First brand pairing, then each host's discovery and one configuration

Keep one stable `CANARY_BROWSER_EVIDENCE` directory for all three brands, including `web-live/shared.cany`. For each brand in order **woowtech → apporo → paseo**, pair both hosts, then enable coordination BEFORE provider agent creation:

```bash
node "$CANARY_STANDARD/tests/smart-parity/browser/production.mjs" pair --receipts "$CANARY_RUN_DIR" --evidence "$CANARY_BROWSER_EVIDENCE" --brand "$CANARY_PHASE" --seconds 1800
node "$CANARY_STANDARD/tests/smart-parity/browser/production.mjs" coordination --receipts "$CANARY_RUN_DIR" --evidence "$CANARY_BROWSER_EVIDENCE" --brand "$CANARY_PHASE" --seconds 1800
```

Retain every emitted original browser manifest/proof root. Keep the first manifest as the closure anchor; the later phase capture uses the actual selected phase/session manifest, never relabelled. Initial canonical/idle/tunnel setup precedes the1800-second lease; subsequent work consumes it. Every actual write still needs fresh30-second admission; no renewal/replay.

On the FIRST brand, separately on Pi3 and Pi4:

```bash
canary_harness run --runner-action discover
canary_harness configure --selection "$CANARY_HOST_SELECTION"
```

Discovery output is retained in the private `provider-runner-RELEASE-UUID.log` and its matching result JSON (action/phase/source/log hash); CLI stdout only returns the result hash. Inspect the exact receipt for that invocation, not an unbound latest log. Read actual `discovery.providers`, `discovery.models` and profiles. Select only available/enabled providers and exact returned IDs.

`CANARY_HOST_SELECTION` is an array of exactly three rows, each with `id`, `model`, `alternateModel`; optional `modeId` and `thinkingOptionId` must come from that host's discovery. When a thinking option is supplied it must be supported by BOTH selected models. Preserve the chosen mode/thinking in actual agent creation. Configure is once per host for the whole multibrand run; the current code refuses replacing a nonempty selection.

| Provider | `model` (initial AND Web target) | `alternateModel` (backend switch) |
|---|---|---|
| Claude | Exact discovered Sonnet4.6 ID | Exact discovered Haiku4.5 ID |
| Codex | First explicitly selected discovered model | Second distinct discovered model |
| Pi | First explicitly selected discovered model | Second distinct discovered model |

Sonnet → Haiku → Web Sonnet is the intended Claude direction on both production hosts, conditional on their own discovery. Root reports owned5164 Paseo hostb Sonnet-initial/Haiku-alternate backend PASS. That is selection evidence, not production execution or a fix for the preserved Haiku-initial greeting/noncompliance. Do not infer Pi3/Pi4 IDs/modes from owned hosts, change product defaults, or swap models during a partially executed run. If a chosen model is absent, stop and report that actual discovery.

## 4. Each brand: backend, Web, isolation, owned-agent cleanup, final capture

For each host, `run` must pass before `web-prepare`. Both hosts must be ready before the one browser conversation invocation (six jobs, three providers per host):

```bash
canary_harness run --runner-action run
canary_harness run --runner-action web-prepare
node "$CANARY_STANDARD/tests/smart-parity/browser/production.mjs" conversations --receipts "$CANARY_RUN_DIR" --evidence "$CANARY_BROWSER_EVIDENCE" --brand "$CANARY_PHASE" --seconds 1800
canary_harness run --runner-action web-verify
```

Run the first two and last commands separately for Pi3/Pi4; run `conversations` ONCE for the two-host group. Require exact requested/snapshot/runtime model binding and actual tool events, including explicit fixture MCP and `pi_shared_memory` server. Do not reinterpret a greeting or no-tool response as PASS.

After BOTH hosts' `web-verify` pass, run this once per destination host:

```bash
canary_harness import-foreign
```

The adapter obtains the exact opposite host through the same immutable validation manifest. It reads that host's original phase report/checkpoint/timelines, independently reruns the existing Web tool observer, checks actual memory revisions and returned write journals, then imports only those three keys using the destination's fresh admission and exclusive CAS. It retains the peer proof/request/result; no caller key/path list, unguarded remote edit or retry is accepted. Then, separately per host:

```bash
canary_harness run --runner-action isolation
canary_harness run --runner-action cleanup
python3 canary_completion_transport.py capture-provider --receipts "$CANARY_RUN_DIR" --release "$CANARY_RELEASE" --phase "$CANARY_PHASE" --browser-manifest "$CANARY_PHASE_BROWSER_MANIFEST" --output "$CANARY_PHASE_FINAL_CAPTURE"
```

Capture into a NEW directory after cleanup so the original lifecycle results exist. Do not overwrite earlier Web-job captures. The command now captures all five reports and every referenced owned timeline (including prior-provider and coordination receiver traces), before changing brand. Its returned `result.directory` is the exact directory used by later `--phase-capture`; it is nested below the requested output root. Cleanup only actual journal-owned conversations/workspaces; retain original fixture MCP/skill/memory, mutable write history and prior-brand Web writes across brands. Then repeat pairing/coordination/provider/Web/isolation/cleanup/capture for the next brand. Do not derive/stage/configure again.

## 5. Restore targets, then fixture cleanup, then portable completion

After all three brand phases pass and all owned agents are cleaned, per host:

1. `canary_completion_transport.py restoration-request` for current phase paseo.
2. `canary_validation.py restore ... --phase paseo --seconds 300 --request <returned request>`; retain the actual returned `restorationReceipt`.
3. Only after successful restoration, `fixture --request <private {"action":"cleanup"}>` under that host's actual original target. The existing locked compare/remove and memory CAS preserve user changes; no whole-file overwrite.
4. `assemble` with that returned restoration receipt and three exact final capture directories.
5. `finish` under that host's original target, the same anchor browser manifest, and the same new private portable output directory for both hosts. Do not create another browser session between the two finishes.

Set `CANARY_ORIGINAL_TARGET` to that host's actual saved target. These are the exact closeout entries; `CANARY_CLEANUP_REQUEST` is private JSON `{"action":"cleanup"}`. Use the returned restoration path, never a caller-created receipt:

```bash
python3 canary_completion_transport.py restoration-request --receipts "$CANARY_RUN_DIR" --release "$CANARY_RELEASE" --phase paseo
python3 canary_validation.py restore --receipts "$CANARY_RUN_DIR" --release "$CANARY_RELEASE" --phase paseo --seconds 300 --request "$CANARY_RESTORE_REQUEST"
python3 canary_validation.py fixture --receipts "$CANARY_RUN_DIR" --release "$CANARY_RELEASE" --phase "$CANARY_ORIGINAL_TARGET" --request "$CANARY_CLEANUP_REQUEST"
python3 canary_completion_transport.py assemble --receipts "$CANARY_RUN_DIR" --release "$CANARY_RELEASE" --restoration-receipt "$CANARY_RESTORATION_RECEIPT" --phase-capture "woowtech=$CANARY_WOOW_CAPTURE" --phase-capture "apporo=$CANARY_APPORO_CAPTURE" --phase-capture "paseo=$CANARY_PASEO_CAPTURE" --output "$CANARY_COMPLETION_INPUTS"
python3 canary_completion_transport.py finish --receipts "$CANARY_RUN_DIR" --release "$CANARY_RELEASE" --phase "$CANARY_ORIGINAL_TARGET" --browser-manifest "$CANARY_BROWSER_MANIFEST" --inputs "$CANARY_COMPLETION_INPUTS" --output "$CANARY_PORTABLE_COMPLETION"
```

The captures above are host-specific; use the same private portable completion root for both host finishes. This produces **five additional cases per host**: canonical provenance, non-owned baseline preservation, owned-agent cleanup, fixture cleanup, configuration restoration. These ten cases cannot replace any failed functional test.

## 6. Assemble the final private root; compile and actual Craft comparison

Keep the SAME portable completion output for the two host `finish` commands, and the SAME browser evidence root for all brand runs. Both host completions must exist before full assembly. Six capture arguments are the exact `result.directory` returned by each final `capture-provider`, not guessed paths. Source roots are read-only; output must be a NEW absolute private directory.

```bash
python3 canary_evidence_assembly.py assemble \
  --completion "$CANARY_PORTABLE_COMPLETION" \
  --browser "$CANARY_BROWSER_EVIDENCE" \
  --output "$CANARY_FULL_EVIDENCE" \
  --phase-capture "pi3:woowtech=$CANARY_PI3_WOOW_CAPTURE" \
  --phase-capture "pi4:woowtech=$CANARY_PI4_WOOW_CAPTURE" \
  --phase-capture "pi3:apporo=$CANARY_PI3_APPORO_CAPTURE" \
  --phase-capture "pi4:apporo=$CANARY_PI4_APPORO_CAPTURE" \
  --phase-capture "pi3:paseo=$CANARY_PI3_PASEO_CAPTURE" \
  --phase-capture "pi4:paseo=$CANARY_PI4_PASEO_CAPTURE"
node "$CANARY_STANDARD/tests/smart-parity/compile.mjs" "$CANARY_FULL_EVIDENCE" k3s-paas
node "$CANARY_STANDARD/tests/smart-parity/audit.mjs" "$CANARY_FULL_EVIDENCE/matrix.json"
SMART_PARITY_EVIDENCE_DIR="$CANARY_FULL_EVIDENCE" \
  SMART_PARITY_HOST_MANIFEST="$CANARY_FULL_EVIDENCE/browser-hosts.private.json" \
  SMART_PARITY_CRAFT_CLI="$CANARY_CRAFT_CLI" \
  node "$CANARY_STANDARD/tests/smart-parity/browser/compare.mjs"
```

Assembly preserves original session manifests/epochs, four-file completion captures, all five functional reports, referenced timelines, returned mutation journals/peer import proofs, browser reports and retained Craft store bytes. It records both original source hashes and derived output hashes; only standard binding copies are derived. Non-identical collisions, symlinks, changed sources, unbound sessions/hosts, missing timelines, modified original tool events and an active Craft writer fail closed. Craft-owned 0644 blobs inside its private0700 retained root are copied byte-for-byte into600 files; the source is never chmodded. Profiles/cookies and unrelated sibling files are not exported.

Require188 required/recorded cases, allPASS, zero problems/unsuccessful; those are actual runtime assertions, never generated from the ten completion checks. Compile AND independent audit re-evaluate captured Web tool evidence with the strict observer described in [observer semantics](provider/observer-contract.md). Final `comparisons.json` must be complete with actual retained IDs and original manifest/transport/session refs. The comparison count follows actual action groups (not assumed147); preserve reported differences for review. A completed Craft comparison is not functional equivalence.

Migration preservation is separate: original old-image before data and actual postdeployment migration receipt must remain alongside this new validation run. The site operator must retain the separate raw-preserving migration receipt outside this repository. Do not relabel a postdeployment baseline as preupgrade evidence. Pi7 remains outside this adapter.

Local source readiness uses `test_canary_full_pipeline` (synthetic returned Python captures→portable assembly→actual JS188 compile/audit; actual Chromium+pinned Craft39 retained records/comparisons) and `test_canary_foreign_keys` (real local CAS/parent journal and negative boundaries). These tests make zero production/provider requests and do not authorize deployment or model turns.
