-- A rollback cannot turn a runtime enablement or run into an API-key one: its consent named another payer
-- and its runs reserved nothing. The operator removes runtime assistants and their runs first.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM personal_run_enablements WHERE engine = 'runtime')
    OR EXISTS (SELECT 1 FROM personal_runs WHERE engine = 'runtime') THEN
    RAISE EXCEPTION 'Runtime assistants and their runs must be removed before reversing 0098';
  END IF;
END $$;
ALTER TABLE personal_runs
  DROP CONSTRAINT personal_runs_plan_limit_check,
  DROP CONSTRAINT personal_runs_run_token_check,
  DROP CONSTRAINT personal_runs_reserved_micros_check,
  ADD CONSTRAINT personal_runs_reserved_micros_check CHECK (reserved_micros > 0),
  DROP COLUMN mcp_limit,
  DROP COLUMN mcp_result_bytes,
  DROP COLUMN run_tools,
  DROP COLUMN run_token_closed_at,
  DROP COLUMN run_token_expires_at,
  DROP COLUMN run_token_jti,
  DROP COLUMN run_token_nonce_hash,
  DROP COLUMN answer_redacted,
  DROP COLUMN stop_acknowledged_at,
  DROP COLUMN plan_limit_resets_at,
  DROP COLUMN end_reason,
  DROP COLUMN engine;
ALTER TABLE personal_run_enablements
  DROP CONSTRAINT personal_run_enablements_runtime_connection_check,
  DROP CONSTRAINT personal_run_enablements_engine_consent_check,
  DROP CONSTRAINT personal_run_enablements_consent_version_check,
  ADD CONSTRAINT personal_run_enablements_consent_version_check
    CHECK (consent_version IN ('o-008-2026-09-28', 'o-008-2026-10-02')),
  DROP COLUMN engine;
