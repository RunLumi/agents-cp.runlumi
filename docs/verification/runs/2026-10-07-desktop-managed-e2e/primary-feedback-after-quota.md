# Primary Claude feedback after quota reset

No implementation from the failed credential-agent launches occurred. Resume at
11:40 Asia/Ho_Chi_Minh only after verifying availability. Maintain 2–3 disjoint
owners; Codex reviews/tests and joins artifact/runtime work. All original FAIL
evidence remains authoritative at its recorded scope.

## 1. Recovery phase CI (candidate clone / PR52 only)

Exact server `4f730a52c6ad8b0abde8f204f473315cf399d796`, client `2a49525`, local
clean-head SDK/HTTP PASS, quality CI PASS. Adoption CI attempts1/2 both fail with
`UND_ERR_SOCKET` at different calls after D1 CLI operations. Do not rerun again
without repair/diagnostics; do not classify network errors as expected403/401.

`runWrangler` uses synchronous subprocess calls; blocked event-loop/idle socket
reuse is a hypothesis. Minimal isolated GET and POST keep-alive controls both
passed, so blocking alone is not a proven cause. Linux Worker diagnostics are
missing from uploaded artifacts. Capture bounded redacted worker/process/health
evidence and reproduce the exact boundary. Do not add automatic retries of
non-idempotent recovery operations or weaken gate expectations.

## 2. Automation race and cleanup (parent/client runtime packet)

Full actual isolated run `automation-full-isolated`, profileVPdMKK, FAIL:
bound-to-A eligibility positive control passed; public owner PATCH removed the
binding and admitted both devices. Contested occurrence then failed with
`run_activation_failed`; P05 run stayed queued with NULL workspace binding.

Source chain: P06 `start` copies definition target binding into run; Main execution
requires a matching authorized non-NULL binding. Also `managedRunTransport.#run`
requires a string binding, so initial get and cleanup get reject the run. Activation
catch swallows cleanup read failure and cannot cancel it. P05 domain permits
queued→cancelled. This does not authorize binding-less execution.

First freeze the proper client/server binding-resolution contract for two actual
eligible clients, including current org/project/device/workspace authorization.
Do not fix race by weakening Main guards or treating a marker as authority.
For cleanup, distinguish safely reading an owned server grant's run metadata from
authorizing execution; terminal readback is required. Preserve losing-client
content/effect controls, no implicit workspace adoption, no D1 authority bypass.

## 3. Stop authority and verifier sensitivity (disjoint client / harness paths)

- Bridge `MAX_REMEMBERED_RUNS` eviction loses the oldest active accepted run's
  owning Host after257 dispatches. Latest-run cancel positive control works;
  oldest cancel returns unknown. Evidence: `active-run-owner-eviction-reproducer.log`.
  Preserve stop authority until a proven terminal outcome; bound new admission
  or retire terminal ownership deliberately, never evict an active owner.
- Empty stage ledger currently finishes with PASS. Positive-claim control passes,
  zero-claim stage must remain UNPROVEN. Evidence: `empty-stage-ledger-reproducer.log`.
  Add executable positive/negative tests and rerun original reproducer; no test
  count or empty verdict list may substitute for an executed claim.

## 4. Required credential choices

Use `DE2E-INT-03-CRED.md`: mode-only PATCH conformance bug needs actual response,
stored row/version and idempotent replay proof. Client hardcoded local mode must
preserve the explicit frozen three choices. P08 modes are labels, separate from
P04 routing/provisioning. Existing web-console secure provisioning, consent,
metadata-only non-disclosure, no local-key reading/export and rollback semantics
remain required. Backend and client owners have disjoint write surfaces.

## Standing proof limits

Old Agent HOME runs do not certify profile isolation. Current native keystore
availability plus in-profile Agent output and selected Host roots are scoped
proof, not proof that every Main reader avoids personal state. External provider,
passkey desktop ceremony, fault/entitlement/off-peak boundaries, compatibility,
clean bootstrap/performance and final merged pair remain incomplete. PR51/39/52
are drafts; no authorized merge before the full recorded gates are satisfied.
