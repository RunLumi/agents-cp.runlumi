--- A. the real local D1, migrations 0001..0020 -------------------------
DB=apps/api/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/e7352547963de7050bd7d94658afc4fe78b61811b7815da12d90be8e863abf4d.sqlite
$ wrangler d1 execute DB --local --env development --command "<sentinel>"
✘ [ERROR] a pending idempotency record carries no result and must hold a claim token: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)

--- B. the same statement against 0001..0019 only -----------------------
$ sqlite3 pre0020.sqlite "<sentinel>"
  Error in 2nd command line argument: NOT NULL constraint failed: idempotency_records.principal_id

--- C. the matcher ---------------------------------------------------
}

impl std::error::Error for AutomationStoreError {}

/// A guard statement aborts a D1 batch by violating a table constraint, so the
/// batch error text is the only signal that a write was refused on purpose.
pub fn is_guard_violation(error: &worker::Error) -> bool {
    let detail = format!("{error:?}");
    detail.contains("NOT NULL") || detail.contains("constraint")
}

// -----------------------------------------------------------------------------
// Inputs

$ sed -n "252,256p" apps/api/src/routes/usage.rs
fn is_guard_violation(error: &worker::Error) -> bool {
    let detail = format!("{error:?}");
    detail.contains("NOT NULL") || detail.contains("constraint")
}


--- D. end to end through the real Worker -----------------------------
$ node apps/api/scripts/p05-smoke.mjs   (fresh local D1, own Worker)
  see evidence/browser-probe-run.log siblings: 175 checks passed, 1 failed
  FAIL  internal reservation endpoint replays the managed hold -- status=503 reason=none

--- E. guard sentinel statements that share the mechanism ---------------
   6 apps/api/src/repositories/ai.rs
   1 apps/api/src/repositories/automations.rs
   1 apps/api/src/repositories/billing.rs
   6 apps/api/src/repositories/budgets.rs
   1 apps/api/src/repositories/data_governance.rs
   2 apps/api/src/repositories/idempotency.rs
   2 apps/api/src/repositories/machine_identity.rs
   2 apps/api/src/repositories/migration.rs
   2 apps/api/src/repositories/platform_ops.rs
   1 apps/api/src/repositories/plugins.rs
   4 apps/api/src/repositories/runs.rs
   6 apps/api/src/repositories/tools.rs
   2 apps/api/src/repositories/usage.rs
   2 apps/api/src/repositories/webhooks.rs
