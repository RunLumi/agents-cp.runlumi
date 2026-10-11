#!/usr/bin/env node
// Disposable harness: what a jobs-queue producer must hand `Queue.send` so the
// consumer can read the envelope.
//
// The Rust `worker` crate's `Queue::send<T: Serialize>` runs
// `serde_wasm_bindgen::to_value(&message)` with the default serializer, which turns a
// serde map -- including `serde_json::Value::Object` -- into a JS `Map`. A queue with
// `contentType: 'json'` JSON-serializes the body, and `JSON.stringify(new Map(...))` is
// `{}`. The consumer then sees a body with no `job_type`.
//
// This probe reproduces that platform behaviour in isolation on the SAME local queue
// stack the real runs use (`wrangler dev --local`), with two producers:
//
//   fault    new Map(...)           what the old producer put on the wire
//   control  JSON.parse(jsonText)   what `js_sys::JSON::parse` hands the new producer
//
// It is a sensitivity proof for the HARNESS, not for the Rust code: it shows the
// control is readable and the fault is detected, for the same envelope. The Rust send
// path is proven separately by a real Worker send -> queue consumer replay.
//
// Exit 0: control readable AND fault reproduced. 1: control unreadable. 2: fault did not
// reproduce (the harness could not have detected the old behaviour; UNPROVEN).

import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const wranglerCli = path.join(
  realpathSync(path.resolve(here, '../node_modules/wrangler/package.json')),
  '..',
  'wrangler-dist',
  'cli.js',
);

// Both envelope families the producer sends, with the fields the consumers decode.
const ENVELOPES = {
  automation: {
    job_id: 'job_66666666666666666666666666666666',
    job_type: 'automation.dispatch',
    schema_version: 1,
    dedupe_key: 'automation.dispatch:occ_55555555555555555555555555555555:0',
    event_id: null,
    occurred_at: '2026-10-08T15:20:00.000Z',
    attempt: 1,
    correlation_id: null,
    tenant_scope: { org_id: 'org_22222222222222222222222222222222' },
    payload_ref: 'd1:automation_occurrences/occ_55555555555555555555555555555555',
    payload: null,
  },
  data: {
    job_id: 'job_77777777777777777777777777777777',
    job_type: 'export.run',
    schema_version: 1,
    dedupe_key: 'export.run:exp_33333333333333333333333333333333',
    event_id: null,
    request_id: 'req_x',
    correlation_id: 'req_x',
    attempt: 1,
    tenant_scope: { org_id: 'org_22222222222222222222222222222222' },
    payload_ref: 'd1:export_jobs/exp_3333',
    payload: { export_id: 'exp_33333333333333333333333333333333', deletion_id: null },
  },
};

const WORKER = `
const seen = [];
// A serde map becomes a JS Map at every depth; mirror that for the fault producer.
const deepMap = (value) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? new Map(Object.entries(value).map(([k, v]) => [k, deepMap(v)]))
    : value;
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/seen') return Response.json(seen);
    const text = await request.text();
    const mode = url.searchParams.get('mode');
    const tag = url.searchParams.get('tag');
    seen.push({ tag, mode, body: null });
    if (mode === 'fault') {
      await env.Q.send(deepMap(JSON.parse(text)), { contentType: 'json' });
    } else {
      await env.Q.send(JSON.parse(text), { contentType: 'json' });
    }
    return new Response('ok');
  },
  async queue(batch) {
    for (const message of batch.messages) {
      // One message in flight at a time (the driver waits), so the first
      // undelivered entry is the one this body belongs to.
      const entry = seen.find((item) => item.body === null);
      if (entry) entry.body = message.body ?? {};
      message.ack();
    }
  },
};
`;

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });

const dir = mkdtempSync(path.join(os.tmpdir(), 'lumi-queue-probe-'));
writeFileSync(path.join(dir, 'worker.mjs'), WORKER);
writeFileSync(
  path.join(dir, 'wrangler.jsonc'),
  JSON.stringify({
    name: 'queue-probe',
    main: 'worker.mjs',
    compatibility_date: '2026-09-01',
    queues: {
      producers: [{ binding: 'Q', queue: 'probe' }],
      consumers: [{ queue: 'probe', max_batch_size: 1, max_batch_timeout: 1 }],
    },
  }),
);

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const dev = spawn(
  process.execPath,
  [
    wranglerCli,
    'dev',
    '--local',
    '--port',
    String(port),
    '--persist-to',
    path.join(dir, 'state'),
    '--log-level',
    'warn',
  ],
  { cwd: dir, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: 'ignore' },
);

const stop = async () => {
  dev.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 500));
  rmSync(dir, { recursive: true, force: true });
};

async function waitReady(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`${base}/seen`);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error('wrangler dev did not become ready');
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

async function send(mode, tag, envelope) {
  const response = await fetch(`${base}/send?mode=${mode}&tag=${tag}`, {
    method: 'POST',
    body: JSON.stringify(envelope),
  });
  if (!response.ok) throw new Error(`send ${mode}/${tag} failed: ${response.status}`);
}

async function settled(count, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const seen = await (await fetch(`${base}/seen`)).json();
    if (seen.length >= count && seen.every((item) => item.body !== null)) return seen;
    if (Date.now() > deadline) return seen;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const readable = (expected, body) =>
  body !== null &&
  body !== undefined &&
  body.job_type === expected.job_type &&
  Object.keys(body).sort().join() === Object.keys(expected).sort().join() &&
  body.tenant_scope?.org_id === expected.tenant_scope.org_id;

let exitCode = 0;
try {
  await waitReady();
  let sent = 0;
  for (const mode of ['control', 'fault']) {
    for (const [tag, envelope] of Object.entries(ENVELOPES)) {
      await send(mode, `${mode}-${tag}`, envelope);
      sent += 1;
      await settled(sent);
    }
  }
  const seen = await settled(sent);
  const byTag = Object.fromEntries(seen.map((item) => [item.tag, item.body]));

  for (const [tag, envelope] of Object.entries(ENVELOPES)) {
    const control = byTag[`control-${tag}`];
    const fault = byTag[`fault-${tag}`];
    const controlOk = readable(envelope, control);
    // The fault is "reproduced" when the old producer's body is NOT a readable
    // envelope: that is what proves this harness could have caught it.
    const faultReproduced = !readable(envelope, fault) && (fault?.job_type ?? null) === null;
    console.log(
      `${controlOk ? 'PASS' : 'FAIL'}  control(${tag}): plain object readable by the consumer ` +
        `(job_type=${control?.job_type ?? null})`,
    );
    console.log(
      `${faultReproduced ? 'PASS' : 'UNPROVEN'}  fault(${tag}): Map body loses the envelope ` +
        `(keys=${JSON.stringify(Object.keys(fault ?? {}))})`,
    );
    if (!controlOk) exitCode = Math.max(exitCode, 1);
    if (!faultReproduced) exitCode = Math.max(exitCode, 2);
  }
} catch (error) {
  console.log(`FAIL  harness error: ${error.message}`);
  exitCode = Math.max(exitCode, 1);
} finally {
  await stop();
}
console.log(exitCode === 0 ? 'VERDICT PASS' : `VERDICT NOT-PASS exit=${exitCode}`);
process.exit(exitCode);
