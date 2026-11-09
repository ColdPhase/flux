-- Whether what a run writes may hold an address the server asked for it (#1156, C-30): the address check sets it when the address is asked,
-- while the run's kept text is there, so the list of a run's pages (under its answer, or in the end line of a run without one) is written
-- without it. A page that opened only by its site's path rule is listed defanged. Flux has no installations or data yet (founder,
-- 2026-10-31): rows of earlier runs read as not writable.
ALTER TABLE public.personal_run_web_reads ADD COLUMN writable boolean NOT NULL DEFAULT false;
