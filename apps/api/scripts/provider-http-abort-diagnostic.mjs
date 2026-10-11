#!/usr/bin/env node
// Diagnostic: which cancel signals does Miniflare's function `outboundService` actually deliver?
// Prints the forwarder ledger (requestAborted / responseCancelled) and the fixture's view of the
// socket for (a) a Worker-side timeout before headers and (b) a caller disconnect mid-stream.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOutboundForwarder } from "./lib/provider-http-forwarder.mjs";
import { startProviderFixture } from "./lib/provider-http-fixture.mjs";

const HOST = "provider-http-fixture.example";
const SRC = `export default { async fetch(request) {
  const u = new URL(request.url);
  const target = "https://${HOST}/v1/" + u.searchParams.get("scenario") + "/v1/chat/completions";
  const init = { method: "POST", redirect: "manual", body: JSON.stringify({ model: "m", stream: true, messages: [] }) };
  const t = Number(u.searchParams.get("timeout") ?? "0");
  if (t) init.signal = AbortSignal.timeout(t);
  try {
    const r = await fetch(target, init);
    return u.pathname === "/pipe" ? new Response(r.body, { status: r.status }) : Response.json({ status: r.status });
  } catch (e) { return Response.json({ err: String(e?.name) }); }
} };`;

const dir = mkdtempSync(join(tmpdir(), "lumi-abort-diag-"));
const fixture = await startProviderFixture();
const forwarder = createOutboundForwarder({ permittedHost: HOST, targetOrigin: fixture.origin });
const { unstable_startWorker } = await import("wrangler");
writeFileSync(join(dir, "w.mjs"), SRC);
const worker = await unstable_startWorker({
  name: "abort-diag",
  entrypoint: join(dir, "w.mjs"),
  compatibilityDate: "2026-09-24",
  dev: { server: { hostname: "127.0.0.1", port: 0 }, inspector: false, logLevel: "error", watch: false, persist: false, outboundService: forwarder },
});
try {
  await worker.ready;
  const base = await worker.url;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const show = (label) =>
    console.log(`${label}\n  forwarder=${JSON.stringify(forwarder.forwarded())}\n  fixture=${JSON.stringify(fixture.records().map((r) => ({ s: r.scenario, outcome: r.outcome, frames: r.framesWritten })))}`);

  if (!process.argv.includes("--cancel-only")) {
  const a = await fetch(new URL("/call?scenario=stall-before-headers&timeout=300", base), { signal: AbortSignal.timeout(5_000) }).then((r) => r.text(), (e) => `client:${e.name}`);
  console.log(`(a) Worker timeout before headers -> worker answered ${a}`);
  await sleep(2_000);
  show("(a) after 2s");
  }

  forwarder.reset();
  const c = new AbortController();
  const piped = await fetch(new URL("/pipe?scenario=slow-stream", base), { signal: c.signal });
  await piped.body.getReader().read();
  c.abort();
  await sleep(2_500);
  show("(b) caller disconnect mid-stream, after 2.5s");
} finally {
  await worker.dispose().catch(() => {});
  await fixture.close();
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}
