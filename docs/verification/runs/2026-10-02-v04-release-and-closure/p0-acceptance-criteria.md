# V04 — P0 acceptance-criterion inventory

Derived from `docs/specs/README.md` priority column and the spec bodies, **before reading any
campaign evidence** (independence protocol step 2). The acceptance-criterion population is every
`FR-*` heading plus every `MUST` sentence. Priority is a property of the *spec*, not of the
individual requirement, so a P0 spec's every FR is in scope.

| spec | priority | FR-* criteria | MUST sentences |
|---|---|---|---|
| F01 | **P0**  ← P0 | 17 | 34 |
| F02 | **P0**  ← P0 | 7 | 7 |
| F03 | **P0**  ← P0 | 8 | 3 |
| F04 | **P0**  ← P0 | 7 | 3 |
| F05 | **P0**  ← P0 | 6 | 1 |
| F06 | **P2** | 6 | 3 |
| F07 | **P0**  ← P0 | 7 | 1 |
| F08 | **P0**  ← P0 | 8 | 2 |
| F09 | **P0**  ← P0 | 7 | 1 |
| F10 | **P0**  ← P0 | 0 | 5 |
| F11 | **P0**  ← P0 | 9 | 1 |
| F12 | **P0**  ← P0 | 8 | 0 |
| F13 | **P0**  ← P0 | 9 | 0 |
| F14 | **P1** | 7 | 1 |
| F15 | **P1** | 9 | 1 |
| F16 | **P0**  ← P0 | 5 | 1 |
| F17 | **P1** | 8 | 0 |
| F18 | **P1** | 8 | 2 |
| F19 | **P0**  ← P0 | 9 | 0 |
| F20 | **P1** | 9 | 1 |
| F21 | **P0**  ← P0 | 11 | 2 |
| F22 | **P0**  ← P0 | 11 | 0 |
| F23 | **P0**  ← P0 | 10 | 1 |
| F24 | **P1** | 8 | 0 |
| F25 | **P1** | 9 | 1 |
| F26 | **P0**  ← P0 | 8 | 1 |

**P0 total: 147 FR-* criteria and 63 MUST sentences across 18 specs.**

P1/P2 specs are **NOT_APPLICABLE to the P0 evidence mapping** by the README's own priority assignment, and are recorded as such rather than silently dropped. Two of them (F17 webhooks, F20 data governance) still carry release-gate checklist rows of their own, so they are mapped against the *release gate*, not against the P0 spec priority.

**F06 (P2, Domains/SSO/SCIM) is the one P0-relevant risk to name explicitly**: the release gate requires passkey flows and a cross-tenant substitution matrix, both of which F06 would extend. Its P2 status means SSO/SCIM itself is out of the P0 mapping, not that the identity invariants F06 would touch are already satisfied by F01/F05.
