//! The JSON boundary for a jobs-queue message body.
//!
//! `worker::Queue::send<T: Serialize>` runs `serde_wasm_bindgen::to_value` with its
//! default serializer, which turns every serde **map** into a JS `Map`. A
//! `serde_json::Value::Object` is a map, so an envelope built as a `Value` reached the
//! queue as a `Map`; with `contentType: 'json'` the queue JSON-serializes it to `{}`, and
//! the consumer read a body with no `job_type`. A typed struct is not affected (it is
//! serialized as an object), which is why the outbox -- which sends `&EventEnvelope` --
//! worked while the jobs producer, which sent a `Value`, did not.
//!
//! The fix is to cross into JS through JSON text. `JSON.parse` cannot return a `Map`, so
//! the body is a plain object whatever the nesting, with no new dependency
//! (`worker` re-exports `js_sys`). The text step is also where a body that could not
//! possibly be an envelope is refused, so an empty `{}` is never published again.

use serde_json::Value;
use worker::{QueueContentType, RawMessageBuilder, SendMessage, wasm_bindgen::JsValue};

/// Upper bound on a serialized body. Queue messages are capped far above this; an
/// envelope is bounded metadata (identifiers, a reference, small counters), never
/// content, so anything near this size is a bug rather than a payload.
pub const MAX_JSON_BODY_BYTES: usize = 64 * 1024;

/// Why a body was refused before it reached the queue. Carries no content.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JsonBodyError {
    /// The value is not a JSON object (an array, string, number, boolean or null).
    NotAnObject,
    /// An object with no fields: the exact shape of the failure this boundary exists to
    /// prevent, and never a valid envelope.
    Empty,
    /// Larger than [`MAX_JSON_BODY_BYTES`].
    TooLarge,
    /// The value could not be encoded as JSON text.
    Encode,
}

impl JsonBodyError {
    pub const fn code(self) -> &'static str {
        match self {
            Self::NotAnObject => "queue_body_not_an_object",
            Self::Empty => "queue_body_empty",
            Self::TooLarge => "queue_body_too_large",
            Self::Encode => "queue_body_encode_failed",
        }
    }
}

/// The JSON text of a body that is a non-empty object within bounds.
///
/// Pure, so the contract is testable without a JS runtime.
pub fn json_object_text(value: &Value) -> Result<String, JsonBodyError> {
    let Value::Object(fields) = value else {
        return Err(JsonBodyError::NotAnObject);
    };
    if fields.is_empty() {
        return Err(JsonBodyError::Empty);
    }
    let text = serde_json::to_string(value).map_err(|_| JsonBodyError::Encode)?;
    if text.len() > MAX_JSON_BODY_BYTES {
        return Err(JsonBodyError::TooLarge);
    }
    Ok(text)
}

/// A queue message whose body is a plain JS object, content type `json`.
pub fn plain_object_message(value: &Value) -> worker::Result<SendMessage<JsValue>> {
    let text = json_object_text(value)
        .map_err(|error| worker::Error::RustError(error.code().to_owned()))?;
    let object = worker::js_sys::JSON::parse(&text)
        .map_err(|_| worker::Error::RustError("queue_body_parse_failed".to_owned()))?;
    Ok(RawMessageBuilder::new(object).build_with_content_type(QueueContentType::Json))
}

/// Send one envelope body to a queue as a plain JSON object.
pub async fn send_json_object(queue: &worker::Queue, value: &Value) -> worker::Result<()> {
    queue.send_raw(plain_object_message(value)?).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_non_empty_object_round_trips_exactly_including_nesting() {
        let body = json!({
            "job_id": "job_66666666666666666666666666666666",
            "job_type": "automation.dispatch",
            "tenant_scope": { "org_id": "org_22222222222222222222222222222222" },
            "payload": { "export_id": "exp_1", "deletion_id": null },
            "attempt": 1,
            "event_id": null,
        });
        let text = json_object_text(&body).expect("accepted");
        let parsed: Value = serde_json::from_str(&text).expect("valid JSON text");
        assert_eq!(parsed, body, "the text boundary must not change the body");
        assert_eq!(parsed["job_type"], "automation.dispatch");
        assert_eq!(
            parsed["tenant_scope"]["org_id"],
            "org_22222222222222222222222222222222"
        );
    }

    #[test]
    fn an_empty_object_is_refused_because_it_is_the_old_failure_shape() {
        // `{}` is what the queue delivered when the body went out as a JS Map.
        assert_eq!(
            json_object_text(&json!({})),
            Err(JsonBodyError::Empty),
            "an empty body must never be published"
        );
    }

    #[test]
    fn only_a_json_object_is_a_queue_body() {
        for not_object in [
            json!([]),
            json!([{ "job_type": "automation.dispatch" }]),
            json!("job"),
            json!(1),
            json!(true),
            Value::Null,
        ] {
            assert_eq!(
                json_object_text(&not_object),
                Err(JsonBodyError::NotAnObject),
                "{not_object}"
            );
        }
    }

    #[test]
    fn an_oversized_body_is_refused_not_truncated() {
        let big =
            json!({ "job_type": "automation.dispatch", "pad": "x".repeat(MAX_JSON_BODY_BYTES) });
        assert_eq!(json_object_text(&big), Err(JsonBodyError::TooLarge));
        let at_limit = json!({ "job_type": "automation.dispatch" });
        assert!(json_object_text(&at_limit).is_ok());
    }

    #[test]
    fn every_refusal_has_a_distinct_bounded_code() {
        let codes = [
            JsonBodyError::NotAnObject.code(),
            JsonBodyError::Empty.code(),
            JsonBodyError::TooLarge.code(),
            JsonBodyError::Encode.code(),
        ];
        let mut sorted = codes.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), codes.len());
        for code in codes {
            assert!(
                code.bytes().all(|b| b.is_ascii_lowercase() || b == b'_'),
                "{code}"
            );
        }
    }
}
