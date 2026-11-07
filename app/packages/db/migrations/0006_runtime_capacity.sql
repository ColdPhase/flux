-- #860: one runtime serves everyone. A slot row is a runtime that any number of people bind to, so it is no longer held or wiped
-- for one person, and it reports how many agents it runs at once. A request that finds no room waits, queued, with end reason
-- `no_room`.
DROP INDEX public.agent_runtime_bindings_slot_live_idx;
CREATE INDEX agent_runtime_bindings_slot_live_idx ON public.agent_runtime_bindings USING btree (slot) WHERE (state <> 'released'::text);

ALTER TABLE public.agent_runtime_slots DROP CONSTRAINT agent_runtime_slots_wiping_check;
ALTER TABLE public.agent_runtime_slots DROP CONSTRAINT agent_runtime_slots_state_check;
ALTER TABLE public.agent_runtime_slots DROP CONSTRAINT agent_runtime_slots_out_of_pool_reason_check;
ALTER TABLE public.agent_runtime_slots DROP COLUMN wipe_boot_id;
ALTER TABLE public.agent_runtime_slots ADD COLUMN capacity smallint;
ALTER TABLE public.agent_runtime_slots ADD CONSTRAINT agent_runtime_slots_state_check CHECK (state = ANY (ARRAY['unknown'::text, 'ready'::text, 'out_of_pool'::text]));
ALTER TABLE public.agent_runtime_slots ADD CONSTRAINT agent_runtime_slots_out_of_pool_reason_check CHECK (out_of_pool_reason = ANY (ARRAY['data_not_empty'::text, 'missing'::text]));
ALTER TABLE public.agent_runtime_slots ADD CONSTRAINT agent_runtime_slots_capacity_check CHECK (capacity IS NULL OR capacity >= 1);

ALTER TABLE public.personal_runs DROP CONSTRAINT personal_runs_end_reason_check;
ALTER TABLE public.personal_runs ADD CONSTRAINT personal_runs_end_reason_check CHECK (end_reason = ANY (ARRAY[
  'sign_in_again', 'plan_limit', 'wall_clock', 'no_event', 'crashed', 'answer_too_large', 'mcp_results_too_large', 'local_tool',
  'slot_busy', 'unknown', 'max_turns', 'refused', 'model_unavailable', 'ai_off', 'budget', 'credits', 'no_room']));
