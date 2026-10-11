#!/usr/bin/env node
// Does wrangler's `unstable_startWorker` (what the adapter probe launches the built Worker with)
// accept `dev.outboundService: { node }` and deliver a Worker timeout as a provider socket close?
// Stand-in Worker, owned loopback fixture, no production artifact. Exit 0 PASS, 1 FAIL, 2 UNPROVEN.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startProviderFixture } from "./lib/provider-http-fixture.mjs";
import { createNodeOutbound } from "./lib/provider-http-node-outbound.mjs";

const HOST = "provider-http-fixture.example";
const SRC = `export default { async fetch() {
  try {
    const r = await fetch("https://${HOST}/v1/stall-before-headers/v1/chat/completions", { method: "POST", redirect: "manual", body: "{}", signal: AbortSignal.timeout(300) });
    return Response.json({ status: r.status });
  } catch (e) { return Response.json({ err: String(e && e.name) }); }
} };`;

const dir = mkdtempSync(join(tmpdir(), "lumi-cancel-wrangler-"));
const fixture = await startProviderFixture();
const outbound = createNodeOutbound({ permittedHost: HOST, targetOrigin: fixture.origin });
let code = 2;
let worker;
try {
  const { unstable_startWorker } = await import("wrangler");
  writeFileSync(join(dir, "w.mjs"), SRC);
  worker = await unstable_startWorker({
    name: "cancel-wrangler-check",
    entrypoint: join(dir, "w.mjs"),
    compatibilityDate: "2026-09-24",
    dev: {
      server: { hostname: "127.0.0.1", port: 0 },
      inspector: false,
      logLevel: "error",
      watch: false,
      persist: false,
      outboundService: { node: outbound },
    },
  });
  await worker.ready;
  const base = await worker.url;
  const j = await fetch(new URL("/", base), { signal: AbortSignal.timeout(10_000) }).then((r) =>
    r.json(),
  );
  await fixture
    .waitFor((rs) => rs.length > 0 && rs[0].outcome !== "pending", { timeoutMs: 5_000 })
    .catch(() => {});
  const r = fixture.records()[0];
  code = r?.outcome === "client-closed" && j.err === "TimeoutError" ? 0 : 2;
  console.log(
    `worker=${JSON.stringify(j)} fixtureOutcome=${r?.outcome} forwarded=${JSON.stringify(outbound.forwarded())}`,
  );
} catch (error) {
  code = 1;
  console.log(`FAIL ${String(error?.message ?? error).slice(0, 300)}`);
} finally {
  await worker?.dispose().catch(() => {});
  await fixture.close();
  rmSync(dir, { recursive: true, force: true });
}
console.log(`WRANGLER_NODE_OUTBOUND_VERDICT exit=${code} scope=platform-standin-only`);
process.exit(code);
