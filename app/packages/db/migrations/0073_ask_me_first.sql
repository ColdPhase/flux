-- #1419 (founder decision, Hubert, 2026-11-13): an agent's and a local client's "What it may do" is one switch, Ask me first. "Only read" is
-- gone; a connection left on it by v0.2.0 is set to Ask me first, so nothing it does applies without its owner's OK (the mapping recorded in
-- AG-3). `act` is the switch off (Do it and tell me), `ask` is on.
UPDATE public.agent_connections SET may_do = 'ask' WHERE may_do = 'read';
ALTER TABLE public.agent_connections DROP CONSTRAINT agent_connections_may_do_check;
ALTER TABLE public.agent_connections ADD CONSTRAINT agent_connections_may_do_check CHECK (may_do = ANY (ARRAY['act'::text, 'ask'::text]));
