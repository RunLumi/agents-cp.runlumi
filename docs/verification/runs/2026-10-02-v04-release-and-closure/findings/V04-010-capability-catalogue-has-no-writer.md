# V04-010 — browser and computer-use policy cannot be reached, because the capability catalogue has no writer

**Severity: HIGH (product). Found by trying to give FR-F13-005/006 their missing evidence rather than
recording them as unproven. The enforcement code is correct and unreachable; the platform cannot
authorize a browser or computer-use tool call at all.**

## What the probe set out to do, and what it found instead

`FR-F13-005` (browser use) and `FR-F13-006` (computer use) were carried as *coverage* gaps: eleven
spec-named sub-controls on `BrowserPolicy` and `ComputerPolicy`, all present as struct fields, none
ever driven over HTTP. The first question was the one that found V04-008 — **is each field consulted
on a decision path?** — and the answer was yes for nine of them, in a real and complete evaluator
(`evaluate_browser_rules` / `evaluate_computer_rules`, `modules/tool_policy.rs:1597` and `:1651`).

So the fields are enforced. Then the probe could not reach them, one precondition at a time, and each
precondition is the finding.

## The chain, each link measured

| # | link | state |
|---|---|---|
| 1 | `BrowserPolicy` / `ComputerPolicy` carry the controls | present, `modules/policy_p05.rs:43` and `:56` |
| 2 | the evaluator consults them per action | present — `policy.allow_download`, `policy.allow_clipboard`, `policy.allow_screen_capture`, `allowed_applications`, `domain_allowed(...)` |
| 3 | a tool can be marked browser- or computer-capable | **impossible** — see below |
| 4 | so `required_capabilities` gets `browser`/`computer` | always |
| 5 | `capabilities_are_catalogued` must find it in `capability_definitions` | **the table has no writer** |
| 6 | managed-organization mode | denies `capability_not_defined`, before any toggle is read |

**Link 3 is the structural one.** `has_browser_capability` (`tool_policy.rs:1714`) matches
`capability == "browser"` or `cap_`-stripped-equals `browser`. But a capability id on a catalog tool is
parsed by `CapabilityId::new`, and `resource_id_type!(CapabilityId, …, Some("cap"))` delegates to
`ResourceId::new`, which requires `<prefix>_<32 lowercase hex>` (`core/identifiers.rs:17-27`). Neither
`browser` nor `cap_browser` satisfies that, so `has_browser_capability(&definition.capability_ids)`
**can never be true** — it is the `is_run_source` shape from V01-047: a live function whose condition
cannot hold. Confirmed from the other side too: the probe's first attempt sent
`capability_ids: ["cap_browser_use"]` and was refused `422 capability_ids_invalid`,
*"Choose valid capability references."*

**Link 5 is the one that stops everything.** `capability_definitions` exists (migration 0010), is read
on **every** tool decision (`CAPABILITIES_FOR_ORG_SQL`, `repositories/tools.rs:256`), and its schema
deliberately separates the opaque `capability_id` from a human `capability_key` that *can* be `browser`
— and `routes/tools.rs:2247` projects **both** spellings, so a single row keyed `browser` would satisfy
the check. There is no such row and **nothing can create one**: no `INSERT` or `UPDATE` anywhere in
`apps/api/src`, no seed in any migration, no route. The probe asserted the table is empty before it
touched it (`rows=0`), which is the finding stated as an assertion.

So every browser or computer-use call in managed-organization mode is refused `capability_not_defined`.
**Measured, not inferred:** the probe's first full run scored 51/68 with thirteen denials passing and
every one of them refused with that same reason — the tell that the toggles had never been read.

## It fails closed, and that is the only good news

Nothing browser-shaped or computer-shaped is ever permitted, so this is not a security hole and no
policy is bypassed. It is a **capability absence**: two of the highest-risk tool categories in the
specification cannot be authorized by this platform, and they cannot be unauthorized either — every such
call dies at a capability check whose reason (`capability_not_defined`) reads like a misconfiguration
rather than a missing feature.

Compare the three shapes this campaign has now separated, which is why the distinction is worth the
table:

- **fail-open, inert** — V04-008's client-version floor: the control cannot be armed, so a client is
  never forced to upgrade.
- **fail-closed, unreachable** — this one: the control cannot be reached, so the feature never runs.
- **fail-closed and settable** — `blocked_categories` and `blocked_applications`, below.

## Proof that the enforcement is correct and only the writer is missing

After seeding the two capability rows as a **precondition fixture** and heartbeating the run's device
(`browser_use`, `computer_use` — capabilities are declared by heartbeat, not at enrollment), the probe
reaches the rules and every assertion passes with the **correct, distinct** reason:
`browser_action_denied` for the five browser toggles and both allowlists, `computer_action_denied` for
the four computer toggles and the application allowlist. **71/71.**

`evidence/v04-f13-sensitivity.sh` proves those assertions are not decorative, **2/2 detected, exit 0**:
making `allow_download` permissive reds exactly one assertion and leaves the computer family green, and
the same for `allow_screen_capture`. Each assertion is bound to its own toggle rather than to "the
browser path".

## Two sub-controls are not settable at all, and that one is correct

`blocked_categories` (browser) and `blocked_applications` (computer) exist on the domain structs, are
consulted by no decision, and are **not in the request structs** — which carry
`#[serde(deny_unknown_fields)]`. The probe measured `422`, so an operator who sends them gets a
refusal rather than a silent no-op. `FR-F13-005` names "blocked domains/**categories**" and
`FR-F13-006` names "target application allow/**deny**", so **two spec-named sub-controls are
unimplemented**, fail-closed. That is a narrower and much less serious gap than the catalogue: a
rejected field cannot mislead anyone.

## Decided: recorded, not implemented

Closing this needs a routed surface to manage capability definitions — creation, lifecycle, org or
platform scope, and the authorization for it — which is a feature with no spec of its own, against a
verification campaign that has already shown the surface does not exist. That is the release repair
rule's "the remaining defect cannot be repaired within the authorized scope", and adding an
un-specced write surface to a tool-authorization boundary mid-campaign would broaden the problem.

Recorded with its next action named: **either** ship a capability-definition surface, **or** relax
`has_browser_capability` / `has_computer_capability` to match the `capability_key` spelling the catalogue
already projects, which would let an org-scoped capability row reach the evaluator without any new
route. The second is a smaller change and is the one worth considering first — the projection at
`routes/tools.rs:2247` already exists and already carries the right spelling.

## What the probe's positive control was worth

Four runs, four times it refused to let a red or falsely-green sheet stand:

1. 13/13 "denials" green, control red `agent_tool_not_allowed` — the tools were missing from the
   agent's `allowed_tool_ids`, so nothing had reached the policy.
2. control red `tool_risk_class_mismatch` — a decision whose declared `risk_class` disagrees with the
   registered tool is refused before any rule is read.
3. all denials green with the **identical** reason `capability_not_defined` — the tell for this finding.
4. reason moved to `runtime_capability_unavailable` — the device must also *report* the capability.

Every one was fixed in the **fixture**, never by weakening an assertion. The accumulated preconditions
are the finding: the product enforces all nine settable controls correctly, and cannot reach that code
without a row nobody can create.