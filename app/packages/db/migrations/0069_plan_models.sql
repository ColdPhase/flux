-- #1332 (F-022 amended, CA-2): the models the signed-in Claude Code or Codex offers the account, as the runtime's supervisor last read them.
-- Display facts only (ids, names and one-line notes in the CLI's own words, never a credential), one typed row per model, like the rest of the
-- runtime's tables. `retired`: a model an earlier list had that the latest lacks (the plan stopped offering it); `position` keeps the CLI's order
-- (retired ones follow, oldest first). The connection keeps whether the last reading worked (`unavailable`: the rows are the last known list)
-- and when it was tried, which paces the next one. A new sign-in or a different account clears all of it; the worker's runtime tick reads
-- again. Works on data left by v0.2.0: a new nullable pair of columns and a new table.
ALTER TABLE public.agent_runtime_connections
  ADD COLUMN models_status text CHECK (models_status = ANY (ARRAY['listed', 'unavailable'])),
  ADD COLUMN models_checked_at timestamp with time zone;

CREATE TABLE public.agent_runtime_connection_models (
  connection_id uuid NOT NULL REFERENCES public.agent_runtime_connections(id) ON DELETE CASCADE,
  model_id text NOT NULL CHECK (model_id ~ '^[a-z0-9][a-z0-9.-]{0,63}$'),
  position smallint NOT NULL CHECK (position >= 0),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 200),
  is_default boolean NOT NULL DEFAULT false,
  sees_pictures boolean NOT NULL DEFAULT true,
  retired boolean NOT NULL DEFAULT false,
  PRIMARY KEY (connection_id, model_id)
);
