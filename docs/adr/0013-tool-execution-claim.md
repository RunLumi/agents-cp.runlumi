# ADR 0013 — Claim managed tool execution before side effects

Status: accepted design for P05-CR-004; runtime delivery pending.

ToolCallRef owns execution admission. A decision is policy evaluation, not a
replayable execution permit. Record immutable execution_started_at,
execution_device_id and execution_policy_version on the existing ref. All three
are null before admission and present after the winning admission. Never reset
them during retry/recovery, and never reinterpret a lost allow response as a
safe instruction to repeat a side effect.

The device result route's pre-execution action re-evaluates current policy and
claims the ref once in the same guarded D1 transaction as approval consumption,
timeline, audit and outbox. Exact catalog/agent and applicable policy records
must retain their individually observed versions. Live run/session, device,
membership, project access and workspace binding are reasserted at commit.
Each per-use grant is consumed before returning an executable allow. Terminal
result reports do not acquire authority retrospectively.

Migration 0027 adds the fields and database invariants. Once execution claims
exist, code rollback must retain the claim-aware backend; older binaries do not
understand admission and can report approval-based allow incorrectly. New clients
fail closed against older backends. Deliver backend first, then client, then the
exact pinned pair. Lost responses remain explicit reconciliation work.
