//! **V04-008 — a guarded column with no writer is a control that cannot be operated.**
//!
//! `security::repository_liveness` proves a *function* is called. It cannot see this failure, and the
//! reason is structural rather than an oversight. The column *is* read, the comparator *is* called,
//! and the guard *is* present in a refusal path — a caller-counting check reports all three as live.
//! What is missing is the **writer** for the table the guard reads, so the guard's condition cannot
//! become true.
//!
//! The instance this was written for (V04-008, `FR-F19-008` minimum client version):
//!
//! | piece | where | state |
//! |---|---|---|
//! | comparator | `modules/devices.rs:203` `version_at_least` | present, five unit tests |
//! | policy read | `routes/devices.rs:386` `latest_min_client_version` | present |
//! | the refusal | `routes/devices.rs:822` → `client_version_too_old` | present |
//! | **the thing that arms it** | `org_device_policy_settings.min_client_version` | **REPAIRED 2026-10-03** — `PUT/GET /api/v1/orgs/{org_id}/device-policy` (DevicesManage), floor validated against the comparator's own parser, optimistic version from migration 0024 |
//!
//! The whole-repo mention list for that table was two lines: the `CREATE TABLE` in migration 0007, and
//! the `SELECT` at `devices.rs:386`. No `INSERT`, no `UPDATE`, no `DELETE`, no seed. So
//! `latest_min_client_version` returned `None` for every organization, `if let Some(minimum)` at
//! `devices.rs:822` was never taken, and `version_at_least` at `devices.rs:823` was a call that could
//! never execute. That was the defect the check was written for; the routed write surface (the
//! campaign that repaired it is recorded in
//! `docs/verification/runs/2026-10-03-v05-whole-site-and-release-security/`) closed it, and the entry
//! below stays as a `Record` so the guard's arming column remains on the books.
//!
//! That last shape is the one to be careful about. AGENTS.md names it for `is_run_source` (V01-047): a
//! **liveness check can be satisfied by a call that can never execute.** `version_at_least` *is*
//! called, so a caller-counting check is green; the condition in front of it cannot hold. Which is why
//! this check is about *writers*, not callers.
//!
//! # What is inert here and what is not
//!
//! Most of this class fails **closed** and is merely absent: V01-046 (`fan_out_event_statement`) is a
//! lever with no trigger, V01-050 (`provider_entitlement_projections`) is a reader with no writer, and
//! both mean the feature does nothing.
//!
//! V04-008 fails **open**, and that is what makes it worth a check. It is the lever for responding to
//! a client-side security fix: every credential-handling bug in a desktop client is a candidate for a
//! forced minimum version, and there is nothing to set. A control that cannot be operated during the
//! incident it exists for is the V01-043 shape — "a kill switch with no lever is not a control that is
//! weak, it is a control that cannot be operated".
//!
//! # What this check asserts, and what it deliberately does not
//!
//! It asserts that every table in [`ARMING_DEPENDENCIES`] is either written by application code or
//! recorded here as unwritable. That is a **declared list, not a heuristic scan** for guards: inferring
//! "this comparison is a guard" from syntax is exactly the kind of heuristic that produces a green sheet
//! about code it never read, and the sibling checks in this module already record what guessing a
//! table name cost — `v02-tool-policy-deny-probe` read a table that did not exist and would have
//! reported six clean assertions about a branch that was never called.
//!
//! The declared list is the record of the decision. The assertions give it teeth, and each one exists
//! because of a specific way the naive version of this check would have been a false signal:
//!
//! 1. **A positive control on the detector itself, asserted as a precondition inside every test that
//!    uses it.** Every "no writer" verdict is worthless if the scan cannot find a writer that exists.
//!    See "The control must be a precondition, not a sibling" below — this is not decoration.
//! 2. **Comments are stripped before scanning; string literals are KEPT.** Otherwise a doc comment
//!    saying *"we should INSERT INTO org_device_policy_settings"* satisfies the check. Stripping
//!    literals as well is the opposite mistake and this module shipped it first: SQL in this codebase
//!    is written as string constants, so stripping literals made the detector blind to every real
//!    writer and the control below caught exactly that.
//! 3. **`#[cfg(test)]` modules are removed.** A test asserting the control exists must not be counted
//!    as the writer that arms it.
//! 4. **The named guard must still be present.** An entry whose guard text no longer appears in
//!    production code **fails**: the record then describes code that no longer exists, and a check
//!    that keeps passing after its subject was deleted describes nothing.
//! 5. **The stale direction is the one that bit V01-045.** An entry recorded as unwritable whose table
//!    has since become writable **fails**. An exclusion for something now implemented records
//!    "examined and accepted" for something nobody examined, and a reader who has already seen the
//!    name will not re-derive that it was unreviewed. A [`Status::Record`] entry is exempt: it states a
//!    fix, so it is a record rather than a justification, and deleting it would erase why the class
//!    found anything at all.
//!
//! What it does **not** assert: that an unwritten column is a defect. Some guarded columns may
//! legitimately be set by a migration, a backfill, or a system outside this repository. Those are
//! [`Status::Record`] entries carrying that reason — reviewed, not silently permitted.
//!
//! # The control must be a precondition, not a sibling
//!
//! The first version of this module asserted the control in its own `#[test]` and the "no writer"
//! verdict in another. Cargo runs tests in parallel, so when the detector was broken **both** ran: the
//! control went red and `an_unwritable_record_stays_unwritable` went **green** — vacuously, having
//! found no writer anywhere, which is precisely what a detector that cannot see writers reports for
//! every table.
//!
//! That is the campaign's own lesson arriving from a new direction: a negative assertion can pass for
//! the wrong reason, and a positive control that is merely *present* does not stop it. What stops it is
//! the control being re-asserted at the head of the test that depends on it, so a broken detector
//! cannot coexist with a green verdict anywhere in the file.

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::fs;
    use std::path::{Path, PathBuf};

    /// Why a table is in this list.
    #[derive(Clone, Copy, PartialEq, Eq, Debug)]
    pub enum Status {
        /// The guard reads this table and no application code writes it. Asserted to stay unwritten.
        Unwritable,
        /// A historical record: the table has since become written, or the guard moved, or the capability
        /// was deliberately deferred with a stated reason. No writer assertion.
        // Exercised by `a_record_entry_imposes_no_writer_assertion` below rather than left as an
        // unconstructed variant a reader has to take on trust.
        Record,
    }

    struct ArmingDependency {
        /// The table whose column feeds a refusal.
        table: &'static str,
        /// The column, for the message. Not parsed.
        column: &'static str,
        /// A distinctive fragment of the guard, asserted to still exist in production code.
        guard: &'static str,
        status: Status,
        reason: &'static str,
    }

    /// Tables read by a guard that produces a refusal, and no application code writes them.
    ///
    /// Adding a name here is a decision, and the list is the record of it.
    const ARMING_DEPENDENCIES: &[ArmingDependency] = &[ArmingDependency {
        table: "org_device_policy_settings",
        column: "min_client_version",
        guard: "latest_min_client_version",
        status: Status::Record,
        reason: "V04-008 / FR-F19-008, REPAIRED in the 2026-10-03 audit pass. The whole-repo mention \
                 list used to be two lines: the CREATE TABLE in migration 0007 and the SELECT at \
                 routes/devices.rs:386 -- no writer anywhere, so `client_version_too_old` was \
                 unreachable and a device could present any syntactically valid app_version. The \
                 lever now exists: `PUT/GET /api/v1/orgs/{org_id}/device-policy` \
                 (routes/devices.rs, DevicesManage), with the floor validated against the \
                 comparator's own parser (`parse_version`, so a minimum that would fail closed for \
                 EVERY device is refused at the boundary), optimistic `version` from migration 0024, \
                 an audit event, and idempotent replay. Kept on the list as a record: the guard and \
                 its arming column stay observable, and a future entry for a DIFFERENT unwritable \
                 arming dependency must not silently inherit this one's history.",
    }];

    /// A table application code definitely writes, used as the detector's positive control.
    ///
    /// If this stops being found, every "no writer" verdict is void.
    const CONTROL_WRITTEN_TABLE: &str = "security_events";

    /// Every `.rs` under `dir`, recursively, **excluding this module**.
    ///
    /// The exclusion is load-bearing and was got wrong first. The first version included this file, so the
    /// record's own copy of the guard name -- in `ARMING_DEPENDENCIES` and in the prose above it --
    /// satisfied the guard-presence assertion. Renaming every occurrence of
    /// `latest_min_client_version` in the product left all five tests green: the check verified itself
    /// against its own text. A precondition satisfied by the thing it is supposed to verify is not a
    /// precondition, and the mutation that found it is the only reason this is written down.
    fn source_files(dir: &Path) -> Vec<PathBuf> {
        let mut out = Vec::new();
        let Ok(entries) = fs::read_dir(dir) else {
            return out;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                out.extend(source_files(&path));
            } else if path.extension().is_some_and(|e| e == "rs")
                && !path.ends_with("security/guarded_column_writers.rs")
            {
                out.push(path);
            }
        }
        out
    }

    /// Strip comments and `#[cfg(test)] mod` blocks, **keeping string literals**.
    ///
    /// The literal retention is load-bearing and was got wrong first: SQL in this codebase lives in string
    /// constants, so a variant that also dropped literals reported `security_events` as unwritten and
    /// silently passed every "no writer" verdict. Comments must go — otherwise a doc comment naming the
    /// write arms the control on paper — and `#[cfg(test)]` blocks must go, or a test asserting the
    /// control exists is mistaken for the control.
    fn production_code(src: &str) -> String {
        let mut code = String::with_capacity(src.len());
        let chars: Vec<char> = src.chars().collect();
        let mut i = 0usize;
        while i < chars.len() {
            // Peek without allocating: the first version built a `String` of the whole remaining source
            // on every character, which is O(n^2) over a multi-megabyte tree and made this module's tests
            // take over a minute each.
            let next = chars.get(i + 1).copied();
            match (chars[i], next) {
                ('/', Some('/')) => {
                    while i < chars.len() && chars[i] != '\n' {
                        i += 1;
                    }
                }
                ('/', Some('*')) => {
                    let mut depth = 0usize;
                    while i < chars.len() {
                        if chars[i] == '/' && chars.get(i + 1) == Some(&'*') {
                            depth += 1;
                            i += 2;
                        } else if chars[i] == '*' && chars.get(i + 1) == Some(&'/') {
                            depth -= 1;
                            i += 2;
                            if depth == 0 {
                                break;
                            }
                        } else {
                            i += 1;
                        }
                    }
                    code.push(' ');
                }
                _ => {
                    code.push(chars[i]);
                    i += 1;
                }
            }
        }
        // `#[cfg(test)] mod name { ... }` -- braces from the first `{` to its match, so a single
        // `#[cfg(test)]` attribute on one item cannot swallow the rest of the file.
        while let Some(start) = code.find("#[cfg(test)]") {
            let after = start + "#[cfg(test)]".len();
            let Some(open) = code[after..].find('{').map(|p| after + p) else {
                code.truncate(start);
                break;
            };
            let mut depth = 0usize;
            let mut end = open;
            for (offset, ch) in code[open..].char_indices() {
                match ch {
                    '{' => depth += 1,
                    '}' => {
                        depth -= 1;
                        if depth == 0 {
                            end = open + offset;
                            break;
                        }
                    }
                    _ => {}
                }
            }
            code.replace_range(start..=end, " ");
        }
        code
    }

    /// Whether application code writes `table`, judged on comment- and test-stripped source.
    fn has_writer(root: &Path, table: &str) -> bool {
        // Both sides upper-cased. The needle was left as written while the source was folded, so every
        // comparison was against a string that could not occur — which is the shape of a detector that
        // reports "no writer" for the entire codebase.
        let insert = format!("INSERT INTO {table}").to_ascii_uppercase();
        let update = format!("UPDATE {table}").to_ascii_uppercase();
        source_files(root).iter().any(|path| {
            let Ok(src) = fs::read_to_string(path) else {
                return false;
            };
            let code = production_code(&src).to_ascii_uppercase();
            code.contains(&insert) || code.contains(&update)
        })
    }

    /// Production source of `src/` as one blob, comment- and test-stripped.
    fn all_production_code(root: &Path) -> String {
        let mut set: BTreeSet<String> = BTreeSet::new();
        for path in source_files(root) {
            if let Ok(src) = fs::read_to_string(&path) {
                set.insert(production_code(&src));
            }
        }
        set.into_iter().collect::<Vec<_>>().join("\n")
    }

    fn root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("src")
    }

    /// The precondition every other verdict depends on, re-asserted at the head of each test that uses
    /// the detector rather than sitting in a sibling test of its own.
    ///
    /// Cargo runs tests in parallel, so a control that is merely *present* does not stop a dependent
    /// verdict from passing vacuously. The first version of this file got that wrong: with literals
    /// stripped the detector was blind to every writer, the control went red, and
    /// `an_unwritable_record_stays_unwritable` went green in the same run — having found no writer
    /// anywhere, which is exactly what a broken detector reports for every table.
    fn assert_detector_can_see_a_writer() {
        let files = source_files(&root());
        assert!(
            files.len() >= 40,
            "expected the source walk to find the crate's modules, found {} -- a vacuous verdict \
             follows from an empty walk",
            files.len()
        );
        assert!(
            has_writer(&root(), CONTROL_WRITTEN_TABLE),
            "the writer detector did not find `{CONTROL_WRITTEN_TABLE}`, which \
             repositories/security.rs inserts into. Every 'no writer' verdict in this module is \
             therefore a statement about a scan that cannot see a writer."
        );
    }

    #[test]
    fn a_comment_is_not_a_writer() {
        let code = production_code(
            "// INSERT INTO widget_registry (org_id) VALUES (?1)\n\
             /// UPDATE widget_registry SET x = 1\n\
             /* INSERT INTO widget_registry (org_id) VALUES (?2) */\n\
             const REAL: &str = \"INSERT INTO widget_registry (org_id) VALUES (?3)\";\n",
        );
        let code = code.to_ascii_uppercase();
        // Exactly the one real write survives; the two comments do not.
        assert_eq!(
            code.matches("INSERT INTO WIDGET_REGISTRY").count(),
            1,
            "a comment survived production_code(), or a real write was lost. The detector would then \
             be satisfiable by a doc comment naming the write, which arms the control on paper."
        );
    }

    #[test]
    fn a_test_module_is_not_a_writer() {
        let code = production_code(
            "fn real() {}\n\
             #[cfg(test)]\n\
             mod tests {\n\
             \x20   #[test]\n\
             \x20   fn it_arms_the_control() {\n\
             \x20       let q = \"INSERT INTO widget_registry (org_id) VALUES (?1)\";\n\
             \x20   }\n\
             }\n\
             fn also_real() {}\n",
        );
        assert!(
            !code.contains("INSERT INTO widget_registry"),
            "a `#[cfg(test)] mod` survived production_code(); a unit test naming the write would be \
             counted as the writer that arms a guard"
        );
        assert!(
            code.contains("fn real()") && code.contains("fn also_real()"),
            "production_code() consumed more than the test module -- code after the block was dropped, \
             so a writer in a later module would be invisible and a 'no writer' verdict would be a \
             false negative"
        );
    }

    #[test]
    fn an_unwritable_record_stays_unwritable() {
        assert_detector_can_see_a_writer();
        for dep in ARMING_DEPENDENCIES {
            let writable = has_writer(&root(), dep.table);
            match dep.status {
                Status::Unwritable => assert!(
                    !writable,
                    "`{}` ({}) is recorded as having no writer, but application code now writes it. \
                     Either the lever now exists -- in which case the control is operable and this \
                     entry must say so -- or the writer does not arm the guard this entry is about. \
                     Leaving it here would record 'examined and accepted' for something nobody \
                     examined, which is the V01-045 failure: a reader who has seen the name will not \
                     re-derive that it was unreviewed.",
                    dep.table, dep.reason
                ),
                Status::Record => {}
            }
        }
    }

    #[test]
    fn every_declared_dependency_is_still_described_by_live_code() {
        assert_detector_can_see_a_writer();
        let all = all_production_code(&root());
        for dep in ARMING_DEPENDENCIES {
            assert!(
                all.contains(dep.table),
                "{} declares `{}`, which appears nowhere in production code. An entry for a table \
                 that does not exist makes the sheet look thorough while inspecting nothing.",
                dep.reason.split('.').next().unwrap_or(dep.reason),
                dep.table
            );
            assert!(
                all.contains(dep.guard),
                "V04-008's record names `{}` ({}.{}) but that text no longer appears in production \
                 code. This entry now describes something that is not there, and a check that keeps \
                 passing after its subject was deleted is a check describing nothing. Update or remove \
                 the entry.",
                dep.guard,
                dep.table,
                dep.column
            );
        }
    }

    /// Exercises [`Status::Record`] so the escape hatch is live code rather than a variant a reader
    /// has to take on trust, and pins the property that distinguishes it: it imposes no writer
    /// assertion, which is what makes it a record and not a justification.
    #[test]
    fn a_record_entry_imposes_no_writer_assertion() {
        assert_detector_can_see_a_writer();
        let record = ArmingDependency {
            table: CONTROL_WRITTEN_TABLE,
            column: "org_id",
            guard: "fn security",
            status: Status::Record,
            reason: "self-test",
        };
        assert_eq!(record.status, Status::Record);
        assert!(
            has_writer(&root(), record.table),
            "the control table is written, and this entry does not assert either way -- which is the \
             whole difference between a record and a justification"
        );
    }
}
