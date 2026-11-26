# Production browser sessions and completion

This is an offline evidence contract. Canonical CI/human approval verification
and fresh per-operation admission remain in the authenticated Python transport.
The dedicated `browser/production.mjs` launcher owns a real authenticated Python
parent; this offline schema alone grants no execution. The ordinary browser
CLIs remain isolated-only. See [production operating sequence](production-closure.md) for the exact external
adapter bundle, fixed command location and prepare/pair/coordination/provider/
conversation/restoration sequence. Those Python adapters are not installed by npm.

Each bounded BrowserSession writes its original browser and transport bytes and
registers their raw path/SHA references. New sessions can change only loopback
ports, tunnel PIDs/expiry and the location of an identical transport copy. Both
host Pod/container/image/PVC/server epochs, baseline, canonical authority and
fixture scope must remain identical. A stopped baseline is still unsupported.

The completion bundle's `production-sessions.json` has this shape:

```json
{
  "schema": "agent-connect-browser-sessions/v1",
  "scope": "production-canary",
  "runId": "original-run-id",
  "primarySourceManifestSha256": "python-canonical-manifest-sha256",
  "transportSha256": "original-raw-transport-sha256",
  "sessions": {
    "python-canonical-manifest-sha256": {
      "manifest": {"path": "session-manifests/HASH.json", "sha256": "raw-sha256"},
      "transport": {"path": "session-manifests/transport.json", "sha256": "raw-sha256"}
    }
  }
}
```

The anchor `browser-hosts.private.json` and every session file retain original
bytes, including original absolute guard paths. The portable bundle resolves
transport through the index's exact raw hash; it does not rewrite those paths.
Every source manifest is independently validated, including actual approval
references and original full baseline. Python canonical hashing preserves JSON
number representation; raw SHA checks remain separate.

All three phases retain four original capture envelopes. Derived lifecycle
reports retain each capture's own `sourceManifestSha256` and reference the raw
capture. The independent completion validator checks those originals, all browser
journals' exact session identity/tunnel/deadline, and the returned restoration
sequence's original session and journal refs. Historical expiry is evaluated at
the original dispatch, not renewed at completion. Current SDK observations are
never fabricated from historical stop snapshots.

`validateProductionReport` stays strict by default. Only offline compile/cleanup
calls opt into another independently verified session. Live jobs and new reports still require the current manifest exactly. The
dedicated launcher may read a prior pairing report only by validating it against
its original registered manifest and identical immutable host/transport epochs;
it never stamps old pairing bytes with a new source hash. All matrix rows retain the
index and session proofs for audit. Cleanup PASS cannot replace failed functional
or Craft evidence.

The operational Python sequence is `restore` → fixture cleanup → local
`canary_completion_transport.py assemble` → authenticated read-only `finish` →
JS `productionCompletion` for both hosts. Assembly resolves the unique returned
cleanup request and actual restoration receipt; there is no handwritten proof
or new approval boolean. Existing source/capture/journal bytes are not modified.

`production-multisession.test.mjs` is included by both existing CI test globs.
The separate Python adapter tests run the actual CLI/reducer → this validator,
including portable raw bundles, expired historical sessions, fresh restoration,
tampered epochs/capture references, and whole-matrix compile/audit behavior.

The executable launcher has no alternate-command/test/approval bypass. Its fixed
parent calls the actual canonical verifier and returns private raw references;
stdout is a bounded correlated begin/finish protocol. EOF, timeout, wrong hash,
concurrent calls and malformed frames fail closed without replay. Production
launch requires a managed parent capability, the exact config and its real guard.

`browser/production-launcher.test.mjs` is included by the existing CI browser
test glob. `browser/production-launcher.browser-check.mjs` is an explicit offline
integration with actual Python stdio, Chromium and pinned Craft. It copies the
unchanged standard modules into a temporary test tree, where only host and
authority observations are synthetic; no production entry has a test switch.
It requires the coordinating workspace's Python fixture and installed tool paths.

The browser parent/launcher allow an explicit 1..1800-second session (default 1800).
Both initial canonical/idle/tunnel setup calls precede lease creation; job capture,
ready, Chromium and all subsequent work consume that original expiry. The serve
loop uses remaining lease time rather than granting a new duration at ready.
Every mutation keeps its original 30-second freshness deadline, and the individual
parent-response timeout is unchanged. There is no renewal or automatic replay.
The independent restoration CLI remains capped at 600 seconds.
