import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const runner = fileURLToPath(
  new URL(
    "../../../docs/verification/runs/2026-10-07-desktop-managed-e2e/evidence/credential-sensitivity-run.sh",
    import.meta.url,
  ),
);
const target = "apps/api/src/routes/migration.rs";
const original = `            statements.push(
                repository
                    .advance_statement(current_stage, requested)
            );
`;

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "credential harness ")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source checkout");
  const disposable = join(root, "disposable checkout");
  const output = join(root, "proof output");
  const bin = join(root, "bin");
  for (const directory of [source, disposable, output, bin]) mkdirSync(directory);
  const exec = (command, args, cwd = disposable) => {
    const result = spawnSync(command, args, { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  for (const repo of [source, disposable]) {
    mkdirSync(dirname(join(repo, target)), { recursive: true });
    writeFileSync(join(repo, target), original);
    exec("git", ["init", "-q"], repo);
    exec("git", ["add", target], repo);
    exec(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "user.name=Harness Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-qm",
        "fixture",
      ],
      repo,
    );
  }
  // Model build and probe process boundaries, without claiming Worker/runtime proof.
  writeFileSync(
    join(bin, "worker-build"),
    '#!/bin/sh\ntest "$PWD" = "$LUMI_E2E_REPO/apps/api" || exit 8\n' +
      'if [ "$FAIL_MUTATION_BUILD" = 1 ] && /usr/bin/grep -q "if current_stage != requested" src/routes/migration.rs; then exit 9; fi\n',
    { mode: 0o755 },
  );
  const node = join(bin, "fixture-node");
  writeFileSync(
    node,
    '#!/bin/sh\ntest "$PWD" = "$LUMI_E2E_REPO" || exit 8\n' +
      'test -n "$LUMI_E2E_TEST_RESULTS" || exit 8\n' +
      'if /usr/bin/grep -q "if current_stage != requested" apps/api/src/routes/migration.rs; then exit "$MUTATION_EXIT"; fi\n',
    { mode: 0o755 },
  );
  writeFileSync(
    join(output, "credential-sensitivity-source-manifest.json"),
    JSON.stringify({ [target]: createHash("sha256").update(original).digest("hex") }),
  );
  const head = exec("git", ["rev-parse", "HEAD"]);
  const run = (overrides = {}) =>
    spawnSync("bash", [runner], {
      cwd: source,
      encoding: "utf8",
      env: {
        ...process.env,
        REPO_ROOT: source,
        LUMI_E2E_REPO: disposable,
        LUMI_E2E_TEST_RESULTS: output,
        LUMI_SENSITIVITY_HEAD: head,
        NODE24_BIN: node,
        PATH: `${bin}:${process.env.PATH}`,
        FAIL_MUTATION_BUILD: "0",
        MUTATION_EXIT: "1",
        ...overrides,
      },
    });
  const unchanged = () => {
    assert.equal(readFileSync(join(source, target), "utf8"), original);
    assert.equal(readFileSync(join(disposable, target), "utf8"), original);
    assert.equal(exec("git", ["diff", "--", target]), "");
    assert.equal(exec("git", ["rev-parse", "HEAD"]), head);
  };
  return { source, disposable, output, run, unchanged };
}

test("credential harness builds, probes and restores only the disposable checkout", (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    readFileSync(join(f.output, "credential-sensitivity-fault-status.txt"), "utf8"),
    "1\n",
  );
  f.unchanged();
});

test("a failed mutation build restores from the nested apps/api directory", (t) => {
  const f = fixture(t);
  assert.equal(f.run({ FAIL_MUTATION_BUILD: "1" }).status, 9);
  f.unchanged();
});

for (const status of ["0", "2"]) {
  test(`mutation exit ${status} cannot report a successful sensitivity run`, (t) => {
    const f = fixture(t);
    assert.equal(f.run({ MUTATION_EXIT: status }).status, 1);
    assert.equal(
      readFileSync(join(f.output, "credential-sensitivity-fault-status.txt"), "utf8"),
      `${status}\n`,
    );
    f.unchanged();
  });
}

test("a wrong expected HEAD fails before mutation", (t) => {
  const f = fixture(t);
  assert.notEqual(f.run({ LUMI_SENSITIVITY_HEAD: "0".repeat(40) }).status, 0);
  f.unchanged();
});

test("the source checkout cannot be selected as the mutation checkout", (t) => {
  const f = fixture(t);
  assert.notEqual(f.run({ LUMI_E2E_REPO: f.source }).status, 0);
  f.unchanged();
});

test("dirty target changes are preserved and refused", (t) => {
  const f = fixture(t);
  const dirty = `${original}// uncommitted work\n`;
  writeFileSync(join(f.disposable, target), dirty);
  assert.notEqual(f.run().status, 0);
  assert.equal(readFileSync(join(f.disposable, target), "utf8"), dirty);
  assert.equal(readFileSync(join(f.source, target), "utf8"), original);
});
