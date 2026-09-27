//! The release documents that are generated from code, and the tests that keep
//! them honest (P09).
//!
//! # Why a document needs a test
//!
//! A generated table that nobody regenerates is a lie with a timestamp on it. The
//! retention map names all 85 declared data classes; the schema map names every
//! migration. If either drifts, the drift is silent until someone relies on it
//! during an incident — which is the worst possible time to discover the runbook's
//! table list is two migrations out of date.
//!
//! So each of these tests parses the checked-in document and compares it against
//! the authority in code. They fail on drift in either direction: a class added to
//! the registry but not the map, and a class in the map that no longer exists.
#![cfg(test)]

use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;

fn release_doc(name: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../docs/release")
        .join(name);
    fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("docs/release/{name} must exist and be readable: {error}"))
}

/// The data classes the document's TABLE names, read from the first column only.
///
/// First column, not "every backticked token": the prose legitimately backticks
/// `lifecycle`, `bounded`, and `anchored` as retention vocabulary, and a looser
/// scan reports them as undocumented classes. A document check that cries wolf is
/// a document check people disable.
fn documented_classes(document: &str) -> BTreeSet<String> {
    document
        .lines()
        .filter_map(|line| {
            let first = line.strip_prefix("| ")?;
            let name = first.strip_prefix('`')?;
            let end = name.find('`')?;
            let token = &name[..end];
            // A class key is snake_case by construction, which is also what makes
            // this unambiguous against a retention word.
            (!token.is_empty()
                && token
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'))
            .then(|| token.to_owned())
        })
        .collect()
}

#[test]
fn the_retention_map_names_exactly_the_declared_data_classes() {
    let declared: BTreeSet<String> = crate::modules::data_governance::registry::all_classes()
        .into_iter()
        .map(|class| class.as_str().to_owned())
        .collect();
    assert!(
        declared.len() > 50,
        "only {} classes are declared; the registry shape probably changed",
        declared.len()
    );
    let documented = documented_classes(&release_doc("data-retention-map.md"));
    let missing: Vec<_> = declared.difference(&documented).collect();
    let extra: Vec<_> = documented.difference(&declared).collect();
    assert!(
        missing.is_empty() && extra.is_empty(),
        "docs/release/data-retention-map.md has drifted from the registry.\n  \
         declared but not documented: {missing:?}\n  \
         documented but not declared: {extra:?}"
    );
}

#[test]
fn the_schema_map_names_every_migration_in_order() {
    let migrations = migration_names();
    let document = release_doc("schema-migration-map.md");
    let mut at = 0usize;
    for migration in &migrations {
        let found = document[at..].find(migration.as_str()).unwrap_or_else(|| {
            panic!("docs/release/schema-migration-map.md does not mention {migration}")
        });
        at += found + migration.len();
    }
    assert!(
        migrations.len() >= 15,
        "only {} migrations found; the scan probably broke",
        migrations.len()
    );
}

/// The migration files, in the order D1 applies them.
fn migration_names() -> Vec<String> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("migrations");
    let mut names: Vec<String> = fs::read_dir(&dir)
        .expect("the migrations directory is readable")
        .filter_map(|entry| {
            let path = entry.expect("a readable entry").path();
            let name = path.file_name()?.to_str()?.to_owned();
            name.ends_with(".sql").then_some(name)
        })
        .collect();
    names.sort();
    names
}
