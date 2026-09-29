#!/usr/bin/env node
// ============================================================================================
// V01-046 -- does a SUBSCRIBED webhook endpoint ever receive a business event?
//
// THE CLAIM UNDER ATTACK
//
// `f17` FR-F17-003 gives a webhook endpoint "subscribed event types", and FR-F17-005 specifies
// at-least-once delivery for those subscriptions. Together they require: a committed business event
// reaches a subscribed endpoint.
//
// WHAT THE STATIC READING FOUND
//
// `fan_out_event_statement` -- "Fan one committed business event out to every enabled endpoint in
// the SAME organization that subscribes to the exact event type" -- has no caller outside its own
// declaration and the liveness list. So does the whole notification cluster beside it. The delivery
// side is fully wired and fully exercised, but only by `test_webhook` and `replay_webhook_delivery`,
// both operator-initiated against an endpoint the caller already named.
//
// A static read can be wrong, and this campaign has been wrong three times in a row about a
// "no caller" claim. So this probe attacks it at the layer the claim is actually about.
//
// THE POSITIVE CONTROL IS THE POINT
//
// The obvious shape -- create an endpoint, cause an event, assert no delivery -- is VACUOUS, because
// a probe that never creates a working endpoint would pass identically. So the first thing proven is
// that the delivery machinery works AT ALL: `test_webhook` must produce a real row in
// `webhook_deliveries`, moving `pending -> queued`, in the same batch as its queue job.
//
// Only after that control is green does the silence mean something. "The subscriber received
// nothing" then means absent, not incapable -- and that distinction is the entire difference between
// a finding and a no-op.
// ============================================================================================
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runProbe } from "./lib/smoke-harness.mjs";

const apiDir = new URL("..", import.meta.url).pathname;

const WEBHOOKS = "/api/v1/orgs/{org_id}/webhooks";

await runProbe("V01 webhook fan-out", async (probe) => {
  await probe.setup({ persistEnvVar: "V01_WEBHOOK_PERSIST_TO", portEnvVar: "V01_WEBHOOK_PORT" });

  const { request, expect, d1Rows, browserMutation } = probe;
  const nonce = probe.nonce;
  const stamp = "2026-09-29T00:00:00.000Z";

  // --- the fixture: a real org, a real user, and an endpoint URL that resolves to nothing ------
  // A plain DNS NAME on 443, which the SSRF guard accepts. Not an IP literal: `is_blocked_address`
  // refuses loopback, and the guard also folds the historical IPv4 spellings and rejects reserved
  // names, so `https://127.0.0.1:9/...` came back `webhook_url_blocked` -- correctly, and worth
  // recording, because the obvious choice for an "unreachable" URL is the one the guard exists to
  // refuse.
  //
  // The URL is never resolved or fetched. The claim is whether a delivery ROW is created, which is
  // decided before any transport work, so a host that does not exist costs nothing -- and it keeps
  // the probe off the outbound-socket question entirely (V01-026), which a reachable URL would turn
  // a real finding into a false BLOCKED.
  const alice = await probe.authenticatedUser("V01 Webhook Subscriber");
  const org = await probe.createOrganization(alice.jar, "Webhook Org", `v01-webhook-${nonce}`);
  const orgId = org.orgId;
  const unreachableUrl = `https://webhook-${nonce}.invalid/v01-hook`;

  // An event type this build definitely emits on a route the probe can drive. The name is
  // `agent_definition.created.v1` -- underscore, no dot -- and the first version of this probe wrote
  // `agent.definition.created.v1` from memory. W0 caught it: the control reads the registry and the
  // name was not in it. A GUESSED event name is a silent way to make a fan-out probe vacuous, because
  // an unregistered type is refused on the way out and the subscriber would never have been eligible
  // -- the silence would look exactly the same.
  const AGENT_EVENT = "agent_definition.created.v1";
  const subscriptions = [AGENT_EVENT, "automation.definition.created.v1"];

  // The registry check is against the SOURCE, because the registry is a list of string literals in
  // `consumers/outbox.rs` and D1 never sees it. An unregistered type would be rejected on the way
  // out, and the silence below would then be the registry's decision rather than a missing fan-out
  // -- a different finding, and one this class would misattribute.
  const OUTBOX_REGISTRY = readFileSync(join(apiDir, "src/consumers/outbox.rs"), "utf8");
  const registered = subscriptions.filter((type) => OUTBOX_REGISTRY.includes(`"${type}"`));
  expect(
    "W0 CONTROL: every event type this probe subscribes to is a STRING LITERAL in the outbox " +
      "registry, read from the source -- an unregistered type would be rejected on the way out, " +
      "and the silence below would be the registry's decision rather than a missing fan-out",
    registered.length === subscriptions.length,
    `registered=${JSON.stringify(registered)} wanted=${JSON.stringify(subscriptions)}`,
  );

  // --- create the endpoint -------------------------------------------------------------------
  const created = await request(
    alice.jar,
    "POST",
    `/api/v1/orgs/${orgId}/webhooks`,
    {
      name: "V01 Subscriber",
      description: "subscribed, and never called",
      url: unreachableUrl,
      subscribed_event_types: subscriptions,
      enabled: true,
    },
    browserMutation(alice.jar, `v01-webhook-create-${nonce}`),
  );
  // The resource is NESTED under `endpoint`. The first version read three plausible top-level keys
  // (`endpoint_id`, `webhook_id`, `id`), got `undefined` from all three, and reported a 201 as a
  // failure -- a probe that could not see a success the product had already given it, which is the
  // most expensive kind of fixture bug: it looks exactly like a defect.
  const endpointId = created.payload?.endpoint?.endpoint_id ?? created.payload?.endpoint_id ?? null;
  expect(
    "W1: an endpoint with SUBSCRIBED EVENT TYPES is created, and the stored row keeps the " +
      "subscription -- a fan-out that cannot see a subscriber proves nothing",
    created.status === 201 && typeof endpointId === "string",
    `status=${created.status} id=${endpointId ?? "-"} body=${probe.brief(created.payload, 170)}`,
  );
  const stored = endpointId
    ? (
        await d1Rows(
          `SELECT endpoint_id, subscribed_event_types_json, enabled, url FROM webhook_endpoints
              WHERE endpoint_id = '${endpointId}'`,
          "V01 reading the created endpoint",
        )
      )[0]
    : null;
  expect(
    "W1: and the SUBSCRIPTION is persisted, not merely accepted -- the fan-out's own comment says " +
      "the exact-match check lives in SQL, so the subscription has to be in the database for that " +
      "check to have anything to read",
    Boolean(stored) &&
      typeof stored.subscribed_event_types_json === "string" &&
      stored.subscribed_event_types_json.includes(AGENT_EVENT) &&
      Number(stored.enabled) === 1,
    `row=${JSON.stringify(stored)?.slice(0, 190)}`,
  );

  if (!stored) {
    return;
  }

  // ==========================================================================================
  // CONTROL 1 -- the delivery machinery works at all.
  //
  // This is what makes the rest of the class non-vacuous. `test_webhook` is the one operation that
  // names an endpoint and asks for a delivery, so it is the only way to show that a delivery row
  // CAN appear. If this control is red, the findings below are statements about a route that
  // refuses everyone, and the probe says so rather than reporting silence.
  // ==========================================================================================
  const tested = await request(
    alice.jar,
    "POST",
    `/api/v1/orgs/${orgId}/webhooks/${endpointId}/test`,
    {},
    browserMutation(alice.jar, `v01-webhook-test-${nonce}`),
  );
  const afterControl = Number(
    (
      await d1Rows(
        `SELECT COUNT(*) AS n FROM webhook_deliveries WHERE endpoint_id = '${endpointId}'`,
        "V01 counting delivery rows after the control",
      )
    )[0]?.n ?? -1,
  );
  expect(
    "W2 CONTROL: `test_webhook` DOES create a delivery row -- so the delivery path, the state " +
      "machine and the history all work, and anything the assertions below find is about the " +
      "ABSENCE OF A TRIGGER rather than a broken mechanism",
    tested.status < 400 && afterControl > 0,
    `status=${tested.status} deliveryRows=${afterControl} body=${probe.brief(tested.payload, 150)}`,
  );
  const controlStates = await d1Rows(
    `SELECT state, COUNT(*) AS n FROM webhook_deliveries
        WHERE endpoint_id = '${endpointId}' GROUP BY state`,
    "V01 the control delivery's state",
  );
  expect(
    "W2 CONTROL: and the row carries a REAL delivery state -- the code's own comment says the " +
      "state advances `pending -> queued` in the same batch as the job, so a row without a state " +
      "is not a delivery",
    controlStates.length > 0 &&
      controlStates.every((row) => typeof row.state === "string" && row.state.length > 0),
    `states=${JSON.stringify(controlStates)?.slice(0, 160)}`,
  );

  if (afterControl <= 0) {
    console.log(
      "    the delivery control is RED -- the rest of this class would be a statement about a " +
        "route that never delivers, so it is skipped rather than reported as a finding",
    );
    return;
  }

  // ==========================================================================================
  // THE ATTACK -- cause real business events, and look for any NEW delivery.
  //
  // Both counts matter. `before` is not 1 (it is however many the control created), and the
  // assertion is on the DELTA, so a probe that ran the control twice cannot pass by comparing
  // against a hard-coded 1.
  // ==========================================================================================
  const before = afterControl;
  const eventsBefore = Number(
    (
      await d1Rows(
        `SELECT COUNT(*) AS n FROM outbox_events WHERE organization_id = '${orgId}'`,
        "V01 counting this org's outbox events before",
      )
    )[0]?.n ?? -1,
  );

  // A real, ordinary business event: create an agent. Nothing about this request is unusual.
  const agent = await request(
    alice.jar,
    "POST",
    `/api/v1/orgs/${orgId}/agents`,
    // Exactly the required field. `name` is `String`, not `Option<String>`, so `{}` cannot create
    // an agent; and `#[serde(deny_unknown_fields)]` is on, so the set must be exact -- `model_route`
    // is not a field of `CreateAgentRequest` at all, which is what the first version's
    // `model_route: null` was actually complaining about. Two 422s for two different reasons, both
    // of which would have read as "the probe is attacking the wrong surface".
    { name: `v01-webhook-agent-${nonce}` },
    browserMutation(alice.jar, `v01-webhook-agent-${nonce}`),
  );
  // FLAT, with `id` at the top level -- unlike the webhook endpoint, which nests under `endpoint`.
  // Two shapes for two routes in one product, so neither can be assumed from the other, and reading
  // the webhook's shape here reported a 201 as a failure.
  const agentId = agent.payload?.id ?? agent.payload?.agent_id ?? null;
  expect(
    "W3: an ordinary business action SUCCEEDS and returns a resource -- the claim is that the event " +
      "goes nowhere, not that the request is refused, and a refusal would be a different finding",
    agent.status < 400 && typeof agentId === "string",
    `status=${agent.status} id=${agentId ?? "-"} body=${probe.brief(agent.payload, 150)}`,
  );

  const eventsAfter = Number(
    (
      await d1Rows(
        `SELECT COUNT(*) AS n FROM outbox_events WHERE organization_id = '${orgId}'`,
        "V01 counting this org's outbox events after",
      )
    )[0]?.n ?? -1,
  );
  expect(
    "W4 CONTROL: the business event WAS emitted to the outbox -- so the silence below is not an " +
      "event that was never produced, which would be a different (and much smaller) finding",
    eventsAfter > eventsBefore,
    `outboxEvents before=${eventsBefore} after=${eventsAfter}`,
  );
  const emitted = await d1Rows(
    `SELECT event_type FROM outbox_events WHERE organization_id = '${orgId}'
        ORDER BY occurred_at DESC LIMIT 5`,
    "V01 the event types this org emitted",
  );
  const sawTheType = emitted.some((row) => String(row.event_type) === AGENT_EVENT);
  console.log(
    `    outbox event types seen: ${JSON.stringify(emitted)?.slice(0, 200)}  contains-agent=${sawTheType}`,
  );

  const after = Number(
    (
      await d1Rows(
        `SELECT COUNT(*) AS n FROM webhook_deliveries WHERE endpoint_id = '${endpointId}'`,
        "V01 counting delivery rows after the business event",
      )
    )[0]?.n ?? -1,
  );
  expect(
    "W5: a SUBSCRIBED endpoint receives NO delivery for a business event it subscribed to -- the " +
      "delivery count is unchanged from the control, read from D1 because a `2xx` that ignored the " +
      "event would be indistinguishable from one that delivered it",
    after === before,
    `deliveries before=${before} after=${after} outboxEvents=${eventsBefore}->${eventsAfter}`,
  );
  // Grade the finding on the SUBSCRIBED type specifically. A delivery for an unsubscribed type
  // would mean the exact-match SQL check is broken, which is a DIFFERENT and more alarming defect
  // than a missing fan-out -- so the two must not be reported as one.
  const forSubscribed = await d1Rows(
    `SELECT d.delivery_id, d.state, d.version, e.event_type FROM webhook_deliveries d
        LEFT JOIN outbox_events e ON e.event_id = d.event_id
       WHERE d.endpoint_id = '${endpointId}'`,
    "V01 the deliveries and the events they name",
  );
  console.log(`    deliveries and their events: ${JSON.stringify(forSubscribed)?.slice(0, 300)}`);

  // ==========================================================================================
  // THE OTHER HALF -- the documented-but-absent lever.
  //
  // A subscriber is not the only way an event should reach an endpoint: `replay_webhook_delivery`
  // exists, and it re-delivers a delivery that already exists. With no delivery ever created, there
  // is nothing to replay -- so the operator's remedy for a missed event is itself unreachable. This
  // is asserted because it is the difference between "delivery is broken" and "there is no event
  // to deliver", and the two need different fixes.
  // ==========================================================================================
  const anyDelivery = forSubscribed[0];
  if (anyDelivery) {
    const replayed = await request(
      alice.jar,
      "POST",
      // NOT nested under the endpoint. The route is `/webhooks/deliveries/{delivery_id}/replay`,
      // org-scoped by the DELIVERY ROW rather than by an endpoint in the path. The first version
      // built the nested path and got `404 not_found` -- a shape a probe reads as "the route
      // refuses everyone" rather than "I addressed the wrong URL", which is how a dead route
      // gets believed dead.
      `/api/v1/orgs/${orgId}/webhooks/deliveries/${anyDelivery.delivery_id}/replay`,
      // `ReplayDeliveryRequest` is `{ version: i64 }`: a REQUIRED optimistic-concurrency field, the
      // same shape as the `version` guard that found V01-033. An empty body is `422`. The value is
      // read from the row the control created, because guessing it would be a THIRD distinct 422
      // inside this one class -- and three different 422s for three different reasons is exactly what
      // a probe that has not read its own routes looks like.
      { version: Number(anyDelivery.version ?? 1) },
      browserMutation(alice.jar, `v01-webhook-replay-${nonce}`),
    );
    console.log(
      `    replay of the CONTROL delivery -> ${replayed.status} ${probe.brief(replayed.payload, 130)}`,
    );
    expect(
      "W6: replaying the control's delivery WORKS, so the operator's remedy for a missed event is " +
        "reachable -- which is what makes the absence below 'no event is ever fanned out' rather " +
        "than 'the recovery path is broken'",
      replayed.status < 400,
      `status=${replayed.status} body=${probe.brief(replayed.payload, 150)}`,
    );
  }
});

console.log("");
console.log("  Note: the DELTA is asserted, never an absolute count, so running the control twice");
console.log(
  "  cannot turn a broken fan-out into a pass. And W5 is a CONFIRMED absence -- W2 and W4",
);
console.log("  establish that deliveries and events both exist when they are supposed to.");
