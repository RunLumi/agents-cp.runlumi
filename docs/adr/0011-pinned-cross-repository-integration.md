# ADR 0011: Pinned cross-repository integration

- Status: Accepted
- Date: 2026-10-06

Track RunLumi/LumiAgents as a Git submodule at `integrations/lumi-agents`.
The gitlink is the tested client revision. Keep histories, releases, package
managers and lockfiles independent; do not add it to pnpm/Cargo workspaces.
Product code must not import its source. Only integration tooling bundles its
real P08 wizard for a Node host and tests it against local Worker/D1.

Sibling checkouts plus a manifest are viable but duplicate Git pin/bootstrap
mechanisms. Symlinks are machine-specific; subtree copies another product into
this history. Submodules add detached-HEAD and two-commit pitfalls, documented
in the operator guide. Cross-repository merges are not atomic.

The host test adapter maps frozen HTTP DTOs into the client's existing port.
It cannot synthesize state or authority. Local overrides support independent
client worktrees; CI requires clean sources and the committed pin. No production
bindings, schema, secrets or deployment behavior change. This test proves a
module/HTTP/D1 journey, not Electron UI or a packaged desktop release.
