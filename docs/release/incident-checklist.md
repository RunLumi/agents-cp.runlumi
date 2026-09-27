# Incident checklist

Terse on purpose. This is the list you follow, not the document you read.

## Declare

- [ ] **Severity.** `SEV1` = data loss, cross-tenant exposure, or auth bypass → page
      the security lead. `SEV2` = a tenant cannot work, or spend is wrong. `SEV3` =
      degraded but working. When unsure, declare `SEV2` and downgrade later; do not
      spend the first ten minutes deciding.
- [ ] **Request id.** From the response body or the log line. Everything joins on it.
- [ ] **Started when.** First occurrence from the hourly histogram, not when someone
      noticed.
- [ ] **Declare it in the incident channel** with those three facts. Refining later is
      cheap; three people working from different assumptions is not.

## Triage — first ten minutes

- [ ] Last Worker deploy, and its time. Most "started at 14:05" is a 14:00 deploy.
- [ ] One tenant or many? `GROUP BY organization_id` over `security_events`.
- [ ] One provider? `provider_health` ordered by `updated_at DESC`.
- [ ] Is it in the durable job table, or is the row genuinely missing? A missing row
      that should exist is itself the bug.
- [ ] Is money involved? Live holds, not estimates — see the runbook §4.

## Contain

Pick the **least destructive thing that stops the bleeding**. The runbook's table is
ranked; prefer a kill switch or a flag over a deploy rollback.

- [ ] Kill switch, if one target class is implicated. Requires a reason; cannot be
      re-engaged in place, which is deliberate.
- [ ] Feature flag off, if the whole feature is wrong. Expiry is checked first, so
      "off because expired" and "off because disabled" are distinguishable.
- [ ] Provider disabled or its route narrowed.
- [ ] Organization suspended — heavy, and it is a customer-visible act.
- [ ] Credential revoked. **Not reversible, and that is the point.** Revoke first,
      investigate second, if there is any doubt the key leaked.
- [ ] Worker rolled back. Last resort: it is blunt and it is whole-platform.

## Communicate

- [ ] State what is affected and what is not, in tenant terms, before you know the
      root cause. "Organization X cannot start runs; other organizations are
      unaffected" is a useful message. "Something is wrong with the run path" is not.
- [ ] If data may have been exposed, that is a `SEV1` and a security conversation
      starts now, not after triage. Do not wait for certainty.
- [ ] Name the reversible action you took and what would reverse it.

## Diagnose

- [ ] Everything one request did, in order, from `outbox_events` by `request_id`.
- [ ] The job row's `state`, `attempt`, `last_error_code`, `lease_expires_at`.
- [ ] Version history of the implicated row. The `version` column only moves on a
      real change, so it is an honest timeline.
- [ ] Re-run the audits rather than reasoning from memory: `pnpm check` runs the
      tenant audit, the secret canaries, the schema invariants, and the egress corpus.

## Mitigate and verify

- [ ] Fix or roll back. Prefer the smallest change that removes the cause.
- [ ] Verify against the **symptom**, not the code. The same query that detected it
      must now come back clean.
- [ ] Check for the second-order effect. A rollback that fixes the page can leave a
      queue of retries that then lands at once.
- [ ] Confirm no orphan state: a `reserved` budget hold with a past expiry, a job in
      `running` with an expired lease, a delivery stuck `delivering`.

## Recover

- [ ] Resume anything you paused, in the reverse order you paused it. A kill switch
      lifted before the cause is fixed re-creates the incident.
- [ ] Let queues drain naturally. Do not bulk-advance delivery state; the
      compare-and-set guards are what make redelivery safe, and bypassing them
      converts a duplicate into a double charge.
- [ ] Confirm the sweep that owns the recovered rows ran, or run it: outbox retry,
      automation due/lease, budget expiry.
- [ ] Reconcile spend. Reservations that were released rather than committed must not
      appear in `cost_records`; `usage_events` is immutable, so a wrong row is
      corrected by a new one, never by an edit.

## Close

- [ ] Timeline: first occurrence, detection, containment, recovery, with deploys
      marked.
- [ ] **Why did detection take as long as it did?** This is the finding that
      usually matters. If a durable row existed and nobody could query it, the fix is
      the runbook or the query, not a reminder.
- [ ] Which of the six Gate D questions could you not answer, and what would have
      answered it?
- [ ] Add a regression test at the smallest layer that can hold the property. If the
      property is a schema invariant, add it to the schema harness so it is a CI
      gate; if it is a projection, add a canary; if it is a statement's tenant
      predicate, the tenant audit will hold it once the statement is classified.
- [ ] Does the runbook need a section for this? Write it now, while you remember.
- [ ] Do not close with a known high. A launch deadline is not mitigation, and an
      incident that is "mostly fixed" is still open.

## Never

- Never edit an `audit` or `usage_events` row to make a number look right. They have
  no UPDATE trigger for exactly this reason.
- Never re-engage a lifted kill switch in place. Lift-and-re-engage is a separate,
  audited act.
- Never bulk-advance a queue or a lease to "clear" a backlog.
- Never roll back a migration to fix data. Migrations here are forward-only and
  create tables; the Worker is what rolls back.
- Never assume a secret leaked just because it was involved. Assume it *did* leak and
  revoke, then prove otherwise. Revocation is cheap; a leaked inference key is not.
