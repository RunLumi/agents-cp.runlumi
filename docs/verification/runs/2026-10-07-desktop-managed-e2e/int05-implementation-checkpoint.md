# DE2E-INT-05 implementation checkpoint (implementer, 2026-10-08)

Status: implementation landed in the client working tree; runtime proof PARTIAL.
This file is the implementer's record. It does not edit the packet or STATUS (coordinator-owned).
No E PASS, no PR, no merge.

## What now exists (client, uncommitted)

- scheduler tick -> `managed-poll-request` (scheduler holds no token, writes no ledger row)
  -> Main `pollManagedAutomations` -> due/claim/start via the P06 fence guard
  -> P05 run validated and started -> Host `lumi-managed-automation-run` (prompt read locally by Main)
  -> existing managed task/inference/tool path -> existing terminal relay
  -> P05 terminal then P06 settle; renewal timer; lease loss revokes authority.
- Downgrade guard: tasks-index migration `0005` (claim trigger) + occurrence journal table.
- Freshness: local revision (`expectedRevision`) and account generation fence.
- UI: hand-over dialog (preview, conflicts, cancel, confirm), card badge, return-to-device.
- Spec 07 and `P06-CR-004` updated first.

## Defects found while proving it (not in the packet's surface)

1. `DEVICE_DUE_OCCURRENCES_SQL` ordered by a non-existent column (`o.scheduled_for_`), so
   `GET /devices/automations/due` could never succeed. Fixed (one token) in
   `apps/api/src/repositories/automations.rs`; original failure retained in
   `integrations/lumi-agents/test-results/int05-due-sql-original-fail.log`.
2. Same static check (prepare every `*_SQL` const against the migrated schema) also reports, NOT fixed:
   `ATTEMPTS_SQL` (ambiguous column `occurrence_id`) and `COLLECT_ORGANIZATION_TEAMS_SQL`
   (no column `t.name`). Owners: P06 / F20 coordinators.

## Runtime evidence actually obtained (no Worker)

`tests/integration/desktop-automation-local-preservation.mjs`, log
`integrations/lumi-agents/test-results/int05-local-preservation-1.log`: real rebuilt Electron app, real
scheduler process, real tasks-index, control plane unreachable. PASS: app boots; an unmarked due automation is
still dispatched by the local scheduler (local cron path preserved); a due adopted original is byte-identical
afterwards with no run history. Weak: "Main stays up" only shows the process survived; I did not observe the
managed poll's log line. This is NOT managed-scheduling proof.

## BLOCKED: Worker runtime (journey E proper)

`wrangler dev` runs `worker-build --release`, which is not installed, and the Homebrew Rust has no
`wasm32-unknown-unknown` target. Installing them is a global network toolchain change that was not authorized.
Everything needing the Worker is UNPROVEN: due/claim/start/renew/settle against D1, two-client race, restart,
lease expiry, revocation, entitlement, off-peak, adoption UI end to end, D1 non-disclosure. The probe
`tests/integration/desktop-automation-electron.mjs` is written only through onboarding and has never run past
Worker startup.

## Toolchain facts

- Only Node 22.14 was runnable; the Node 24 path requires interactive approval. Production build ran via
  `test-results/int05-desktop-build.mjs` (adds `--experimental-strip-types`). Not equivalent evidence.
- Root `pnpm typecheck`: 0 errors. `tsc -b packages/desktop/tsconfig.main.json`: 90 errors, 0 in new files and
  0 inside any modified hunk (`int05-attribute-errors.mjs`); they are unresolved, not dismissed.
- A `tsc -b` run emits into `packages/desktop/out/*` and clobbers the bundled build; always rebuild after it.
