// A transparent loopback proxy between the actual desktop and the development Worker for a wire
// and at-rest secret sweep. It forwards every request unchanged (streams included) and keeps, IN
// MEMORY ONLY, the secrets the Worker hands out (session/CSRF cookies, device and lease tokens),
// plus each request's method and route shape. Request bodies are inspected for forbidden local
// content (workspace path, local file content) and then discarded; nothing secret is written.
import { createServer, request as httpRequest } from "node:http";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { routeShape } from "./claim-recording-proxy.mjs";

const SECRET_FIELDS = new Set(["token", "device_token", "lease_token", "refresh_token"]);

function collectJsonSecrets(value, out) {
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_FIELDS.has(key) && typeof item === "string" && item.length >= 16) out.add(item);
    else collectJsonSecrets(item, out);
  }
}

export async function startSecretSweepProxy({ target, forbiddenInBodies = [] }) {
  const upstream = new URL(target);
  const secrets = new Set();
  const routes = [];
  const bodyLeaks = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const text = body.toString("utf8");
      const shape = `${req.method} ${routeShape(req.url)}`;
      routes.push(shape);
      for (const needle of forbiddenInBodies)
        if (needle && (text.includes(needle) || decodeURIComponent(req.url ?? "").includes(needle)))
          bodyLeaks.push(shape);
      const forward = httpRequest(
        {
          host: upstream.hostname,
          port: upstream.port,
          method: req.method,
          path: req.url,
          headers: req.headers,
        },
        (upstreamRes) => {
          for (const cookie of upstreamRes.headers["set-cookie"] ?? []) {
            const value = cookie.split(";")[0].split("=").slice(1).join("=");
            if (value.length >= 16) secrets.add(value);
          }
          const json = /json/.test(upstreamRes.headers["content-type"] ?? "");
          const parts = [];
          upstreamRes.on("data", (chunk) => {
            if (json) parts.push(chunk);
          });
          upstreamRes.on("end", () => {
            if (!json) return;
            try {
              collectJsonSecrets(JSON.parse(Buffer.concat(parts).toString("utf8")), secrets);
            } catch {
              /* not JSON after all; nothing to collect */
            }
          });
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          upstreamRes.pipe(res);
        },
      );
      forward.on("error", () => {
        res.writeHead(502);
        res.end();
      });
      forward.end(body);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    secretCount: () => secrets.size,
    routeShapes: () => [...new Set(routes)].sort(),
    bodyLeaks: () => [...new Set(bodyLeaks)],
    /** Paths (relative to `root`) of files whose bytes contain any captured secret in plaintext. */
    scan(root) {
      const hits = [];
      const walk = (dir) => {
        let entries;
        try {
          entries = readdirSync(dir);
        } catch {
          return;
        }
        for (const name of entries) {
          const path = join(dir, name);
          let info;
          try {
            info = statSync(path);
          } catch {
            continue;
          }
          if (info.isDirectory()) walk(path);
          else if (info.isFile() && info.size <= 64 * 1024 * 1024) {
            const bytes = readFileSync(path);
            for (const secret of secrets)
              if (bytes.includes(secret)) {
                hits.push(path.slice(root.length + 1));
                break;
              }
          }
        }
      };
      walk(root);
      return hits;
    },
    /** Scanner control: a planted copy of a captured secret must be found, then it is removed. */
    selfTest() {
      const [secret] = secrets;
      if (!secret) return false;
      const dir = mkdtempSync(join(tmpdir(), "lumi-sweep-control-"));
      try {
        writeFileSync(join(dir, "planted.bin"), `prefix ${secret} suffix`);
        return this.scan(dir).length === 1;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
