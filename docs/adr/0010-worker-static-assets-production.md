# ADR 0010: Production SPA and Rust API on one Worker

- Status: Accepted
- Date: 2026-10-02

Cloudflare Workers Static Assets serves apps/web/dist on the existing Rust Worker
at agents-cp.runlumi.app. SPA fallback handles navigation; run_worker_first covers
/api and /api/*, preserving Rust responses even for browser API navigation.
Development remains Vite plus a development Worker. No JS backend is introduced.

WebAuthn uses the exact domain as RP ID and its HTTPS origin; workers.dev and
preview URLs are disabled. Private exports remain in R2. Build web before API.

Actions deploys only main after quality passes, serializes deployments, checks
main freshness and takes its API token from Actions secrets. Apply compatible,
forward-only migrations before upload. Rollback the Worker, retain D1 and keys;
schema restores require review. Deployment does not certify email/provider
integration or all release obligations.

Sources:
- https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/
- https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
- https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/
