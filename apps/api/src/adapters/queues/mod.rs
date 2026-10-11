//! Cloudflare Queue binding adapters. The domain/application layer depends on
//! the `EventPublisher` port and never receives raw `Env`.

mod consumer;
mod json_body;
mod logging;
mod publisher;

pub use consumer::{OUTBOX_RETRY_DELAY_SECONDS, consume_queue_batch};
pub use json_body::{JsonBodyError, MAX_JSON_BODY_BYTES, json_object_text, send_json_object};
pub use logging::WorkerOutboxLogger;
pub use publisher::CloudflareQueuePublisher;
