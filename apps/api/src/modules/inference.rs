//! P04 vendor-neutral inference envelopes and response safety state machine.

use std::collections::BTreeMap;
use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::catalog::ModelCapability;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageRole {
    System,
    User,
    Assistant,
    Tool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentPart {
    Text { text: String },
}

pub const MAX_TOOL_CALLS: usize = 128;
pub const MAX_TOOL_CALL_ID_BYTES: usize = 128;
pub const MAX_TOOL_NAME_BYTES: usize = 128;
pub const MAX_TOOL_ARGUMENTS_BYTES: usize = 256 * 1024;
/// Aggregate bound for tool-call arguments accumulated from one response.
pub const MAX_TOOL_ARGUMENTS_TOTAL_BYTES: usize = 512 * 1024;

/// A validated assistant function call. Arguments stay an opaque JSON string:
/// the gateway transports calls and never interprets or executes them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct InferenceMessage {
    pub role: MessageRole,
    pub content: Vec<ContentPart>,
    /// Assistant function calls. Valid only on assistant messages.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<ToolCall>,
    /// Call answered by a tool message. Valid only on tool messages.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

impl InferenceMessage {
    pub fn user(text: impl Into<String>) -> Self {
        Self {
            role: MessageRole::User,
            content: vec![ContentPart::Text { text: text.into() }],
            tool_calls: Vec::new(),
            tool_call_id: None,
        }
    }

    /// Bytes of caller-supplied content, including tool-call material, for
    /// the aggregate request limit and token estimate.
    pub fn content_bytes(&self) -> usize {
        let text = self.content.iter().fold(0_usize, |total, part| {
            let ContentPart::Text { text } = part;
            total.saturating_add(text.len())
        });
        self.tool_calls.iter().fold(text, |total, call| {
            total
                .saturating_add(call.id.len())
                .saturating_add(call.name.len())
                .saturating_add(call.arguments.len())
        })
    }
}

pub fn valid_tool_call_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_TOOL_CALL_ID_BYTES
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b':'))
}

pub fn valid_tool_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= MAX_TOOL_NAME_BYTES && !name.chars().any(char::is_control)
}

/// A tool-call fragment or message violated the bounded wire contract.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ToolCallError;

#[derive(Debug)]
struct TrackedCall {
    id: Option<String>,
    name: String,
    arguments: String,
}

/// Validates and reassembles interleaved streamed tool-call fragments. It is
/// the single bounds/uniqueness authority for provider output, used by both
/// the streaming renderer and the buffered response path.
#[derive(Debug, Default)]
pub struct ToolCallTracker {
    calls: BTreeMap<u32, TrackedCall>,
    argument_bytes: usize,
}

impl ToolCallTracker {
    pub fn is_empty(&self) -> bool {
        self.calls.is_empty()
    }

    /// An id or name fragment is never invented; a later fragment may omit
    /// both. A repeated id must match, and ids are unique across indexes.
    pub fn accept(
        &mut self,
        index: u32,
        id: Option<&str>,
        name: Option<&str>,
        arguments_delta: &str,
    ) -> Result<(), ToolCallError> {
        if index as usize >= MAX_TOOL_CALLS {
            return Err(ToolCallError);
        }
        if let Some(id) = id {
            if !valid_tool_call_id(id) {
                return Err(ToolCallError);
            }
            let duplicated_elsewhere = self
                .calls
                .iter()
                .any(|(other, call)| *other != index && call.id.as_deref() == Some(id));
            if duplicated_elsewhere {
                return Err(ToolCallError);
            }
        }
        self.argument_bytes = self.argument_bytes.saturating_add(arguments_delta.len());
        if self.argument_bytes > MAX_TOOL_ARGUMENTS_TOTAL_BYTES {
            return Err(ToolCallError);
        }
        let call = self.calls.entry(index).or_insert_with(|| TrackedCall {
            id: None,
            name: String::new(),
            arguments: String::new(),
        });
        if let Some(id) = id {
            match call.id.as_deref() {
                Some(existing) if existing != id => return Err(ToolCallError),
                Some(_) => {}
                None => call.id = Some(id.to_owned()),
            }
        }
        if let Some(name) = name {
            call.name.push_str(name);
            if call.name.len() > MAX_TOOL_NAME_BYTES || call.name.chars().any(char::is_control) {
                return Err(ToolCallError);
            }
        }
        call.arguments.push_str(arguments_delta);
        if call.arguments.len() > MAX_TOOL_ARGUMENTS_BYTES {
            return Err(ToolCallError);
        }
        Ok(())
    }

    /// Terminal check: every started call must have gained an id, a name and
    /// complete JSON-object arguments.
    pub fn finish(&self) -> Result<Vec<ToolCall>, ToolCallError> {
        self.calls
            .values()
            .map(|call| match call.id.as_deref() {
                // Arguments must be a complete JSON object: a truncated or
                // non-object payload is corrupt output, not a call to forward.
                Some(id)
                    if valid_tool_name(&call.name)
                        && serde_json::from_str::<Value>(&call.arguments)
                            .is_ok_and(|arguments| arguments.is_object()) =>
                {
                    Ok(ToolCall {
                        id: id.to_owned(),
                        name: call.name.clone(),
                        arguments: call.arguments.clone(),
                    })
                }
                _ => Err(ToolCallError),
            })
            .collect()
    }
}

/// Decode a buffered OpenAI `message.tool_calls` array with the same bounds
/// as the streaming path.
pub fn decode_message_tool_calls(calls: &[Value]) -> Result<Vec<ToolCall>, ToolCallError> {
    let mut tracker = ToolCallTracker::default();
    for (position, call) in calls.iter().enumerate() {
        if call
            .get("type")
            .is_some_and(|kind| kind.as_str() != Some("function"))
        {
            return Err(ToolCallError);
        }
        let function = call.get("function").ok_or(ToolCallError)?;
        let text = |value: &Value, key: &str| -> Result<String, ToolCallError> {
            value
                .get(key)
                .and_then(Value::as_str)
                .map(str::to_owned)
                .ok_or(ToolCallError)
        };
        tracker.accept(
            u32::try_from(position).map_err(|_| ToolCallError)?,
            Some(&text(call, "id")?),
            Some(&text(function, "name")?),
            &text(function, "arguments")?,
        )?;
    }
    tracker.finish()
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct InferenceRequest {
    pub model: String,
    pub messages: Vec<InferenceMessage>,
    pub required_capabilities: Vec<ModelCapability>,
    pub stream: bool,
    pub max_output_tokens: Option<u32>,
    pub temperature: Option<f32>,
    pub tools: Vec<Value>,
    /// Whether a pre-dispatch failure may safely be retried/fallbacked.
    /// Tool-bearing requests are conservative until an adapter explicitly
    /// proves the operation idempotent.
    pub retry_safe: bool,
    pub project_id: Option<String>,
    pub session_id: Option<String>,
    pub run_id: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResponseLifecycle {
    NotDispatched,
    DispatchedNoOutput,
    StreamCommitted,
    Completed,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AdapterErrorKind {
    ConnectionFailed,
    Timeout,
    RateLimited,
    ProviderUnavailable,
    InvalidRequest,
    InvalidResponse,
    CredentialRejected,
    UnsupportedCapability,
    ContentFiltered,
}

impl AdapterErrorKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ConnectionFailed => "connection_failed",
            Self::Timeout => "timeout",
            Self::RateLimited => "rate_limited",
            Self::ProviderUnavailable => "provider_unavailable",
            Self::InvalidRequest => "invalid_request",
            Self::InvalidResponse => "invalid_response",
            Self::CredentialRejected => "credential_rejected",
            Self::UnsupportedCapability => "unsupported_capability",
            Self::ContentFiltered => "content_filtered",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AdapterError {
    pub kind: AdapterErrorKind,
    pub retryable: bool,
    pub status_code: Option<u16>,
}

impl fmt::Display for AdapterError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.kind.as_str())
    }
}

pub fn normalize_adapter_error(status_code: u16, _upstream_body: &str) -> AdapterError {
    let kind = match status_code {
        408 | 504 => AdapterErrorKind::Timeout,
        429 => AdapterErrorKind::RateLimited,
        401 | 403 => AdapterErrorKind::CredentialRejected,
        400 | 422 => AdapterErrorKind::InvalidRequest,
        502 | 503 => AdapterErrorKind::ProviderUnavailable,
        _ => AdapterErrorKind::InvalidResponse,
    };
    AdapterError {
        kind,
        retryable: matches!(
            kind,
            AdapterErrorKind::ConnectionFailed
                | AdapterErrorKind::Timeout
                | AdapterErrorKind::RateLimited
                | AdapterErrorKind::ProviderUnavailable
        ),
        status_code: Some(status_code),
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ProviderUsage {
    pub input_tokens: Option<u32>,
    pub output_tokens: Option<u32>,
    pub cached_tokens: Option<u32>,
    pub provider_name: Option<String>,
    pub pricing_version: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ProviderStreamEvent {
    TextDelta {
        text: String,
    },
    /// One fragment of a streamed function call. `call_id` and `name` are
    /// present only on the fragments where the provider sent them.
    ToolCallDelta {
        index: u32,
        call_id: Option<String>,
        name: Option<String>,
        arguments_delta: String,
    },
    Usage {
        usage: ProviderUsage,
    },
    ProviderRequestId {
        provider_request_id: String,
    },
    Done,
    InvalidResponse,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AdapterStreamState {
    pub done: bool,
    pub invalid_response: bool,
    pub buffer_bytes: usize,
}

impl AdapterStreamState {
    /// Whether an ended provider response may be recorded as a completion.
    ///
    /// `done` is set only by the protocol's terminal marker, `data: [DONE]`,
    /// which every adapter normalizes to (`message_stop` becomes `[DONE]` in
    /// the Anthropic adapter). A body that ends without it was cut short by a
    /// disconnect or an upstream fault, so whatever the decoder could flush is
    /// partial output, not a finished answer.
    ///
    /// This is the commitment gate, and it is deliberately stricter than "we
    /// emitted some text": recording a truncated stream as a completion would
    /// report a cut-short run as succeeded and would let the caller commit a
    /// budget reservation for output that never arrived. A malformed body has
    /// already failed the response outright, so it never qualifies either.
    pub const fn may_complete(&self) -> bool {
        self.done && !self.invalid_response
    }
}

#[derive(Clone, Debug, Default)]
pub struct SseDecoder {
    buffer: String,
}

impl SseDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Decode complete SSE events while retaining a bounded partial event for
    /// the next network chunk. Malformed provider data is represented as a
    /// typed event and never forwarded as a raw body.
    pub fn push(
        &mut self,
        bytes: &[u8],
        state: &mut AdapterStreamState,
    ) -> Vec<ProviderStreamEvent> {
        if state.done || bytes.len() > 256 * 1024 {
            state.invalid_response = true;
            return vec![ProviderStreamEvent::InvalidResponse];
        }
        let text = String::from_utf8_lossy(bytes);
        self.buffer.push_str(&text);
        state.buffer_bytes = self.buffer.len();
        if self.buffer.len() > 512 * 1024 {
            self.buffer.clear();
            state.invalid_response = true;
            return vec![ProviderStreamEvent::InvalidResponse];
        }
        let normalized = self.buffer.replace("\r\n", "\n").replace('\r', "\n");
        let Some(separator_end) = normalized.rfind("\n\n") else {
            state.buffer_bytes = normalized.len();
            self.buffer = normalized;
            return Vec::new();
        };
        let complete = &normalized[..separator_end + 2];
        let remaining = normalized[separator_end + 2..].to_owned();
        let mut events = Vec::new();
        for block in complete.split("\n\n") {
            if block.trim().is_empty() {
                continue;
            }
            if !block.contains("data:") {
                state.invalid_response = true;
                events.push(ProviderStreamEvent::InvalidResponse);
                continue;
            }
            let mut data = String::new();
            for line in block.lines() {
                if let Some(value) = line.strip_prefix("data:") {
                    if !data.is_empty() {
                        data.push('\n');
                    }
                    data.push_str(value.trim_start());
                }
            }
            if data == "[DONE]" {
                state.done = true;
                events.push(ProviderStreamEvent::Done);
                continue;
            }
            match serde_json::from_str::<Value>(&data) {
                Ok(value) => events.extend(decode_openai_value(&value, state)),
                Err(_) => {
                    state.invalid_response = true;
                    events.push(ProviderStreamEvent::InvalidResponse);
                }
            }
        }
        self.buffer = remaining;
        state.buffer_bytes = self.buffer.len();
        events
    }

    pub fn finish(&mut self, state: &mut AdapterStreamState) -> Vec<ProviderStreamEvent> {
        if self.buffer.trim().is_empty() {
            return Vec::new();
        }
        let mut bytes = self.buffer.as_bytes().to_vec();
        self.buffer.clear();
        if !bytes.ends_with(b"\n\n") {
            bytes.extend_from_slice(b"\n\n");
        }
        self.push(&bytes, state)
    }
}

fn decode_openai_value(value: &Value, state: &mut AdapterStreamState) -> Vec<ProviderStreamEvent> {
    let mut events = Vec::new();
    if let Some(id) = value.get("id").and_then(Value::as_str)
        && !id.is_empty()
    {
        events.push(ProviderStreamEvent::ProviderRequestId {
            provider_request_id: id.to_owned(),
        });
    }
    if let Some(usage) = value.get("usage").filter(|usage| !usage.is_null()) {
        events.push(ProviderStreamEvent::Usage {
            usage: ProviderUsage {
                input_tokens: usage
                    .get("prompt_tokens")
                    .and_then(Value::as_u64)
                    .and_then(|v| u32::try_from(v).ok()),
                output_tokens: usage
                    .get("completion_tokens")
                    .and_then(Value::as_u64)
                    .and_then(|v| u32::try_from(v).ok()),
                cached_tokens: usage
                    .get("prompt_tokens_details")
                    .and_then(|details| details.get("cached_tokens"))
                    .and_then(Value::as_u64)
                    .and_then(|v| u32::try_from(v).ok()),
                provider_name: value
                    .get("model")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                pricing_version: None,
            },
        });
    }
    if let Some(choice) = value
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
    {
        if let Some(text) = choice
            .get("delta")
            .and_then(|delta| delta.get("content"))
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
        {
            events.push(ProviderStreamEvent::TextDelta {
                text: text.to_owned(),
            });
        }
        if let Some(tool_calls) = choice
            .get("delta")
            .and_then(|delta| delta.get("tool_calls"))
            .and_then(Value::as_array)
        {
            for call in tool_calls {
                match decode_tool_call_fragment(call) {
                    Some(event) => events.push(event),
                    None => {
                        state.invalid_response = true;
                        events.push(ProviderStreamEvent::InvalidResponse);
                        break;
                    }
                }
            }
        }
    }
    if events.is_empty() {
        state.invalid_response = true;
        events.push(ProviderStreamEvent::InvalidResponse);
    }
    events
}

/// Structural decode of one streamed `delta.tool_calls[]` element. Null or
/// empty id/name/arguments are "absent"; any other wrong type is corrupt.
fn decode_tool_call_fragment(call: &Value) -> Option<ProviderStreamEvent> {
    let optional_text = |value: Option<&Value>| -> Option<Option<String>> {
        match value {
            None | Some(Value::Null) => Some(None),
            Some(Value::String(text)) if text.is_empty() => Some(None),
            Some(Value::String(text)) => Some(Some(text.clone())),
            Some(_) => None,
        }
    };
    let index = u32::try_from(call.get("index")?.as_u64()?).ok()?;
    if call
        .get("type")
        .is_some_and(|kind| !kind.is_null() && kind.as_str() != Some("function"))
    {
        return None;
    }
    let call_id = optional_text(call.get("id"))?;
    let function = match call.get("function") {
        None | Some(Value::Null) => None,
        Some(value) if value.is_object() => Some(value),
        Some(_) => return None,
    };
    let name = optional_text(function.and_then(|function| function.get("name")))?;
    let arguments_delta =
        optional_text(function.and_then(|function| function.get("arguments")))?.unwrap_or_default();
    Some(ProviderStreamEvent::ToolCallDelta {
        index,
        call_id,
        name,
        arguments_delta,
    })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RetryController {
    state: ResponseLifecycle,
    remaining_retries: u8,
    max_fallbacks: u8,
    fallback_count: u8,
}

impl RetryController {
    pub fn new(remaining_retries: u8, max_fallbacks: u8) -> Self {
        Self {
            state: ResponseLifecycle::NotDispatched,
            remaining_retries,
            max_fallbacks,
            fallback_count: 0,
        }
    }

    pub fn state(&self) -> ResponseLifecycle {
        self.state
    }

    pub fn fallback_count(&self) -> u8 {
        self.fallback_count
    }

    pub fn can_retry(&self) -> bool {
        matches!(
            self.state,
            ResponseLifecycle::NotDispatched | ResponseLifecycle::DispatchedNoOutput
        ) && (self.remaining_retries > 0 || self.fallback_count < self.max_fallbacks)
    }

    pub fn mark_dispatched(&mut self) {
        if matches!(self.state, ResponseLifecycle::NotDispatched) {
            self.state = ResponseLifecycle::DispatchedNoOutput;
        }
    }

    pub fn mark_stream_committed(&mut self) {
        if matches!(
            self.state,
            ResponseLifecycle::NotDispatched | ResponseLifecycle::DispatchedNoOutput
        ) {
            self.state = ResponseLifecycle::StreamCommitted;
        }
    }

    pub fn mark_retryable_failure(&mut self, _kind: AdapterErrorKind) {
        if self.state == ResponseLifecycle::StreamCommitted {
            self.state = ResponseLifecycle::Failed;
            return;
        }
        if self.can_retry() {
            self.remaining_retries = self.remaining_retries.saturating_sub(1);
            self.fallback_count = self.fallback_count.saturating_add(1);
            self.state = ResponseLifecycle::NotDispatched;
        } else {
            self.state = ResponseLifecycle::Failed;
        }
    }

    pub fn complete(&mut self) {
        self.state = ResponseLifecycle::Completed;
    }

    pub fn fail(&mut self) {
        self.state = ResponseLifecycle::Failed;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partial_sse_event_is_retained_until_complete() {
        let mut decoder = SseDecoder::new();
        let mut state = AdapterStreamState::default();
        assert!(
            decoder
                .push(
                    b"data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}",
                    &mut state
                )
                .is_empty()
        );
        let events = decoder.push(b"\n\n", &mut state);
        assert!(matches!(
            events.as_slice(),
            [ProviderStreamEvent::TextDelta { .. }]
        ));
    }

    #[test]
    fn final_sse_event_without_blank_line_is_flushed_at_eof() {
        let mut decoder = SseDecoder::new();
        let mut state = AdapterStreamState::default();
        assert!(
            decoder
                .push(
                    b"data: {\"choices\":[{\"delta\":{\"content\":\"tail\"}}]}",
                    &mut state
                )
                .is_empty()
        );
        let events = decoder.finish(&mut state);
        assert!(events.iter().any(
            |event| matches!(event, ProviderStreamEvent::TextDelta { text } if text == "tail")
        ));
    }

    #[test]
    fn provider_error_event_marks_stream_invalid_after_text() {
        let mut decoder = SseDecoder::new();
        let mut state = AdapterStreamState::default();
        let events = decoder.push(
            b"data: {\"id\":\"r\",\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\ndata: {\"error\":{\"code\":\"synthetic\"}}\n\n",
            &mut state,
        );
        assert!(
            events
                .iter()
                .any(|event| matches!(event, ProviderStreamEvent::TextDelta { .. }))
        );
        assert!(
            events
                .iter()
                .any(|event| matches!(event, ProviderStreamEvent::InvalidResponse))
        );
        assert!(state.invalid_response);
    }

    fn tool_chunk(calls: &str) -> Vec<u8> {
        format!("data: {{\"id\":\"c\",\"choices\":[{{\"delta\":{{\"tool_calls\":{calls}}}}}]}}\n\n")
            .into_bytes()
    }

    fn decode_all(chunks: &[Vec<u8>]) -> (Vec<ProviderStreamEvent>, AdapterStreamState) {
        let mut decoder = SseDecoder::new();
        let mut state = AdapterStreamState::default();
        let mut events = Vec::new();
        for chunk in chunks {
            events.extend(decoder.push(chunk, &mut state));
        }
        (events, state)
    }

    #[test]
    fn fragmented_interleaved_calls_keep_index_id_name_and_arguments() {
        let (events, state) = decode_all(&[
            tool_chunk(r#"[{"index":0,"id":"call_a","type":"function","function":{"name":"fs_wr","arguments":""}}]"#),
            tool_chunk(r#"[{"index":1,"id":"call_b","type":"function","function":{"name":"list","arguments":"{"}}]"#),
            tool_chunk(r#"[{"index":0,"function":{"name":"ite","arguments":"{\"p\":"}}]"#),
            tool_chunk(r#"[{"index":0,"id":null,"function":{"arguments":"1}"}},{"index":1,"function":{"arguments":"}"}}]"#),
            b"data: {\"id\":\"c\",\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\ndata: {\"id\":\"c\",\"choices\":[],\"usage\":{\"prompt_tokens\":9,\"completion_tokens\":4}}\n\ndata: [DONE]\n\n".to_vec(),
        ]);
        assert!(state.may_complete());
        let mut tracker = ToolCallTracker::default();
        let mut usage = None;
        for event in &events {
            match event {
                ProviderStreamEvent::ToolCallDelta {
                    index,
                    call_id,
                    name,
                    arguments_delta,
                } => tracker
                    .accept(*index, call_id.as_deref(), name.as_deref(), arguments_delta)
                    .unwrap(),
                ProviderStreamEvent::Usage { usage: value } => usage = Some(value.clone()),
                _ => {}
            }
        }
        assert_eq!(usage.unwrap().output_tokens, Some(4));
        let calls = tracker.finish().unwrap();
        assert_eq!(
            calls,
            vec![
                ToolCall {
                    id: "call_a".to_owned(),
                    name: "fs_write".to_owned(),
                    arguments: "{\"p\":1}".to_owned(),
                },
                ToolCall {
                    id: "call_b".to_owned(),
                    name: "list".to_owned(),
                    arguments: "{}".to_owned(),
                },
            ]
        );
        // The first fragment of call 1 keeps the provider's id; later
        // fragments are not given a substitute id.
        assert!(events.iter().any(|event| matches!(
            event,
            ProviderStreamEvent::ToolCallDelta { index: 0, call_id: None, name: Some(name), .. } if name == "ite"
        )));
    }

    #[test]
    fn corrupt_tool_call_fragments_fail_closed() {
        for calls in [
            r#"[{"function":{"name":"x"}}]"#,
            r#"[{"index":-1}]"#,
            r#"[{"index":"0"}]"#,
            r#"[{"index":0,"id":7}]"#,
            r#"[{"index":0,"type":"custom"}]"#,
            r#"[{"index":0,"function":"x"}]"#,
            r#"[{"index":0,"function":{"arguments":{}}}]"#,
        ] {
            let (events, state) = decode_all(&[tool_chunk(calls)]);
            assert!(state.invalid_response, "{calls}");
            assert!(
                events
                    .iter()
                    .any(|event| matches!(event, ProviderStreamEvent::InvalidResponse)),
                "{calls}"
            );
        }
    }

    #[test]
    fn tracker_enforces_bounds_identity_and_completeness() {
        let mut tracker = ToolCallTracker::default();
        assert!(tracker.accept(128, Some("a"), Some("n"), "").is_err());
        assert!(tracker.accept(0, Some("bad id"), Some("n"), "").is_err());
        assert!(
            tracker
                .accept(0, Some(&"x".repeat(129)), Some("n"), "")
                .is_err()
        );
        assert!(
            tracker
                .accept(0, Some("a"), Some(&"n".repeat(129)), "")
                .is_err()
        );

        let mut tracker = ToolCallTracker::default();
        tracker.accept(0, Some("a"), Some("n"), "{}").unwrap();
        assert!(
            tracker.accept(0, Some("b"), None, "").is_err(),
            "id changed"
        );
        assert!(
            tracker.accept(1, Some("a"), Some("n"), "").is_err(),
            "duplicate id"
        );

        let mut tracker = ToolCallTracker::default();
        assert!(
            tracker
                .accept(
                    0,
                    Some("a"),
                    Some("n"),
                    &"x".repeat(MAX_TOOL_ARGUMENTS_BYTES + 1)
                )
                .is_err()
        );

        let mut tracker = ToolCallTracker::default();
        tracker.accept(0, None, Some("n"), "{}").unwrap();
        assert!(tracker.finish().is_err(), "call never received an id");
        let mut tracker = ToolCallTracker::default();
        tracker.accept(0, Some("a"), None, "{}").unwrap();
        assert!(tracker.finish().is_err(), "call never received a name");
    }

    #[test]
    fn truncated_or_non_object_arguments_never_finish_as_a_call() {
        for arguments in ["{\"file_path\":\"/a", "", "[]", "null", "\"s\""] {
            let mut tracker = ToolCallTracker::default();
            tracker.accept(0, Some("a"), Some("n"), arguments).unwrap();
            assert!(tracker.finish().is_err(), "{arguments:?}");
        }
        let truncated = serde_json::json!([{"id":"c","function":{"name":"w","arguments":"{\"a"}}]);
        assert!(decode_message_tool_calls(truncated.as_array().unwrap()).is_err());
    }

    #[test]
    fn buffered_message_tool_calls_share_the_stream_bounds() {
        let ok = serde_json::json!([{"id":"call_1","type":"function","function":{"name":"w","arguments":"{}"}}]);
        assert_eq!(
            decode_message_tool_calls(ok.as_array().unwrap())
                .unwrap()
                .len(),
            1
        );
        for bad in [
            serde_json::json!([{"id":"call_1","type":"custom","function":{"name":"w","arguments":"{}"}}]),
            serde_json::json!([{"type":"function","function":{"name":"w","arguments":"{}"}}]),
            serde_json::json!([{"id":"c","function":{"name":"w"}}]),
            serde_json::json!([
                {"id":"c","function":{"name":"w","arguments":"{}"}},
                {"id":"c","function":{"name":"w","arguments":"{}"}}
            ]),
        ] {
            assert!(decode_message_tool_calls(bad.as_array().unwrap()).is_err());
        }
    }

    #[test]
    fn adapter_error_display_never_contains_upstream_body() {
        let error = normalize_adapter_error(503, "secret body");
        assert_eq!(error.to_string(), "provider_unavailable");
    }
}
