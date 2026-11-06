-- #854, #843 (F-036): one Connect AI per person with several connections, no Flux limits, one daily budget per API key.
-- Flux has no installations yet, so nothing is converted: superseded columns are dropped.

-- An API key keeps one daily budget, in its owner's time zone. Its local allowance for background comparisons (requests a
-- day, a 30-day and a per-request allowance), its set-up attestations and its payer labels go.
ALTER TABLE public.background_compute_connections
  DROP COLUMN max_runs_per_day,
  DROP COLUMN period_days,
  DROP COLUMN period_budget_cents,
  DROP COLUMN per_run_cents,
  DROP COLUMN consent_version,
  DROP COLUMN consented_at,
  DROP COLUMN payer_organization,
  DROP COLUMN provider_workspace,
  ADD COLUMN daily_budget_cents integer NOT NULL CHECK (daily_budget_cents BETWEEN 10 AND 100000),
  ADD COLUMN time_zone text NOT NULL DEFAULT 'UTC' CHECK (length(time_zone) BETWEEN 1 AND 64);

-- A comparison rule has no allowance of its own: it counts against the background key's daily budget.
ALTER TABLE public.proactive_comparison_rules
  DROP COLUMN max_runs_per_day,
  DROP COLUMN period_budget_cents,
  DROP COLUMN per_run_cents;

-- The assistant: no consent record per use, no per-request ceiling, no daily cap of its own. It keeps the connection its
-- model belongs to: `connection_id` for an API key, `provider` for the CLI of a plan.
ALTER TABLE public.personal_run_enablements
  DROP COLUMN consent_version,
  DROP COLUMN consented_at,
  DROP COLUMN consent_model,
  DROP COLUMN consent_payer_organization,
  DROP COLUMN consent_payer_workspace,
  DROP COLUMN per_run_cents,
  DROP COLUMN daily_cap_cents,
  DROP COLUMN time_zone;
ALTER TABLE public.personal_run_enablements RENAME COLUMN consent_provider TO provider;
ALTER TABLE public.personal_run_enablements RENAME CONSTRAINT personal_run_enablements_consent_provider_check TO personal_run_enablements_provider_check;
ALTER TABLE public.personal_run_enablements ADD CONSTRAINT personal_run_enablements_server_key_check CHECK ((engine = 'runtime') OR (connection_id IS NOT NULL));

-- No background runs a day.
ALTER TABLE public.assistant_settings DROP COLUMN background_runs_per_day;

-- A request paused by its connection's limit (a plan's limit or the key's daily budget) waits, queued, until `resume_at`.
ALTER TABLE public.personal_runs ADD COLUMN resume_at timestamp with time zone;
ALTER TABLE public.personal_runs ADD CONSTRAINT personal_runs_resume_check CHECK ((resume_at IS NULL) OR (status = ANY (ARRAY['queued', 'stopped', 'paused', 'revoked', 'denied', 'unavailable'])));
-- A run on an API key reserves when the worker starts it, against what is left of the key's day; until then it holds nothing.
ALTER TABLE public.personal_runs DROP CONSTRAINT personal_runs_reserved_micros_check;
ALTER TABLE public.personal_runs ADD CONSTRAINT personal_runs_reserved_micros_check CHECK (reserved_micros >= 0);
ALTER TABLE public.personal_runs DROP CONSTRAINT personal_runs_end_reason_check;
ALTER TABLE public.personal_runs ADD CONSTRAINT personal_runs_end_reason_check CHECK (end_reason = ANY (ARRAY[
  'sign_in_again', 'plan_limit', 'wall_clock', 'no_event', 'crashed', 'answer_too_large', 'mcp_results_too_large', 'local_tool',
  'slot_busy', 'unknown', 'max_turns', 'refused', 'model_unavailable', 'ai_off', 'budget', 'credits']));
CREATE INDEX personal_runs_resume_idx ON public.personal_runs (resume_at) WHERE status = 'queued' AND resume_at IS NOT NULL;
-- A key's day counts money when it is held, not when the request was asked: a request can wait overnight. A run lost with
-- its worker counts what it had spent and the most one more request could have cost, never its whole reservation.
ALTER TABLE public.personal_runs
  ADD COLUMN reserved_at timestamp with time zone NOT NULL DEFAULT now(),
  ADD COLUMN largest_request_micros integer CHECK (largest_request_micros >= 0);
CREATE INDEX personal_runs_key_day_idx ON public.personal_runs (connection_id, reserved_at) WHERE engine = 'server';

-- The provider's remaining usage of a plan, as last seen (display facts only, never a credential): the share of the
-- most-used window left, which window, when it resets, and whether the limit was reached.
ALTER TABLE public.agent_runtime_connections
  ADD COLUMN usage_left_percent smallint CHECK (usage_left_percent BETWEEN 0 AND 100),
  ADD COLUMN usage_window text CHECK (usage_window = ANY (ARRAY['five_hour', 'weekly'])),
  ADD COLUMN usage_resets_at timestamp with time zone,
  ADD COLUMN usage_limit_reached boolean NOT NULL DEFAULT false,
  ADD COLUMN usage_read_at timestamp with time zone;

-- A reaction has no runs a day of its own (#843).
ALTER TABLE public.assistant_reactions DROP COLUMN daily_limit;
