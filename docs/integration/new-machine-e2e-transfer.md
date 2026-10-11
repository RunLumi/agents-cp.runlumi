# Desktop E2E source transfer — 2026-10-11

This is a source-preservation handoff, not a release or complete-E2E PASS. Existing native and review candidates are independently published so a fresh machine does not lose either version. Private profiles, dependency/build outputs and raw evidence awaiting redaction are retained on the original machine and excluded from Git.

## Fresh checkout of the native source pair

```bash
git clone --branch codex/transfer-paired-e2e-20261011 --recurse-submodules https://github.com/RunLumi/agents-cp.runlumi.git
cd agents-cp.runlumi
git rev-parse HEAD
git -C integrations/lumi-agents rev-parse HEAD
git submodule status --recursive
```

The parent pins published child `fa741def7b98913e7780b5e55deb07ebb0af3eb4`. This snapshot has not acquired a clean exact-pair E2E PASS. Use repository setup instructions and pinned toolchains; never use a personal profile for native tests.

## Other source variants

All branches are in their respective independent repositories:

| Repository | Branch | Source snapshot SHA |
| --- | --- | --- |
| LumiAgents | `codex/transfer-native-client-20261011` | `fa741def7b98913e7780b5e55deb07ebb0af3eb4` |
| LumiAgents | `codex/transfer-review-client-20261011` | `8c9ac89256b8e78c5979e5ead5273d6a8d909e88` |
| agents-cp.runlumi | `codex/transfer-native-parent-20261011` | `845397d4d0edf62d8f2c4f2ee2cc1d163fe4e541` |
| agents-cp.runlumi | `codex/transfer-review-parent-20261011` | `d7e3a83d1088c73f0a1e74a1fc1c69a9234b4bfc` |

Fetch the review branches before source reconciliation; do not overwrite native source with a review snapshot wholesale. A trial merge found 32 conflicted client paths and 16 conflicted parent paths, including dispatch, authorization, custody and adoption state. These require semantic resolution and regression/runtime proof before a combined main merge.

## Current proof limits and authorization

The user authorized commit/push/PR/main merge and confirmed DCO signing as `j <hong@cloudjetkpi.com>`. The user stopped Claude usage; continue directly with the chosen coding agent. The prior Claude implementation attempts terminated before doing work because API authentication expired.

Native run22 was UNPROVEN overall: onboarding/adoption/restart passed on a dirty historical pair; schedule/race/faults and the full A–E closure remain unproven. A real external-provider call remains blocked without approved credentials and a spend cap. Do not equate a source snapshot, published branch or successful baseline build with a full native integration PASS.

Run each repo's current quality gates and frozen runtime obligations on the reconciled exact pair. Preserve valid DCO/provenance, server-first compatibility and independent PR histories. Read back both merged main SHAs before a final gitlink PR. No manual deployment or external-provider spending is authorized by this source transfer.
