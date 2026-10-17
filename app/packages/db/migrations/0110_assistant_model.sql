-- 0110 (F-027 AST-11, #596): the assistant's model.
--  * `personal_run_enablements.assistant_model`: the one model the owner chose for the assistant (an id from the account's
--    list: a Claude Code alias, a Codex model id or an API model id). NULL means none chosen: an assistant turned on before
--    this runs exactly as before, with the account's own default and no model flag.
--  * `personal_runs.end_reason` gains `model_unavailable`: the vendor did not accept the chosen model. Nothing was changed,
--    no other model is tried and the setting stays.
-- A run already records its model (`personal_runs.model`, 0024), which is fixed when the request is sent.
ALTER TABLE personal_run_enablements
  ADD COLUMN assistant_model text CHECK (assistant_model IS NULL OR assistant_model ~ '^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$');
ALTER TABLE personal_runs
  DROP CONSTRAINT personal_runs_end_reason_check,
  ADD CONSTRAINT personal_runs_end_reason_check CHECK (end_reason IN ('sign_in_again', 'plan_limit', 'wall_clock', 'no_event', 'crashed',
    'answer_too_large', 'mcp_results_too_large', 'local_tool', 'slot_busy', 'unknown', 'max_turns', 'refused', 'model_unavailable'));
