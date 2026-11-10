-- A person's own time zone (#1168, C-57): the IANA zone of the browser they use Flux in, saved by the web app whenever it is a different one.
-- The schedules they ask their agents for run in it, and their agents' clock reads in it. UTC until a browser has said. Flux has no
-- installations or data yet (founder, 2026-10-31).
ALTER TABLE public.auth_users ADD COLUMN time_zone text NOT NULL DEFAULT 'UTC';
