# Compatibility proof matrix — 2026-10-09

This records current evidence and missing runtime proof; it is not release
certification. The full goal requires both a supported-release/new-backend pair
and the candidate pair. No production deployment or personal-profile operation
is inferred.

| Client | Backend | Current verdict | Evidence and missing proof |
|---|---|---|---|
| GitHub stable `v3.14.0`, source `a907e8e52e44980d293d16f0bf9dc9c925bc16e4` | New candidate | UNPROVEN | Latest non-prerelease metadata read from GitHub; published assets are Linux deb/pkg/AppImage/rpm. Source has no Lumi account transport. Legacy local/provider behaviour against additive backend and existing-state compatibility still needs actual supported-platform runtime. Source absence of a managed client is not a blanket compatibility PASS. |
| Clean phase client `2a495254f0018644d24c9c1e5c5210bb7a30075c` | Clean recovery server `4f730a52c6ad8b0abde8f204f473315cf399d796` | PASS for SDK/HTTP recovery only | Fresh 25-migration Worker/D1, wrong proof, expiry, replay, cross-tenant stored effects, token rotation/refresh, revocation and logout; both dirty flags false. Electron recovery UI is UNPROVEN. PR52 Linux CI adoption failed twice with transport socket loss; local proof does not override that gate. |
| Dirty macOS desktop based on `2a495254f0018644d24c9c1e5c5210bb7a30075c` | Dirty server based on `e7ad897a7f400048df17100594ef86b3788ea0f1` | UNPROVEN overall | Real isolated Electron managed schedule succeeds, with in-profile Agent output and matching policy/run/lease/storage. Full race fails activation when target has no workspace binding. Restart/fault not executed by the fail-stop run. Exact candidate content/build digests remain in individual reports; these base SHAs are not release pins. |
| Final merged desktop SHA | Final merged backend SHA | UNPROVEN | Not merged. Final gitlink, clean checkout, paired replay, hosted checks and remote main readbacks remain required. |

The [published release](https://github.com/RunLumi/LumiAgents/releases/tag/v3.14.0)
was published 2026-09-21T23:23:02Z. Its `targetCommitish: main` is a release label,
not the candidate commit; the Git tag must be resolved independently. No macOS
GitHub asset is listed for that release, and App Store version/status has not
been inspected here. Do not silently substitute a dev build for a shipping
artifact or mark missing platform proof NOT_APPLICABLE without evidence.

Legacy source still derives the Agent session store from HOME. Any legacy
runtime must use a genuinely isolated test environment while preserving native
encryption. Do not read or reuse the operator's Agent store to certify old-state
compatibility. Required old BYOK/MCP/session/multiple-workspace fixtures and
downgrade/rollback proof remain in the full-goal checklist.

Delivery ledger: `docs/implementation/desktop-e2e/plan.md`. Phase PRs #51, #39 and
#52 remain drafts; their scope and dependencies must be checked independently
before any authorized merge.
