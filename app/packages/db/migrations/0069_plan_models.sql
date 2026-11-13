-- #1332 (F-022 amended, CA-2): the models the signed-in Claude Code or Codex offers the account, as the runtime's supervisor last read them.
-- Display facts only (ids, names and one-line notes, never a credential): `models` is {"listed": [{id, name, note, default, seesPictures}],
-- "retired": [{id, name}]} (`retired`: models an earlier list had that the latest lacks). `models_status` says whether the last reading worked
-- (`unavailable`: the list is the last known one) and `models_checked_at` when it was tried, which paces the next one. A new sign-in or a
-- different account clears all three; the worker's runtime tick fills them again. Works on data left by v0.2.0: new nullable columns.
ALTER TABLE public.agent_runtime_connections
  ADD COLUMN models jsonb CHECK (pg_column_size(models) <= 65536),
  ADD COLUMN models_status text CHECK (models_status = ANY (ARRAY['listed', 'unavailable'])),
  ADD COLUMN models_checked_at timestamp with time zone;
