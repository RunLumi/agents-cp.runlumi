#!/usr/bin/env node
// Cancel/timeout topology probe (STAND-IN workerd, not the production adapter).
//
// Question: with Miniflare's `outboundService: { node: handler }`, does a Worker-side timeout or a
// caller disconnect close the provider-facing socket, observably? The same cases also run through the
// function form `(Request) => Response` as a comparison (known not to deliver aborts).
//
// Everything is owned and loopback: an owned node:http fixture, a Miniflare instance serving a tiny
// stand-in Worker, no production Worker/artifact, no external network, no secrets.
//
//   node scripts/provider-http-cancel-topology-probe.mjs [--topology=node|function|both] [--json]
//
// Exit 0: every node-topology critical claim PASS. 1: a control or claim FAILED. 2: UNPROVEN/BLOCKED.
// A pass here proves the PLATFORM topology only; it says nothing about the Rust adapter.

import { createRequire } from "node:module";
import { createOutboundForwarder } from "./lib/provider-http-forwarder.mjs";
import { startProviderFixture } from "./lib/provider-http-fixture.mjs";
import { createNodeOutbound } from "./lib/provider-http-node-outbound.mjs";

const HOST = "provider-http-fixture.example";
const BOUND_MS = 5_000;
const args = process.argv.slice(2);
const topologyArg = args.find((a) => a.startsWith("--topology="))?.split("=")[1] ?? "both";
const asJson = args.includes("--json");

const WORKER = `export default { async fetch(request) {
  const u = new URL(request.url);
  const host = u.searchParams.get("host") ?? "${HOST}";
  const target = "https://" + host + "/v1/" + u.searchParams.get("scenario") + "/v1/chat/completions";
  const init = { method: "POST", redirect: "manual", body: JSON.stringify({ model: "m", stream: true, messages: [] }) };
  const t = Number(u.searchParams.get("timeout") ?? "0");
  if (t) init.signal = AbortSignal.timeout(t);
  try {
    const r = await fetch(target, init);
    // Keep the upstream content-type: without it Miniflare's entry buffered the whole body before the
    // caller's first read (measured), which would hide mid-stream cancel behind a stand-in artifact.
    if (u.pathname === "/pipe") return new Response(r.body, { status: r.status, headers: { "content-type": r.headers.get("content-type") ?? "text/event-stream" } });
    if (u.searchParams.get("read") === "1") { await r.text(); }
    return Response.json({ status: r.status });
  } catch (e) { return Response.json({ err: String(e && e.name), msg: String(e && e.message).slice(0, 80) }); }
} };`;

function resolveMiniflare() {
  const req = createRequire(import.meta.url);
  const wranglerPkg = req.resolve("wrangler/package.json");
  return createRequire(wranglerPkg)("miniflare");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settled = (r) => r.outcome !== "pending";

async function runTopology(name, { Miniflare, convertV4MiniflareOptions }) {
  const fixture = await startProviderFixture();
  const outbound =
    name === "node"
      ? createNodeOutbound({ permittedHost: HOST, targetOrigin: fixture.origin })
      : createOutboundForwarder({ permittedHost: HOST, targetOrigin: fixture.origin });
  // Miniflare 5 validates the constructor against its new schema; the documented README options
  // (`outboundService: { node }`) are the V4 shape and need `convertV4MiniflareOptions` first.
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: WORKER,
      compatibilityDate: "2026-09-24",
      host: "127.0.0.1",
      port: 0,
      outboundService: name === "node" ? { node: outbound } : outbound,
    }),
  );
  const results = [];
  try {
    const base = new URL(await mf.ready);
    const ledgerFor = (before) => fixture.records().slice(before);
    const waitSettled = async (before, ms = BOUND_MS) => {
      try {
        await fixture.waitFor((rs) => rs.length > before && settled(rs[before]), {
          timeoutMs: ms,
          label: "settle",
        });
      } catch {}
      return ledgerFor(before)[0] ?? null;
    };
    const rec = (id, critical, verdict, detail) =>
      results.push({ topology: name, id, critical, verdict, detail });

    // 1. Positive control, no cancel: a full slow stream through the topology must complete.
    {
      const before = fixture.count();
      const t0 = Date.now();
      const res = await fetch(new URL("/pipe?scenario=slow-stream", base), {
        signal: AbortSignal.timeout(15_000),
      });
      const text = await res.text();
      const r = await waitSettled(before, 2_000);
      const frames = (text.match(/data: /g) ?? []).length;
      const ok =
        res.status === 200 &&
        text.includes("[DONE]") &&
        r?.outcome === "completed" &&
        r.framesWritten >= 60;
      rec("no-cancel-completes", true, ok ? "PASS" : "FAIL", {
        status: res.status,
        framesSeenByCaller: frames,
        fixtureOutcome: r?.outcome,
        fixtureFrames: r?.framesWritten,
        ms: Date.now() - t0,
      });
    }

    // 2. Positive control, plain JSON through the topology.
    {
      const before = fixture.count();
      const j = await fetch(new URL("/call?scenario=ok", base), {
        signal: AbortSignal.timeout(10_000),
      }).then((r) => r.json());
      const r = await waitSettled(before, 2_000);
      rec("json-control", true, j.status === 200 && r?.outcome === "completed" ? "PASS" : "FAIL", {
        worker: j,
        fixtureOutcome: r?.outcome,
      });
    }

    // 3. Deny control: a host that is not permitted must never reach the fixture.
    {
      const before = fixture.count();
      outbound.reset?.();
      const j = await fetch(new URL("/call?scenario=ok&host=other.example", base), {
        signal: AbortSignal.timeout(10_000),
      }).then((r) => r.json());
      const denied = outbound.denials?.() ?? [];
      const ok = j.status === 403 && fixture.count() === before && denied.length === 1;
      rec("deny-other-host", true, ok ? "PASS" : "FAIL", {
        worker: j,
        fixtureCalls: fixture.count() - before,
        denials: denied,
      });
    }

    // 4. Caller disconnect mid-stream. PASS only if the fixture saw the socket close before the end.
    {
      const before = fixture.count();
      const c = new AbortController();
      const piped = await fetch(new URL("/pipe?scenario=slow-stream", base), { signal: c.signal });
      await piped.body.getReader().read();
      const abortedAt = Date.now();
      c.abort();
      const r = await waitSettled(before, BOUND_MS);
      const closed = r?.outcome === "client-closed" && r.framesWritten < 60;
      rec(
        "caller-disconnect-closes-upstream",
        true,
        closed ? "PASS" : r && settled(r) ? "UNPROVEN" : "UNPROVEN",
        {
          fixtureOutcome: r?.outcome,
          fixtureFrames: r?.framesWritten,
          msToObserve: r && settled(r) ? r.endedAt - abortedAt : null,
          boundMs: BOUND_MS,
        },
      );
    }

    // 5. Worker timeout before response headers.
    {
      const before = fixture.count();
      const t0 = Date.now();
      const j = await fetch(new URL("/call?scenario=stall-before-headers&timeout=300", base), {
        signal: AbortSignal.timeout(10_000),
      }).then((r) => r.json());
      const r = await waitSettled(before, BOUND_MS);
      rec(
        "timeout-before-headers-closes-upstream",
        true,
        r?.outcome === "client-closed" ? "PASS" : "UNPROVEN",
        {
          worker: j,
          fixtureOutcome: r?.outcome,
          msToObserve: r && settled(r) ? r.endedAt - t0 : null,
          boundMs: BOUND_MS,
        },
      );
    }

    // 6. Worker timeout while reading a body the provider has stopped sending (headers already delivered).
    //    The Worker is blocked in `r.text()` when the 300 ms signal fires, so this is a real timeout.
    {
      const before = fixture.count();
      const t0 = Date.now();
      const j = await fetch(
        new URL("/call?scenario=stall-after-headers&timeout=300&read=1", base),
        { signal: AbortSignal.timeout(10_000) },
      ).then((r) => r.json());
      const r = await waitSettled(before, BOUND_MS);
      const msToObserve = r && settled(r) ? r.endedAt - t0 : null;
      // A close earlier than the timeout would be the unread-body path, not the abort: require >= 250 ms.
      const timedOut =
        r?.outcome === "client-closed" &&
        j.err === "TimeoutError" &&
        msToObserve !== null &&
        msToObserve >= 250;
      rec("timeout-during-body-closes-upstream", true, timedOut ? "PASS" : "UNPROVEN", {
        worker: j,
        fixtureOutcome: r?.outcome,
        msToObserve,
        boundMs: BOUND_MS,
      });
    }

    // 7. Observation, not a timeout: the Worker returns without reading the provider body.
    {
      const before = fixture.count();
      const t0 = Date.now();
      const j = await fetch(new URL("/call?scenario=stall-after-headers&timeout=300", base), {
        signal: AbortSignal.timeout(10_000),
      }).then((r) => r.json());
      const r = await waitSettled(before, BOUND_MS);
      rec(
        "unread-body-at-worker-return-closes-upstream",
        false,
        r?.outcome === "client-closed" ? "PASS" : "UNPROVEN",
        {
          worker: j,
          fixtureOutcome: r?.outcome,
          msToObserve: r && settled(r) ? r.endedAt - t0 : null,
          boundMs: BOUND_MS,
        },
      );
    }

    const ledger = { forwarded: outbound.forwarded?.() ?? [], denials: outbound.denials?.() ?? [] };
    return {
      results,
      ledger,
      fixture: {
        calls: fixture.count(),
        connections: fixture.connections(),
        openSocketsAtEnd: fixture.openSockets(),
      },
    };
  } finally {
    await mf.dispose().catch(() => {});
    await fixture.close();
  }
}

const mod = resolveMiniflare();
const topologies = topologyArg === "both" ? ["node", "function"] : [topologyArg];
const out = {};
for (const t of topologies) out[t] = await runTopology(t, mod);

if (asJson) console.log(JSON.stringify(out, null, 2));
else {
  for (const [t, v] of Object.entries(out)) {
    console.log(`\n== topology: ${t} ==`);
    for (const r of v.results)
      console.log(
        `${r.verdict.padEnd(9)} ${r.critical ? "critical" : "advisory"} ${r.id}  ${JSON.stringify(r.detail)}`,
      );
    console.log(`fixture: ${JSON.stringify(v.fixture)}`);
    console.log(`forwarded ledger: ${JSON.stringify(v.ledger.forwarded)}`);
  }
}

const nodeRes = out.node?.results ?? [];
const code = nodeRes.some((r) => r.critical && r.verdict === "FAIL")
  ? 1
  : nodeRes.some((r) => r.critical && r.verdict !== "PASS")
    ? 2
    : nodeRes.length
      ? 0
      : 2;
console.log(
  `\nCANCEL_TOPOLOGY_VERDICT ${JSON.stringify({ exit: code, scope: "platform-standin-only", node: nodeRes.map((r) => [r.id, r.verdict]) })}`,
);
process.exit(code);
