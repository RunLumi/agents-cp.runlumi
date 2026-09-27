# Verification runs

One directory per campaign. Each directory answers, with rerunnable evidence, what an
independent verifier could actually prove about the repository at a named commit.

| Run | Commit | Verdict | Headline |
|---|---|---|---|
| [`2026-09-27-v00-independent-reconstruction`](./2026-09-27-v00-independent-reconstruction/verification-run.md) | `ecbdac1` → `d2917a3` | **FAIL → repaired** | At `ecbdac1` the primary authentication path (passkeys) returned 500 on the real Worker runtime and no self-service user could onboard. Seven findings, all now closed: the real-browser journey went **20/23 → 39/39**, the P05 runtime smoke **175/1 → 185/0**, and the mutation campaign **9/9 → 11/11** on the required minimum set. See [`repair-closure.md`](./2026-09-27-v00-independent-reconstruction/repair-closure.md). |

## Contents of a run

- `verification-run.md` — identity, environment, scope, baseline, verdicts, evidence limits
- `claim-evidence-matrix.md` — one row per falsifiable claim, with its cheapest capable verifier
- `missing-external-proofs.md` — obligations that cannot be discharged from this repository
- `next-verification-actions.md` — ordered repairs and proofs
- `repair-closure.md` — the post-repair half: what each finding became, the evidence that moved each verdict, and the verifier defects found while repairing
- `findings/` — one file per finding, with the pre-repair evidence and a closure record
- `evidence/` — the exact scripts, logs, and screenshots the verdicts rest on

## Reading order

`verification-run.md` is the reconstruction: what an independent verifier could prove at `ecbdac1`,
derived from specs, ADRs, and contracts rather than from implementer handoffs. It deliberately
keeps its "before" tables, because a verification record that silently rewrites its own baseline is
not a record of anything. `repair-closure.md` is the repair loop that followed, and
`verification-run.md`'s **Claim summary (post-repair)** section re-derives every moved verdict from
post-repair evidence.

The two most expensive things learned here, both structural rather than product-specific:

1. **A verifier that repairs its own subject stops being a verifier.** The V00 browser probe called
   `/verify-email` by hand and created the second organization by API so the rest of the journey
   would keep passing — which is exactly why it reported three failures instead of four. Those
   fallbacks are deleted, and the journey now drives the UI or fails where the product is broken.
2. **A host build can look fine while the Worker target fails at run time.** Not at compile time —
   at *run* time, which is strictly worse, and invisible to every gate that existed.
