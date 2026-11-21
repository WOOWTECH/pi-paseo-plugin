# Production browser parent contract

The dedicated launcher requires the actual fixed Python parent described in [production prerequisites](../production-closure.md). This schema grants no production authority. The parent authenticates canonical CI and observes the real current runtime, Pod/container/PVC/mount and owned activity before each server mutation. Static proof files are evidence, not authorization.

`controlledStop` still references the exact reducer output and `journal.preStopReference` the immutable pre-stop checkpoint. The stopped start/save branch additionally requires:

```json
{
  "controlledStopJournals": {"path": "private-relative-file.json", "sha256": "raw-file-sha256"}
}
```

That private file contains:

```json
{
  "schema": "agent-connect-returned-transition-bytes/v1",
  "records": {
    "RELEASE-ATTEMPT.jsonl": {
      "journalBase64": "EXACT original JSONL bytes in canonical base64",
      "resultBase64": "EXACT original result-envelope bytes in canonical base64"
    }
  }
}
```

Copy exactly `proof.stopJournal` plus all ordered `proof.transitionJournals` from their existing private files, while holding the host evidence lock. Preserve original bytes and timestamps; never reconstruct rows from `journalIndex`. The browser verifies raw hashes, Python canonical hash chains, returned status/result, original epoch/canonical proof, exact operation payload and before/after connector/hash transitions. Missing bytes, unresolved intents, intervening journals, persistent identity changes, stale activity, remaining daemon processes or Pi queues fail closed. The old full SDK snapshot stays explicitly historical; the current stopped observation must have no `activity`, `snapshot` or `sdk` substitute.

The exact payload is `{kind, hostLabel, expectedConnector}`; phase/target belongs to the outer bound request. The controlled-stop reducer accepts only the node executable in the immutable fixture manifest (`/usr/bin/node` or `/usr/local/bin/node`) and verifies the original manifest and MCP entry hashes.

Controls are ported from root `271b98196a8a544948998203854e2452710fb4f8`. Model-open, prompt-fill and send use the actual SINGLE visible composer under the owned selected-agent pane, including hidden inactive composers mounted within the same pane. Craft selectors consist only of the owned pane, selected tab, bounded direct-child path and exact typed control. They are rederived immediately before recording. Navigation, reload, menu/focus/fill and local target selection acquire no mutation grant or journal. The isolated CLI retains its verified-prefix resume; production sessions reject resume.

The reviewed external parent supplies this reference through `returned_transition_bytes()` and the browser validates it before a stopped transition. Local tests and synthetic Chromium fixtures are not production receipts.
