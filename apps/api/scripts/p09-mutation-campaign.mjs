#!/usr/bin/env node
// VI-TEST-001 — is the critical verification actually sensitive to a dangerous
// implementation fault?
//
// The contract (`docs/verification/contracts/core-invariants-v1.yaml`) names a
// specific mutation per Tier-0 invariant and requires that "the mutation must be
// killed by the expected verifier FOR THE INTENDED REASON". A test suite that
// fails for an unrelated reason has not proven anything, so every case here checks
// BOTH halves:
//
//   1. the mutant SURVIVES a build/compile, so the fault really is injected and
//      not merely a syntax error that trivially "fails the test"; and
//   2. the named verifier FAILS, and the failure text is inspected for the
//      invariant it is supposed to be defending.
//
// Usage:
//   node apps/api/scripts/p09-mutation-campaign.mjs            # report
//   node apps/api/scripts/p09-mutation-campaign.mjs --apply    # mutate + verify
//   node apps/api/scripts/p09-mutation-campaign.mjs --self-test
//
// `--self-test` exercises the harness's OWN verdict parsing and needs no worktree, no
// Worker, and no mutation, so it runs in `pnpm test`. See the note above `SELF_TEST`.
//
// `--apply` mutates a DISPOSABLE WORKTREE and never the working tree; it refuses
// to run unless the worktree it was given is not the current checkout. The
// campaign is therefore safe to run, and running it is how you find out that a
// gate you wrote cannot fail.

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const APPLY = process.argv.includes("--apply");

/**
 * Every case names the invariant, the fault, where it goes, and the verifier that
 * MUST die. `expect` is a substring of the expected failure, so a verifier that
 * fails for the wrong reason does not count as a kill.
 */
const CASES = [
  {
    id: "VI-TEN-001",
    tier: 0,
    title: "a cross-tenant read loses its organization predicate",
    file: "apps/api/src/repositories/plugins.rs",
    // The org-scoped install read every P09 statement-classification test asserts.
    find: "WHERE org_id = ?1 AND package_id = ?2",
    replace: "WHERE package_id = ?2",
    verifier: ["tenant_audit", "schema"],
    expect: "PLUGIN_INSTALL",
  },
  {
    id: "VI-TEN-001",
    tier: 0,
    // The two VI-TEN-001 cases above this one are both statement-level, and that is
    // the point rather than an oversight. They remove a predicate from SQL and the
    // tenant audit sees it, because the audit classifies statements. This case
    // removes nothing from SQL at all: the statements are unchanged, still correctly
    // classified, and the handler that calls them stops checking the resource against
    // the organization it was authorized for. Every statement-level verifier stays
    // green -- which is exactly how `projects/{project_id}/access` shipped a
    // cross-tenant read of another organization's access grants. See VFY-011.
    title: "a project grant list is served without the project being org-scoped",
    file: "apps/api/src/routes/projects.rs",
    find: '    ProjectRepository::new(database)\n        .find_project(&project_id)\n        .await\n        .map_err(|_| service_unavailable(&context))?\n        .filter(|project| project.org_id == org_id)\n        .ok_or_else(|| {\n            deny(\n                &context,\n                ApiErrorCode::NotFound,\n                "not_found",\n                "No such project.",\n            )\n        })?;\n    let grants = ProjectRepository::new(database)',
    replace: "let grants = ProjectRepository::new(database)",
    verifier: ["smoke:p08"],
    expect: "/projects/{id}/access",
  },
  {
    id: "VI-TEN-001",
    tier: 0,
    title: "a service-account page stops being org-scoped",
    file: "apps/api/src/repositories/machine_identity.rs",
    find: "WHERE org_id = ?1",
    replace: "WHERE 1 = 1",
    verifier: ["tenant_audit", "schema"],
    expect: "MACHINE",
  },
  {
    id: "VI-AUTHZ-001",
    tier: 0,
    title: "a human-only permission becomes grantable to a machine",
    file: "apps/api/src/modules/machine_identity.rs",
    // Mutate the DECISION, not the enum's Display arm. The first version of this case
    // replaced `Self::HumanOnlyAction` in the `as_str` match, which changed a STRING
    // and was killed by a test asserting the code text -- a kill for the wrong reason
    // that looked exactly like a behavioural one. It also briefly failed to compile.
    //
    // This is the real filter: the `is_human_only` gate in `allow`, which is what
    // makes a widened scope unable to grant OrgLifecycle, BillingManage, or
    // DataDelete to a machine.
    find: "    if is_human_only(permission) {\n        return MachineDecision::Deny(MachineDenyReason::HumanOnlyAction);\n    }",
    replace:
      "    if false {\n        return MachineDecision::Deny(MachineDenyReason::HumanOnlyAction);\n    }",
    file2: undefined,
    verifier: ["cargo", "machine_identity"],
    expect: "HumanOnlyAction",
  },
  {
    id: "VI-INF-001",
    tier: 0,
    title: "a truncated stream is allowed to complete",
    file: "apps/api/src/modules/inference.rs",
    find: "self.done && !self.invalid_response",
    replace: "true",
    verifier: ["cargo", "p09_failure_tests::a_truncated_stream"],
    expect: "completion",
  },
  {
    id: "VI-BUD-001",
    tier: 0,
    // The contract asks for "move the budget decision after dispatch". This case does
    // NOT do that: a string-replace harness cannot move a call site honestly, and a
    // mutation that reshuffles code and then fails to compile proves nothing. So it
    // tests the load-bearing half instead -- that a hard over-limit budget is
    // enforced AT ALL -- and says so, rather than claiming an ordering property it
    // does not establish. The ordering half remains UNPROVEN and is named as a
    // follow-up in the P09 gate.
    title: "a hard budget stops being enforced at all",
    file: "apps/api/src/modules/budget_p05.rs",
    // The version of this mutation that disabled the over-limit guard in the policy
    // loop SURVIVED, and the reason is worth recording: `MAX_RESERVATION_MINOR` is
    // `i64::MAX`, D1 stores INTEGER, so `limit_minor > MAX_RESERVATION_MINOR` cannot
    // be true for any stored value. That branch is defence in depth against a value
    // the storage layer cannot hold, and nothing tests it because nothing can reach
    // it. A mutation of unreachable code tells you about the mutation, not the code.
    //
    // This one disables the reachable hard denial: over a hard limit, allow.
    find: "BudgetKind::Hard if projected > policy.limit_minor => consider_candidate(\n                &mut best,\n                BudgetDecision::Deny,",
    replace:
      "BudgetKind::Hard if projected > policy.limit_minor => consider_candidate(\n                &mut best,\n                BudgetDecision::Allow,",
    verifier: ["cargo", "modules::budget_p05"],
    // The kill is `left: Allow, right: Deny` in two tests. Name the test, not the
    // reason enum: the assertion is on the DECISION, and expecting a symbol that does
    // not appear in the failure is how a correct kill gets recorded as a wrong one.
    expect: "soft_limit_notifies_but_hard_and_unavailable_are_closed",
  },
  {
    id: "VI-BUD-001",
    tier: 0,
    // The SECOND half of VI-BUD-001: the ordering.
    //
    // The contract's own mutation is "move the budget decision after dispatch". Run
    // literally on this file, hoisting the dispatch region above the decision is a
    // COMPILE ERROR rather than a silent behaviour change, because the dispatch
    // metadata consumes `budget_decision_value` -- a binding the match produces. So
    // for THAT mutation the verifier that fails is rustc, which is stronger than any
    // test. It is recorded as a case rather than a paragraph because "the compiler
    // enforces this" is exactly the kind of claim that decays silently: the day
    // somebody rewrites the dispatch to stop carrying the decision, the coupling is
    // gone and nothing here would notice.
    //
    // What rustc does NOT catch is neutering the scrutinee. Same type, compiles
    // happily, every decision takes the Allow arm, and a denied request is dispatched.
    // That is the mutation below, and the structural gate is what kills it.
    title: "a budget denial no longer consults its own decision (ordering)",
    file: "apps/api/src/routes/inference.rs",
    find: "match budget_admission.decision {",
    replace: "match P05BudgetDecision::Allow {",
    verifier: ["cargo", "modules::p09_failure_tests::a_hard_budget_denial"],
    // The kill is the scrutinee assertion, not the divergence one: the gate's second
    // check (`the admission decision is matched on its own value, not on a constant`)
    // fires first, because neutering the scrutinee is exactly what it exists to catch.
    // Verified by hand rather than assumed, since "the right test failed" and "some
    // test failed" look identical in a tally.
    expect: "is matched on its own value, not on a constant",
  },
  {
    id: "VI-IDEM-001",
    tier: 0,
    // The original form of this case renamed a column in the upsert's ON CONFLICT
    // clause and expected the schema harness to notice. It did not, because the
    // harness had no case for `idempotency_records` at all -- `grep -c idempotency`
    // returned 0. A SURVIVED verdict there was correct and load-bearing: it said the
    // retry-safety substrate had no database-level proof.
    //
    // It now mutates the trigger that migration 0020 added, so it tests that the
    // proof which was written to close the gap is itself sensitive.
    title: "a completed idempotency record is allowed to hold no status again",
    file: "apps/api/migrations/0020_p09_idempotency_null_safety.sql",
    find: "WHEN NEW.state = 'completed'\n AND (\n        NEW.response_status IS NULL\n     OR NEW.response_status NOT BETWEEN 200 AND 299\n )",
    replace:
      "WHEN 0\n AND (\n        NEW.response_status IS NULL\n     OR NEW.response_status NOT BETWEEN 200 AND 299\n )",
    verifier: ["schema"],
    expect: "NO status is refused",
  },
  {
    id: "VI-MIG-001",
    tier: 1,
    title: "a terminal-state trigger stops enforcing",
    file: "apps/api/migrations/0017_p07_plugin_governance.sql",
    // Not "delete the trigger". Deleting only the `CREATE TRIGGER` line leaves
    // `BEFORE UPDATE OF ... BEGIN ... END;` as an orphan statement, the migration
    // fails to apply, and the harness reports a PARSE ERROR -- which is not the same
    // as the invariant failing to be enforced, and is how this case first came out
    // KILLED_FOR_THE_WRONG_REASON. Neutralising the WHEN clause keeps the DDL valid
    // and removes only the enforcement, which is the fault under test.
    find: "FOR EACH ROW WHEN NEW.review_state = 'blocked' AND NEW.blocked_reason IS NULL",
    replace: "FOR EACH ROW WHEN 0",
    verifier: ["schema"],
    // The harness reports a failing case by its LABEL; the trigger's own RAISE text
    // never reaches the output. Expecting the RAISE text made a correct kill read as
    // "killed for the wrong reason", which is the mirror image of the same mistake:
    // checking that a verifier failed without checking what it said.
    expect: "a blocked install without a reason is refused",
  },
  {
    id: "VI-SEC-001",
    tier: 0,
    title: "an API key projection starts returning the secret hash",
    file: "apps/api/src/routes/machine_identity.rs",
    find: '"fingerprint": key.fingerprint,',
    replace: '"fingerprint": key.fingerprint,\n        "secret_hash": key.secret_hash,',
    verifier: ["cargo", "secret_canary"],
    expect: "leak",
  },
  {
    id: "VI-AUTH-001",
    tier: 0,
    // The one entry in `docs/verification/proof-obligations.md`'s "Minimum
    // mutation set" this campaign did not cover: "accept a consumed auth
    // ceremony".
    //
    // F01 FR-F01-010 requires a ceremony to be "consumed atomically on success".
    // That requirement is enforced TWICE, independently:
    //
    //   1. `ensure_pending` re-reads the row and requires `status = 'pending'`.
    //   2. `consume_ceremony` is a compare-and-set that only transitions a PENDING
    //      row, returns `false` when there was nothing to transition, and the
    //      handler turns that `false` into `ceremony_invalid`.
    //
    // Which is why this case is a TWO-SITE fault. Removing either defence alone
    // leaves the other one standing, so a single-site mutation here would report
    // a survivor for the uninteresting reason that it was not really testing the
    // invariant. That was measured, not assumed: mutating `ensure_pending` alone
    // left every probe check green, because the storage CAS caught the replay.
    //
    // WHY ONLY THE RUNTIME PROBE CAN CATCH THIS. The row is still consumed in both
    // layers, so every storage invariant holds, `schema:p07` is unaffected, and a
    // domain test over `consume_ceremony` still passes -- nothing in the store
    // changed. Only a probe that actually completes a ceremony TWICE, over real
    // HTTP against a real Worker with real ES256, sees the second completion
    // succeed. That is why this case names `smoke:passkey` and not `cargo test`.
    //
    // The probe's replay case also advances the signature counter. Without that,
    // the replay is refused for the wrong reason (`passkey_counter_regression` --
    // a property of the credential, not of the ceremony) and the ceremony
    // invariant stays unproven no matter what is mutated. Found while building
    // this case; see the comment on the case inside `p02-passkey-smoke.mjs`.
    //
    // COST: this case makes the harness build a release Worker in the scratch
    // tree, so it is minutes rather than seconds. That is the price of crossing
    // the boundary where the bug actually lives.
    title: "a consumed WebAuthn ceremony is accepted a second time",
    edits: [
      {
        // Defence 1: the handler stops requiring the ceremony to be pending.
        file: "apps/api/src/routes/authenticators.rs",
        find: "        || ceremony.status != CeremonyStatus::Pending.as_str()",
        replace: "        || false",
      },
      {
        // Defence 2: the compare-and-set transitions any row, not just a pending
        // one, so it reports success for a ceremony that was already consumed.
        file: "apps/api/src/repositories/authenticators.rs",
        find: "        Ok(D1Adapter::changes(&result)? == 1)",
        replace: "        let _ = &result; Ok(true)",
      },
    ],
    verifier: ["smoke:passkey"],
    expect: "consumed login ceremony cannot be replayed",
  },
  {
    id: "GUARD-1",
    tier: 1,
    // The other entry `docs/verification/proof-obligations.md` names in its minimum
    // mutation set and that this campaign did not cover: "bypass one idempotency
    // guard". Found by V00-2026-09-27.
    //
    // WHAT IT FAULTS, precisely. `ASSERT_RESERVATION_CREATED_SQL` in
    // `repositories/budgets.rs` is a guard sentinel: a deliberately invalid
    // `idempotency_records` insert whose `WHERE NOT EXISTS (… budget_reservations …)`
    // holds only when the reservation the preceding statement just made did NOT
    // appear. This mutation replaces that predicate with `WHERE 0`, so the sentinel
    // can never insert, so the batch can never abort on it, so the assertion
    // "a reservation I was told exists actually exists" stops being asserted.
    //
    // That assertion is the last line of defence for the internal reservation
    // endpoint. `routes/budgets.rs` builds the batch as
    // `[insert, guard, audit]` and commits it through `commit_scoped_mutation`; if
    // the conditional insert matched zero rows -- budget unavailable, limit reached,
    // reservation already taken -- nothing else in the batch notices, and the caller
    // is handed a 201 for a hold that was never taken.
    //
    // WHAT P05 ACTUALLY OBSERVES, recorded as measured rather than as predicted.
    // The failing assertion is `managed run start and correlated inference`,
    // reporting "internal reservation endpoint replays the managed hold
    // (status=503 reason=none)". So bypassing the guard does not present as a
    // duplicate charge here; it presents as a 503, because the batch commits state
    // the surrounding flow then cannot answer, and the replay of the internal
    // reservation lands on a record the flow no longer recognises. The exact
    // propagation was NOT traced step by step, and the honest claim is the narrow
    // one: the guard is load-bearing, and removing it changes the outcome. The
    // mechanism is noted here so the next person does not assume a duplicate-charge
    // scenario that this mutation does not actually produce.
    //
    // WHY ONLY P05 CAN CATCH THIS. The sentinel is Rust source, not schema, so
    // `schema:p07` is blind to it -- the table, its constraints, and its indexes are
    // all still correct, and `schema:p07` is the gate that normally proves the
    // storage refuses what the domain says it refuses. A `cargo test` is also blind,
    // because the sentinel's whole purpose is to abort a D1 BATCH, and no unit test
    // drives a batch. What sees it is a probe that creates and replays a reservation
    // over real HTTP against a real Worker.
    //
    // This is also the round trip for VFY-004. Before that finding was fixed, the
    // SAME p05 assertion failed -- with the same `status=503 reason=none` -- because
    // the guard's abort was being classified as a store outage instead of a
    // deliberate refusal. So between them the two states pin both halves: the abort
    // must be RECOGNISED in order to be refused, and refusing it must still WORK.
    title: "an idempotency guard sentinel is bypassed, so its assertion stops being enforced",
    edits: [
      {
        file: "apps/api/src/repositories/budgets.rs",
        find: "WHERE NOT EXISTS (\n    SELECT 1 FROM budget_reservations\n    WHERE reservation_id = ?1 AND org_id = ?2 AND request_id = ?3\n)",
        replace: "WHERE 0",
      },
    ],
    verifier: ["smoke:p05"],
    expect: "replays the managed hold",
  },
  {
    id: "GUARD-2",
    tier: 1,
    // VFY-004's own mutation case, named as a deliverable in
    // `docs/verification/runs/2026-09-27-v00-independent-reconstruction/next-verification-actions.md`:
    // "add a storage probe that executes one real guard sentinel through D1 and
    // asserts the recogniser accepts the produced error" AND "a mutation case".
    //
    // The probe exists (`p02-guard-probe.mjs`, in `pnpm test`). Until now the
    // recogniser's own mutation was only exercised by a shell script, so
    // `pnpm verify:mutation` did not cover it and the campaign could not tell a reader
    // that the fix is load-bearing.
    //
    // WHAT IT FAULTS. `core::idempotency::is_guard_abort` is replaced by the matcher it
    // replaced: `detail.contains("NOT NULL") || detail.contains("constraint")`. That is
    // the pre-VFY-004 implementation, and it is BOTH halves of the original defect at
    // once -- it misses the migration-0020 trigger text, and it accepts a UNIQUE or
    // FOREIGN KEY violation on any table as a deliberate guard.
    //
    // WHY THIS PROBE, AND WHAT IT ACTUALLY CATCHES -- which is narrower than the
    // first draft of this comment claimed, and was corrected by measurement.
    //
    // `guard:probe` applies the real migrations to a real database and runs the real
    // sentinel, then compares the abort text against the LIST. It does NOT execute the
    // Rust function. So the draft's claim that "it also fails the negative cases,
    // because the old matcher calls a UNIQUE violation a guard" was wrong: the
    // negatives -- "an UNIQUE violation on an unrelated table is NOT read as a guard" --
    // are testing the probe's OWN matcher in JavaScript, and they pass straight through
    // a mutation of the Rust body. Measured, not assumed: under this mutation the
    // probe reported 12/13, and the single failure was the structural check.
    //
    // What catches it is the structural check "is_guard_abort does not widen itself
    // past the list", which reads the Rust body and rejects `contains("constraint")`.
    // That check exists because the first run of this case surfaced the gap; before
    // it, a mutation of the function left all eleven original checks green.
    title:
      "the guard recogniser reverts to matching any constraint, so a store outage reads as a guard",
    edits: [
      {
        file: "apps/api/src/core/idempotency.rs",
        find: "    GUARD_ABORT_TEXTS\n        .iter()\n        .any(|text| lowered.contains(&text.to_ascii_lowercase()))",
        replace:
          '    lowered.contains("NOT NULL") || lowered.contains("constraint")\n    || GUARD_ABORT_TEXTS.is_empty()',
      },
    ],
    // WHICH CHECK CATCHES IT, since the probe has two and only one is load-bearing.
    // The mutation keeps a reference to the constant -- `|| GUARD_ABORT_TEXTS.is_empty()`
    // -- so the compiler does not warn about an unused item, which means
    // `is_guard_abort actually reads the list` still PASSES. The check that fires is
    // `is_guard_abort does not widen itself past the list`, and that is what `expect`
    // names. Pointing it at the other one produced a kill attributed to a check that
    // did none of the work, which is the same false confidence as a wrong-reason kill
    // in any other form.
    //
    // CONSEQUENT LIMIT, stated rather than glossed. The probe is evidence in two
    // pieces: the LIST is right against a real database (behavioural), and the
    // FUNCTION is wired to that list without widening past it (structural). It does
    // NOT prove the function performs the match correctly at run time. The run-time
    // evidence for the match itself is `smoke:p05` and the `GUARD-1` case.
    //
    // `guard:probe` opens SQLite directly and starts no Worker, so this case skips
    // the release build entirely -- seconds rather than minutes.
    verifier: ["smoke:guard"],
    expect: "does not widen itself past the list",
  },
];

/**
 * The runtime probes this campaign can drive, by the `smoke:<name>` a case declares.
 *
 * A mapping rather than a convention so that adding a probe is a one-line change with an
 * explicit spelling, instead of a case silently naming a script that does not exist and
 * being reported as a product failure.
 */
const SMOKE_SCRIPTS = {
  // `needsWorker: true` means the probe starts a real development Worker, so the
  // mutant has to be built for wasm32 and bundled before it can run. `guard` opens a
  // SQLite database directly and touches no HTTP surface, so building a Worker for it
  // would cost five minutes to test nothing. Deriving this from a flag rather than
  // from the `smoke:` prefix is what keeps a cheap case cheap.
  //
  // `tally(out)` answers one question: did this probe just report a verdict, and did
  // that verdict come out clean? It returns null when no verdict was reported at all,
  // which the caller treats as a harness fault.
  //
  // Each probe therefore parses its OWN summary, beside its own name, because the three
  // do not share a format:
  //
  //   passkey   "55/55 checks passed"
  //   p05       "P05 smoke: 185 checks passed; 0 failures; 0 limitations"   <- no "/n"
  //   guard     "13/13 guard cases hold across 2 recognised abort texts"
  //
  // Two earlier attempts to share one pattern both broke. Matching the passkey wording
  // rejected the guard probe's correct "13/13 guard cases hold" as reporting nothing.
  // Loosening it to any /n/n then went the other way: p05 has no denominator, so a
  // SURVIVING p05 mutant -- the one outcome this whole campaign exists to detect --
  // would have been relabelled a harness fault and quietly excluded from the tally.
  // A shared pattern is only safe when the things it parses actually agree.
  passkey: {
    script: "apps/api/scripts/p02-passkey-smoke.mjs",
    needsWorker: true,
    tally(out) {
      const m = /(\d+)\/(\d+) checks passed/.exec(out);
      if (!m) return null;
      return { clean: m[1] === m[2], reported: `${m[1]}/${m[2]} checks passed` };
    },
  },
  p05: {
    script: "apps/api/scripts/p05-smoke.mjs",
    needsWorker: true,
    tally(out) {
      const m = /P05 smoke: (\d+) checks passed; (\d+) failures/.exec(out);
      if (!m) return null;
      return {
        clean: m[2] === "0",
        reported: `P05 smoke: ${m[1]} checks passed; ${m[2]} failures`,
      };
    },
  },
  p08: {
    // `needsWorker: true` for the same reason as passkey and p05: this probe asks a
    // real Worker for one organization's data with another organization's id, over
    // real HTTP, and nothing cheaper can tell a refused route from an absent one.
    script: "apps/api/scripts/p08-tenancy-smoke.mjs",
    needsWorker: true,
    // The probe's own summary, beside its own name. A leak makes one of its cases
    // fail, so the numerator drops and the counts differ -- which is the only signal
    // needed, and matching on the word "leak" instead would break the moment the
    // probe reworded a line.
    tally(out) {
      const m = /(\d+)\/(\d+) P08 cross-tenant cases hold/.exec(out);
      if (!m) return null;
      return {
        clean: m[1] === m[2],
        reported: `${m[1]}/${m[2]} P08 cross-tenant cases hold`,
      };
    },
  },
  guard: {
    script: "apps/api/scripts/p02-guard-probe.mjs",
    needsWorker: false,
    tally(out) {
      const m = /(\d+)\/(\d+) guard cases hold/.exec(out);
      if (!m) return null;
      return { clean: m[1] === m[2], reported: `${m[1]}/${m[2]} guard cases hold` };
    },
  },
};

/**
 * Check the harness's own verdict parsing.
 *
 * WHY THIS IS A TEST AND NOT A COMMENT. Every campaign case that uses a runtime probe
 * asks the same question before believing a kill: *did that probe just report a clean
 * verdict?* A wrong answer there is invisible in the best case (a mutant is called
 * `HARNESS_FAULT` and quietly excluded from the tally) and catastrophic in the
 * worst.
 *
 * That is not hypothetical. The first version of this check matched the *passkey*
 * probe's summary wording and rejected the guard probe's correct result. The second
 * version generalised to any `/n/n` and then could not see `p05`, whose summary has no
 * denominator at all -- so a *surviving* p05 mutant, the one outcome this campaign
 * exists to detect, would have been relabelled `HARNESS_FAULT` and dropped.
 *
 * So each probe parses its own summary, and these cases pin the three shapes that
 * matter for each of them: a clean summary, a FAILING summary that nevertheless
 * exited 0, and a crash with no summary at all. The templates are the real ones, so
 * a probe changing its wording shows up here rather than at the end of a
 * twenty-minute campaign.
 */
const SELF_TEST = [
  // [probe, what the output is, must the verdict come back clean?]
  ["passkey", "\n55/55 checks passed", true],
  ["passkey", "\n54/55 checks passed", false],
  ["passkey", "Error: ENOENT\n  at boot (x.mjs:1:1)", null],
  ["p05", "\nP05 smoke: 185 checks passed; 0 failures; 0 limitations", true],
  ["p05", "\nP05 smoke: 184 checks passed; 1 failures; 0 limitations", false],
  ["p05", "Error: ENOENT\n  at boot (x.mjs:1:1)", null],
  ["p08", "\n45/45 P08 cross-tenant cases hold, 2 skipped", true],
  ["p08", "\n44/45 P08 cross-tenant cases hold, 2 skipped", false],
  ["p08", "Error: ENOENT\n  at boot (x.mjs:1:1)", null],
  ["guard", "\n13/13 guard cases hold across 2 recognised abort texts", true],
  ["guard", "\n12/13 guard cases hold across 2 recognised abort texts", false],
  ["guard", "Error: ENOENT\n  at boot (x.mjs:1:1)", null],
];

/**
 * Do every case's fault still apply to the source it names?
 *
 * WHY THIS IS A PREFLIGHT AND NOT A COMMENT. A case's `find` is a literal slice of a
 * source file. Nothing forces that slice to still be there: rename a column, rewrap a
 * line, move a statement, and the fault simply stops matching. The campaign then
 * reports the case as NOT_A_VALID_MUTATION -- or, for a source edit that still
 * compiles, as a mutant that suspiciously changes nothing -- and a twenty-minute run
 * is spent discovering it.
 *
 * That is not hypothetical. The first version of the VFY-011 case began its `find` at
 * the `.filter(...)` line rather than at the whole statement, so removing it left a
 * dangling `?` and the mutant did not compile. The campaign reported that honestly,
 * which is the behaviour it should have, but the whole run was spent finding out.
 *
 * WHAT IT CHECKS, AND WHAT IT DELIBERATELY DOES NOT.
 *
 *   1. `find` occurs at least once in the target file.
 *   2. Applying it changes that file.
 *
 * It does NOT require the fault text to be gone afterwards, because the campaign
 * applies `String.prototype.replace` with a string pattern -- the FIRST occurrence
 * only -- so a case whose `find` legitimately occurs three times is correct and still
 * leaves the same text further down. Two pre-existing cases do exactly that. The
 * occurrence count is reported instead, because a case that depends on which match
 * comes first depends on the source's shape rather than on the case.
 *
 * It also cannot check that the mutant COMPILES. That is the more valuable check and it
 * costs a full `cargo check` per case, so it stays the campaign's job; this preflight
 * is the cheap half, and it catches the far more common cause.
 */
function preflightFaults() {
  const broken = [];
  const notes = [];
  for (const testCase of CASES) {
    const faults = testCase.edits ?? [{ find: testCase.find, replace: testCase.replace }];
    for (const fault of faults) {
      const file = fault.file ?? testCase.file;
      if (!file || !fault.find) continue;
      let source;
      try {
        source = readFileSync(join(process.cwd(), file), "utf8");
      } catch {
        broken.push(`${testCase.id} ${testCase.title}: ${file} does not exist`);
        continue;
      }
      const occurrences = source.split(fault.find).length - 1;
      if (occurrences === 0) {
        broken.push(
          `${testCase.id} ${testCase.title}: the fault text is not in ${file}. The source ` +
            "moved and the case is now inert.",
        );
        continue;
      }
      if (occurrences > 1) {
        notes.push(
          `${testCase.id} ${testCase.title}: the fault text occurs ${occurrences} times in ` +
            `${file}; the first is replaced, so the case depends on the source's shape`,
        );
      }
      if (source.replace(fault.find, fault.replace) === source) {
        broken.push(`${testCase.id} ${testCase.title}: applying the fault changes nothing`);
      }
    }
  }
  return { broken, notes };
}

if (process.argv.includes("--preflight")) {
  const { broken, notes } = preflightFaults();
  for (const note of notes) console.log(`  note  ${note}`);
  for (const problem of broken) console.log(`  BROKEN ${problem}`);
  const total = CASES.length;
  console.log(
    `\n${total - broken.length}/${total} cases have a fault that still applies to the source`,
  );
  if (broken.length > 0) {
    console.log(
      "\nA case whose fault no longer applies proves nothing and costs a full campaign run to\n" +
        "discover. Fix the case's `find` against the current source -- do not remove the case and\n" +
        "do not widen the text until it matches, because a fault that matches something it was\n" +
        "not written for is not the invariant it claims to be.",
    );
  }
  process.exit(broken.length > 0 ? 1 : 0);
}

if (process.argv.includes("--self-test")) {
  let failed = 0;
  for (const [name, output, wantClean] of SELF_TEST) {
    const verdict = SMOKE_SCRIPTS[name].tally(output);
    const gotClean = verdict === null ? null : verdict.clean;
    const ok = gotClean === wantClean;
    if (!ok) failed += 1;
    const label = wantClean === null ? "no verdict (harness fault)" : `clean=${wantClean}`;
    console.log(
      `  ${ok ? "PASS" : "FAIL"}  ${name.padEnd(8)} ${label.padEnd(24)} ${
        verdict ? verdict.reported : "null"
      }`,
    );
    if (!ok) {
      console.log(
        `        wanted clean=${wantClean}, got clean=${gotClean} from:\n  ${JSON.stringify(output)}`,
      );
    }
  }
  console.log(`\n${SELF_TEST.length - failed}/${SELF_TEST.length} verdict-parsing cases hold`);
  if (failed > 0) {
    console.log(
      "\nA verdict parser that no longer recognises its probe will relabel mutants as\n" +
        "HARNESS_FAULT. Fix the parser or the probe's wording -- do not loosen the\n" +
        "check until it passes.",
    );
  }
  process.exit(failed > 0 ? 1 : 0);
}

/**
 * Locate a wrangler binary outside the scratch copy.
 *
 * Order, most specific first:
 *   1. \$PROBE_WRANGLER -- an explicit override always wins.
 *   2. `<cwd>/apps/api/node_modules/.bin/wrangler` -- correct when the campaign is
 *      run from a full checkout.
 *   3. The MAIN checkout, derived from the git common directory. A linked worktree
 *      stores its gitdir under `<main>/.git/worktrees/<name>`, so the parent of the
 *      common dir is the main checkout, and that is the one place `pnpm install`
 *      actually ran. This is what makes a worktree run work at all.
 */
function resolveWrangler() {
  const rel = join("apps", "api", "node_modules", ".bin", "wrangler");
  const candidates = [process.env.PROBE_WRANGLER, join(process.cwd(), rel)];
  try {
    const common = run(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      process.cwd(),
    ).trim();
    if (common) {
      // `--git-common-dir` is `<main>/.git`, so the checkout root is one level up
      // from that. Both forms are tried: the first version used only
      // `dirname(common) + "/.."`, which climbs ABOVE the checkout and therefore
      // never found anything. A resolver that silently finds nothing reports
      // HARNESS_FAULT, which is diagnosable but costs a full campaign run to
      // discover.
      candidates.push(join(common, "..", rel));
      candidates.push(join(dirname(common), rel));
    }
  } catch {
    // Not a git checkout, or git is unavailable. The first two candidates stand.
  }
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Where each mutant's scratch tree is built.
 *
 * DEFAULT, not the system temp dir. A scratch tree holds a full `target/` -- about
 * 2.4 GB, because the copy deliberately excludes `target/` and every case builds
 * from scratch -- and `os.tmpdir()` is routinely on the small system volume. On a
 * 228 GB volume with 1 GB free the build fails with ENOSPC partway through the
 * campaign, and the harness then reports `NOT_A_VALID_MUTATION`: "the mutant did
 * not compile, so no verifier could have caught the fault". That is a
 * MISDIAGNOSIS. Nothing is wrong with the mutation, the machine is out of room, and
 * a reader of the report is told a product property failed to compile.
 *
 * So the scratch defaults to a directory on the SAME volume as the repository,
 * where the build outputs already live, and `$P09_SCRATCH` overrides it. The
 * disk-space classification in `classifyBuildFailure` is the second half of the
 * fix: even with a better default, a machine can still fill up, and a build that
 * failed for any reason other than the code must not be reported as a property of
 * the mutation.
 */
function scratchRoot() {
  const override = process.env.P09_SCRATCH;
  const root = override ?? join(process.cwd(), "..", "..", "target", "mutation-scratch");
  mkdirSync(root, { recursive: true });
  return root;
}

/**
 * Distinguish "the mutant does not compile" from "the build environment failed".
 *
 * Only a genuine compiler diagnostic means the mutation was invalid. A build that
 * ran out of disk, ran out of memory, or was killed belongs to the harness, and
 * reporting it as a property of the mutant inverts cause and effect -- it tells a
 * reader that a Tier-0 invariant's evidence is absent for a reason that has
 * nothing to do with it.
 */
function classifyBuildFailure(result) {
  const out = result.out ?? "";
  if (
    /No space left on device|ENOSPC|disk (?:is )?full|out of memory|Killed|signal: 9|Too many open files/i.test(
      out,
    )
  ) {
    return {
      verdict: "HARNESS_FAULT",
      detail:
        "the BUILD ENVIRONMENT failed, not the mutant: the compiler never got to judge the " +
        `code. That makes the case absent, not invalid. The build said:\n  ${out
          .split("\n")
          .filter((line) =>
            /No space|ENOSPC|disk|out of memory|Killed|Too many open files/i.test(line),
          )
          .slice(0, 3)
          .join("\n  ")}`,
    };
  }
  if (!/error\[E\d+]|error: could not compile|error: aborting/i.test(out)) {
    return {
      verdict: "HARNESS_FAULT",
      detail:
        "the build failed WITHOUT a compiler diagnostic, so the mutant was never judged. " +
        `Output tail: ${out.slice(-300)}`,
    };
  }
  return {
    verdict: "NOT_A_VALID_MUTATION",
    detail: "the mutant did not compile, so no verifier could have caught the fault",
  };
}

function run(cmd, args, cwd, env) {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
}

function tryRun(cmd, args, cwd, env) {
  try {
    return { code: 0, out: run(cmd, args, cwd, env) };
  } catch (error) {
    return {
      code: error.status ?? 1,
      out: `${error.stdout ?? ""}${error.stderr ?? ""}`,
    };
  }
}

console.log(
  APPLY
    ? "VI-TEST-001 mutation campaign — APPLYING in a disposable worktree\n"
    : "VI-TEST-001 mutation campaign — dry run (use --apply to mutate)\n",
);
for (const c of CASES) {
  console.log(`  ${c.id} (tier ${c.tier})  ${c.title}`);
  const sites = c.edits ? [...new Set(c.edits.map((e) => e.file ?? c.file))] : [c.file];
  console.log(
    `      fault in  ${sites.join(" + ")}${c.edits && c.edits.length > 1 ? ` (${c.edits.length}-site fault)` : ""}`,
  );
  console.log(`      killed by ${c.verifier.join(" + ")}; reason must mention "${c.expect}"`);
}

if (!APPLY) {
  console.log("\nNothing was mutated. The cases above are the campaign.");
  process.exit(0);
}

// Refuse to spend the run on a case whose fault no longer matches its source. The
// dry run above is where a reader wants to be told this, and doing it here rather
// than leaving it to `--preflight` means nobody can start the expensive mode past
// it by forgetting the cheap one.
{
  const { broken, notes } = preflightFaults();
  for (const note of notes) console.log(`  note  ${note}`);
  if (broken.length > 0) {
    for (const problem of broken) console.log(`  BROKEN ${problem}`);
    console.log(
      `\nRefusing to apply: ${broken.length} case(s) would fault nothing. Fix the \`find\` text\n` +
        "against the current source. `pnpm verify:campaign-preflight` checks this on its own.",
    );
    process.exit(1);
  }
}

// --- execute --------------------------------------------------------------

// Refuse to run against the MAIN checkout. `git rev-parse --git-dir` is the
// honest test: in a linked worktree it resolves to `<repo>/.git/worktrees/<name>`,
// while in the main checkout it is `<repo>/.git` itself. Comparing the script's
// own path to the cwd does NOT work, because the script is copied into the
// worktree along with everything else.
function gitDir(cwd) {
  try {
    return run("git", ["rev-parse", "--git-dir"], cwd).trim();
  } catch {
    return "";
  }
}

if (!gitDir(process.cwd()).includes("/worktrees/")) {
  console.error(
    "\nRefusing to run: --apply must be pointed at a disposable LINKED worktree,\n" +
      "not the main checkout. This script mutates code on purpose. Create one with:\n" +
      "  git worktree add /tmp/p09-verify HEAD\n" +
      "and run this script with that directory as cwd.\n" +
      `  git rev-parse --git-dir here: ${gitDir(process.cwd()) || "not a git checkout"}`,
  );
  process.exit(2);
}
console.log(`mutating a linked worktree at ${process.cwd()}\n`);

const results = [];
for (const testCase of CASES) {
  const scratch = mkdtempSync(join(scratchRoot(), "p09-mutant-"));
  const label = `${testCase.id} ${testCase.title}`;
  try {
    // A cheap copy rather than a worktree per case: the tree is small enough and
    // `target/` is the only thing worth not copying.
    cpSync(process.cwd(), scratch, {
      recursive: true,
      filter: (src) =>
        !src.includes("/target/") && !src.includes("/node_modules/") && !src.includes("/.git/"),
    });
    // Link the real `node_modules` back in.
    //
    // The copy skips them because they are large, and because a mutated source
    // directory with its own dependency tree is not what is under test. But three of
    // this campaign's verifiers start a real Worker, and `wrangler` then bundles
    // `apps/api/sentry-entry.mjs`, which imports `@sentry/cloudflare`. With no
    // `node_modules` in the scratch tree that import cannot resolve, the build
    // fails, and the probe reports "the Worker never became healthy" -- which the
    // campaign grades as a kill for the wrong reason.
    //
    // That is worse than a red gate, because it looks like evidence about the
    // product. It also went unnoticed for exactly the reason a gate nobody can
    // trust gets ignored: `verify:mutation` is not in CI, and the three affected
    // cases had last been run on a branch that predated the Sentry entry.
    //
    // A symlink rather than a copy: the point is to resolve the real packages, and
    // a second copy would be gigabytes per case.
    for (const dir of ["node_modules", "apps/api/node_modules", "apps/web/node_modules"]) {
      const real = join(process.cwd(), dir);
      if (!existsSync(real)) continue;
      const link = join(scratch, dir);
      try {
        mkdirSync(dirname(link), { recursive: true });
        rmSync(link, { force: true, recursive: true });
        symlinkSync(real, link, "dir");
      } catch (error) {
        // A filesystem without symlinks would fail here. Say so rather than letting
        // the build fail later with an unrelated-looking message.
        throw new Error(
          `could not link ${dir} into the scratch copy (${error.message}). A case that ` +
            "builds a Worker needs the real dependencies, and without them the build " +
            "fails in a way that reads like a product fault.",
        );
      }
    }
    // A case injects one fault (`find`/`replace`) or several (`edits`).
    //
    // Multiple edits exist because a genuinely defended-in-depth invariant cannot
    // be disabled by touching one place, and pretending otherwise would produce a
    // mutation that "survives" for the uninteresting reason that a second
    // mechanism was doing the work. VI-AUTH-001 is the case in point: the
    // ceremony-replay requirement is enforced twice, independently, so removing
    // either defence alone leaves the other standing.
    //
    // Every target is checked for existence and every anchor for presence BEFORE
    // anything is written, so a case can never half-apply and then be reported as
    // evidence. A missing anchor is BLOCKED, which the tally gate now treats as a
    // failure -- an earlier version exited 0 here, next to "0/1 killed".
    const faults = testCase.edits ?? [{ find: testCase.find, replace: testCase.replace }];
    // The file list is derived, not read from `testCase.file`, so a case that uses
    // `edits` does not also have to declare a redundant `file`.
    const relative = [...new Set(faults.map((f) => f.file ?? testCase.file))];
    const absent = relative.filter((rel) => !existsSync(join(scratch, rel)));
    if (absent.length) {
      results.push({
        ...testCase,
        verdict: "BLOCKED",
        detail: `target file(s) not found in the scratch copy: ${absent.join(", ")}`,
      });
      continue;
    }
    const sources = new Map();
    const missing = [];
    for (const fault of faults) {
      const rel = fault.file ?? testCase.file;
      const file = join(scratch, rel);
      const source = sources.get(file) ?? readFileSync(file, "utf8");
      if (!source.includes(fault.find)) {
        missing.push(`${rel}: "${fault.find}"`);
        continue;
      }
      sources.set(file, source.replace(fault.find, fault.replace));
    }
    if (missing.length) {
      results.push({
        ...testCase,
        verdict: "BLOCKED",
        detail: `anchor(s) not present, so the fault was never injected: ${missing.join("; ")}`,
      });
      continue;
    }
    for (const [file, source] of sources) writeFileSync(file, source);
    if (faults.length > 1) {
      console.log(
        `      (${faults.length}-site fault: ${[...sources.keys()].map((f) => f.replace(`${scratch}/`, "")).join(", ")})`,
      );
    }

    // Half one: the mutant must COMPILE. A mutation that fails to build has
    // killed nothing; it just failed to typecheck.
    //
    // A case whose verifier drives the real Worker needs a RELEASE build of the
    // wasm, not just `cargo build --tests`: `wrangler dev` serves
    // `apps/api/build/index.js`, and if that artifact is stale the probe would
    // test unmutated code and report a false pass. The `cargo build --tests` step
    // is kept as well so an obviously non-compiling mutant is rejected cheaply
    // before the expensive one.
    const needsWorker = testCase.verifier.some(
      (v) => v.startsWith("smoke:") && SMOKE_SCRIPTS[v.slice("smoke:".length)]?.needsWorker,
    );
    if (!testCase.verifier.includes("schema")) {
      const compile = tryRun(
        "cargo",
        ["build", "--tests", "-p", "lumi-agents-control-plane-api"],
        scratch,
      );
      if (compile.code !== 0) {
        results.push({ ...testCase, ...classifyBuildFailure(compile) });
        continue;
      }
    }
    if (needsWorker) {
      const wasm = tryRun(
        "cargo",
        [
          "build",
          "--release",
          "-p",
          "lumi-agents-control-plane-api",
          "--target",
          "wasm32-unknown-unknown",
        ],
        scratch,
      );
      if (wasm.code !== 0) {
        const classified = classifyBuildFailure(wasm);
        results.push({
          ...testCase,
          ...classified,
          detail:
            classified.verdict === "NOT_A_VALID_MUTATION"
              ? "the mutant did not build for wasm32, so the Worker probe cannot reach it"
              : classified.detail,
        });
        continue;
      }
      // `worker-build` is what produces `apps/api/build/index.js`. It is a
      // separate binary from cargo, so the harness runs it directly rather than
      // assuming `pnpm build` works inside a scratch copy.
      const bundle = tryRun("worker-build", ["--release"], join(scratch, "apps/api"));
      if (bundle.code !== 0) {
        results.push({
          ...testCase,
          verdict: "HARNESS_FAULT",
          detail:
            "worker-build failed, so the Worker probe would have tested a stale or absent bundle " +
            "and its result would mean nothing",
        });
        continue;
      }
    }

    // Half two: EVERY named verifier must die, and say why.
    //
    // Running only the first named verifier is a reporting bug that reads as a
    // finding: three of the four "survivors" in the first run of this campaign were
    // this line, not the system.
    const runs = [];
    for (const verifier of testCase.verifier) {
      if (verifier === "tenant_audit") {
        runs.push([
          "tenant_audit",
          tryRun(
            "cargo",
            ["test", "-p", "lumi-agents-control-plane-api", "--lib", "security::tenant_audit"],
            scratch,
          ),
        ]);
      } else if (verifier === "schema") {
        runs.push([
          "schema",
          tryRun("node", ["apps/api/scripts/p07-schema-invariants.mjs"], scratch),
        ]);
      } else if (verifier === "canary") {
        runs.push(["canary", tryRun("node", ["apps/api/scripts/p09-secret-canary.mjs"], scratch)]);
      } else if (verifier === "cargo") {
        continue; // the concrete filter is the next entry
      } else if (verifier.startsWith("smoke:")) {
        // A real-runtime probe. Run from the scratch tree so the mutated sources
        // and the freshly built bundle are the ones under test.
        //
        // The scratch copy deliberately excludes `node_modules`, so the wrangler
        // binary has to come from the REAL tree. The first version resolved it as
        // `<cwd>/apps/api/node_modules/.bin/wrangler`, and `cwd` is the disposable
        // worktree -- which has no `node_modules` -- so the probe died with `spawn
        // ... ENOENT` and the case was reported as KILLED_FOR_THE_WRONG_REASON. A
        // missing launcher reported as a wrong reason is how a broken campaign
        // reads as a finding about the product.
        const wrangler = resolveWrangler();
        if (!wrangler) {
          results.push({
            ...testCase,
            verdict: "HARNESS_FAULT",
            detail:
              "no wrangler binary could be found, so the runtime probe could not be " +
              "started at all. Looked in the worktree, in the main checkout derived " +
              "from the git common dir, and at \$PROBE_WRANGLER. Install workspace " +
              "dependencies and re-run; this is a campaign defect, not evidence.",
          });
          continue;
        }
        const entry = SMOKE_SCRIPTS[verifier.slice("smoke:".length)];
        if (!entry) {
          results.push({
            ...testCase,
            verdict: "HARNESS_FAULT",
            detail:
              `no script is registered for "${verifier}". Known: ` +
              `${Object.keys(SMOKE_SCRIPTS)
                .map((n) => `smoke:${n}`)
                .join(", ")}. ` +
              "A case naming a probe that does not exist would otherwise be reported as " +
              "evidence about the product.",
          });
          continue;
        }
        // Every probe gets the resolved binary under the name IT reads, not just
        // the two that happened to need one when the harness was written. A probe
        // whose wrangler is missing from a mutated copy reports a missing binary
        // path, which the campaign correctly grades as a kill for the wrong
        // reason -- and a wrong-reason kill is worse than no case, because it
        // looks like evidence.
        const result = tryRun("node", [entry.script], scratch, {
          PROBE_WRANGLER: wrangler,
          P02_PASSKEY_WRANGLER: wrangler,
          P05_WRANGLER: wrangler,
        });
        // A probe that crashed before its verdict is not a pass, and a probe that
        // printed a failing tally while still exiting 0 is not a pass either. Both
        // are harness faults: they mean the run produced no evidence either way.
        //
        // Note this only runs on exit 0. A mutant that the probe rejects exits
        // non-zero, which is the kill path and must stay untouched.
        if (result.code === 0) {
          const verdict = entry.tally(result.out);
          if (!verdict) {
            results.push({
              ...testCase,
              verdict: "HARNESS_FAULT",
              detail: `the runtime probe exited 0 without reporting a check tally in its own format, so it crashed before its verdict`,
            });
            continue;
          }
          if (!verdict.clean) {
            results.push({
              ...testCase,
              verdict: "HARNESS_FAULT",
              detail: `the runtime probe exited 0 but its own tally read "${verdict.reported}"; a probe that reports failures must not exit 0`,
            });
            continue;
          }
        }
        runs.push([verifier, result]);
      } else {
        const r = tryRun(
          "cargo",
          ["test", "-p", "lumi-agents-control-plane-api", "--lib", verifier],
          scratch,
        );
        // A filter that matches nothing exits 0 and looks exactly like a pass.
        // Count the tests so that failure mode is impossible to miss.
        const matched = Number((r.out.match(/test result: ok\. (\d+) passed/) ?? [])[1] ?? 0);
        if (matched === 0 && r.code === 0) {
          results.push({
            ...testCase,
            verdict: "HARNESS_FAULT",
            detail: `the filter "${verifier}" matched ZERO tests, so cargo exited 0 and it looked like a pass`,
          });
          continue;
        }
        runs.push([verifier, r]);
      }
    }
    if (results[results.length - 1]?.verdict === "HARNESS_FAULT") continue;
    // Killed if ANY named verifier dies. Requiring all of them was the second
    // reporting bug in this harness: naming the schema harness alongside the tenant
    // audit made a mutation the audit catches look like a survivor, because the
    // schema harness legitimately still passed.
    const out = runs.map(([, r]) => r.out).join("\n");
    const code = runs.some(([, r]) => r.code !== 0) ? 1 : 0;
    if (code === 0) {
      results.push({
        ...testCase,
        verdict: "SURVIVED",
        detail: `the fault is live and NO verifier noticed — this is the dangerous outcome`,
      });
      continue;
    }
    const killedForTheRightReason = out.toLowerCase().includes(testCase.expect.toLowerCase());
    // The verifier's own words travel with the verdict. A KILLED_FOR_THE_WRONG_REASON
    // is a question -- "what DID it say?" -- and a verdict that raises a question
    // without the evidence to answer it forces a manual re-run in a scratch tree to
    // diagnose, which is what had to happen for VI-AUTH-001.
    //
    // Trimmed to the lines that actually mention the expected marker, falling back
    // to a short tail, so the useful part is visible without pasting a release
    // build log into the summary.
    const evidence = (() => {
      const lines = out.split("\n");
      const needle = testCase.expect.toLowerCase();
      const near = lines.filter((line) => line.toLowerCase().includes(needle));
      return (near.length ? near : lines.slice(-30))
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 8)
        .join(" / ")
        .slice(0, 900);
    })();
    results.push({
      ...testCase,
      verdict: killedForTheRightReason ? "KILLED" : "KILLED_FOR_THE_WRONG_REASON",
      detail: killedForTheRightReason
        ? `the verifier failed, and the failure names the invariant: ${evidence}`
        : `the verifier failed but nothing mentioned "${testCase.expect}", so the kill may ` +
          `be incidental. What it actually said: ${evidence}`,
    });
  } catch (error) {
    results.push({
      ...testCase,
      verdict: "BLOCKED",
      detail: String(error.message ?? error).slice(0, 200),
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    // Logged here rather than after the loop: a `continue` on the BLOCKED or
    // NOT_A_VALID_MUTATION paths jumps past a trailing log, and a verdict that is
    // computed but not printed is the same as no verdict at all.
    const last = results[results.length - 1];
    const mark = last.verdict === "KILLED" ? "✓" : "✗";
    console.log(`  ${mark} [${last.verdict}] ${testCase.id}  ${testCase.title}`);
    console.log(`      ${last.detail}`);
    console.log("");
  }
}

const killed = results.filter((r) => r.verdict === "KILLED").length;
const total = results.length;
const byVerdict = {};
for (const r of results) byVerdict[r.verdict] = (byVerdict[r.verdict] ?? 0) + 1;
console.log("tally:", JSON.stringify(byVerdict));
console.log(
  `${killed}/${total} mutations were killed by the verifier that is supposed to defend them`,
);
const survivors = results.filter(
  (r) => r.verdict === "SURVIVED" || r.verdict === "KILLED_FOR_THE_WRONG_REASON",
);
if (survivors.length) {
  console.log("\nA surviving mutation means a Tier-0 claim is UNPROVEN, not PASS:");
  for (const s of survivors) console.log(`  - ${s.id}: ${s.title} (${s.verdict})`);
}

// A case that never ran is not a pass. Found while adding the `smoke:passkey`
// case: a BLOCKED case (a harness fault, a missing anchor, a build that failed)
// left `survivors` empty, so the campaign printed `0/1 mutations were killed` and
// then exited 0. A green exit code next to a zero tally is the exact shape of
// claim this campaign exists to prevent, and it was in the harness itself.
//
// So the gate is on the TALLY, not on the survivor list: every case must be
// KILLED for the process to succeed.
const unresolved = results.filter((r) => r.verdict !== "KILLED");
if (unresolved.length) {
  console.log("\nNOT every mutation was killed, so this campaign did not pass:");
  for (const r of unresolved) {
    console.log(`  - ${r.id}: ${r.title} (${r.verdict}) — ${r.detail}`);
  }
  if (survivors.length === 0) {
    console.log(
      "\n  Note: none of these are SURVIVED. A BLOCKED or HARNESS_FAULT verdict means the\n" +
        "  case never produced evidence either way, which is a gap in the campaign, not a\n" +
        "  clean bill of health. Fix the case and re-run.",
    );
  }
}
process.exit(unresolved.length ? 1 : 0);
