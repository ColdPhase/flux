-- #1465: the model price lists. One row per list: LiteLLM's (Anthropic, OpenAI and Gemini, fetched daily, or the list the release shipped,
-- stored when the database had none or an older one) and OpenRouter's own (fetched while someone has an OpenRouter key). Each keeps the
-- last list that passed every check until a newer one does. A connection's price from a list is called 'list' (it was 'table', the
-- hand-kept table this replaces). Works on data left by v0.2.0: a new table, and the CHECK of price_source widened, its 'table' rows
-- renamed in place.
CREATE TABLE public.ai_price_lists (
    list text NOT NULL PRIMARY KEY CHECK (list = ANY (ARRAY['litellm'::text, 'openrouter'::text])),
    fetched_on date NOT NULL,
    source text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 2048),
    prices jsonb NOT NULL CHECK (jsonb_typeof(prices) = 'object'),
    stored_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.background_compute_connections DROP CONSTRAINT background_compute_connections_price_source_check;
UPDATE public.background_compute_connections SET price_source = 'list' WHERE price_source = 'table';
ALTER TABLE public.background_compute_connections ADD CONSTRAINT background_compute_connections_price_source_check
  CHECK ((price_source = ANY (ARRAY['list'::text, 'owner'::text])));
