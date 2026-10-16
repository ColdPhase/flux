-- F-022 T5 / F-027 A2 (#280, #484): the assistant's engine, its run token and the runtime run's own end states.
--
-- An enablement names its engine: `server` (the owner's API key connection, F-020) or `runtime` (the owner's
-- own signed-in Claude Code in their runtime slot, F-022 AIM-3), whose consent is its own disclosure. A
-- runtime run reserves no money: its caps are runs per day, the serial lane, two timeouts, turns, MCP result
-- size and answer size.
ALTER TABLE personal_run_enablements
  ADD COLUMN engine text NOT NULL DEFAULT 'server' CHECK (engine IN ('server', 'runtime')),
  DROP CONSTRAINT personal_run_enablements_consent_version_check,
  ADD CONSTRAINT personal_run_enablements_consent_version_check
    CHECK (consent_version IN ('o-008-2026-09-28', 'o-008-2026-10-02', 'f-022-runtime-2026-10-16')),
  ADD CONSTRAINT personal_run_enablements_engine_consent_check
    CHECK ((engine = 'runtime') = (consent_version = 'f-022-runtime-2026-10-16')),
  ADD CONSTRAINT personal_run_enablements_runtime_connection_check
    CHECK (engine = 'server' OR connection_id IS NULL);

-- The run token is never stored: only the hash of the worker's one-time minting nonce, the token's id
-- (`jti`), its expiry and the exact tools it was minted for. The MCP route accounts the bytes tool
-- results returned to it and records which of its result bounds a call hit.
ALTER TABLE personal_runs
  ADD COLUMN engine text NOT NULL DEFAULT 'server' CHECK (engine IN ('server', 'runtime')),
  ADD COLUMN end_reason text CHECK (end_reason IN ('sign_in_again', 'plan_limit', 'wall_clock', 'no_event', 'crashed',
    'answer_too_large', 'mcp_results_too_large', 'local_tool', 'slot_busy', 'unknown', 'max_turns', 'refused')),
  ADD COLUMN plan_limit_resets_at timestamptz,
  ADD COLUMN stop_acknowledged_at timestamptz,
  ADD COLUMN answer_redacted boolean NOT NULL DEFAULT false,
  ADD COLUMN run_token_nonce_hash text CHECK (run_token_nonce_hash ~ '^[0-9a-f]{64}$'),
  ADD COLUMN run_token_jti uuid,
  ADD COLUMN run_token_expires_at timestamptz,
  ADD COLUMN run_token_closed_at timestamptz,
  ADD COLUMN run_tools text[] NOT NULL DEFAULT '{}' CHECK (cardinality(run_tools) <= 32),
  ADD COLUMN mcp_result_bytes integer NOT NULL DEFAULT 0 CHECK (mcp_result_bytes >= 0),
  ADD COLUMN mcp_limit text CHECK (mcp_limit IN ('call', 'run')),
  DROP CONSTRAINT personal_runs_reserved_micros_check,
  ADD CONSTRAINT personal_runs_reserved_micros_check CHECK (reserved_micros > 0 OR (engine = 'runtime' AND reserved_micros = 0)),
  ADD CONSTRAINT personal_runs_run_token_check CHECK ((run_token_jti IS NULL) = (run_token_expires_at IS NULL)),
  ADD CONSTRAINT personal_runs_plan_limit_check CHECK (plan_limit_resets_at IS NULL OR end_reason = 'plan_limit');
