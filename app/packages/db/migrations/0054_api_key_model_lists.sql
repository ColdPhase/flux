-- An API key's models come from its provider, read with that key (CA-2, #1218). Each key keeps the last list its provider gave
-- (`listed_models`: id, display name, family, release date), when that was read and when the last attempt was and how it ended (the
-- 6-hour freshness and Try again), the prices its owner entered for models Flux's table does not price, and the models that were in an
-- earlier list and are no longer offered (their agents pause until another model is chosen; nothing switches by itself). A key added
-- before v0.2.1 has none of these: its picker shows only the key's own model until its first listing (Flux keeps no list of its own).
ALTER TABLE public.background_compute_connections
  ADD COLUMN listed_models jsonb,
  ADD COLUMN models_listed_at timestamp with time zone,
  ADD COLUMN models_checked_at timestamp with time zone,
  ADD COLUMN models_list_status text,
  ADD COLUMN model_prices jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN retired_models text[] NOT NULL DEFAULT '{}'::text[],
  ADD CONSTRAINT background_compute_connections_models_list_status_check
    CHECK (models_list_status IS NULL OR models_list_status = ANY (ARRAY['listed'::text, 'key_refused'::text, 'unavailable'::text, 'refused'::text]));
