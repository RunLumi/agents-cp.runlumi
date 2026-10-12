//! Development-only controlled provider fixture for model-driven tool turns
//! (P04-CR-002).
//!
//! Selected only by the closed `mock://lumi-tool` endpoint (or `mock-tool`
//! model id). `validate_endpoint_url` refuses it outside development and the
//! gateway refuses every `mock` adapter outside the development environment,
//! so it is unreachable in production. It never executes anything: it emits at
//! most one synthetic `Write` call chosen from the descriptors the caller
//! actually sent in `request.tools`, then plain text once the matching tool
//! result is present. This is gateway/desktop integration evidence, not
//! external-provider proof.

use serde_json::{Value, json};

use crate::modules::inference::{ContentPart, InferenceRequest, MessageRole};

pub const MOCK_TOOL_ENDPOINT: &str = "mock://lumi-tool";
pub const MOCK_TOOL_MODEL: &str = "mock-tool";
/// A request already holding this many tool results is answered with text.
pub const MAX_MOCK_TOOL_ROUNDS: usize = 4;
/// The newest user message selects the target: `lumi-mock-write:<abs path>`.
pub const MOCK_WRITE_MARKER: &str = "lumi-mock-write:";
/// Only disposable fixture files may be targeted.
pub const MOCK_WRITE_BASENAME_PREFIX: &str = "lumi-e2e-fixture-";
pub const MOCK_WRITE_CONTENT: &str = "lumi mock tool fixture content\n";
const MAX_MOCK_PATH_BYTES: usize = 512;
const RESULT_TEXT: &str = "The mock fixture received the tool result.";
const NO_PATH_TEXT: &str = "The mock fixture found no disposable write path.";
const NO_WRITE_TOOL_TEXT: &str = "The mock fixture was offered no usable Write tool.";
const PATH_KEYS: [&str; 2] = ["file_path", "path"];
const CONTENT_KEYS: [&str; 2] = ["content", "text"];
const PROVIDER_ID: &str = "mock-tool";
/// `lumi-mock-call:<tool name>` asks the fixture to call that exact offered tool once with a
/// fixed synthetic `note`, so a harness can drive a non-Write tool (e.g. a custom MCP tool)
/// through the real managed gate. Only a tool whose schema declares a string `note` qualifies.
pub const MOCK_CALL_MARKER: &str = "lumi-mock-call:";
pub const MOCK_CALL_NOTE: &str = "lumi mock tool call fixture";
const MAX_MOCK_TOOL_NAME_BYTES: usize = 128;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MockToolTurn {
    Call {
        id: String,
        name: String,
        arguments: String,
    },
    Text(&'static str),
    /// The post-result reply. It carries a short bounded snippet of the tool
    /// result so an integration harness can see why the client reported what it
    /// did. Development fixture only; the reply is never persisted.
    Observed(String),
}

const MAX_OBSERVED_BYTES: usize = 160;

fn observed_reply(request: &InferenceRequest) -> MockToolTurn {
    let snippet: String = request
        .messages
        .last()
        .filter(|message| message.role == MessageRole::Tool)
        .map(|message| message_text(&message.content))
        .unwrap_or_default()
        .chars()
        .map(|ch| if ch.is_control() { ' ' } else { ch })
        .scan(0_usize, |used, ch| {
            *used += ch.len_utf8();
            (*used <= MAX_OBSERVED_BYTES).then_some(ch)
        })
        .collect();
    MockToolTurn::Observed(format!("{RESULT_TEXT} Result: {snippet}"))
}

fn reply_text(turn: &MockToolTurn) -> Option<&str> {
    match turn {
        MockToolTurn::Text(text) => Some(text),
        MockToolTurn::Observed(text) => Some(text),
        MockToolTurn::Call { .. } => None,
    }
}

fn split_middle(text: &str) -> (&str, &str) {
    let cut = text
        .char_indices()
        .map(|(offset, _)| offset)
        .nth(text.chars().count() / 2)
        .unwrap_or(0);
    text.split_at(cut)
}

pub fn selected(endpoint: &str, provider_model_id: &str) -> bool {
    endpoint == MOCK_TOOL_ENDPOINT || provider_model_id == MOCK_TOOL_MODEL
}

fn message_text(parts: &[ContentPart]) -> String {
    parts
        .iter()
        .map(|ContentPart::Text { text }| text.as_str())
        .collect::<Vec<_>>()
        .join("")
}

fn disposable_path(candidate: &str) -> Option<&str> {
    let basename = candidate.rsplit('/').next()?;
    let acceptable = candidate.starts_with('/')
        && candidate.len() <= MAX_MOCK_PATH_BYTES
        && !candidate.chars().any(char::is_control)
        && !candidate.split('/').any(|segment| segment == "..")
        && basename.starts_with(MOCK_WRITE_BASENAME_PREFIX)
        && basename.len() > MOCK_WRITE_BASENAME_PREFIX.len();
    acceptable.then_some(candidate)
}

fn requested_path(request: &InferenceRequest) -> Option<String> {
    let user = request
        .messages
        .iter()
        .rev()
        .find(|message| message.role == MessageRole::User)?;
    let text = message_text(&user.content);
    let start = text.find(MOCK_WRITE_MARKER)? + MOCK_WRITE_MARKER.len();
    let token = text[start..]
        .split(|ch: char| ch.is_whitespace() || matches!(ch, '"' | '\'' | '`'))
        .next()?;
    disposable_path(token).map(str::to_owned)
}

/// The real descriptor the model was offered: a function named `Write` with a
/// path and a content property.
/// The exact offered tool named after [`MOCK_CALL_MARKER`], if it declares a string `note`.
fn requested_call(request: &InferenceRequest) -> Option<String> {
    let user = request
        .messages
        .iter()
        .rev()
        .find(|message| message.role == MessageRole::User)?;
    let text = message_text(&user.content);
    let start = text.find(MOCK_CALL_MARKER)? + MOCK_CALL_MARKER.len();
    let wanted = text[start..]
        .split(|ch: char| ch.is_whitespace() || matches!(ch, '"' | '\'' | '`'))
        .next()
        .filter(|name| !name.is_empty() && name.len() <= MAX_MOCK_TOOL_NAME_BYTES)?;
    request.tools.iter().find_map(|tool| {
        let function = tool.get("function")?;
        let name = function.get("name")?.as_str()?;
        let note = function.get("parameters")?.get("properties")?.get("note")?;
        (name == wanted && note.get("type")?.as_str()? == "string").then(|| name.to_owned())
    })
}

fn write_descriptor(tools: &[Value]) -> Option<(String, &'static str, &'static str)> {
    tools.iter().find_map(|tool| {
        let function = tool.get("function")?;
        let name = function.get("name")?.as_str()?;
        if !name.eq_ignore_ascii_case("write") {
            return None;
        }
        let properties = function.get("parameters")?.get("properties")?.as_object()?;
        let path_key = PATH_KEYS
            .into_iter()
            .find(|key| properties.contains_key(*key))?;
        let content_key = CONTENT_KEYS
            .into_iter()
            .find(|key| properties.contains_key(*key))?;
        Some((name.to_owned(), path_key, content_key))
    })
}

pub fn plan_turn(request: &InferenceRequest) -> MockToolTurn {
    let results = request
        .messages
        .iter()
        .filter(|message| message.role == MessageRole::Tool)
        .count();
    if results >= MAX_MOCK_TOOL_ROUNDS
        || request
            .messages
            .last()
            .is_some_and(|message| message.role == MessageRole::Tool)
    {
        return observed_reply(request);
    }
    if let Some(name) = requested_call(request) {
        let issued = request
            .messages
            .iter()
            .map(|message| message.tool_calls.len())
            .sum::<usize>();
        return MockToolTurn::Call {
            id: format!("call_mock_{}", issued + 1),
            name,
            arguments: json!({ "note": MOCK_CALL_NOTE }).to_string(),
        };
    }
    // Distinct fixed texts so a harness can tell why no call was made without
    // the fixture ever echoing request content.
    let Some(path) = requested_path(request) else {
        return MockToolTurn::Text(NO_PATH_TEXT);
    };
    let Some((name, path_key, content_key)) = write_descriptor(&request.tools) else {
        return MockToolTurn::Text(NO_WRITE_TOOL_TEXT);
    };
    let issued = request
        .messages
        .iter()
        .map(|message| message.tool_calls.len())
        .sum::<usize>();
    MockToolTurn::Call {
        id: format!("call_mock_{}", issued + 1),
        name,
        arguments: json!({path_key: path, content_key: MOCK_WRITE_CONTENT}).to_string(),
    }
}

fn frame(value: &Value) -> Vec<u8> {
    format!("data: {value}\n\n").into_bytes()
}

fn delta_frame(delta: Value, finish_reason: Option<&str>) -> Vec<u8> {
    frame(&json!({
        "id": PROVIDER_ID,
        "model": MOCK_TOOL_MODEL,
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
    }))
}

fn usage_frame() -> Vec<u8> {
    let mut bytes = frame(&json!({
        "id": PROVIDER_ID,
        "model": MOCK_TOOL_MODEL,
        "choices": [],
        "usage": {"prompt_tokens": 4, "completion_tokens": 3},
    }));
    bytes.extend_from_slice(b"data: [DONE]\n\n");
    bytes
}

fn tool_fragment(index: u32, id: Option<&str>, name: Option<&str>, arguments: &str) -> Value {
    let mut function = json!({"arguments": arguments});
    if let Some(name) = name {
        function["name"] = json!(name);
    }
    let mut call = json!({"index": index, "function": function});
    if let Some(id) = id {
        call["id"] = json!(id);
        call["type"] = json!("function");
    }
    call
}

/// Fragmented SSE: metadata, id+name, argument halves, finish, usage, done.
pub fn stream_chunks(turn: &MockToolTurn) -> Vec<Vec<u8>> {
    let metadata = frame(&json!({"id": PROVIDER_ID, "model": MOCK_TOOL_MODEL, "choices": []}));
    match turn {
        MockToolTurn::Call {
            id,
            name,
            arguments,
        } => {
            let split = arguments
                .char_indices()
                .map(|(offset, _)| offset)
                .nth(arguments.chars().count() / 2)
                .unwrap_or(0);
            let (head, tail) = arguments.split_at(split);
            vec![
                metadata,
                delta_frame(
                    json!({"role": "assistant", "content": null,
                           "tool_calls": [tool_fragment(0, Some(id), Some(name), "")]}),
                    None,
                ),
                delta_frame(
                    json!({"tool_calls": [tool_fragment(0, None, None, head)]}),
                    None,
                ),
                delta_frame(
                    json!({"tool_calls": [tool_fragment(0, None, None, tail)]}),
                    None,
                ),
                delta_frame(json!({}), Some("tool_calls")),
                usage_frame(),
            ]
        }
        MockToolTurn::Text(_) | MockToolTurn::Observed(_) => {
            let (head, tail) = split_middle(reply_text(turn).unwrap_or_default());
            vec![
                metadata,
                delta_frame(json!({"role": "assistant", "content": head}), None),
                delta_frame(json!({"content": tail}), None),
                delta_frame(json!({}), Some("stop")),
                usage_frame(),
            ]
        }
    }
}

pub fn json_body(turn: &MockToolTurn) -> Vec<u8> {
    let (message, finish_reason) = match turn {
        MockToolTurn::Call {
            id,
            name,
            arguments,
        } => (
            json!({"role": "assistant", "content": null, "tool_calls": [
                {"id": id, "type": "function", "function": {"name": name, "arguments": arguments}}
            ]}),
            "tool_calls",
        ),
        MockToolTurn::Text(_) | MockToolTurn::Observed(_) => (
            json!({"role": "assistant", "content": reply_text(turn)}),
            "stop",
        ),
    };
    json!({
        "id": PROVIDER_ID,
        "model": MOCK_TOOL_MODEL,
        "choices": [{"message": message, "finish_reason": finish_reason}],
        "usage": {"prompt_tokens": 4, "completion_tokens": 3},
    })
    .to_string()
    .into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::catalog::ModelCapability;
    use crate::modules::inference::{
        AdapterStreamState, InferenceMessage, ProviderStreamEvent, SseDecoder, ToolCall,
        ToolCallTracker,
    };

    const PATH: &str = "/tmp/run/lumi-e2e-fixture-1.txt";

    fn write_tool() -> Value {
        json!({"type": "function", "function": {"name": "Write", "description": "w",
            "parameters": {"type": "object", "properties": {
                "file_path": {"type": "string"}, "content": {"type": "string"}}}}})
    }

    fn request(messages: Vec<InferenceMessage>, tools: Vec<Value>) -> InferenceRequest {
        InferenceRequest {
            model: "coding-default".to_owned(),
            messages,
            required_capabilities: vec![ModelCapability::Text],
            stream: true,
            max_output_tokens: None,
            temperature: None,
            tools,
            retry_safe: false,
            project_id: None,
            session_id: None,
            run_id: None,
        }
    }

    fn prompt() -> InferenceMessage {
        InferenceMessage::user(format!("please write {MOCK_WRITE_MARKER}{PATH} now"))
    }

    fn assistant_call(id: &str) -> InferenceMessage {
        InferenceMessage {
            role: MessageRole::Assistant,
            content: Vec::new(),
            tool_calls: vec![ToolCall {
                id: id.to_owned(),
                name: "Write".to_owned(),
                arguments: "{}".to_owned(),
            }],
            tool_call_id: None,
        }
    }

    fn tool_result(id: &str) -> InferenceMessage {
        InferenceMessage {
            role: MessageRole::Tool,
            content: vec![ContentPart::Text {
                text: "ok".to_owned(),
            }],
            tool_calls: Vec::new(),
            tool_call_id: Some(id.to_owned()),
        }
    }

    fn note_tool(name: &str) -> Value {
        json!({"type": "function", "function": {"name": name, "description": "n",
            "parameters": {"type": "object", "properties": {"note": {"type": "string"}}}}})
    }

    #[test]
    fn calls_the_exact_named_tool_with_the_fixed_note() {
        let prompt = InferenceMessage::user(format!("run {MOCK_CALL_MARKER}mcp__e2e__echo now"));
        let MockToolTurn::Call {
            name, arguments, ..
        } = plan_turn(&request(
            vec![prompt],
            vec![write_tool(), note_tool("mcp__e2e__echo")],
        ))
        else {
            panic!("expected a tool call");
        };
        assert_eq!(name, "mcp__e2e__echo");
        let arguments: Value = serde_json::from_str(&arguments).unwrap();
        assert_eq!(arguments, json!({ "note": MOCK_CALL_NOTE }));
    }

    #[test]
    fn a_named_tool_that_is_not_offered_or_lacks_a_note_is_never_called() {
        for tools in [
            vec![write_tool()],
            vec![write_tool(), {
                let mut tool = note_tool("mcp__e2e__echo");
                tool["function"]["parameters"]["properties"] = json!({"other": {"type": "string"}});
                tool
            }],
        ] {
            let prompt = InferenceMessage::user(format!("run {MOCK_CALL_MARKER}mcp__e2e__echo"));
            assert!(!matches!(
                plan_turn(&request(vec![prompt], tools)),
                MockToolTurn::Call { .. }
            ));
        }
    }

    #[test]
    fn emits_one_write_call_built_from_the_offered_descriptor() {
        let MockToolTurn::Call {
            id,
            name,
            arguments,
        } = plan_turn(&request(vec![prompt()], vec![write_tool()]))
        else {
            panic!("expected a tool call");
        };
        assert_eq!((id.as_str(), name.as_str()), ("call_mock_1", "Write"));
        let arguments: Value = serde_json::from_str(&arguments).unwrap();
        assert_eq!(arguments["file_path"], PATH);
        assert_eq!(arguments["content"], MOCK_WRITE_CONTENT);
        // The key names follow the descriptor, not a hard-coded shape.
        let renamed = json!({"type": "function", "function": {"name": "write",
            "parameters": {"type": "object", "properties": {
                "path": {"type": "string"}, "text": {"type": "string"}}}}});
        let MockToolTurn::Call { arguments, .. } =
            plan_turn(&request(vec![prompt()], vec![renamed]))
        else {
            panic!("expected a tool call");
        };
        assert!(arguments.contains("\"path\"") && arguments.contains("\"text\""));
    }

    #[test]
    fn answers_with_text_after_the_tool_result_and_after_the_round_bound() {
        let answered = vec![
            prompt(),
            assistant_call("call_mock_1"),
            tool_result("call_mock_1"),
        ];
        assert_eq!(
            plan_turn(&request(answered, vec![write_tool()])),
            MockToolTurn::Observed(format!("{RESULT_TEXT} Result: ok"))
        );
        let mut many = vec![prompt()];
        for round in 0..MAX_MOCK_TOOL_ROUNDS {
            many.push(assistant_call(&format!("c{round}")));
            many.push(tool_result(&format!("c{round}")));
        }
        many.push(prompt());
        assert_eq!(
            plan_turn(&request(many, vec![write_tool()])),
            MockToolTurn::Observed(format!("{RESULT_TEXT} Result: ")),
            "the round bound never echoes a user message"
        );
        // The snippet is bounded, control-free and char-boundary safe.
        let long = InferenceMessage {
            role: MessageRole::Tool,
            content: vec![ContentPart::Text {
                text: format!("é\n{}", "ß".repeat(500)),
            }],
            tool_calls: Vec::new(),
            tool_call_id: Some("c".to_owned()),
        };
        let MockToolTurn::Observed(text) = plan_turn(&request(
            vec![prompt(), assistant_call("c"), long],
            vec![write_tool()],
        )) else {
            panic!("expected an observed reply");
        };
        assert!(text.len() <= RESULT_TEXT.len() + " Result: ".len() + MAX_OBSERVED_BYTES);
        assert!(!text.contains('\n'));
        // Splitting a multi-byte reply for streaming must not panic.
        assert_eq!(stream_chunks(&MockToolTurn::Observed(text)).len(), 5);
    }

    #[test]
    fn refuses_anything_but_a_disposable_absolute_path_and_a_real_write_tool() {
        let with_path =
            |path: &str| InferenceMessage::user(format!("go {MOCK_WRITE_MARKER}{path}"));
        for bad in [
            "relative/lumi-e2e-fixture-1.txt",
            "/tmp/run/important.txt",
            "/tmp/run/lumi-e2e-fixture-",
            "/tmp/../etc/lumi-e2e-fixture-1",
            "/tmp/run/lumi-e2e-fixture-1/",
        ] {
            assert_eq!(
                plan_turn(&request(vec![with_path(bad)], vec![write_tool()])),
                MockToolTurn::Text(NO_PATH_TEXT),
                "{bad}"
            );
        }
        let no_marker = InferenceMessage::user("write something");
        assert_eq!(
            plan_turn(&request(vec![no_marker], vec![write_tool()])),
            MockToolTurn::Text(NO_PATH_TEXT)
        );
        let other_tool = json!({"type": "function", "function": {"name": "Bash",
            "parameters": {"type": "object", "properties": {"command": {"type": "string"}}}}});
        let no_content = json!({"type": "function", "function": {"name": "Write",
            "parameters": {"type": "object", "properties": {"file_path": {"type": "string"}}}}});
        for tools in [Vec::new(), vec![other_tool], vec![no_content]] {
            assert_eq!(
                plan_turn(&request(vec![prompt()], tools)),
                MockToolTurn::Text(NO_WRITE_TOOL_TEXT)
            );
        }
    }

    #[test]
    fn fragmented_stream_decodes_into_one_valid_call_and_text_stays_text() {
        let turn = plan_turn(&request(vec![prompt()], vec![write_tool()]));
        let mut decoder = SseDecoder::new();
        let mut state = AdapterStreamState::default();
        let mut tracker = ToolCallTracker::default();
        let mut fragments = 0;
        for chunk in stream_chunks(&turn) {
            for event in decoder.push(&chunk, &mut state) {
                match event {
                    ProviderStreamEvent::ToolCallDelta {
                        index,
                        call_id,
                        name,
                        arguments_delta,
                    } => {
                        fragments += 1;
                        tracker
                            .accept(index, call_id.as_deref(), name.as_deref(), &arguments_delta)
                            .unwrap();
                    }
                    ProviderStreamEvent::InvalidResponse => panic!("fixture stream rejected"),
                    _ => {}
                }
            }
        }
        assert!(state.may_complete());
        assert!(
            fragments >= 3,
            "id/name and both argument halves are separate fragments"
        );
        let calls = tracker.finish().unwrap();
        let MockToolTurn::Call {
            id,
            name,
            arguments,
        } = turn
        else {
            panic!("expected a call");
        };
        assert_eq!(
            calls,
            vec![ToolCall {
                id,
                name,
                arguments
            }]
        );

        let mut decoder = SseDecoder::new();
        let mut state = AdapterStreamState::default();
        let text: String = stream_chunks(&MockToolTurn::Text(RESULT_TEXT))
            .iter()
            .flat_map(|chunk| decoder.push(chunk, &mut state))
            .filter_map(|event| match event {
                ProviderStreamEvent::TextDelta { text } => Some(text),
                ProviderStreamEvent::ToolCallDelta { .. } => panic!("text turn emitted a call"),
                _ => None,
            })
            .collect();
        assert_eq!(text, RESULT_TEXT);
        assert!(state.may_complete());
    }

    #[test]
    fn buffered_body_carries_the_same_call_with_null_content() {
        let turn = plan_turn(&request(vec![prompt()], vec![write_tool()]));
        let body: Value = serde_json::from_slice(&json_body(&turn)).unwrap();
        assert_eq!(body["choices"][0]["message"]["content"], Value::Null);
        assert_eq!(body["choices"][0]["finish_reason"], "tool_calls");
        let calls = body["choices"][0]["message"]["tool_calls"]
            .as_array()
            .unwrap();
        assert!(crate::modules::inference::decode_message_tool_calls(calls).is_ok());
    }

    #[test]
    fn fixture_is_unreachable_outside_development() {
        use crate::adapters::providers::{SsrfError, validate_endpoint_url};
        assert_eq!(validate_endpoint_url(MOCK_TOOL_ENDPOINT, &[], true), Ok(()));
        assert_eq!(
            validate_endpoint_url(MOCK_TOOL_ENDPOINT, &[], false),
            Err(SsrfError::SchemeNotAllowed)
        );
        assert_eq!(
            validate_endpoint_url("mock://lumi-tool/extra", &[], true),
            Err(SsrfError::SchemeNotAllowed)
        );
        assert!(selected(MOCK_TOOL_ENDPOINT, "x") && selected("x", MOCK_TOOL_MODEL));
    }
}
