-- A rollback forgets the chosen models (an assistant then runs with the account's own default) and records a run that
-- ended because the vendor did not accept its model as the generic refusal.
UPDATE personal_runs SET end_reason = 'refused' WHERE end_reason = 'model_unavailable';
ALTER TABLE personal_runs
  DROP CONSTRAINT personal_runs_end_reason_check,
  ADD CONSTRAINT personal_runs_end_reason_check CHECK (end_reason IN ('sign_in_again', 'plan_limit', 'wall_clock', 'no_event', 'crashed',
    'answer_too_large', 'mcp_results_too_large', 'local_tool', 'slot_busy', 'unknown', 'max_turns', 'refused'));
ALTER TABLE personal_run_enablements DROP COLUMN assistant_model;
