-- Guarded reversal of 0111 (#153, #400). Not applied by the migrator and never edits the schema ledger: a reversal runner owns that.
-- It refuses (and changes nothing) while any project requires reviews by another owner: dropping the table would silently
-- loosen that rule. Otherwise it forgets who cancelled requests (the requests stay cancelled) and the explicit default choices.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cowork_review_policies WHERE review_separation = 'distinct_owner') THEN
    RAISE EXCEPTION '0111 reversal refused: a project requires reviews by another owner' USING ERRCODE = 'restrict_violation';
  END IF;
END $$;
DROP TABLE cowork_review_policies;
ALTER TABLE cowork_requests DROP COLUMN cancelled_by;
