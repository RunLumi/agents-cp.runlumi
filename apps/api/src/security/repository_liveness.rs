//! Every `pub` repository function has a caller — or is on a reviewed list with a reason.
//!
//! # The defect this is for
//!
//! V01-040, V01-041, and V01-042 are the same defect three times, and the third one's own doc comment
//! shows the class was already found once and fixed in one subsystem:
//!
//! > This function is the producer half of the P06 job queue, **and it did not exist**. `JOBS_QUEUE`
//! > was declared as a producer binding, had a consumer attached, and a handler that routes on
//! > `batch.queue()` -- but no code anywhere obtained the binding, so nothing was ever sent.
//!
//! **A binding declared, a consumer attached, a handler present, and no code that obtains it.** That was
//! fixed for P06 and the class was never swept for. The three instances this check exists for:
//!
//! - **V01-041** `deny_enrollment` — the schema admitted `'denied'`, `DENY_ENROLLMENT_SQL` was correct
//!   and org-scoped, the repository method existed, and the sibling `approve` route was registered. A
//!   device enrollment could be **approved but never denied**, so a human control had an affirmative
//!   branch and no negative one, and a reviewer's refusal left no record.
//! - **V01-040** `find_grants_for_staff_and_org` — its doc comment reads *"the grant read every
//!   customer-context request uses"*, a second comment repeats the claim, and a unit test asserts its
//!   SQL predicates. **The scoping was verified and the existence of a caller was not**, because a test
//!   over a string constant cannot report that nothing calls the function that owns it.
//! - **V01-042** `purge_expired_statement` — a batched, bounded, oldest-first purge with a dedicated
//!   index built for it, called by nothing, in a sweep that runs every minute.
//!
//! So the repair for this class is **a check that asks the question**, not a fix. Fixing one instance
//! does not close it.
//!
//! # What this check asserts, and what it deliberately does not
//!
//! Every `pub fn` / `pub async fn` in `repositories/` must have at least one **non-test** call site
//! anywhere under `src/`, unless its name appears in [`REVIEWED_UNCALLED`] with a reason.
//!
//! It is a **liveness** check and nothing more, and the limit is worth stating because the temptation
//! to read more into it is exactly how a liveness check becomes a false assurance:
//!
//! - It proves a function is **called**, not that it is called **correctly**, or for the right reason,
//!   or on the right path. A function called once from dead code passes.
//! - It reads the **source text**, so it is a statement about what the tree says, not a runtime
//!   measurement. A `macro_rules!` expansion or a build script that generates a call would be invisible.
//! - It counts a call by **name**, so two same-named functions on different types are indistinguishable.
//!   No such collision exists in `repositories/` today, and a collision would show up as a *false
//!   pass*, which is the dangerous direction.
//!
//! # Two parser faults recorded, because each produced a confidently wrong answer first
//!
//! **1. A lookbehind that excluded the normal call form.** The first version used
//! `(?<![\w:.])name\s*\(` to avoid matching a longer identifier -- and the `:` in that class excluded
//! `.method(`, which is *how repositories are called*. It reported **474 of 568** functions as dead. A
//! check whose first output is nonsense is a check nobody reads, and the correct response to "three
//! quarters of the codebase is dead" is to distrust the check.
//!
//! **2. Doc comments and strings counted as calls.** The scan must ignore `//` and `///` lines and
//! string literals, or a function named in prose reads as called. V01-040 is the proof that this
//! matters in the *other* direction: its misleading doc comment is exactly a name in prose.
//!
//! **3. `#[cfg(test)]` modules must be excluded**, or a function called only from tests passes -- which
//! is the exact case worth reporting. The exclusion brace-matches the module's own `{`, and a bare
//! `#[cfg(test)]` attribute on a single item is skipped rather than swallowing the rest of the file.

#[cfg(test)]
mod tests {
    use std::collections::{BTreeMap, BTreeSet};
    use std::fs;
    use std::path::{Path, PathBuf};

    /// Zero-caller functions, each with the reason it is allowed to have none.
    ///
    /// Adding a name here is a decision, and the list is the record of it. `UNTRIAGED` is an honest
    /// label rather than an invented justification: those entries are known-unexamined, which is the
    /// state this check is designed to make visible instead of leaving as an unexamined list of 53.
    const REVIEWED_UNCALLED: &[(&str, &str)] = &[
        // --- found by this class, and resolved -------------------------------------------------
        (
            "deny_enrollment",
            "V01-041, now called: POST .../enrollments/{id}/deny. Was the clearest instance -- schema \
             state, correct org-scoped SQL, repository method, registered sibling route, no caller.",
        ),
        (
            "purge_expired_statement",
            "V01-042, now called from `run_scheduled_sweep`. Was a bounded batched purge with a \
             dedicated index and no caller, in a sweep that runs every minute.",
        ),
        (
            "insert_quarantine_statement",
            "V01-043, now called by POST /api/v1/internal/plugin-quarantines. Was one of three \
             quarantine methods with no route above them, while `is_quarantined` was enforced on four \
             paths -- a control with no lever.",
        ),
        (
            "lift_quarantine_statement",
            "V01-043, now called by .../plugin-quarantines/{id}/lift. Kept as a pair with the engage \
             lever on purpose: a quarantine that cannot be lifted is its own outage.",
        ),
        (
            "list_quarantines",
            "V01-043, now called by GET /api/v1/internal/plugin-quarantines. The piece that makes the \
             other two auditable -- an operator who cannot see the set cannot judge a lift.",
        ),
        // --- deliberately out of band -----------------------------------------------------------
        (
            "insert_staff_statement",
            "Staff provisioning is out of band BY DESIGN: `core::staff` states the raw value is \
             'shown once to the operator who provisioned the principal', so a staff principal is \
             created by an operator, not by an API. `verify:staff-credential` provisions one by \
             inserting the row for the same reason.",
        ),
        (
            "find_staff",
            "Same: there is no staff-management API. Reading a staff principal is an operator \
             action, and inventing a route for it would be a feature, not a repair.",
        ),
        ("list_staff", "Same as `find_staff`."),
        // --- known gap, recorded as a finding --------------------------------------------------
        (
            "find_grants_for_staff_and_org",
            "V01-040: ADR 0007's 'grant on every use' has no implementation, so this read has no \
             caller. Its doc comment asserting the opposite is the misleading part, and the record \
             proposes the comment be corrected rather than the route invented here.",
        ),
        // --- redundancy, and the hazard is the duplicate ----------------------------------------
        (
            "touch_credential_statement",
            "Duplicates `mark_credential_used_statement`, which IS called from `routes/inference.rs`, \
             with the same `UPDATE credentials SET last_used_at`. Two ways to write one column is the \
             hazard rather than the convenience; the live path is the called one.",
        ),
        // --- examined and left, with the reason -------------------------------------------------
        (
            "encode_audit_cursor",
            "The audit list is served by the page SQL's own keyset; this encoder has no caller and no \
             spec requires one. Harmless: it writes nothing.",
        ),
        (
            "parsed_code",
            "A pure parser helper with no caller. Writes nothing, so a dead parser cannot cause a \
             retention or authorisation problem -- which is the distinction that matters when triaging \
             a list like this.",
        ),
        (
            "parsed_remedy",
            "Pure parser helper, no caller, writes nothing. See `parsed_code`.",
        ),
        (
            "rolled_back_from",
            "A record projection field with no reader. Reads a column that exists; changes nothing.",
        ),
        (
            "is_hard",
            "A budget predicate. `budgets.rs` reads hardness inline in the reservation path, so this \
             accessor is redundant rather than load-bearing.",
        ),
        // --- UNEXAMINED, and labelled as such ---------------------------------------------------
        // The remainder are recorded rather than triaged. The honest reason is that they have NOT been
        // examined, and saying so is the point: before this check the same information existed as an
        // unexamined scan output that nobody read, and two of the three findings in this class were
        // sitting in it. A list that says "53, of which 53 are untriaged" is a to-do list; a list that
        // is absent is a false assurance.
        ("create_organization", "UNTRIAGED"),
        ("create_user", "UNTRIAGED"),
        ("decode_json_document", "UNTRIAGED"),
        ("decode_stored_bytes", "UNTRIAGED"),
        (
            "deny_enrollment_statement",
            "V01-041, now called by the `deny_enrollment` handler: POST .../enrollments/{id}/deny. A pending enrollment could be approved and never denied, so a human control had an affirmative branch and no negative one.",
        ),
        (
            "find_active_credential",
            "EXAMINED, no gap. Superseded by the session/machine authentication paths, which resolve a credential together with the principal rather than alone. A credential lookup that returns a row without its owner is the same shape as V01-034's prefix resolver, so it has no caller.",
        ),
        ("find_active_route_version", "UNTRIAGED"),
        ("find_budget_for_scope_period", "UNTRIAGED"),
        ("find_identity_by_user", "UNTRIAGED"),
        (
            "find_key_by_prefix",
            "EXAMINED, deliberately uncalled, and the reason is V01-034. It resolves a credential by its lookup prefix alone. The V01-034 fix made the staff path compare the presented secret in constant time against the stored hash, and the machine path eleven lines above already did. A prefix-only resolver is the exact shape of the authentication bypass that was CRITICAL, so no caller is the safe state. Recorded because the method still exists and the temptation is symmetric.",
        ),
        (
            "find_live_device_token",
            "EXAMINED, superseded rather than missing, and the reason is a security improvement rather than a redundancy. The live path is `require_device` (`routes/devices.rs:191`, 7 call sites), which INLINES its own query joining `devices` and filtering `d.status = 'active'`. This function reads `device_tokens` alone (`WHERE token_hash = ?1 AND device_id = ?2 AND expires_at > ?3`), so it cannot see a device's status -- which is exactly the coupling V01-016 recorded: revocation works today only because `revoke_device` deletes the token rows in the same batch. Wiring the WEAKER query would be a regression, so leaving it uncalled is correct.",
        ),
        (
            "find_snapshot",
            "EXAMINED, and the one entry triaged as a LATENT cross-tenant read rather than a gap. `SNAPSHOT_BY_ID_SQL` is `WHERE policy_id = ?1` with NO `org_id` predicate, so it would return another organization's compiled policy payload. It is unreachable: no route takes a `policy_id` in its path (`/policy`, `/policy/tools`, `/plugins/policy` are all org-scoped with no id), and the only caller that needs a snapshot uses the org-scoped `latest_snapshot`. Recorded because the defect is latent and one route away -- if a future route ever accepts a policy id, this is the statement that would leak.",
        ),
        (
            "find_snapshot_by_version",
            "EXAMINED, no gap. `WHERE org_id = ?1 AND policy_version = ?2` is correctly org-scoped, and nothing needs it: the compile path reads `latest_snapshot`, and the one write site (`routes/devices.rs:363`, the device policy cache) is a dedup against the latest, not a versioned fetch. A point lookup with no caller is cheaper to keep than to justify removing.",
        ),
        ("get_for_organization", "UNTRIAGED"),
        ("insert_budget_reservation_statement", "UNTRIAGED"),
        ("insert_notification_delivery_statement", "UNTRIAGED"),
        ("insert_notification_statement", "UNTRIAGED"),
        ("insert_plan_entitlement_statement", "UNTRIAGED"),
        ("insert_plan_statement", "UNTRIAGED"),
        (
            "insert_quarantine_statement",
            "V01-043, now called by POST /api/v1/internal/plugin-quarantines. The write half of a quarantine that was enforced on four paths and operable on none.",
        ),
        (
            "insert_remediation_statement",
            "EXAMINED, no gap. Migration bookkeeping: it writes the migration ledger's own remediation row as part of applying a migration, so it is reached through the migration runner rather than by a route. Out of band by design.",
        ),
        (
            "insert_run_usage_statement",
            "V01-047, OPEN by decision. P05-CR-002 §7 commits to a second usage source and §8 says it `must use` the same cost rules, but `UsageSource::Run` is constructed only in `modules/usage_tests.rs`, so this writer is unreachable and `list_usage`/`summarize_usage` UNION ALL an always-empty table. Left open: what counts as billable non-inference usage is a money decision needing the deliberate change process.",
        ),
        ("list_active_plans", "UNTRIAGED"),
        (
            "list_cost_records",
            "V01-047, examined. A list over `cost_records` with no caller. The per-record reads (`find_cost_record`, `find_run_cost_record`) ARE called from `routes/usage.rs:1193-1204`, so this is a list variant nothing needs -- not a gap, and recorded so it is not re-derived.",
        ),
        (
            "list_deletions_for_user",
            "EXAMINED, no gap. A per-user listing; the routes read deletions by scope (`find_deletion_for_scope`, `find_deletion_for_target`) and by id (`find_deletion_for_scope` at `routes/data_governance.rs`), which is what the tenant-scoped API needs. Nothing asks for one user's deletions across scopes.",
        ),
        ("list_entitlement_definitions", "UNTRIAGED"),
        (
            "list_quarantines",
            "V01-043, now called by GET /api/v1/internal/plugin-quarantines. Without it the other two are unauditable: an operator who cannot see the set cannot judge a lift.",
        ),
        ("list_reservations_page", "UNTRIAGED"),
        ("list_signing_keys", "UNTRIAGED"),
        (
            "mark_artifact_deleted_statement",
            "EXAMINED, no gap in the deletion LIFECYCLE, and a leaf that is unused rather than missing. The lifecycle is live: `insert_deletion_statement`, `update_deletion_state_statement` (two sites in `consumers/data_jobs.rs`) and the queue envelope all have callers, and the consumer plans through `deletion_inventory`. This one would flip `export_artifacts.deleted_at` and has no caller -- a leaf the expiry path covers by TTL, so nothing is left un-deleted; recorded so it is not re-derived.",
        ),
        ("record_provider_failure_statement", "UNTRIAGED"),
        (
            "revoke_grants_statement",
            "EXAMINED, and the sixth instance of the read-without-write / write-without-read shape. `export_download_grants` is LIVE: `insert_download_grant_statement`, `find_download_grant` and `touch_download_grant_statement` all have callers in `routes/data_governance.rs`. Only the REVOKE is unreachable. Redemption checks `revoked_at IS NULL` AND `expires_at`, and the TTL is `DOWNLOAD_GRANT_TTL_SECONDS = 900` (15 min, frozen by the AccessGrant baseline), so the working control is expiry and the missing one is EARLY revocation: a leaked grant cannot be killed before it expires. No spec requires revocation, and the failure direction is fail-closed, so this is a capability gap rather than a contract violation -- recorded so it is not re-derived, not repaired here because adding a revoke route is a feature with its own spec.",
        ),
        ("seat_policy_for_plan", "UNTRIAGED"),
        (
            "set_deletion_cutoff_statement",
            "EXAMINED, same family as `mark_artifact_deleted_statement`: a leaf with no caller. It would stamp `deletion_jobs` with the cutoff the job actually applied. The job still transitions through `update_deletion_state_statement`, so the lifecycle completes; what is absent is the record of WHERE the deletion stopped. Left untriaged in the sense that whether the retention certificate needs it is a P06 question, not a code one.",
        ),
        ("switches_for", "UNTRIAGED"),
        (
            "to_verification_key",
            "EXAMINED, no gap. A pure projection from a stored signing-key row into the adapter's key type. The billing path uses the row directly; this is a convenience projection, and leaving it unused is cheaper than deleting a documented conversion.",
        ),
        ("update_state", "UNTRIAGED"),
        ("upsert_provider_projection_statement", "UNTRIAGED"),
        (
            "upsert_rollup_statement",
            "V01-047, examined. `list_rollups` IS called (`routes/usage.rs:776`) but nothing WRITES a rollup, so every rollup read returns nothing. Same shape as the run-source writer: a read wired without its write. Open with V01-047.",
        ),
        ("assert_single_queued_successor_statement", "UNTRIAGED"),
        // Found by this check and MISSED by the looser scan that motivated it, because the only
        // occurrences of these two names outside their declarations are inside a doc comment or a
        // string literal. That is the third parser fault in this file's header, and it runs the
        // opposite way to the first: the STRICTER instrument found MORE dead code, because the
        // looseness was in the weaker one.
        (
            "budget",
            "UNTRIAGED -- the only non-declaration occurrences of this name are in a comment or \
                    a string, so a scan that does not strip them counts prose as a call",
        ),
        (
            "list_attempts",
            "UNTRIAGED -- as `budget`: named in prose, never called",
        ),
        ("fan_out_count", "UNTRIAGED"),
        ("fan_out_event_statement", "UNTRIAGED"),
        ("policy_conflict_ids", "UNTRIAGED"),
        (
            "lift_quarantine_statement",
            "V01-043, now called by .../plugin-quarantines/{id}/lift. Kept as a pair with its sibling: a lever that can be pulled but not released is its own outage.",
        ),
    ];

    fn source_files(root: &Path) -> Vec<PathBuf> {
        let mut found = Vec::new();
        let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            let entries =
                fs::read_dir(&dir).unwrap_or_else(|e| panic!("cannot read {}: {e}", dir.display()));
            for entry in entries {
                let path = entry.expect("readable dir entry").path();
                if path.is_dir() {
                    stack.push(path);
                } else if path.extension().is_some_and(|e| e == "rs") {
                    found.push(path);
                }
            }
        }
        found.sort();
        found
    }

    /// Remove `#[cfg(test)] mod <name> { ... }` blocks, and every comment and string literal.
    ///
    /// Comments and strings are removed because a function named in prose is not a call — and V01-040's
    /// misleading doc comment is exactly that case. The module removal brace-matches the module's own
    /// `{`, so a bare `#[cfg(test)]` attribute on a single item cannot swallow the rest of the file.
    fn production_code(text: &str) -> String {
        // 1. `#[cfg(test)] mod name { ... }`
        let mut without_tests = String::with_capacity(text.len());
        let mut rest = text;
        loop {
            let Some(start) = rest.find("#[cfg(test)]") else {
                without_tests.push_str(rest);
                break;
            };
            without_tests.push_str(&rest[..start]);
            let after = &rest[start + "#[cfg(test)]".len()..];
            let looks_like_module = after
                .trim_start()
                .strip_prefix("mod ")
                .is_some_and(|t| t.starts_with(|c: char| c.is_alphanumeric() || c == '_'));
            match after.find('{') {
                Some(brace) if looks_like_module => {
                    let mut depth = 0i32;
                    let mut end = brace;
                    for (offset, ch) in after[brace..].char_indices() {
                        match ch {
                            '{' => depth += 1,
                            '}' => {
                                depth -= 1;
                                if depth == 0 {
                                    end = brace + offset;
                                    break;
                                }
                            }
                            _ => {}
                        }
                    }
                    rest = &after[end + 1..];
                }
                _ => {
                    // A `#[cfg(test)]` on a single item: drop the attribute, keep the item.
                    rest = after;
                }
            }
        }
        // 2. Line comments, then string literals (which may contain `//`).
        let mut out = String::with_capacity(without_tests.len());
        for line in without_tests.lines() {
            let mut in_string = false;
            let mut escaped = false;
            let mut cut = line.len();
            for (index, ch) in line.char_indices() {
                if escaped {
                    escaped = false;
                    continue;
                }
                match ch {
                    '\\' if in_string => escaped = true,
                    '"' => in_string = !in_string,
                    '/' if !in_string && line[index..].starts_with("//") => {
                        cut = index;
                        break;
                    }
                    _ => {}
                }
            }
            out.push_str(&line[..cut]);
            out.push('\n');
        }
        // 3. Raw and ordinary string literals.
        let mut no_strings = String::with_capacity(out.len());
        let bytes = out.as_bytes();
        let mut index = 0usize;
        while index < bytes.len() {
            if bytes[index] == b'"' {
                let mut hashes = 0usize;
                let mut back = index;
                while back > 0 && bytes[back - 1] == b'#' {
                    hashes += 1;
                    back -= 1;
                }
                let is_raw = back > 0 && bytes[back - 1] == b'r' && hashes > 0;
                if is_raw {
                    let terminator = format!("\"{}", "#".repeat(hashes));
                    match out[index + 1..].find(&terminator) {
                        Some(end) => {
                            index = index + 1 + end + terminator.len();
                            continue;
                        }
                        None => break,
                    }
                }
                let mut end = index + 1;
                while end < bytes.len() {
                    match bytes[end] {
                        b'\\' => end += 2,
                        b'"' => break,
                        b'\n' => break,
                        _ => end += 1,
                    }
                }
                no_strings.push(' ');
                index = (end + 1).min(bytes.len());
                continue;
            }
            no_strings.push(bytes[index] as char);
            index += 1;
        }
        no_strings
    }

    /// Every `pub fn` / `pub async fn` name declared in `repositories/`.
    fn declared_in_repositories(root: &Path) -> BTreeMap<String, String> {
        let mut declared = BTreeMap::new();
        for path in source_files(&root.join("repositories")) {
            let code = production_code(&fs::read_to_string(&path).expect("readable source"));
            for line in code.lines() {
                let trimmed = line.trim_start();
                let Some(rest) = trimmed
                    .strip_prefix("pub")
                    .or_else(|| trimmed.strip_prefix("pub(crate)"))
                else {
                    continue;
                };
                let rest = rest.trim_start();
                if !rest.starts_with("fn ") && !rest.starts_with("async fn ") {
                    continue;
                }
                let after = rest
                    .trim_start_matches("async ")
                    .trim_start()
                    .trim_start_matches("fn ")
                    .trim_start();
                let name: String = after
                    .chars()
                    .take_while(|c| c.is_alphanumeric() || *c == '_')
                    .collect();
                if name.is_empty() {
                    continue;
                }
                declared
                    .entry(name)
                    .or_insert_with(|| path.display().to_string());
            }
        }
        declared
    }

    /// Every identifier that is CALLED anywhere in production source, collected in one pass.
    ///
    /// One pass, not one per function. The middle version scanned the whole corpus for each of 569
    /// declared functions -- 25 seconds, still far too slow for a test that runs on every
    /// `pnpm check`. Tokenising once and testing membership is linear in the corpus and finishes in
    /// well under a second, and it is also *more* correct: extracting whole identifier tokens cannot
    /// half-match, where a substring search for `name(` could.
    ///
    /// Declaration lines in `repositories/` are excluded, so a function never counts as calling itself.
    /// Calls to `.method(` and `::method(` are counted -- they are how repositories are called, and
    /// excluding `:` is what made the first version of this scan report 474 of 568 functions as dead.
    fn called_names(root: &Path) -> BTreeSet<String> {
        let mut called = BTreeSet::new();
        for path in source_files(root) {
            let is_repository = path.to_string_lossy().contains("repositories");
            let code = production_code(&fs::read_to_string(&path).expect("readable source"));
            for line in code.lines() {
                let trimmed = line.trim_start();
                if is_repository
                    && (trimmed.starts_with("pub fn ")
                        || trimmed.starts_with("pub async fn ")
                        || trimmed.starts_with("pub(crate) fn ")
                        || trimmed.starts_with("pub(crate) async fn "))
                {
                    continue;
                }
                let bytes = line.as_bytes();
                let mut index = 0usize;
                while index < bytes.len() {
                    let ch = bytes[index];
                    if !(ch.is_ascii_alphanumeric() || ch == b'_') {
                        index += 1;
                        continue;
                    }
                    let start = index;
                    while index < bytes.len()
                        && (bytes[index].is_ascii_alphanumeric() || bytes[index] == b'_')
                    {
                        index += 1;
                    }
                    let next = bytes.get(index).copied();
                    if next == Some(b'(') {
                        called.insert(line[start..index].to_string());
                    }
                }
            }
        }
        called
    }

    #[test]
    fn every_repository_function_is_called_or_on_the_reviewed_list() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");

        // --- vacuity, BEFORE any verdict -------------------------------------------------------
        let files = source_files(&root);
        assert!(
            files.len() >= 100,
            "only {} .rs files found under apps/api/src. The scan is declared over the whole source \
             tree; a small number means the walk is broken, and a broken walk is a silent pass.",
            files.len()
        );
        let declared = declared_in_repositories(&root);
        assert!(
            declared.len() >= 400,
            "only {} `pub fn` declarations found in repositories/. The scan's denominator is the \
             declared set, and a small one means the declaration pattern no longer matches.",
            declared.len()
        );
        //
        // ENFORCED, which the first version only documented. It computed the stale set, sorted it, and
        // then asserted nothing about it -- a check that describes a rule it does not apply is worse
        // than one that omits the rule, because a reader trusts the prose. Three entries went stale the
        // moment V01-043 wired the quarantine routes, which is exactly the rot it was written to catch.
        //
        // Two entries name functions that do not exist at all, and they are here deliberately: they
        // are what proves this assertion has teeth rather than being vacuously satisfied.

        let called = called_names(&root);

        // The OTHER direction, which this check did not enforce and which is the more dangerous of
        // the two: an entry whose function is CALLED and whose reason still reads as a justification
        // rather than a record of a fix.
        //
        // The subtlety, and the reason the first attempt at this rule was wrong: a RESOLVED entry is
        // not a stale entry. `deny_enrollment` carries "V01-041, now called: POST .../deny", and that
        // is a *record* -- the finding, the fix, and the route that closed it. Deleting it would erase
        // why the class found anything at all, since this list is how a name becomes a decision. So
        // the rule is not "is it called" but "does its reason still read as a live justification".
        //
        // A reason that still justifies a function nobody examined is the dangerous case: it records
        // "examined and accepted" for nothing, and it hides the next genuine finding, because a
        // reader has already seen the name and will not re-derive that it is unreviewed. `UNTRIAGED`
        // is the honest label for exactly those, so they are what this asserts on -- and it is what
        // would have caught the four quarantine and enrollment entries the hour they were wired up
        // while still labelled UNTRIAGED.
        let mut unjustified: Vec<&str> = REVIEWED_UNCALLED
            .iter()
            .filter(|(name, reason)| called.contains(*name) && reason.trim() == "UNTRIAGED")
            .map(|(name, _)| *name)
            .collect();
        unjustified.sort();
        assert!(
            unjustified.is_empty(),
            "REVIEWED_UNCALLED marks {} function(s) UNTRIAGED although they ARE called from \
             production code: {}. An `UNTRIAGED` entry asserts a function is unreviewed; if it is in \
             fact wired up, nobody examined it and nothing said so. Replace the label with the \
             decision and the route that resolved it, in the same commit that wires the caller.",
            unjustified.len(),
            unjustified.join(", ")
        );

        let reviewed: BTreeSet<&str> = REVIEWED_UNCALLED.iter().map(|(name, _)| *name).collect();
        let mut stale: Vec<&str> = REVIEWED_UNCALLED
            .iter()
            .map(|(name, _)| *name)
            .filter(|name| !declared.contains_key(*name))
            .collect();
        stale.sort();
        assert!(
            stale.is_empty(),
            "REVIEWED_UNCALLED names {} function(s) that no longer exist: {}. A stale entry is a decision \
             recorded against a function that is gone, so the list stops describing the present and starts \
             accumulating history -- and a list that only grows is how a review list rots into a permission \
             slip. Remove the entry, or restore the declaration if the function is genuinely still \
             needed.",
            stale.len(),
            stale.join(", ")
        );

        let mut dead: Vec<(String, String)> = Vec::new();
        for (name, where_) in &declared {
            if !called.contains(name.as_str()) && !reviewed.contains(name.as_str()) {
                dead.push((name.clone(), where_.clone()));
            }
        }

        assert!(
            dead.is_empty(),
            "{} repository function(s) have no non-test caller and are not on REVIEWED_UNCALLED. Each \
             one is a capability that exists and cannot be reached -- which is how V01-041 shipped a \
             device enrollment that could be approved but never denied, and how V01-042 shipped a purge \
             that nothing called. Add each to the list WITH A REASON, or wire it up.\n  - {}\n\
             Declared functions scanned: {}.",
            dead.len(),
            dead.iter()
                .map(|(name, where_)| format!("{name}  ({})", short(where_)))
                .collect::<Vec<_>>()
                .join("\n  - "),
            declared.len()
        );
    }

    fn short(path: &str) -> String {
        path.rsplit('/').next().unwrap_or(path).to_string()
    }
}
