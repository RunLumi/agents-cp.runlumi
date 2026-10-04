# Work Packet — PNN-LANE-NN: <short name>

## Metadata

- Phase:
- Lane: MOD | BE | FE | INT | QA
- Status: ready | claimed | in_progress | blocked | review | merged
- Owner:
- Depends on:
- Blocks:
- Specs:
- ADRs:
- Contract version / Contract Gate commit:

## Outcome

One paragraph describing the externally observable or architectural result.

## In scope

- 
- 
- 

## Explicitly out of scope

- 
- 
- 

## Write surface

Allowed paths:

```text
path/**
path/file.ext
```

Shared files requiring coordinator approval:

- none

Do not edit outside this surface without first updating the packet.

## Frozen contracts consumed

List exact contracts this packet relies on:

- API:
- entities:
- permissions:
- events:
- policy schema:
- generated types:

## Implementation notes

State assumptions that another agent would otherwise have to rediscover.

Do not prescribe implementation detail unnecessarily if the packet is FE/QA and the contract is already frozen.

## Acceptance criteria

- [ ] 
- [ ] 
- [ ] 

Map each important item to a spec requirement ID where possible.

## Tests

Required:

- [ ] unit
- [ ] integration
- [ ] cross-tenant negative
- [ ] browser/UX
- [ ] performance/regression
- [ ] not applicable with reason

## Security checklist

- [ ] tenant scope preserved
- [ ] authorization centralized
- [ ] no secret/token leakage
- [ ] no raw sensitive body logging
- [ ] idempotency/concurrency considered
- [ ] destructive action behavior understood
- [ ] not applicable with reason

## Handoff

Before PR review, complete `templates/handoff.md`.

## Resume checkpoint

For long-running work, update before interruption, compaction, or handoff. Follow [the resume protocol](../../prompts/README.md#resuming-long-running-work). Use this section only while the packet is active; merged packets remain immutable.

- Updated on / owner:
- Original outcome / first unmet acceptance criterion:
- Latest user constraints / do not do:
- Checkout path / HEAD / relevant working and index changes:
- Packet write surface / shared-file ownership:
- Contract Gate commit/version / dependency status:
- Completed work / exact evidence paths and commands:
- Unresolved hypotheses / blockers / missing proof:
- Running commands or processes / worktree or runtime resources:
- Next concrete action / safe retry or recovery conditions:

Do not include credentials, raw tokens, or sensitive request bodies.

## Stop conditions

Stop rather than improvise if:

- frozen contract is insufficient or contradictory;
- write surface overlaps another active packet;
- a shared invariant requires a new ADR/spec change;
- a runtime/platform assumption is false.
