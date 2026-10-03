# V05 release verdict — candidate `aa05674` (product repairs) on `8aaca08` (pin), recorded at `c326cad`

## VERDICT: **FAIL — do not release (one measured Tier-0 BLOCKED remains, and the deployed tree is not this candidate)**

Not because this campaign found the product broadly broken — the opposite: **the security gate
PASSES**, the largest single unknown V04 closed with ("does WebAuthn work on the production
origin?") is now **measured**, and the two gaps verify-05 named are closed or narrowed to honest
residuals. The verdict is FAIL for the reason the release gate defines, and the gate is the
authority:

> Release is blocked if: any Tier-0 claim is FAIL, UNPROVEN, or BLOCKED …

**T0-16 (export/deletion) remains BLOCKED** — the local runtime never invokes the jobs consumer, a
measured environmental cause (two fresh runs in V04, re-confirmed this campaign: `smoke:p06` exits 2
with 27/27 cases holding and the R2 leg blocked). Fail-closed: the job sits queued and does nothing.
A required external system cannot be exercised from this host; that is a stop condition, not a
defect to fix locally.

And a second, operational fact a reader needs on the same page as the verdict: **what is deployed at
`agents-cp.runlumi.app` is not this candidate.** The live deployment was built from the
`origin/main` deployment line, which branched from `795d403` — V04's original pin, a FAILED candidate
that ships V04-002 (the queue entrypoint cannot construct the Worker: **the deployed control plane
cannot consume a queue message at all**). Local `main` is 43 commits ahead with the repair and is
NOT deployed. Merging the two lines and redeploying is a human decision this campaign has no
standing to make.

## What this campaign closed

| | |
|---|---|
| **V05-001** (HIGH, product/config, **repaired**) | the candidate's own production env carried no `WEBAUTHN_*`/`EMAIL_FROM` vars — deploying it would have silently disabled passkeys and verification mail with health green. Vars converged with the deployment line; regression-proven (`v05-webauthn-config.sh`, 7/7) |
| **V05-002** (MEDIUM, product, **repaired**) | a passkey route with no adapter answered the D1-outage error verbatim; now `503 passkeys_not_configured`, distinguishable by an operator reading the response |
| **The production WebAuthn unknown** (V04's closing question) | **MEASURED**: the live deployment issues ceremonies with `rp.id = agents-cp.runlumi.app` (201, both start endpoints); the full 91-check suite passes under the exact production pairing; origin/RP-ID mismatches are refused with reasons distinct from wrong-credential; replay is refused for **all five ceremony kinds** (PasskeyAdd + Reauthenticate closed this campaign); the counter boundary is enforced at the stored value; revocation and step-up hold |
| **§2 security gate** | 33 runtime gates re-run green; the two expected environmental BLOCKEDs behave as documented; observability 28/28 with 0 unmeasured |
| **§3 capability sweep** | standing checks 2/2 + 5/5; every known-open capability re-derived with its failure direction; no new instance of the class |
| **§4 whole site** | all 19 sections in a real browser at 1440/390 with focus, keyboard, error-recovery, one-time-secret and destructive-confirmation legs (93 checks); `smoke:browser` 91/91; **12/12 screen references opened and compared** |
| **V05-003** (LOW, product, recorded) | Billing & entitlements on a fresh org renders an error state where the reference designs a not-connected empty state. Fail-closed; a design decision to make deliberately |

## Tier-0 summary

19 PASS · **1 BLOCKED (T0-16, measured environmental, fail-closed)** — the per-claim mapping with
this campaign's evidence is in `02-security-gate.md`.

## Blockers and accepted residual risks (carried + new)

1. **T0-16** — the jobs consumer has never been observed to process an envelope, locally (measured)
   or in production (the deployed tree cannot even construct it — V04-002, unfixed on the deployment
   line). This is the release blocker.
2. **Production origin **completions**** — the RP ID half of the pairing is measured live; a real
   CTAP2 authenticator completing a ceremony on `https://agents-cp.runlumi.app` still needs a human
   with a browser (this host's browser surfaces cannot drive WebAuthn). The origins allowlist is
   evidenced by the deployment config plus the local run under the identical pairing. **UNPROVEN**,
   narrowly.
3. **V04-008** (fail-open, inert: no lever arms the minimum-client-version floor), **V04-010**
   (fail-closed, unreachable: `capability_definitions` has no writer), **V01-040/046/047/050**
   (fail-closed capability absences, `V01-050` behind a customer route answering `200 {items: []}`
   forever) — re-derived in §3, open by decision, each needing the deliberate process.
4. **FR-F12-008** — the P0 spec containing a requirement whose own text says P1; frozen-contract
   drift only a human can settle.
5. **INP UNMEASURED** — carried from V04; not measurable on this stack. Every other performance
   budget measured green in V04 and no bundled web code changed this campaign.
6. **V05-003** — the billing empty-state choice (LOW).
7. **Desktop client** — none exists; the External Lumi Agents rows are NOT_APPLICABLE as in V04.
8. **Provider/billing/webhook sandboxes** — unreachable from this host (V01-026 family), carried.

## Migration and rollback

Fresh ledger applies (22 files, head `0022`) and the populated-table path applies
(`verify:migration-prior-state` green). `verify:restore` green. `pnpm build` exit 0 (vite production
build + Worker dry-run) alongside `pnpm check` exit 0 on the final tree. The campaign's product
changes are two files (`routes/authenticators.rs` error mapping, `wrangler.jsonc` production vars) —
rollback is a pure revert; neither touches schema or stored data.

## Limitations of this verdict

1. **Shared host, shared store** — the pnpm store this checkout previously shared proved
   unreliable mid-campaign (ENOENT during install); every gate after that point ran against a
   dedicated store (`/Volumes/SSD/.pnpm-store-v12`). Recorded because a reader re-running the gates
   needs the same isolation or they may reproduce the failure.
2. **Harness findings in this campaign's own runners were frequent and are recorded where they were
   fixed** (§4's seven runs; §2's two setup gaps; §1's `--var` affordance). None weakened an
   assertion; every affected gate was re-run to green after each fix.
3. The mutation campaign was not re-run: the product tree is byte-identical to `1d3ec1e` in every
   guarded path (verified by diff at re-pin), and `campaign-preflight` confirms each case still
   applies. The eleven V04 kills are carried explicitly, per the pin discipline V04 itself used.
4. This campaign changed the tree it judged (two repairs) and re-pinned honestly — `8aaca08` →
   `aa05674` — re-running the affected proofs (91/91 pairing suite, config script, `pnpm check`,
   standing checks) on the new tree.

## What important thing do we still not know?

**Whether the control plane real users are using — the one deployed at `agents-cp.runlumi.app` —
works at all beyond its health check.** It runs a tree that predates every repair since `795d403`:
it cannot consume a queue message (V04-002), it predates the recovery-replay closure, and nobody has
merged the line it lives on with the line this campaign just verified. Every green gate in this
record describes a candidate that is **not deployed**; the deployment's own evidence is one health
probe, two ceremony starts, and its git ancestry. Closing that gap is not verification work — it is
a merge, a redeploy, and a real-browser WebAuthn completion on the public origin — and until it
closes, the honest answer to "can we release this?" is: this candidate is the best the product has
been, and it is not what is running.
