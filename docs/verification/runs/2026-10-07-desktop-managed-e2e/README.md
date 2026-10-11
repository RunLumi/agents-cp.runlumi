# Actual Electron managed request and reversible binding

Claim-specific proofs below include PASS. The full A–E goal remains UNPROVEN.
Older continuation entries are historical and retain their original scope.

## Latest actual runtime evidence — 2026-10-08

### Automation E continuation scope

Actual preview runtime (profile aqiXkF) failed with `lumi_response_invalid`;
`automation-preview-original-runtime-fail.json` preserves the original verdict.
The Worker emits `subject:null` for whole-automation conflicts, while the client
required a string. Exact decoder regression FAIL is retained; repair normalizes
only explicit null to the empty display subject and keeps the conflict blocking.
Transport/UI flow16PASS, root typecheckPASS, lint70warnings0errors, desktop rebuild
PASS. Fresh actual preview/cancel/confirm run is still pending; these checks alone
do not supersede the runtime failure. Harness synthetic billing grants are local
fixture state only, never evidence of billing-provider integration or production.

Subsequent actual Electron run (profile iJTAWw, report
`evidence/automation-confirm-schedule-check-runtime-fail.json`) proves the repaired
server-conflict display, no Confirm while blocked, preview/Cancel no-write controls,
and bounded-schedule refusal. It still FAILs at Confirm: Worker returned503 because
create supplied NULL cron/timezone columns to the immutable schedule CHECK. Update
had the same defect. Both now use the canonical revision as the sole SQL projection
source; no schema relaxation. `python3 apps/api/scripts/p06-schedule-projection.py`
checks actual SQL against the migration's table for all four kinds plus malformed
cron refusal. Rust automation142, WASM check, bind-count479 and final SQL parser
controls4PASS. Actual Confirm replay is pending; storage/native proof is not HTTP
or scheduler certification. Original runtime FAIL remains preserved.

Independent supporting suites cover marker5, transports10, owner6, custody7,
driver9 and Main command/assembly6 tests (logs prefixed `automation-` in evidence).
These use real local SQLite where named, with server/lease fixtures. They do not
prove actual managed scheduler, import UI or two desktop clients. Three separate
coordinator reproducers originally FAILed: scheduler housekeeping changes suppressed
original on expiration; recovery accepts missing completeness/foreign-project
correlation; lost start response triggers unproven pre-start release. Their logs
are retained beside supporting PASS logs. Green suites did not cover these faults.
Do not certify E until fixes and original/runtime reproducer replay demonstrate
scope/preservation/ambiguity plus real scheduler fencing and execution.

Follow-on repair evidence supersedes those failures only at their tested boundary:
housekeeping regression6 and original SQLite replay PASS; recovery transport
suite6 and original malformed/project replay with positive control PASS; lost-start
regression/original fixture replay20 PASS. Original failures stay retained.
Main membership/projection suite8 PASS. These do not prove HTTP/device/runtime
freshness throughout confirm. A further trusted-baseline old scheduler query
still selects adopted local originals (downgrade SQL reproducer FAIL), so downgrade
safety remains incomplete. Actual scheduler/Host/Agent fencing, adoption UI and
two-client runtime remain UNPROVEN; no whole E verdict from these repairs.

`evidence/run-scoped-tools-report.json`, `lumi-restored-tools-report.json` and
`lumi-narrow-tools-report.json` report PASS on the dirty paired candidate:
control plane `e7ad897a7f400048df17100594ef86b3788ea0f1`, client
`2a495254f0018644d24c9c1e5c5210bb7a30075c`. These SHAs identify checkout bases;
dirty changes are required to reproduce this candidate, so they are not release
pins or clean-checkout proof. Reports retain assertion lists and no observation
retries. Matching runtime logs are beside them.

Actual Electron/bundled Agent → Rust Worker/D1 proof covers Lumi-first entry,
public browser PKCE approval, enrollment/policy, managed text/usage, live second
alias without restart, actual registered Write with exact reviewed descriptor,
public per-use approval, one execution claim, real file effect, automatic completed
result and audit. Denial leaves the file absent and no execution claim; audit
tables omit tool content. Restart/rollback/rebind, encrypted custody, device
revocation and Lumi logout also pass. Restored Lumi session does not reopen entry.

Startup320px screenshot was visually inspected for no horizontal overflow and
readable actions. Native Tab focus-visible assertion passed, but visual review
found insufficient ring prominence. Scoped ring source repair and stronger
computed-style verifier are pending rebuild/runtime evidence; old screenshot is
not proof of that repair. Async/error/offline/old-provider-state matrices remain
incomplete.

The provider is a development-only controlled mock returning a tool call; the
desktop executes its real Write handler and all backend authority boundaries.
This does not prove third-party provider response or production deployment.
Automation import/scheduler/lease journey E, additional hostile/sensitivity
requirements, standalone Main type errors, performance/compatibility/clean
bootstrap, hosted CI and PR/merge/gitlink delivery remain outstanding. See
DE2E-INT-04 and DE2E-INT-05; do not infer whole-goal completion from this slice.

## Managed tool broker continuation

### 2026-10-08 reviewed catalog reader

Private human-session catalog lookup now returns a strict server-ID identity only
for one active exact fingerprint/source/risk/capability-set match. Unknown/review/
disabled remain unavailable; malformed/foreign/duplicate/mismatched or incomplete
paginated collections fail closed. It never creates a tool or grants execution.
P05 still resolves current agent/device/project/policy/MCP authority independently.

Twelve catalog/account tests, current client types/lint (70 warnings), architecture
and provenance PASS. Actual production human adapter → Worker/D1 maps exact
descriptor, refuses risk mismatch/other-org fingerprint and preserves tool count.
See reviewed-catalog-result.json. Whole P05 PENDING243 checks/zero failures/six limits.
Per-turn Core/Host/Main resolution is NOT wired yet, so this reader proof does not
establish real managed tool execution or authorize skipping uncatalogued denial.
MCP ID is local correlation until authoritative registration resolution at P05.
All original product/security/compatibility/clean bootstrap/CI/PR/merge gates stay
active. No full Electron tool or latest release PASS is claimed.

### 2026-10-08 bounded approval waiting and native clock

Main now polls the existing decision route with live lease/policy validation on
every attempt, one approval binding and bounded15m wait; no automatic approval.
Denial, expiry, changed binding or lost scope stops. Host/Agent decision margins
are bounded, report cleanup deadline remains separate. Core pauses its existing
depth-counted native deadline for managed admission and report delivery, preserving
the handler's own timeout and user cancellation.

Thirty targeted controls PASS. Real Main helper/Core/bootstrap/device/Worker
fixture wait PASS: no handler/file effect while pending; actual human approval;
one effect and stored completed report despite a20ms native handler budget and
longer wait. Full P05 PENDING238 checks/zero failures/six limits. The first run
failed when the verifier tail-buffer truncated20k JSON; full UTF8 collection with
explicit2MiB overflow FAIL preserves the same query/obligations and repaired run
PASS. No reducing evidence or accepting truncated JSON.

Valid runtime mutation omitting managed wait pause/resume is detected; baseline/
restored PASS and source unchanged. Native slow-handler positive still times out.
Client type/lint PASS70 warnings; Core/bootstrap/architecture/notice PASS. Explicit
CLI call-runner max-lines FAIL remains (baseline669,candidate670). No full Main
gate or new Electron proof. Source hashes/scopes and original failure are saved
in approval-wait-result.json and associated logs. Reviewed catalog mapping, approval
UX, real model-driven Electron tools and all original delivery gates remain owed.

### 2026-10-08 automatic reporting follow-on

Source now connects automatic metadata-only reporting from Core through bootstrap
reverse RPC, owned Host workspace and private Main lease to DeviceToken transport.
Core waits for ACK before success; required reporter absence blocks handler;
failed delivery has stable non-retry error; cancellation cleanup has independent
deadline and does not execute after late allow. It sends no output/exception/path.
Actual model-driven Electron tool reporting remains UNPROVEN.

Supporting actual Core/bootstrap/device/Worker proof PASSes with reviewed fixture
handler, actual approval API, one file effect and completed stored before success.
No fake Main/Electron is claimed by it. Whole P05 PENDING:234 checks/zero failures/
six limits. Original public Core interface-export bundle and __filename/ESM load
failures survive; type export and production-compatible CJS repair them.

38 affected regressions, client typecheck/lint (70 baseline warnings), explicit
CLI lint, architecture/provenance and Agent/Desktop builds PASS. Broader standalone
Main gate remains FAIL. Policy snapshot id maps validated policy_id to Main id;
its earlier unknown/missing field error is repaired without weakening the type.

Original mutation run was terminated after a verifier cancellation wait hung and
does not certify sensitivity. Bounded fresh clone baseline/restored PASS; omission
fails meaningful reporting assertions and explicit missing-report error. Use
automatic-report-sensitivity-* from the bounded run only.

Actual rebuilt Electron account/inference/restart/rebind/revoke/logout regression
PASSes with zero retries and both dirty heads unchanged. No tool invocation in
that flow. Evidence automatic-report-result.json/automatic-report-electron-result.json
separates scopes and keeps Main FAIL visible. No clean checkout/CI/PR/merge or
full A–E completion is claimed. Recent review quota save failure cleared via the
same normal approval path; no bypass occurred.

### Latest private result transport and terminal CAS

Normal automatic review became available again; format/check ran normally, with
no bypass. The result transport and latest CAS source are now verified at their
explicit scope. reportManagedToolResult sends status only and validates resource/
status/time. Five targeted tests, client typecheck/lint PASS (70 baseline warnings).
Automatic Core/reverse-RPC/Host/Main reporting is still unwired.

Actual production adapter → Worker/D1 proves terminal report, completed→failed
refusal, unchanged state and replay with one audit. The new CAS makes concurrent
conflicting reports acknowledge one winner, store that winner and append one
audit/outbox transaction; same-status replay has no extra audit. This follows an
independently approved/claimed tool-call positive control. Whole P05 is PENDING:
228 checks, zero failures, six limits. See tool-result-cas-result.json.

Six ordered terminal conflicts PASS on memory copies of actual D1/audit schema.
A valid-SQL CAS omission is caught at a conflicting stale report; baseline and
restored controls PASS and active source is unchanged. It is SQL component
sensitivity, not whole-HTTP mutation. Rust1042+11, clippy, WASM, formatting and
syntax/diff checks PASS. Original before-CAS explicit reporting proof remains
under client-tool-result-*; latest source hashes and runtime proof are recorded.

Next implement automatic typed metadata reporting and its cancellation/failure/
unknown-delivery behavior, reviewed catalog mapping and approval waiting. No
full Electron tool, clean checkout, CI, PR/merge or goal completion is claimed.

### Latest capability catalog race guard

Backend now snapshots the bounded500 effective platform/org capability
ID/key/risk/version list before evaluation and reasserts exact tuple equality
inside the claim/consume transaction. Deterministic key+ID ordering matches the
evaluator query. No client binding is trusted and no wire/schema changed.

`capability-claim-component.json` has seven PASS controls against the actual SQL
and retained real schema (memory copies only). Visible addition, version change,
risk reclassification, key remapping and removal refuse with claim/grant unchanged;
foreign tenant addition preserves the own-scope positive. A disposable clone's
valid-SQL omission is detected at visible addition, with baseline/restored PASS
and unchanged active source. See capability-claim-sensitivity-*.

Actual production adapter/Worker/D1 positive proof PASSes again; scoped result is
capability-claim-result.json. Whole P05 stays PENDING (218 checks, zero failures,
six limits). Rust1042+11, clippy and WASM PASS. This is SQL race component and
sensitivity plus HTTP positive proof, not whole-route HTTP interleaving fault
injection or actual Electron tool execution. All original product/delivery gates
remain active. Next implement reviewed mapping, approval waiting and automatic
result reporting; no latest full Electron PASS or PR/merge is claimed.

### Latest private client admission wiring

Every allow from production LumiDeviceHostTransport now requires an exact P05
allowed preflight permit first. Pending does not claim. Response binds resource,
tool, arguments, policy and approval identities with execution start time;
unsupported, malformed, refused or ambiguous admission throws without automatic
retry. Main's existing private DeviceToken callback supplies authentication.

Four targeted tests PASS: deferred admission precedes real file-handler I/O,
wrong claim fields refuse, only DeviceToken crosses loopback HTTP, pending does
not claim, and 404/409/lost response never retry. Client typecheck/lint PASS
(70 existing warnings), architecture/notice PASS. Mutation bypassing the claim
is detected with valid baseline/restored controls and unchanged active source.

`client-admission-result.json` is scoped PASS for the actual production adapter
against Worker/D1: pending no effect; real approval resolution; one permit from
concurrent adapter requests; consumed grant observed before file write; replay
refusal and explicit terminal reporting. Whole P05 stays PENDING:218 checks, zero
failures, six limits. No actual Electron/Core tool or automatic result-reporting
claim. The new entrypoint is tests/integration/tool-admission.mjs, with real client
bundle and exact source hashes recorded. No mock duplicates the adapter logic.

Reviewed catalog/capability mapping, automatic approval waiting/result reporting,
capability version race guard, wider hostile/sensitivity tests and full Electron
tool side effects remain owed. Rebuild Desktop after emitting typecheck before
running Electron; current failure evidence is not erased by this adapter proof.

### Latest pre-execution backend gate

Migration 0027/ADR0013 and the existing device result route's allowed preflight
implement the P05-CR-004 backend claim. Decisions are re-evaluated; current scope,
catalog/agent and individually observed policy/MCP records are guarded in the
same D1 transaction as one claim, per-use consumption and timeline/audit/outbox.
Terminal completed without a claim refuses; reporting does not consume afterward.

`execution-claim-result.json` is scoped PASS for actual Worker/D1 and a real
harness-owned file handler: pending and missing policy ACK leave the grant and
claim untouched; actual API ACK enables a positive control; concurrent starts
yield one permit; grant consumption is observed before file write; both replay
forms refuse, and terminal result retains admission. This is not Electron tool
runtime proof. Whole P05 remains PENDING (210 checks, zero failures, six limits),
including generic/MCP flows still lacking preflight, browser and disconnect.

Original D1 expression-depth FAIL and missing-ACK FAIL survive. Scope/policy guards
were split without removing conditions or leaving the transaction. Missing ACK
became an explicit hostile test followed by public API ACK. Eight schema-invariant
tests on memory copies of real retained D1 PASS. Rust1042+11, clippy, WASM PASS.
Remaining proof includes every scope/version race and backend mutation sensitivity;
capability record version race still needs scrutiny. Private preflight is now
wired as described above; approval waiting and automatic result reporting remain owed.

The short SSD-temp Electron retry FAILed before app startup because Wrangler
could not write its registry on the full internal disk. That failure is preserved
and distinct from SQLite/CDP failures. Admission probes verified pinned Wrangler's
XDG_CONFIG_HOME support and use task-owned SSD config/log/temp. No credentials or
user configuration are copied. No latest full Electron PASS or release is claimed.

### Latest argument-binding follow-on

The real Core summary originally exported local paths/arbitrary values and
collapsed nested, long or undisplayed input differences. Three of four original
regressions FAILed; preserve `arguments-original-fail.log`. Summary now contains
the complete bounded canonical JSON input digest plus closed action/type/count
metadata. It exports no arbitrary field names, paths, commands or content. Invalid,
cyclic, accessor, non-JSON, excessive-depth or oversized input fails closed.

Core rechecks input after awaited approval and at the last synchronous handler
boundary. The managed handler receives an isolated approved JSON snapshot.
Twenty Core regressions and 25 affected regressions PASS, including real file
effects, mutation while waiting, Promise continuation mutation, cancellation and
external reference mutation during asynchronous handler execution. Disposable
clone mutation delivering caller-owned input is detected; baseline/restored PASS,
source unchanged. See `arguments-sensitivity-*`. This is Core ownership proof,
not actual Electron approval consumption.

Production Core/Agent and Desktop builds PASS. Required client typecheck/lint
PASS (70 warnings). Core typecheck and six targeted CLI files PASS lint; the full
seven-file targeted gate FAILs because call-runner.ts exceeds 400 lines. HEAD
baseline is 669 substantive lines, candidate 666. Preserve both logs; no rule is
weakened and no full CLI lint PASS is claimed. Architecture/notice/diff checks PASS.

Actual production summary helper → Worker/D1 roundtrip PASS: canonical summary
and complete input digest are retained exactly; raw input sentinels absent. P05
has 204 checks, zero failures, four limitations, whole PENDING. The first broad
Core-entrypoint attempt failed on TS-only shared module loading before the new
proof; its FAIL survives. Repaired probe uses the built production pure helper.

Electron on this rebuilt pair passed login/enrollment/managed streaming and D1
attribution, then FAILed on restart with SQLite open_failed/errcode 14. Internal
disk had 255 MiB free, but that observation does not establish the error's cause.
Profile/log/report are retained. The SSD control passed restart and rollback/
rebind, then FAILed on its next restart with CDP WebSocket ErrorEvent. Chromium
logged `Failed to create socket directory` immediately before that failure.
Cause remains UNPROVEN; inspect path length/platform prerequisites and preserve
the profile. Both handles are terminal. Do not reuse
the earlier Electron PASS to certify the new working sources.

P05-CR-004 records the missing pre-execution consume/once-only claim design.
No implementation claim: approval-based allow stays refused until that route,
catalog mapping, result reporting and real Electron effects are proven. Source
and artifact hashes are in `arguments-source-manifest.json`.

Core now has the actual reverse tool-decision port, assembled for workspace apps.
Its presence preserves local mode; explicit per-turn managed context enters the
gate. Host derives workspace from its owned Agent process. Strict private
utility-process messages reach Main, which reuses its run/session/workspace/
policy validation before DeviceToken P05 I/O. The response binds run, tool call,
tool/fingerprint/risk and server canonical summary hash. Approval-based allows
remain refused until atomic consumption is wired. Catalog mapping and actual
Electron tool allow/approval effects remain UNPROVEN.

Evidence: `tool-broker-regressions.log` has 17 PASS regressions, including loopback
DeviceToken-only HTTP, wrong response binding, stale/expired private replies,
local-mode positive control and a real file handler. The cancellation regression
originally FAILed: a late allow entered the file handler after the executor had
reported cancellation. `tool-broker-cancel-original-fail.log` survives the repair;
the gate now rechecks abort after awaited decision/approval. Main also rejects a
reply after logout/settlement removes or replaces its exact lease.

The independent disposable clone's run-binding omission produces a real assertion
FAIL with valid HTTP positive control. Baseline and restored runs PASS, and source
equality is verified. See `tool-broker-sensitivity-*`; its initial missing package
link failure is preserved and is not mutation detection. This proves sensitivity
of the transport test, not the complete Electron approval/effect verifier.

P05 Worker/D1: 198 checks, zero failures, four limitations; whole probe verdict
PENDING. Canonical argument hash readback is PASS. Browser capability catalog,
browser approval and passive disconnect remain limited; no full P05 PASS claim.
Rust 1042 unit + 11 integration tests, clippy and WASM check PASS. Required client
typecheck and lint PASS (70 existing warnings). Explicit CLI lint applies the
unchanged root rules with only CLI ignore patterns removed; zero-file attempts
are not PASS. An earlier separate Electron Main typecheck FAIL is preserved and
that broader gate is still owed; do not infer it from root typecheck or bundling.

Actual Electron after the cancellation/lease repairs and serialized checks/build
PASSes (`tool-broker-electron-serialized-pass.json`), zero observation retries,
dirty parent/client heads e7ad897a7f400048df17100594ef86b3788ea0f1 /
2a495254f0018644d24c9c1e5c5210bb7a30075c. It covers the existing account/inference/
restart/reversible binding journey, not a tool invocation. `tool-broker-source-manifest.json`
records working-source and built-artifact hashes.
Exact executed probe hashes are retained in `tool-broker-runtime-source-manifest.json`;
only pinned formatter output for the two probe scripts changed afterward.
The prior Electron FAIL is
preserved: concurrent emitting typecheck overwrote bundled Host index.js with an
unbundled import, producing ERR_MODULE_NOT_FOUND for hostDatabaseStartup.js.
Run emitting checks before production build and runtime; never concurrently.

Next: server-reviewed catalog mapping; harden argument summaries against path/
string disclosure and lossy/truncated approval bindings; atomic approval consume,
result reporting and benign real Electron tool effects. All original A–E,
clean-checkout/compatibility/CI/PR/merge obligations remain active.

### Earlier native checkpoint

Actual Electron using the long SSD TMPDIR failed before Agent initialization
with socket EINVAL. Preserve electron-long-temp-original-fail.json. Browser
broker now uses a short system-temp socket path when the UTF-8 path exceeds its
conservative native budget. Random path ID and independent 32-byte token/auth
handshake remain intact. Live socket test proves startup, valid-shape wrong-token
and subagent refusals, valid request and socket cleanup.

After CLI rebuild/stage, the same long-TMPDIR Electron reproducer PASSes;
electron-long-temp-repaired-pass.json also proves the explicit runner report
output port. It matches the dirty pair and required stream/rebind assertions.
Native/tool regressions: 11 tests PASS. CLI bootstrap typecheck/build and explicit
broker lint PASS. This does not remove the earlier CLI turn-tools baseline lint
limitation or prove CUA sibling long-path support.

Synthetic profile:
$REPO_ROOT/test-results/desktop-clean-elaprn7t/tmp/lumi-electron-account-Klmi1F.
D1: $REPO_ROOT/test-results/desktop-report-port-repaired-d1.
Full clean bootstrap remains BLOCKED at dependency installation as recorded below.

Follow-on after tool context propagation: Electron report at
$TMPDIR/lumi-electron-account-W4BQKt/evidence/result.json also PASSes.
The first source manifest describes the earlier proven pair; see the follow-on
manifest for the subsequent tool-boundary files.

## Runtime tool boundary sensitivity

Core per-turn context now reaches the same wrapper for streaming and completed
tool schedules. Managed models missing context refuse before executor admission.
Ten focused tests PASS, including a real file-backed handler with local-positive,
managed-missing-broker refusal, unchanged file, and subsequent local-positive
controls. In a disposable helper copy, omitting context forwarding makes this
test fail (successful tool result where denial was required); compilation and
execution succeed. Restoring the helper reproduces the baseline PASS.
This proves verifier sensitivity for runtime scheduling. It does not prove a
working Electron Main→P05 tool decision/approval broker.

Root client lint ignores CLI sources. Explicit CLI lint passes the new boundary
and other small modified files; turn-tools.ts still fails the existing 400-line
limit (baseline 501 substantive lines, candidate 509) and has a baseline unused
modelSelection warning. Do not describe this explicit CLI gate as PASS.

## Controlled HTTP provider gate

The original probe handled/counted /v1/ok while backend appends
/v1/chat/completions to base URL. Its reachability claim was insufficient.
Preserve original output, then use the corrected final-path fixture plus an
independent total-request tally. Corrected run exits 2: expected and total
counts are zero at 127.0.0.1, localhost, 192.168.1.4 and 10.2.0.2, each with
503/provider_unavailable. Healthy HTTP control remains BLOCKED; no fault verdict
is established. Absence of a dispatch log does not locate the underlying cause.
Disposable D1 is $TMPDIR/lumi-http-provider-fault-persist. See original and
corrected probe logs under evidence/. Local socket receipt alone would still
require a usable positive response before grading faults.

Evidence report and screenshots are in evidence/. Both source HEADs are dirty:
parent e7ad897a7f400048df17100594ef86b3788ea0f1 and client
2a495254f0018644d24c9c1e5c5210bb7a30075c. The source manifest fingerprints
the tested working files; a HEAD alone does not identify these dirty changes.
Report originated at $TMPDIR/lumi-electron-account-Y9FZr6/evidence/result.json.
Disposable D1: $TMPDIR/lumi-electron-account-persist-17.

## Scope proven

Actual Electron Main/Host/renderer and bundled Agent CLI, fresh local Worker/D1
(26 migrations), browser password login/PKCE approval, device enrollment/token
refresh, opaque explicit binding and ladder, one managed streaming request.
Run succeeds; P04 request and usage correlate project/device/P05 agent session
separately from P02 login session. The one-shot P05 session closes.

Restart preserves ownership without duplicates. UI rollback revokes binding
authority while retaining historical run references; lists hide removal.
An old binding ID cannot create a new session (404 with stable reason and no
new stored session). Explicit UI rebind creates a new ID, then stage-zero unbind
works. Local sentinel file remains intact. Device revoke blocks policy sync,
restart retains the same device, logout clears its own session vault.

All text columns of inference_requests, usage_events, runs, run_events,
security_events and outbox_events are scanned for the unique prompt sentinel,
returning counts only. Full captured ordinary desktop logs are also checked.
This proves absence of that sentinel in these surfaces, not universal absence
of arbitrary sensitive content. Local task/session content remains local by design.
This PASS had zero observation retries. A prior local D1 internal-error report
is retained in temporary evidence; the exact query independently passed on the
same preserved database.

## Reproduction and prerequisites

Build both the client Desktop and Agent CLI and stage the CLI bundle first.
build:no-runtime-assets alone does not rebuild the CLI. Use Node 24,
pinned Electron with native assets/keychain/display on macOS, Rust stable with
WASM target and worker-build 0.8.x. Current available Node is 24.19.0; client
declares 24.14.0. Then, from the parent:

```sh
node tests/integration/desktop-account-electron.mjs
```

DE2E_ELECTRON_PERSIST can preserve disposable D1 outside the checkout for
failure investigation. Never select a personal profile. The source freshness
control requires a newly built current Worker. No remote resources are used.
The clean install/build one-command desktop runner remains to be completed.

## Clean bootstrap follow-on

Desktop mode is now implemented:

```sh
LUMI_INTEGRATION_DESKTOP=1 node scripts/integration/lumi-agents.mjs
```

Disposable clean snapshots use parent ca66e8820eb41bd9c506b1932da4775eded5ff95
and client 21d2e11f134e1d77d165a076b1754697bad53825. They are local validation
commits only, not remote releases. The candidate moved from $TMPDIR to
$REPO_ROOT/test-results/desktop-clean-elaprn7t/control-plane
after the first install hit ENOSPC. Both sources stayed clean.

Both pinned pnpm tools install correctly on SSD. Offline root install is BLOCKED
by missing semver@6.3.1 tarball. Online frozen install reports repeated tarball
timeouts and has not reached build; the task-owned probe was ended after a
verified 4m48s and returned exit 2/SIGTERM. This is a deliberately bounded
prerequisite attempt, not an observed package-manager completion. Preserve
offline/online result JSON and online log under evidence/. No clean bootstrap
PASS, native-hook, paired runtime, hosted CI or publication claim follows.

The runner pins each repository's nested pnpm calls, builds current-host runtime
assets plus Desktop/CLI, and checks the Electron report matches the pair. Native
prerequisites stay explicit. The achieved journey scope is machine-readable;
full A–E remains the goal, including all missing tool/fault/automation claims.

## Quality and limits

Current Rust suite: 1042 unit + 11 outbound-guard tests PASS; clippy PASS.
Client full typecheck and CLI core/bootstrap/adapters no-emit checks PASS;
22 focused tests PASS; lint zero errors/70 baseline warnings; architecture and
Lumi modified-file notices PASS; modified source formatting and both builds PASS.
These checks do not certify all goal requirements.

Provider is the development mock adapter. Controlled reachable HTTP provider,
external provider, faults/cancellation/nonstream, budget mutation, actual tool
allow/deny/approval effects, browser/computer/MCP, web results/audit, second
workspace/provider-login matrix, automation import/scheduler/lease races,
compatibility, clean checkout, hosted CI, PRs, merge and release remain owed.
Migration 0026 requires a removal-aware backend for rollback (ADR0012).
