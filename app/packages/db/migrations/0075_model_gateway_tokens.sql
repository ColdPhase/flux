-- #1441: the model gateway. A run on an API key in the agent runtime holds a gateway token instead of the key; the worker keeps only the
-- token's SHA-256 and expiry on the run, finds the run by it on every model request, and clears both when the token closes (the run ended).
-- Works on data left by v0.2.0: two new nullable columns and a unique index over the rows that have one; nothing to convert.
ALTER TABLE public.personal_runs
  ADD COLUMN gateway_token_hash text CHECK (gateway_token_hash ~ '^[0-9a-f]{64}$'),
  ADD COLUMN gateway_token_expires_at timestamp with time zone,
  ADD CONSTRAINT personal_runs_gateway_token_check CHECK ((gateway_token_hash IS NULL) = (gateway_token_expires_at IS NULL));

CREATE UNIQUE INDEX personal_runs_gateway_token_idx ON public.personal_runs (gateway_token_hash) WHERE gateway_token_hash IS NOT NULL;
