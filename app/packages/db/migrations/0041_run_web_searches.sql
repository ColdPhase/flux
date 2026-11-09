-- The searches of an agent's run (#954, founder direction 2026-11-08, C-29, C-30): the provider's own built-in web search (Anthropic's
-- `web_search`, OpenAI's Responses `web_search`). The worker writes one row for each provider answer that searched the web or cites a
-- search result, BEFORE any tool call of that answer runs: `results` (the addresses the search returned) and `cited` (the addresses the
-- answer cites) are then addresses the same run's `flux_read_web` may read, and no other run's; `queries` and `cited` are listed under the
-- run's answer, or in its end line when it has none. Addresses are normalized (no fragment). No page text is kept. Flux has no
-- installations or data yet (founder, 2026-10-31): nothing is converted.
CREATE TABLE public.personal_run_web_searches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    run_id uuid NOT NULL,
    queries text[] DEFAULT '{}' NOT NULL,
    results text[] DEFAULT '{}' NOT NULL,
    cited text[] DEFAULT '{}' NOT NULL,
    searched_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT personal_run_web_searches_pkey PRIMARY KEY (id),
    CONSTRAINT personal_run_web_searches_run_fkey FOREIGN KEY (run_id) REFERENCES public.personal_runs(id) ON DELETE CASCADE,
    CONSTRAINT personal_run_web_searches_size_check CHECK (cardinality(queries) <= 10 AND cardinality(results) <= 100 AND cardinality(cited) <= 100)
);
CREATE INDEX personal_run_web_searches_run_idx ON public.personal_run_web_searches USING btree (run_id, searched_at);
