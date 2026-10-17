-- A rollback cannot keep a run listing more tools than 0100 allowed; such runs must have ended and been removed.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM personal_runs WHERE cardinality(run_tools) > 32) THEN
    RAISE EXCEPTION 'Runs listing more than 32 tools must be removed before reversing 0104';
  END IF;
END $$;
ALTER TABLE personal_runs DROP CONSTRAINT personal_runs_run_tools_check,
  ADD CONSTRAINT personal_runs_run_tools_check CHECK (cardinality(run_tools) <= 32);
DROP TABLE assistant_changes;
