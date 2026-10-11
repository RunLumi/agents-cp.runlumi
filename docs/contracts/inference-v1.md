# Lumi managed inference v1

P04-INT-01 consumes the P04-CG `p04-cg-v1` contract.

## Authentication and scope

Desktop managed mode uses the P02 login session (cookie or bearer session) and sends exactly one `X-Org-ID` header. A project/device policy snapshot may be attached by the trusted P03 client policy layer; the API accepts that typed snapshot as an optional server extension, validates its organization and project scope, and still resolves the current principal and active membership. Client-supplied organization, role, provider, credential, or route IDs are not authorization evidence.

## Native request

`POST /api/v1/inference/responses`

```json
{
  "model": "coding-default",
  "messages": [{"role":"user","content":[{"type":"text","text":"Hello"}]}],
  "required_capabilities": ["text"],
  "stream": true,
  "max_output_tokens": 256,
  "temperature": 0.2,
  "tools": [],
  "project_id": null,
  "session_id": null,
  "run_id": null
}
```

The server owns `request_id`, route version, provider/model selection, and credential resolution. The client must not send a provider credential or provider endpoint. P04 reserves a bounded input/output-token estimate before dispatch; the reservation is committed or released in the same finalization path, while P05/P06 may replace the internal unit with priced minor units. An unconfigured policy is represented by `null` allowlists (unrestricted only by the server's default policy); an explicit empty array is a deny-all allowlist.

### Managed-mode opt-in

Managed mode is an explicit client capability choice (`managedInference: "lumi"` in the host model-selection view), not an automatic replacement for a configured ZCode provider. The host may select it only when the P03 policy snapshot reports `managed_route_enabled: true` and the current P02 session has an active organization. The request builder supplies the P02 session and one trusted `X-Org-ID`; it copies the stable alias from the catalog and adds no provider, model, route, or credential fields. If the policy disallows managed mode, the existing local/BYOK adapter remains eligible and is never silently replaced.

## Streaming

A successful streaming response is `text/event-stream`. Events are typed and carry the same request ID:

- `response.started`
- `response.output_text.delta`
- `response.tool_call.delta`
- `response.completed`
- `error`

`response.tool_call.delta` (P04-CR-002, additive) carries `index`, nullable `call_id`, nullable `name` and `arguments_delta`. `call_id` and `name` are present only on the fragments where the provider sent them; the gateway never substitutes an ID. `response.completed` carries `finish_reason` (`tool_calls` when any call was streamed, otherwise `stop`). Calls are bounded: index below 128, ID 1-128 bytes of `[A-Za-z0-9_.:-]`, unique per response, name 1-128 bytes, at most 256 KiB of arguments per call and 512 KiB per response. A call that never receives an ID and a name, or any out-of-bounds fragment, ends the stream with `error` (`upstream_invalid_response`). A tool-call fragment is meaningful output: no fallback or retry follows it.

Clients should preserve backpressure, stop reading when cancelled, and treat the first received event as response commitment. A disconnect does not authorize a new model request; a new call receives a new request ID.

## OpenAI compatibility

`POST /api/v1/inference/chat/completions` supports the documented P04 subset of `model`, `messages`, `stream`, `temperature`, `max_tokens`/`max_completion_tokens`, and `tools`. Unsupported fields fail validation. The `model` value is a Lumi alias, not a vendor model ID.

Tool turns (P04-CR-002) use the OpenAI shape, strictly validated with unknown fields refused:

- An assistant message may carry `tool_calls: [{"id", "type": "function", "function": {"name", "arguments"}}]` and then may have `null` or absent `content`. Without calls, `content` stays required. `type` must be exactly `function`; call IDs are 1-128 bytes of `[A-Za-z0-9_.:-]` and unique in the request; at most 128 calls per request; `arguments` is a JSON object string of at most 256 KiB. Calls count toward the aggregate 512 KiB request content limit and the token estimate.
- A `tool` message requires `tool_call_id` naming one earlier, still-unanswered call and non-null `content`. No other role may carry `tool_calls` or `tool_call_id`.
- Streaming chunks carry `delta.tool_calls[]` with `index`, `id`/`type` and `function.name` only on the fragments where the provider sent them, and `function.arguments` fragments. The terminal chunk has `finish_reason: "tool_calls"` when calls were produced (plain text keeps `stop`). With `stream_options.include_usage` a final independent chunk with empty `choices` carries `usage`. Non-streaming responses return `message.tool_calls`, `content: null` when there is no text, and `finish_reason: "tool_calls"`.
- The gateway only transports calls. It never executes them or resolves approvals; P05 device/scope checks, the reviewed catalog, policy, grants and the once-only execution claim remain the authority. Tool arguments and results are request content under the existing privacy rules and are never written to audit metadata or logs.
- The Anthropic adapter does not translate tool turns and refuses them (`unsupported_capability`) instead of dropping them.

## Compatibility and fallback

Clients never need a release when an administrator publishes or rolls back a route version. The server selects an eligible candidate at request time. It may fall back only before response commitment; after a meaningful event, a provider error is surfaced as a terminal error and is never retried on another model.

## Local/BYOK coexistence

A desktop may continue to use local-only provider credentials or a direct provider endpoint when local policy permits. That path is separate from managed inference and must not silently override an organization policy. The P08 migration maps existing identities; it does not upload local secrets.
