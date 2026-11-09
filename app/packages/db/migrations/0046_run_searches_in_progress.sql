-- A search of the owner's own Claude Code (#1065, C-30, RT-5): the runtime reports a `WebSearch` when the CLI starts it and again when its
-- results come back. The worker writes the first as a row in progress (`pending`, with the query) and fills in its results with the
-- second; a run's `flux_read_web` call for an address it cannot read yet waits while the run has a search in progress. A search of an
-- API-key run is written once, when the provider's answer comes back, and is never in progress. Flux has no installations or data yet
-- (founder, 2026-10-31): nothing is converted.
ALTER TABLE public.personal_run_web_searches ADD COLUMN pending boolean DEFAULT false NOT NULL;
