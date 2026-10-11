# PR #59 reconciliation — 2026-10-11

Coordinator: Codex. Packet: DE2E-INT-05 continuation/review. Parent baseline:
`80a3813de76b1e13a26f8704f5810c3404c0bac6`. Original WIP head:
`24896bb0a32234994da2cb00db5027733b15fd95`. Client pin:
`ac011fce8d6273a1218022de17fdeafec7a59ba9` (merged LumiAgents PR #48).

## Review findings and resolutions

| Finding | Resolution |
| --- | --- |
| The WIP targeted an old recovery branch and diverged from current main. Directly accepting it would remove newer provider cancellation, subprocess/socket diagnostics, asynchronous D1, recovery and automation assertions. | Merge current main into the existing PR branch without rewriting history. Preserve main's product sources, migrations, runtime harnesses, workflow, prompts and design updates. Retarget the PR to main. |
| The added binding guard test replaced main's dispatch-eligibility test in the snapshot. | Retain both source-derived tests. Real SQLite verifies live binding authority and no-write refusals for foreign organization/device and removed bindings. Preserve active dispatch and lost-authorization controls. |
| The portable credential sensitivity script contained invalid embedded Python, an unexported results path and a restore tied to a changing working directory. Python wrappers passed a literal `$REPO_ROOT` as TMPDIR. | Resolve paths before changing directories, export the results path, use the disposable checkout explicitly for builds/probes/restores, check expected HEAD before restore and require a successful baseline/restored probe plus mutation exit 1. Create real temporary directories in the Python wrappers. |
| The submodule pointed at an older, divergent WIP client commit. | Select latest merged client main at review time. PR #48's resolution preserves the newer v3.15.1 and session/vault/paging work. Keep the original WIP commits fetchable in their own histories. |

Historical evidence paths are normalized for sharing. Original outcomes, counts,
source manifests and FAIL/UNPROVEN/BLOCKED records are preserved. A path placeholder
does not recreate an ignored local profile, database or fixture.

## Validation

- PASS: `pnpm check` on the resolved candidate: formatting, lint, web types,
  818 web tests, 1,123 Rust tests, 12 egress tests, schema/canary checks,
  request-boundary tests, seven new harness safety tests, guard probe,
  mutation-parser self-tests, bind scan, Clippy and WASM check.
- PASS: 17/17 real SQLite guard cases. Fresh sensitivity evidence forces the
  live binding predicate to return no row; baseline/restored exit 0 and mutation
  exit 1 with `live binding was refused`. The target source and HEAD remain unchanged.
  See [sensitivity report](runs/2026-10-07-desktop-managed-e2e/evidence/20261011-pr59-guard-sensitivity.json)
  and its baseline/mutation/restored transcripts. The probe SHA identifies the
  exact verifier used independently of later documentation edits.
- PASS: Python wrapper and embedded-heredoc syntax validation; shell syntax and
  Git whitespace checks. This is not execution proof for all historical wrappers.
- Product source, migrations, frontend, existing integration tests and workflows
  are byte-identical to the parent main baseline. No new runtime dependency,
  schema, frozen contract or production configuration change is introduced.

The seven harness regression tests use disposable Git fixture repositories and
stub build/probe processes. They establish path/restoration behavior, dirty/head
refusal and rejection of mutation success/setup failure. They do not establish
the credential-mode product claim. Real provider and paired Worker/D1 results,
and hosted checks for the final PR head, are recorded in the PR and runner output.

The credential sensitivity script requires a prepared clean disposable checkout,
installed toolchain and an independently checked source manifest in
`LUMI_E2E_TEST_RESULTS/credential-sensitivity-source-manifest.json`. Its historical
expected HEAD remains the default; an intentionally selected new baseline uses
`LUMI_SENSITIVITY_HEAD`. Set `LUMI_E2E_REPO`, `REPO_ROOT` and `NODE24_BIN` for the
receiving machine. Missing historical fixtures remain a prerequisite failure.

## Delivery and resume boundaries

Use the [integration guide](../integration/lumi-agents.md) for recursive checkout,
Node/Rust prerequisites, the one-command adoption/account gate and paired SHA
readback. The final source revision is the PR head recorded by GitHub checks;
the runner refuses dirty sources or an override in CI.

This reconciliation does not complete the full desktop/backend E2E goal. Actual
Electron/provider/tool/automation obligations retain their recorded verdicts.
Main quality, serialized production deployment and live smoke are separate from
PR/local validation. Review and merge do not authorize secret rotation, remote
resource creation, weakened gates or destructive schema recovery.
