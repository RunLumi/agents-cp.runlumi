# Desktop E2E continuation — UI source and HTTP cancellation

Full goal: **INCOMPLETE**. No phase02 commit, PR or production deployment in this continuation.

## Actual source UI

Original report `tests/lumi-ui-proof/evidence/2026-10-09T12-14-13-500Z-2a49525/report.json`:
50 PASS / 6 FAIL, missing keyboard focus and credential-fieldset overflow at320px.
Claude applied source repairs: defined brand focus outline with forced-colors Highlight,
fieldset min-width0, wrapping console button.

Current report: `evidence/20261009-ui-actual-source-node24-report.json`, 56PASS,
Node24.19.0 explicitly recorded, source hashes recorded on dirty baseline2a49525.
Claude tool result records exit0, browser.close385ms and server.close9ms.
This is real React rendering over a synthetic host bridge; it does not prove native
Electron, keystore, IPC, backend authorization, or the complete startup account matrix.

UI sensitivity remains **UNPROVEN** as a complete campaign. The reread-keeps-projection
mutant detects the intended two failures, but browser.close timed out10s twice and
the repaired runner exits3. Earlier unbounded hangs and interruptedexit130 reports
remain preserved; green assertion counts alone did not close the gate.

## HTTP provider cancellation

`evidence/20261009-http-cancel-signal-runtime.log` uses the actual Rust HTTP adapter,
fresh Worker/D1, Node24.19.0, owned node outboundService HTTP socket fixture, no
redirect shim. Critical claim ledger overallPASS; external provider remainsBLOCKED.
Socket closes85ms after3frames; D1 requestfailedrequest_cancelled and reservation
released2738ms, satisfying20s. Positive fully-read stream settles committedheld0.
Mock-provider disconnect advisory remainsUNPROVEN: held past20s, settles23550ms.

Enabling `enable_request_signal` matches Cloudflare's primary documentation:
https://developers.cloudflare.com/changelog/post/2025-05-22-handle-request-cancellation/
The original hold/watchdog failure records survive. A noflag comparison reproduced
60frames/noearlyclose/settlement24506ms. It was performed in the active dirty checkout,
so it is supporting comparison evidence, **not accepted disposable sensitivity proof**.
Current config restoration independently verified: nodejs_compat + enable_request_signal.
A disposable sensitivity replay and exact committed-head checks remain owed.

## Resume blockers

Claude Code session limit reports reset21:50Asia/Saigon on2026-10-09. No alternative
model or account was used to bypass it. UI cleanup source cause, all8mutants, phase02
queueproducer/adminreplay repairs, native race/restart/faults and full account matrix
remain owed. Native/non-native/provider/hosted/production proof layers remain separate.

## Terminal workspace hostile reproducer

`evidence/20261009-workspace-policy-replay-original-fail.log`: terminalexit1,
123/125assertions, one skipped, wholeprobeFAIL. S5-T9 fault control succeeds:
adminunbind commits its tombstone while snapshotINSERTfault causes5xx; same-key
replay204 does not heal the policy, and expected exactlyone new snapshot is absent.
Original failing evidence survives; no Rustrepair occurred before the Claudequota.
S5-T6 remainsBLOCKED: occurrencespending, automation.dispatch envelopesqueued
withattempt1. That is not the never-published signature; a missingproducer source
inference is insufficient. Inspect actualconsumer/retry and Workerlog with positive
controls before choosing the minimal repair. Other declared claimsPASS on this
source/environment, not on a future committedpair. AllprimaryCLI handles terminal.
