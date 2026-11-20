-- An API-key run that never reached Flux's model gateway ends `gateway_unreachable` (#1556), not `crashed` reported as a provider failure.
-- 0096–0099 belong to other changes of v0.2.2 (assigned by the coordinator), so a gap is expected until they land.
-- Existing runs keep their end reasons; only the allowed set grows.
ALTER TABLE public.personal_runs DROP CONSTRAINT personal_runs_end_reason_check;
ALTER TABLE public.personal_runs ADD CONSTRAINT personal_runs_end_reason_check CHECK (end_reason = ANY (ARRAY[
  'sign_in_again', 'plan_limit', 'wall_clock', 'no_event', 'crashed', 'answer_too_large', 'mcp_results_too_large', 'local_tool',
  'slot_busy', 'unknown', 'max_turns', 'refused', 'model_unavailable', 'ai_off', 'budget', 'credits', 'no_room', 'gateway_unreachable']));
