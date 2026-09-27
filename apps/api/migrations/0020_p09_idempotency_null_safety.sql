-- P09: a completed idempotency record must carry a status, and a CHECK cannot say so.
--
-- FOUND BY: the P09 verification campaign (VI-IDEM-001 / VI-TEST-001), which
-- mutated the idempotency upsert and found the storage-invariant harness had no
-- case for this table at all. Adding the cases then exposed the hole below.
--
-- `idempotency_records` is the substrate that makes every mutating route safe to
-- retry, so "a completed record has no response" is exactly the kind of state that
-- must be unrepresentable. The table's own CHECK tries to say so:
--
--     CHECK (
--         (state = 'pending'  AND response_status IS NULL AND ...)
--      OR (state = 'completed' AND response_status BETWEEN 200 AND 299 AND ...)
--     )
--
-- The pending branch is safe: `IS NULL` is a definite test. The completed branch is
-- not. With `response_status` NULL, `BETWEEN 200 AND 299` evaluates to NULL rather
-- than false, the OR becomes `0 OR NULL` = NULL, and a SQLite CHECK constraint
-- fails only on a definite false -- it PASSES on NULL. So:
--
--     INSERT ... state='completed', response_status=NULL, response_body='{}'
--
-- is accepted by the database. Probed directly, not inferred: status 200 accepted,
-- status 500 rejected, status NULL accepted.
--
-- The consequence is a record that claims a request completed and carries no result.
-- A retrying client is served a NULL status, and the idempotency layer reports a
-- settled request that settled to nothing.
--
-- A trigger rather than a rebuilt table, deliberately:
--
--   * SQLite cannot ALTER a CHECK constraint, so closing this in the table means
--     create-copy-drop-rename. That would be the first migration in this repository
--     to alter a table created by an earlier phase, and the release schema map's
--     rollback argument depends on no migration doing that. Trading that property
--     for one NULL-safety gap would be a bad trade.
--   * A trigger is the only thing that still holds when nobody remembers the Rust,
--     which is the same reason the 0001-era CHECKs are being kept rather than
--     replaced. The CHECK stays as the fast path and the documented intent; the
--     trigger closes the one clause the CHECK cannot express.
--   * The trigger is additive, so old and new Workers remain schema-compatible in
--     both directions and a rollback needs no down-migration.
--
-- Written with explicit `IS NULL` tests rather than `BETWEEN`, because the entire
-- point is that `BETWEEN` on a NULL column is not a test.

CREATE TRIGGER trg_idempotency_completed_requires_status
BEFORE INSERT ON idempotency_records
FOR EACH ROW
WHEN NEW.state = 'completed'
 AND (
        NEW.response_status IS NULL
     OR NEW.response_status NOT BETWEEN 200 AND 299
 )
BEGIN
    SELECT RAISE(ABORT, 'a completed idempotency record requires a 2xx response_status');
END;

-- The same rule on UPDATE, because a row can be moved pending -> completed by the
-- finalize path, and a trigger that only watched INSERT would let the finalize
-- write the very state the INSERT trigger refuses.
--
-- `BEFORE UPDATE OF state, response_status` is the wrong shape here: it would not
-- fire on an update that changed neither column, which is fine, but it would also
-- not fire on an update that changed response_status alone unless response_status
-- were listed -- so the two columns are both listed AND the WHEN clause is written
-- against NEW values, which is what makes it independent of which column moved.
CREATE TRIGGER trg_idempotency_completed_requires_status_update
BEFORE UPDATE ON idempotency_records
FOR EACH ROW
WHEN NEW.state = 'completed'
 AND (
        NEW.response_status IS NULL
     OR NEW.response_status NOT BETWEEN 200 AND 299
 )
BEGIN
    SELECT RAISE(ABORT, 'a completed idempotency record requires a 2xx response_status');
END;

-- The mirror image, for the same reason: the pending branch is NULL-safe in the
-- CHECK only because every clause is an `IS NULL`/`IS NOT NULL` test. Guard it
-- explicitly so a future edit to the CHECK cannot quietly open the other half.
CREATE TRIGGER trg_idempotency_pending_has_no_result
BEFORE INSERT ON idempotency_records
FOR EACH ROW
WHEN NEW.state = 'pending'
 AND (
        NEW.response_status IS NOT NULL
     OR NEW.response_body IS NOT NULL
     OR NEW.claim_token IS NULL
 )
BEGIN
    SELECT RAISE(ABORT, 'a pending idempotency record carries no result and must hold a claim token');
END;

CREATE TRIGGER trg_idempotency_pending_has_no_result_update
BEFORE UPDATE ON idempotency_records
FOR EACH ROW
WHEN NEW.state = 'pending'
 AND (
        NEW.response_status IS NOT NULL
     OR NEW.response_body IS NOT NULL
     OR NEW.claim_token IS NULL
 )
BEGIN
    SELECT RAISE(ABORT, 'a pending idempotency record carries no result and must hold a claim token');
END;
