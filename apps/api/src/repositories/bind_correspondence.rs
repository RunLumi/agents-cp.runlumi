//! A standing check that a two-predicate lookup binds its ids in the order its `WHERE` reads them.
//!
//! # The defect this is for
//!
//! V01-028: `ENDPOINT_BY_ID_SQL` is `WHERE org_id = ?1 AND endpoint_id = ?2`, and the bind list passed
//! `[endpoint_id, org_id]`. Every statement was well-formed — the right number of placeholders, the
//! right number of binds, both bound — so nothing rejected it. The statement was simply **unsatisfiable**
//! for any real row, and the owner of an endpoint could not read their own endpoint.
//!
//! The tenant half is worse than a broken route. A swapped bind on a two-id lookup does not return
//! another tenant's row, because both predicates have to hold; it returns *nothing*. So it fails safe on
//! confidentiality and unsafe on availability, which is the worst possible shape for a check that only
//! looks for leaks: **a bind-order defect on a scoped lookup is invisible to a leak probe and visible to
//! a control.** V01-030 is the other half of that sentence — a route that refuses everyone passes every
//! cross-tenant assertion.
//!
//! # Why this is narrow, and what it therefore cannot see
//!
//! A previous attempt at this scanned every `prepare()` for any mismatch between a column name and a
//! bind expression. It produced **117 candidates** and shipped nothing, because a name-based rule cannot
//! distinguish a real defect from a naming convention: `org_id` bound to `?1` looks identical to
//! `owner_user_id` bound to `?1`.
//!
//! So this checks exactly one shape, and requires the evidence to be **mutual**:
//!
//! * the `WHERE` clause (never a `SET`) contains **exactly two** `<column> = ?N` predicates whose
//!   placeholders are **distinct**;
//! * both columns are id-like (`_id` or `id`), so a non-id column cannot be dragged in;
//! * and the two bind expressions are **swapped relative to each other** — the bind for `?1` names the
//!   column that `?2` filters on, and vice versa.
//!
//! Mutual disagreement is what a naming convention cannot manufacture. One mismatch is a guess; two
//! matching mismatches in opposite directions is a transposition.
//!
//! **Stated limits, so nobody reads more into a pass than is there:**
//!
//! * It only sees `?N` equality predicates. `IN (?, ?, ?)`, `LIKE ?N`, `> ?N`, `BETWEEN`, subqueries and
//!   three-or-more-id predicates are all outside it. Three ids transposed is a rotation, not a swap.
//! * It only sees statements whose SQL is a named `const` in the same file, which is every statement in
//!   this module today but is a property of the style, not a guarantee.
//! * It compares **identifier names**, so a bind written as a function call (`some_id(&x)`) is matched on
//!   its trailing identifier and a bind written as a bare literal is skipped.
//! * A pass means "no two-id transposition of this shape exists in this directory today". It is a
//!   standing regression check, not a proof of correspondence in general.

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::fs;
    use std::path::Path;

    /// A `<column> = ?N` predicate, or a `SET` assignment, found in a statement.
    struct Predicate {
        column: String,
        placeholder: usize,
        in_set: bool,
    }

    /// The identifier a bind expression supplies, lowercased.
    ///
    /// `&org_id` -> `org_id`, `Some(&endpoint_id)` -> `endpoint_id`, `record.scope.method` -> `method`,
    /// and -- the shape that actually appears on every id bind in this module -- the
    /// `BindValue::Text(endpoint_id)` constructor call -> `endpoint_id`.
    ///
    /// The call case is not an optimisation. The first version of this function stripped a trailing
    /// `)` and then took the last `::` segment, so `BindValue::Text(endpoint_id)` came out as
    /// `text(endpoint_id`, matched nothing, and **the check reported 0 transposed while
    /// `find_endpoint` was binding its two ids in the wrong order** -- which is the exact defect the
    /// check exists to catch, present in the tree while the check passed. The comment above this
    /// function claimed it handled a function call; the code did not, and a stated limit that the
    /// implementation does not honour is worse than no comment, because it is relied upon.
    fn bind_identifier(expression: &str) -> String {
        let trimmed = expression.trim();
        let mut text = trimmed;
        if let Some(open) = trimmed.rfind('(')
            && trimmed.ends_with(')')
        {
            text = &trimmed[open + 1..trimmed.len() - 1];
        }
        text.trim()
            .trim_start_matches('&')
            .rsplit(['.', ':'])
            .next()
            .unwrap_or_default()
            .trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '_')
            .to_ascii_lowercase()
    }

    fn is_id_like(name: &str) -> bool {
        name == "id" || name.ends_with("_id")
    }

    /// Split a bind list into its expressions, on commas that are not inside brackets.
    ///
    /// The outer `&[` `]` wrapper is removed FIRST. It was not, at first, and that made the function
    /// return the whole list as a single expression: the `[` put every inner comma at depth 1, where
    /// this function does not split. Every bind then compared as one long string, nothing matched, and
    /// the check reported `0 transposed` with `find_endpoint` binding its ids in the wrong order. The
    /// denominator is what gave it away -- 38 two-id lookups were examined, so the SQL side was alive and
    /// the bind side was not.
    fn split_binds(list: &str) -> Vec<String> {
        let inner = list.trim().trim_start_matches("&[").trim_end_matches(']');
        let mut out = Vec::new();
        let mut depth = 0usize;
        let mut current = String::new();
        for ch in inner.chars() {
            match ch {
                '[' | '(' | '{' => {
                    depth += 1;
                    current.push(ch);
                }
                ']' | ')' | '}' => {
                    depth = depth.saturating_sub(1);
                    current.push(ch);
                }
                ',' if depth == 0 => {
                    out.push(current.clone());
                    current.clear();
                }
                _ => current.push(ch),
            }
        }
        if !current.trim().is_empty() {
            out.push(current);
        }
        out
    }

    /// Remove `//` and `/* */` comments, replacing them with a single space so byte offsets and token
    /// boundaries survive.
    ///
    /// This is not tidiness. `find_endpoint`'s own comment -- the one that documents V01-028 -- contains
    /// the text "(after V01-008 and V01-011)", and a depth counter that reads parentheses inside a
    /// comment loses its balance and runs off to the end of the file. So `.prepare(` was never matched
    /// to its call, **every** statement was skipped, and the check reported `0 transposed` while
    /// `find_endpoint` was binding its two ids in the wrong order. A parser that silently stops finding
    /// its subject is worse than one that crashes, and the denominator line is what made that visible.
    ///
    /// Stated limit: a `//` inside a Rust string literal would be treated as a comment. Every SQL
    /// statement in this module is a named `const`, so none is scanned through a string literal.
    fn strip_comments(text: &str) -> String {
        let bytes = text.as_bytes();
        let mut out = String::with_capacity(text.len());
        let mut i = 0usize;
        while i < bytes.len() {
            if bytes[i] == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'/' {
                while i < bytes.len() && bytes[i] != b'\n' {
                    i += 1;
                }
                out.push(' ');
                continue;
            }
            if bytes[i] == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'*' {
                i += 2;
                while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                    i += 1;
                }
                i = (i + 2).min(bytes.len());
                out.push(' ');
                continue;
            }
            let ch = text[i..].chars().next().unwrap_or(' ');
            out.push(ch);
            i += ch.len_utf8();
        }
        out
    }

    /// Pull the two arguments out of every `.prepare(CONST, &[ ... ])`.
    fn prepare_calls(sql_of: &str) -> Vec<String> {
        let source = strip_comments(sql_of);
        let mut out = Vec::new();
        let mut rest = source.as_str();
        while let Some(at) = rest.find(".prepare(") {
            rest = &rest[at + ".prepare(".len()..];
            let mut depth = 0usize;
            let mut end = None;
            for (index, ch) in rest.char_indices() {
                match ch {
                    '(' | '[' => depth += 1,
                    ')' | ']' => {
                        depth = depth.saturating_sub(1);
                        if depth == 0 {
                            end = Some(index);
                            break;
                        }
                    }
                    _ => {}
                }
            }
            match end {
                Some(index) => {
                    out.push(rest[..index].to_owned());
                    rest = &rest[index..];
                }
                None => break,
            }
        }
        out
    }

    /// The filtering part of a statement: from the first `WHERE` that follows the `SET`,
    /// or from the `SET` when there is no `WHERE`. A `SET` is never scanned for predicates,
    fn predicate_region(sql: &str) -> (String, bool) {
        let set_at = keyword_positions(sql, "SET").first().copied();
        let where_at = keyword_positions(sql, "WHERE")
            .into_iter()
            .find(|at| set_at.is_none_or(|set| *at > set));
        match (where_at, set_at) {
            (Some(w), _) => (sql[w..].to_owned(), false),
            (_, Some(s)) => (sql[s..].to_owned(), true),
            _ => (String::new(), true),
        }
    }

    /// Every position at which `keyword` appears as a whole SQL word: not preceded by an identifier
    /// character, followed by whitespace or an open bracket.
    ///
    /// The obvious spelling of this search is `" WHERE "`, and it is wrong. `WHERE` normally begins a
    /// LINE, so the character in front of it is a newline rather than a space and the search finds
    /// nothing at all. Every `WHERE`-bearing statement in `webhooks.rs` then produced an empty region and
    /// was skipped before a single predicate was read -- so `ENDPOINT_BY_ID_SQL` never appeared in the
    /// trace, and the check reported `0 transposed` across 38 examined lookups while the defect sat in
    /// the tree. **A region that is silently empty is the most expensive kind of nothing**, which is why
    /// this now counts the lookups it examined and fails when the count collapses.
    fn keyword_positions(sql: &str, keyword: &str) -> Vec<usize> {
        let upper = sql.to_ascii_uppercase();
        let bytes = upper.as_bytes();
        let mut out = Vec::new();
        let mut from = 0usize;
        while let Some(relative) = upper[from..].find(keyword) {
            let at = from + relative;
            let before_ok =
                at == 0 || !(bytes[at - 1].is_ascii_alphanumeric() || bytes[at - 1] == b'_');
            let after = at + keyword.len();
            let after_ok =
                after >= bytes.len() || matches!(bytes[after], b' ' | b'\n' | b'\r' | b'\t' | b'(');
            if before_ok && after_ok {
                out.push(at);
            }
            from = at + 1;
        }
        out
    }

    /// Collect `<column> = ?N` from a region, character by character so that a `?N` inside a string
    /// literal or a comment cannot be counted as a placeholder.
    fn predicates(region: &str, in_set: bool) -> Vec<Predicate> {
        let bytes = region.as_bytes();
        let mut out = Vec::new();
        let mut i = 0usize;
        while i < bytes.len() {
            if bytes[i] == b'\'' {
                i += 1;
                while i < bytes.len() && bytes[i] != b'\'' {
                    i += 1;
                }
                i += 1;
                continue;
            }
            if bytes[i] == b'-' && i + 1 < bytes.len() && bytes[i + 1] == b'-' {
                while i < bytes.len() && bytes[i] != b'\n' {
                    i += 1;
                }
                continue;
            }
            if bytes[i] == b'?' && i + 1 < bytes.len() && bytes[i + 1].is_ascii_digit() {
                let number: usize = region[i + 1..]
                    .chars()
                    .take_while(char::is_ascii_digit)
                    .collect::<String>()
                    .parse()
                    .unwrap_or(0);
                // Walk back over spaces, `=`, spaces, then take the identifier.
                let mut j = i;
                while j > 0 && (bytes[j - 1] == b' ' || bytes[j - 1] == b'\t') {
                    j -= 1;
                }
                if j == 0 || bytes[j - 1] != b'=' {
                    i += 1;
                    continue;
                }
                j -= 1;
                while j > 0 && (bytes[j - 1] == b' ' || bytes[j - 1] == b'\t') {
                    j -= 1;
                }
                let start = j;
                while j > 0 && (bytes[j - 1].is_ascii_alphanumeric() || bytes[j - 1] == b'_') {
                    j -= 1;
                }
                if start > j {
                    out.push(Predicate {
                        column: region[j..start].to_ascii_lowercase(),
                        placeholder: number,
                        in_set,
                    });
                }
                i += number.to_string().len() + 1;
                continue;
            }
            i += 1;
        }
        out
    }

    /// The standing check. Named for what it asserts so a failure says which claim broke.
    #[test]
    fn v01_004_no_two_id_lookup_binds_its_ids_transposed() {
        // Every directory that holds `.prepare(` calls, asserted to EXIST before anything is scanned.
        //
        // Asserting existence is the point. A path typo in a list of directories produces a scan that
        // reads less and reports a cleaner result, which is the failure this whole check is a reaction
        // to -- 84 statements were once skipped by a region that was silently empty, and nothing said so.
        // So a missing directory is a loud failure, never a smaller denominator.
        const DIRECTORIES: [&str; 3] = ["repositories", "routes", "consumers"];
        let base = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        for directory in DIRECTORIES {
            assert!(
                base.join(directory).is_dir(),
                "src/{directory} does not exist. The scan is declared over a fixed list of \
                 directories, and a missing one must fail loudly rather than shrink the denominator -- \
                 which is how 84 statements went unread for four runs while this check reported \
                 success."
            );
        }

        let mut checked = 0usize;
        let mut transposed: Vec<String> = Vec::new();
        let mut two_id_lookups = 0usize;
        // Per-directory, so the coverage is visible. A healthy total is not enough: it can be healthy
        // while one whole directory contributed nothing, and in the total that is invisible.
        let mut per_directory: BTreeMap<&str, (usize, usize)> = BTreeMap::new();

        // Each file carries the directory it came from, so a count cannot be attributed to the wrong
        // directory once the list is sorted together.
        let mut files: Vec<(std::path::PathBuf, &'static str)> = Vec::new();
        for directory in DIRECTORIES {
            let mut in_directory: Vec<_> = fs::read_dir(base.join(directory))
                .unwrap_or_else(|error| panic!("src/{directory} must be readable: {error}"))
                .filter_map(|entry| entry.ok().map(|entry| entry.path()))
                .filter(|path| path.extension().is_some_and(|extension| extension == "rs"))
                .collect();
            in_directory.sort();
            files.extend(in_directory.into_iter().map(|path| (path, directory)));
        }
        files.sort();

        for (path, directory) in &files {
            // Comments are stripped ONCE, here, so the const scan and the `prepare` scan cannot
            // disagree about what the file says.
            let raw = fs::read_to_string(path).expect("a repository module is readable");
            let source = strip_comments(&raw);
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("<unknown>")
                .to_owned();
            let slot = per_directory.entry(directory).or_insert((0, 0));

            // Every `const NAME: &str = r#"..."#` / `r"..."` in this file.
            let mut sql_by_name: BTreeMap<String, String> = BTreeMap::new();
            let bytes = source.as_bytes();
            // Over CHAR boundaries, not bytes: a byte-wise scan slices a multi-byte character out of
            // a doc comment and panics on a char boundary, which is a crash in the CHECK rather than a
            // finding -- and a check that dies on an em dash is not a check.
            let mut starts: Vec<usize> = source.char_indices().map(|(i, _)| i).collect();
            starts.push(bytes.len());
            let mut cursor = 0usize;
            while cursor + 1 < starts.len() {
                let i = starts[cursor];
                cursor += 1;
                if source[i..].starts_with("const ") {
                    let rest = &source[i + "const ".len()..];
                    if let Some(colon) = rest.find(':') {
                        let ident = rest[..colon].trim().to_owned();
                        if ident
                            .chars()
                            .all(|c| c.is_ascii_uppercase() || c == '_' || c.is_ascii_digit())
                            && !ident.is_empty()
                        {
                            let after = &rest[colon..];
                            if let Some(eq) = after.find('=') {
                                let tail = after[eq + 1..].trim_start();
                                // A Rust raw or plain string literal, as its body.
                                let between = |open: &str, close: &str| -> Option<String> {
                                    tail.strip_prefix(open).and_then(|body| {
                                        body.find(close).map(|end| body[..end].to_owned())
                                    })
                                };
                                let literal = between("r#\"", "\"#")
                                    .or_else(|| between("r\"", "\""))
                                    .or_else(|| between("\"", "\""));
                                if let Some(body) = literal {
                                    sql_by_name.insert(ident, body);
                                    checked += 1;
                                    slot.0 += 1;
                                }
                            }
                        }
                    }
                }
            }

            for call in prepare_calls(&source) {
                let (sql_name, bind_list) = match call.find(',') {
                    Some(comma) => (call[..comma].trim(), call[comma + 1..].trim()),
                    None => continue,
                };
                let sql_name = sql_name.trim_start_matches('&').trim();
                if sql_name.is_empty() || !sql_by_name.contains_key(sql_name) {
                    continue;
                }
                let binds = split_binds(bind_list);
                let (region, is_set) = predicate_region(&sql_by_name[sql_name]);
                if region.is_empty() {
                    continue;
                }
                let found = predicates(&region, is_set);

                // Exactly two EQUALITY predicates, distinct placeholders, both id-like, and neither
                // inside a SET. Anything else is out of scope by design, not by oversight.
                let mut by_placeholder: BTreeMap<usize, &Predicate> = BTreeMap::new();
                let mut duplicates = false;
                for predicate in &found {
                    if predicate.in_set
                        || !is_id_like(&predicate.column)
                        || predicate.placeholder == 0
                    {
                        continue;
                    }
                    if by_placeholder
                        .insert(predicate.placeholder, predicate)
                        .is_some()
                    {
                        duplicates = true;
                    }
                }
                if duplicates || by_placeholder.len() != 2 {
                    continue;
                }
                two_id_lookups += 1;
                slot.1 += 1;

                // The placeholders need not be 1 and 2 -- only that they are distinct -- so they are
                // taken in ascending order and the binds are read positionally from there.
                let mut ordered: Vec<&Predicate> = by_placeholder.values().copied().collect();
                ordered.sort_by_key(|predicate| predicate.placeholder);
                let (first, second) = (ordered[0], ordered[1]);
                let first_bind = binds.get(first.placeholder - 1);
                let second_bind = binds.get(second.placeholder - 1);
                let (Some(first_bind), Some(second_bind)) = (first_bind, second_bind) else {
                    continue;
                };
                let first_name = bind_identifier(first_bind);
                let second_name = bind_identifier(second_bind);

                // The transposition: each bind names the column the OTHER placeholder filters on.
                if first_name == second.column && second_name == first.column {
                    transposed.push(format!(
                        "{name}: {sql_name} binds {first_bind} to ?{} (which filters {}) and \
                         {second_bind} to ?{} (which filters {})",
                        first.placeholder, first.column, second.placeholder, second.column
                    ));
                }
            }
        }

        // The denominator, printed on every run. A check that can report a clean sheet without saying
        // how much it looked at is a check whose silence means nothing, and `pnpm check` swallows
        // passing output unless asked.
        eprintln!(
            "v01_004 bind correspondence: {checked} SQL constants read, {two_id_lookups} two-id \
             lookups examined, {} transposed",
            transposed.len()
        );
        for (directory, (constants, lookups)) in &per_directory {
            eprintln!("v01_004   src/{directory}: {constants} SQL constants, {lookups} lookups");
            assert!(
                *constants > 0,
                "src/{directory} contributed NO SQL constants, so it was not really scanned. A \
                 directory that silently contributes nothing is the same failure as a region that is \
                 silently empty, and it is invisible in the total."
            );
        }
        assert_eq!(
            per_directory.len(),
            DIRECTORIES.len(),
            "a declared directory produced no entry at all, which means the loop and the report \
             disagree about what was scanned"
        );

        assert!(
            checked >= 40,
            "the scan read {checked} SQL constants, which is too few to mean anything: a check that \
             silently stops finding statements reports a clean sheet for the wrong reason. Expected at \
             least 40 across src/repositories."
        );
        assert!(
            two_id_lookups >= 5,
            "only {two_id_lookups} two-id lookups were examined, so this run cannot say much about the \
             shape it exists to check. Expected at least 5."
        );
        assert!(
            transposed.is_empty(),
            "a two-id lookup binds its ids transposed, which makes the statement unsatisfiable and the \
             resource unreadable by its own owner:\n  {}",
            transposed.join("\n  ")
        );
    }
}
