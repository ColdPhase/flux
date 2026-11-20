-- A model id may begin with `/` (#1593): a llama.cpp server started without `--alias` names its model by the file it loaded
-- (`/models/Qwen3.8-27B-UD-Q4_K_XL.gguf`), and that is the id its `/v1/models` lists and its chat endpoint answers to. The id only travels in a
-- JSON body and is shown as text; the rule keeps its purpose: no spaces, controls or quotes, at most 200 characters (AI_MODEL_ID_PATTERN).
-- The three model checks still in the schema widen to it (0015 and 0016 dropped the tables of the other two of the baseline).
--
-- v0.2.1 data: every id the old checks held still matches, so no row changes; adding each check reads its table once.
-- It waits at most 5 s for a table's lock (C-68 (4)): API and worker are stopped during an upgrade, so a wait means another session holds it.
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.background_compute_connections DROP CONSTRAINT background_compute_connections_model_check,
  ADD CONSTRAINT background_compute_connections_model_check CHECK (model ~ '^[A-Za-z0-9/][A-Za-z0-9._:/@+-]{0,199}$');
ALTER TABLE public.assistant_settings DROP CONSTRAINT assistant_settings_model_check,
  ADD CONSTRAINT assistant_settings_model_check CHECK (model IS NULL OR model ~ '^[A-Za-z0-9/][A-Za-z0-9._:/@+-]{0,199}$');
ALTER TABLE public.api_key_checks DROP CONSTRAINT api_key_checks_model_check,
  ADD CONSTRAINT api_key_checks_model_check CHECK (model ~ '^[A-Za-z0-9/][A-Za-z0-9._:/@+-]{0,199}$');
