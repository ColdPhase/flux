-- An API-key run that never reached Flux's model gateway ends `gateway_unreachable` (#1556), not `crashed` reported as a provider failure.
-- v0.2.2's migrations are 0100 to 0110; 0096–0099, 0102 and 0108 were never used, and the migrator applies the files there are, in order.
-- Existing runs keep their end reasons; only the allowed set grows.
-- It waits at most 5 s for a table's lock (C-68 (4)): API and worker are stopped during an upgrade, so a wait means another session holds it.
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.personal_runs DROP CONSTRAINT personal_runs_end_reason_check;
ALTER TABLE public.personal_runs ADD CONSTRAINT personal_runs_end_reason_check CHECK (end_reason = ANY (ARRAY[
  'sign_in_again', 'plan_limit', 'wall_clock', 'no_event', 'crashed', 'answer_too_large', 'mcp_results_too_large', 'local_tool',
  'slot_busy', 'unknown', 'max_turns', 'refused', 'model_unavailable', 'ai_off', 'budget', 'credits', 'no_room', 'gateway_unreachable']));
