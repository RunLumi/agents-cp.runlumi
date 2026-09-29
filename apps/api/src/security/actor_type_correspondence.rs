//! A standing check that every `actor_type` the code can WRITE is one the schema will ACCEPT.
//!
//! # The defect this is for
//!
//! V01-035: `staff_audit` in `apps/api/src/routes/internal.rs` inserts `actor_type = 'staff'`.
//! `security_events.actor_type` is CHECK-constrained, and the constraint enumerated the pre-P07 world:
//!
//! ```sql
//! actor_type TEXT NOT NULL CHECK (
//!     actor_type IN ('user', 'service_account', 'support', 'system', 'anonymous')
//! )
//! ```
//!
//! `'staff'` was not in it, and never could be: the `staff_principals` table, `StaffActor`, and the
//! whole `/api/v1/internal/**` surface arrive in migration **0018**, sixteen migrations after the one
//! that declared the audit table, and nothing extended the CHECK to name ADR 0007's third actor kind.
//!
//! So the value the product writes is the one value the schema refuses. Every one of the four
//! internal writers — `create_flag`, `patch_flag`, `create_kill_switch`, `lift_kill_switch` — calls
//! `staff_audit`, so every one of them aborted its D1 batch and answered `503 service_unavailable`.
//! **The platform could not roll out a feature flag or arm a kill switch through its own API, and its
//! own actions were never audited.** Reads were unaffected, which is exactly why nothing noticed:
//! `list_flags` answers `200` to the same token that cannot write.
//!
//! This is the same class as migration 0021, where a CHECK no insert could satisfy meant the team
//! surface had never worked. A CHECK that rejects a value the product writes fails **closed and
//! silently**: the statement is well-formed, the bind count is right, and the only symptom is a
//! `503` that reads like a transient store fault.
//!
//! # Why a whole-workspace scan and not a test at the insert site
//!
//! A test beside `staff_audit` would only ever have covered `staff_audit`. The class is "a literal in
//! the code that the ledger does not permit", and the ledger is a *different file* that changes on its
//! own schedule — 0022 above is the fourth corrective migration in this repository, and the two most
//! recent ones were both this class. So the check reads both sides and compares them, which is the
//! only formulation that survives the next actor kind being added.
//!
//! It is deliberately the schema-side twin of `repositories::bind_correspondence`, which catches a
//! statement whose binds do not match its predicates. Together they close the two ways a D1 statement
//! can be perfectly formed and still never succeed.
//!
//! # What this cannot see, stated rather than implied
//!
//! - It reads `actor_type` **literals in SQL strings**. A value computed at runtime, or bound as a
//!   `BindValue::Text` from a Rust `&str` variable, is invisible to it. `staff_audit`'s value is a
//!   literal inside the statement, which is the shape the scan is for.
//! - It proves the code's literals are *permitted*. It does not prove the code writes an audit event
//!   at all, nor that the event is the right one. Whether a given action *should* be audited is a
//!   spec question, and ADR 0007 is where that is answered.
//! - It cannot see a table other than `security_events`. One table is the whole claim.

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::fs;
    use std::path::{Path, PathBuf};

    /// Every `.rs` file under `src/`, recursively.
    ///
    /// Read from the directory rather than from a hand-kept list, so a new module is covered without
    /// editing this test. A list would be a denominator a route can be added past.
    fn rust_sources(root: &Path) -> Vec<PathBuf> {
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

    /// Migration files, in ledger order.
    fn migrations(app_root: &Path) -> Vec<PathBuf> {
        let dir = app_root.join("migrations");
        assert!(
            dir.is_dir(),
            "apps/api/migrations does not exist. The permitted set is read from the ledger, and a \
             missing ledger must fail loudly rather than leave the set empty -- an empty set makes \
             every assertion below pass for the wrong reason, which is the failure this whole module \
             exists to prevent."
        );
        let mut found: Vec<PathBuf> = fs::read_dir(&dir)
            .expect("readable migrations dir")
            .map(|e| e.expect("readable dir entry").path())
            .filter(|p| p.extension().is_some_and(|e| e == "sql"))
            .collect();
        found.sort();
        found
    }

    /// The permitted `actor_type` values, read out of the ledger.
    ///
    /// Scans every migration, not just the one that created the table, because the correction for
    /// V01-035 is migration **0022** and a check that read only 0002 would report `'staff'` as
    /// forbidden forever — a verifier disagreeing with the database it exists to protect.
    fn permitted_actor_types(app_root: &Path) -> BTreeSet<String> {
        // Matches the IN (...) list of an actor_type CHECK, across line breaks. Deliberately tolerant
        // of formatting: the list is written one value per line in 0022 and on one line in 0002, and a
        // regex that only matched one of those would read an empty set on a reformat.
        let mut permitted = BTreeSet::new();
        let mut declarations = 0usize;
        for path in migrations(app_root) {
            let sql = fs::read_to_string(&path).expect("readable migration");
            let lower = sql.to_ascii_lowercase();
            let mut from = 0usize;
            while let Some(found) = lower[from..].find("actor_type") {
                let at = from + found;
                // Look for the IN list within this statement's neighbourhood.
                let window_end = (at + 600).min(lower.len());
                let window = &sql[at..window_end];
                if let Some(open) = window.to_ascii_lowercase().find("in (") {
                    let after = &window[open + 4..];
                    if let Some(close) = after.find(')') {
                        for value in after[..close].split(',') {
                            let value = value.trim().trim_matches('\'').trim();
                            if !value.is_empty() {
                                permitted.insert(value.to_string());
                                declarations += 1;
                            }
                        }
                    }
                }
                from = at + "actor_type".len();
            }
        }
        assert!(
            declarations > 0,
            "no `actor_type IN (...)` list was found in the migration ledger, so the permitted set is \
             empty and every check below would pass vacuously. The set is the reference this test \
             grades against; a reference that was not read is not a reference."
        );
        permitted
    }

    /// Every `actor_type` value literal the code can write.
    ///
    /// Scanned **inside SQL string literals only**, and the first version of this scan did not do
    /// that, so it matched Rust type declarations instead:
    ///
    /// ```text
    /// - "a str,\n    pub actor_id: Option<&" in src/repositories/audit.rs
    /// ```
    ///
    /// `actor_type: Option<&'a str>` contains the token `actor_type`, an `=`, and a `'`, so a naive
    /// scan read the LIFETIME `'a` as a string literal and reported a value called `a`. Three files
    /// plus this one, all false, and a check whose first output is four false positives has to be
    /// rewritten before anyone can read its second output. The lesson is the one GAP-004's parser
    /// faults recorded: a scanner that does not know what it is scanning will scan the wrong thing
    /// and report it confidently.
    ///
    /// So a candidate must be a double-quoted (or `r#"..."#`) literal that also looks like a
    /// statement -- it must contain a SQL verb. A Rust doc comment or a type declaration is not a
    /// string literal at all, and a struct field is not a statement.
    fn sql_literals(source: &str) -> Vec<&str> {
        let mut literals = Vec::new();
        let bytes = source.as_bytes();
        let mut at = 0usize;
        while at < bytes.len() {
            if bytes[at] != b'"' {
                at += 1;
                continue;
            }
            // A raw string: r#"..."# / r##"..."##
            let mut hashes = 0usize;
            let mut back = at;
            while back > 0 && source.as_bytes()[back - 1] == b'#' {
                hashes += 1;
                back -= 1;
            }
            let is_raw = back > 0 && source.as_bytes()[back - 1] == b'r' && hashes > 0;
            if is_raw {
                let body = at + 1;
                let terminator = format!("\"{}", "#".repeat(hashes));
                match source[body..].find(&terminator) {
                    Some(end) => {
                        literals.push(&source[body..body + end]);
                        at = body + end + terminator.len();
                    }
                    None => break,
                }
                continue;
            }
            // An ordinary string. Line continuations are rare in SQL constants; the first unescaped
            // quote closes it.
            let body = at + 1;
            let mut end = body;
            while end < bytes.len() {
                match bytes[end] {
                    b'\\' => end += 2,
                    b'"' => break,
                    // NOT a terminator: a Rust string literal spans newlines, and every SQL constant
                    // in this repository is a multi-line "...". The first version of this scan broke
                    // here and therefore found NOTHING -- which the vacuity assertion below caught,
                    // and which is the whole reason that assertion is written before the verdict
                    // rather than after it.
                    _ => end += 1,
                }
            }
            if end < bytes.len() && bytes[end] == b'"' {
                literals.push(&source[body..end]);
            }
            at = end.max(body) + 1;
        }
        literals
    }

    /// A literal is treated as a candidate when it mentions `actor_type` -- the column under test --
    /// AND carries a statement verb.
    ///
    /// Both halves are needed. The verb is what keeps a struct field or a doc comment out; the column
    /// name is what stops a quoted word in prose from pairing up with an unrelated `INSERT` further
    /// down the same file, which is the failure mode of any scan that pairs two distant tokens.
    fn looks_like_sql(literal: &str) -> bool {
        let upper = literal.to_ascii_uppercase();
        upper.contains("ACTOR_TYPE")
            && ["INSERT", "SELECT", "UPDATE", "DELETE", "VALUES"]
                .iter()
                .any(|verb| upper.contains(verb))
    }

    /// Split a SQL fragment on its TOP-LEVEL commas, so a comma inside `(...)` or inside a quoted
    /// string does not split an element in half. A `VALUES` tuple is full of both.
    fn split_top_level(text: &str) -> Vec<String> {
        let mut elements = Vec::new();
        let mut current = String::new();
        let mut depth = 0i32;
        let mut in_quote = false;
        for ch in text.chars() {
            match ch {
                '\'' => {
                    in_quote = !in_quote;
                    current.push(ch);
                }
                '(' if !in_quote => {
                    depth += 1;
                    current.push(ch);
                }
                ')' if !in_quote => {
                    depth -= 1;
                    current.push(ch);
                }
                ',' if !in_quote && depth == 0 => {
                    elements.push(current.trim().to_string());
                    current.clear();
                }
                _ => current.push(ch),
            }
        }
        if !current.trim().is_empty() {
            elements.push(current.trim().to_string());
        }
        elements
    }

    /// The `actor_type` value one SQL literal writes.
    ///
    /// Returns `None` when the statement does not write a literal for the column at all, and
    /// `Some(None)` when it writes the position with a PLACEHOLDER. The two are kept distinct so a
    /// bind is never mistaken for a clean bill of health -- see the note on binds below.
    ///
    /// THREE shapes, because the repository uses three, and the first version of this scan
    /// understood two of them and therefore reported **nothing**. The vacuity assertion caught that
    /// rather than letting it through, which is the entire reason it is written before the verdict.
    ///
    /// 1. `actor_type = 'value'` -- an explicit assignment.
    /// 2. `actor_type IN ('a', 'b')` / `NOT IN (...)` -- a list.
    /// 3. **`INSERT INTO t (..., actor_type, ...) VALUES (..., 'value', ...)`** -- the dominant shape
    ///    here, and the one that hid V01-035. The column is named in the column list and the value
    ///    sits at the same POSITION in the `VALUES` tuple, with nothing joining them but the ordinal.
    ///    So the check does the correspondence itself: find `actor_type`'s index in the column list,
    ///    take the element at that index in the tuple, and read it if it is a quoted literal.
    ///
    /// Binds are reported, not passed. Three of the four sites in this repository bind `actor_type`
    /// as `?n` rather than hard-coding it, and a static scan cannot follow a bind into a bind list.
    /// The check's power is therefore exactly "a hard-coded literal the schema refuses" -- which is
    /// V01-035's shape precisely. That is a real class and not a general proof, and the module docs
    /// say so rather than leaving a reader to assume coverage.
    fn written_actor_type(literal: &str) -> Option<Option<String>> {
        // Shape 3: positional correspondence.
        if let Some((columns_text, values_start)) = column_list_and_values(literal) {
            let columns = split_top_level(&columns_text);
            if let Some(index) = columns
                .iter()
                .position(|c| c.eq_ignore_ascii_case("actor_type"))
                && let Some(tuple) = values_tuple(&literal[values_start..])
            {
                let elements = split_top_level(&tuple);
                if let Some(element) = elements.get(index) {
                    return Some(quoted_value(element));
                }
            }
        }
        // Shapes 1 and 2.
        let lower = literal.to_ascii_lowercase();
        let mut from = 0usize;
        while let Some(found) = lower[from..].find("actor_type") {
            let at = from + found;
            let window_end = (at + 240).min(lower.len());
            let window = &literal[at..window_end];
            if let Some(eq) = window.find('=')
                && let Some(value) = quoted_value(window[eq + 1..].trim_start())
            {
                return Some(Some(value));
            }
            if let Some(upper) = window.to_ascii_uppercase().find("IN (") {
                let after = &window[upper + 4..];
                if let Some(close) = after.find(')') {
                    for (_, rest) in after[..close].match_indices('\'') {
                        if let Some(end) = rest.find('\'') {
                            let value = rest[..end].to_string();
                            if value.eq_ignore_ascii_case("staff") {
                                return Some(Some(value));
                            }
                        }
                    }
                }
            }
            from = at + "actor_type".len();
        }
        None
    }

    /// The column list of an `INSERT`, and the offset of its `VALUES` tuple's opening parenthesis.
    ///
    /// Parenthesis nesting is resolved by walking the real characters in `matching_paren`, never by a
    /// pattern trusting a count: a `(` inside a quoted string is common in a column list, and a regex
    /// that counted them would pair the wrong tuple with the wrong columns -- a false pairing is worse
    /// than no pairing, because it reports a verdict.
    fn column_list_and_values(literal: &str) -> Option<(String, usize)> {
        let lower = literal.to_ascii_lowercase();
        let insert = lower.find("insert")?;
        let mut at = insert;
        while let Some(open) = lower[at..].find('(') {
            let open = at + open;
            if let Some(close) = matching_paren(literal, open) {
                let columns = &literal[open + 1..close];
                if columns.to_ascii_lowercase().contains("actor_type") {
                    let after = &lower[close + 1..];
                    if let Some(values_at) = after.find("values") {
                        let tuple_open = close + 1 + values_at;
                        if let Some(paren) = lower[tuple_open..].find('(') {
                            return Some((columns.to_string(), tuple_open + paren));
                        }
                    }
                }
            }
            at = open + 1;
        }
        None
    }

    /// The text inside the parenthesised group that starts at the first `(` of `text`.
    fn values_tuple(text: &str) -> Option<String> {
        let open = text.find('(')?;
        let close = matching_paren(text, open)?;
        Some(text[open + 1..close].to_string())
    }

    /// The index of the `)` matching the `(` at `open`, or `None` when unbalanced.
    fn matching_paren(text: &str, open: usize) -> Option<usize> {
        let bytes = text.as_bytes();
        let mut depth = 0i32;
        let mut in_quote = false;
        let mut i = open;
        while i < bytes.len() {
            match bytes[i] {
                b'\'' => in_quote = !in_quote,
                b'(' if !in_quote => depth += 1,
                b')' if !in_quote => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(i);
                    }
                }
                _ => {}
            }
            i += 1;
        }
        None
    }

    /// The string inside a quoted SQL literal, or `None` for a placeholder or an expression.
    fn quoted_value(element: &str) -> Option<String> {
        let trimmed = element.trim();
        if trimmed.len() >= 2 && trimmed.starts_with('\'') && trimmed.ends_with('\'') {
            let inner = &trimmed[1..trimmed.len() - 1];
            if !inner.is_empty() && inner.len() < 40 && !inner.contains('\'') {
                return Some(inner.to_string());
            }
        }
        None
    }

    #[test]
    fn every_written_actor_type_is_one_the_schema_accepts() {
        let app_root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let permitted = permitted_actor_types(app_root);

        // Vacuity, asserted BEFORE any verdict. A scan that read no Rust file would otherwise report
        // a clean sheet while measuring nothing, which is the campaign's recurring failure and the
        // reason this module states its denominators instead of assuming them.
        let sources = rust_sources(&app_root.join("src"));
        assert!(
            sources.len() >= 100,
            "only {} .rs files were found under apps/api/src. The scan is declared over the whole \
             source tree; a small number means the walk is broken, and a broken walk is a silent \
             pass rather than a failure.",
            sources.len()
        );

        let mut literals: Vec<(Option<String>, String)> = Vec::new();
        for path in &sources {
            let text = fs::read_to_string(path).expect("readable source");
            for literal in sql_literals(&text)
                .into_iter()
                .filter(|l| looks_like_sql(l))
            {
                if let Some(written) = written_actor_type(literal) {
                    let relative = path
                        .strip_prefix(app_root)
                        .unwrap_or(path)
                        .display()
                        .to_string();
                    literals.push((written, relative));
                }
            }
        }

        assert!(
            !literals.is_empty(),
            "no `actor_type` literal was found anywhere under apps/api/src. The code writes actor \
             types -- `staff_audit` alone writes one on every internal write -- so an empty result \
             means the pattern no longer matches and this check has stopped checking."
        );

        // A bind is neither a pass nor a failure: it is a position written by a placeholder, which
        // this static scan cannot follow. It is counted so the sheet says how much of the surface the
        // check actually grades, rather than implying it graded all of it.
        let bound = literals.iter().filter(|(value, _)| value.is_none()).count();
        let forbidden: Vec<String> = literals
            .iter()
            .filter_map(|(value, where_)| match value {
                Some(value) if !permitted.contains(value) => Some(format!("{value:?} in {where_}")),
                _ => None,
            })
            .collect();

        assert!(
            forbidden.is_empty(),
            "the code writes actor_type value(s) the schema's CHECK will refuse, so the INSERT is \
             rejected, the D1 batch aborts, and the caller is told the store is unavailable:\n  - {}\n\
             Permitted by the ledger: {:?}\n\
             A literal that the schema refuses fails closed and silently -- the statement is \
             well-formed and the bind count is right, so the only symptom is a 503 that reads like a \
             transient store fault. This is V01-035, and it is why all four /api/v1/internal/** \
             writers answered 503 for as long as 'staff' was absent from the CHECK.\n\
             Of {} statement position(s) naming actor_type, {} carry a literal and are graded here; \
             the other {} are `?n` binds, which a static scan cannot follow.",
            forbidden.join("\n  - "),
            permitted,
            literals.len(),
            literals.len() - bound,
            bound
        );
    }

    #[test]
    fn the_staff_actor_type_is_named_in_the_ledger() {
        // The specific claim, separate from the general one so that a future edit which removes
        // `'staff'` fails with a message about ADR 0007 rather than about a set comparison. ADR
        // 0007 establishes three actor kinds and requires a staff audit event on every use; the
        // ledger is where the third kind has to be spelled for that MUST to be satisfiable.
        let app_root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let permitted = permitted_actor_types(app_root);
        assert!(
            permitted.contains("staff"),
            "the migration ledger no longer permits actor_type = 'staff'. ADR 0007 establishes \
             StaffActor as the third actor kind and requires a staff audit event on grant creation \
             and on every use, and 'staff_audit' in routes/internal.rs writes exactly that. Without \
             this value the MUST is unsatisfiable and every internal write route aborts its batch. \
             Permitted now: {:?}",
            permitted
        );
    }
}
