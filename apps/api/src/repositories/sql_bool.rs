//! A `bool` that can be read out of a SQLite `INTEGER 0/1` column.
//!
//! # Why this exists
//!
//! D1 hands a row to `workers-rs`, which materialises every column as a JavaScript value before
//! `Deserialize` runs. An `INTEGER` column therefore arrives as a JavaScript **number**, so a row whose
//! `enabled` column is `1` reaches serde as the float `1.0` — and `bool`'s visitor accepts only
//! `true` and `false`. The decode fails, the repository returns `Err`, and every caller maps that to
//! `503`.
//!
//! That failure is V01-030, and its shape is worse than a wrong answer: it fires on exactly one
//! condition, **the row exists**. A row that is absent returns `Ok(None)` and never reaches a
//! deserializer, so every cross-tenant probe over these routes passed while the owner's own request
//! could not be served at all. A gate that only ever sees the absent case is measuring nothing.
//!
//! The store is not wrong and the schema is not wrong. `INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN
//! (0, 1))` is a good constraint: it is exact, it is enforced, and it cannot be null. The decode target
//! was the thing that disagreed with it.
//!
//! # What this accepts
//!
//! `0`/`1` as an integer **or** a float, plus a real JSON `true`/`false`. Nothing else: `2`, `-1`,
//! `0.5`, `"1"` and `null` are all errors, because a boolean column that silently accepts other values
//! is a boolean column nobody can reason about.

use serde::{Deserializer, de};

/// Deserialize a SQLite `INTEGER 0/1` column into a `bool`.
///
/// Applied with `#[serde(deserialize_with = "crate::repositories::sql_bool::deserialize")]`.
pub fn deserialize<'de, D>(deserializer: D) -> Result<bool, D::Error>
where
    D: Deserializer<'de>,
{
    deserializer.deserialize_any(SqlBool)
}

struct SqlBool;

impl<'de> de::Visitor<'de> for SqlBool {
    type Value = bool;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a boolean, or the SQLite INTEGER 0 or 1")
    }

    fn visit_bool<E: de::Error>(self, value: bool) -> Result<bool, E> {
        Ok(value)
    }

    fn visit_u64<E: de::Error>(self, value: u64) -> Result<bool, E> {
        match value {
            0 => Ok(false),
            1 => Ok(true),
            other => Err(E::custom(format!(
                "expected 0 or 1 for a boolean column, found {other}"
            ))),
        }
    }

    fn visit_i64<E: de::Error>(self, value: i64) -> Result<bool, E> {
        // A negative value cannot be a boolean, and `as u64` would wrap `-1` into `u64::MAX`, so the
        // sign is checked before the conversion rather than after it.
        if value < 0 {
            return Err(E::custom(format!(
                "expected 0 or 1 for a boolean column, found {value}"
            )));
        }
        self.visit_u64(value as u64)
    }

    /// The shape D1 actually produces, and the one that made V01-030 invisible: a JavaScript number has
    /// one type, so an `INTEGER` column arrives as `1.0`.
    fn visit_f64<E: de::Error>(self, value: f64) -> Result<bool, E> {
        if value.abs() < f64::EPSILON {
            return Ok(false);
        }
        if (value - 1.0).abs() < f64::EPSILON {
            return Ok(true);
        }
        Err(E::custom(format!(
            "expected 0 or 1 for a boolean column, found {value}"
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::deserialize;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct Row {
        #[serde(deserialize_with = "deserialize")]
        flag: bool,
    }

    fn read(json: &str) -> Result<bool, String> {
        serde_json::from_str::<Row>(json)
            .map(|row| row.flag)
            .map_err(|error| error.to_string())
    }

    /// The regression test for V01-030, at the cheapest layer that can hold it: the shapes the store
    /// produces, decoded through the same deserializer the repository uses.
    ///
    /// `1.0` and `0.0` are the two that matter and the two the old plain `bool` field rejected, so
    /// they are asserted first and named in the failure message. A test that only asserted the integer
    /// forms would pass against a fix that handled integers and leave the D1 path broken.
    #[test]
    fn v01_030_integer_columns_decode_as_booleans() {
        for (json, expected) in [
            // What D1 delivers: a JavaScript number, so a float.
            ("{\"flag\":1.0}", true),
            ("{\"flag\":0.0}", false),
            // What the same values look like as JSON integers.
            ("{\"flag\":1}", true),
            ("{\"flag\":0}", false),
            // A genuine JSON boolean must still work, so a future migration to a BOOLEAN column
            // cannot regress this.
            ("{\"flag\":true}", true),
            ("{\"flag\":false}", false),
        ] {
            assert_eq!(
                read(json),
                Ok(expected),
                "{json} must decode to {expected}: a SQLite INTEGER 0/1 column is not a JSON boolean"
            );
        }
    }

    /// The regression test that belongs to the DEFECT rather than to the helper.
    ///
    /// The two tests above pin the deserializer, and they would both pass if someone annotated a
    /// different struct. This one decodes a real `WebhookEndpointRecord` from a row shaped the way D1
    /// delivers it, and it is the test that fails without the repair -- because before the repair the
    /// field was a plain `bool` and `1.0` was refused.
    ///
    /// The row is the shape the product actually reads: every column present, `enabled` and
    /// `auto_disable_enabled` as the floats D1 produces, and one nullable column null. A shorter fixture
    /// would decode for the wrong reasons.
    #[test]
    fn v01_030_an_endpoint_row_decodes_from_a_d1_row() {
        let row = r#"{
            "endpoint_id": "whe_d22566136dbc4d10bf2e96386425e12c",
            "org_id": "org_23af54fa58e59f181e28ae56d0f95378",
            "name": "alpha-hook",
            "description": null,
            "url": "https://example.test/hook",
            "subscribed_event_types_json": "[\"project.created.v1\"]",
            "current_secret_version_id": null,
            "enabled": 1.0,
            "max_attempts": 8,
            "base_delay_seconds": 30,
            "max_delay_seconds": 86400,
            "replay_window_seconds": 300,
            "auto_disable_enabled": 0.0,
            "auto_disable_threshold": 10,
            "consecutive_terminal_failures": 0,
            "version": 1,
            "created_by_user_id": "usr_0000000000000000000000000000aaaa",
            "created_at": "2026-09-29T00:00:00.000Z",
            "updated_at": "2026-09-29T00:00:00.000Z"
        }"#;
        let record: crate::repositories::webhooks::WebhookEndpointRecord =
            serde_json::from_str(row).expect("a D1 endpoint row must decode");
        assert!(record.enabled, "enabled = 1.0 is true");
        assert!(
            !record.auto_disable_enabled,
            "auto_disable_enabled = 0.0 is false"
        );
    }

    /// A boolean column must not accept anything else. Without this the deserializer could be widened
    /// to "any non-zero number is true" and every assertion above would still pass — which is the shape
    /// of a check that cannot fail for the reason it exists.
    #[test]
    fn v01_030_boolean_columns_reject_everything_else() {
        for json in [
            "{\"flag\":2}",
            "{\"flag\":2.0}",
            "{\"flag\":-1}",
            "{\"flag\":0.5}",
            "{\"flag\":\"1\"}",
            "{\"flag\":null}",
        ] {
            assert!(
                read(json).is_err(),
                "{json} must be refused: only 0, 1, true and false are booleans here"
            );
        }
    }
}
