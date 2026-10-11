#!/usr/bin/env node
// Redact credential-bearing fields from a probe log and prove it. Usage:
//   node phase02-redact-log.mjs <raw.log> <redacted.log>
// Writes the derivative, prints `sha256(raw)` and `sha256(redacted)` (provenance), and exits 1 if the
// derivative still matches the redaction gate. The raw log is never printed and must never be committed.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const RULES = [
  [/("lease_token"\s*:\s*")[^"]+(")/g, "$1[REDACTED]$2"],
  [/(lease_token["']?\s*[:=]\s*["']?)[0-9a-f]{32,}/gi, "$1[REDACTED]"],
  [/(DeviceToken\s+)[A-Za-z0-9._~+/=-]{16,}/g, "$1[REDACTED]"],
  [/(Authorization["']?\s*[:=]\s*["']?Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, "$1[REDACTED]"],
  [/("device_token"\s*:\s*")[^"]+(")/g, "$1[REDACTED]$2"],
];
const GATE = [
  /lease_token["']?\s*[:=]\s*["']?[0-9a-f]{32,}/i,
  /DeviceToken\s+(?!\[REDACTED\])[A-Za-z0-9._~+/=-]{16,}/,
  /"device_token"\s*:\s*"(?!\[REDACTED\])/,
];

export function redact(text) {
  return RULES.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);
}
export function leaks(text) {
  return GATE.filter((pattern) => pattern.test(text)).map(String);
}
const sha = (text) => createHash("sha256").update(text).digest("hex");

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    console.error("usage: phase02-redact-log.mjs <raw.log> <redacted.log>");
    process.exit(2);
  }
  const raw = readFileSync(input, "utf8");
  const clean = redact(raw);
  writeFileSync(output, clean);
  const remaining = leaks(clean);
  console.log(`raw_sha256=${sha(raw)} redacted_sha256=${sha(clean)} leaks=${remaining.length}`);
  process.exit(remaining.length === 0 ? 0 : 1);
}
