-- AI off in a direct message, and local embeddings are an index, not AI (C-73, #1591; founder decisions, Hubert, 2026-11-20).
--
-- 1. `dm_ai_off`: each participant's own "Turn off AI in this conversation". AI is off in a conversation while it has a row; each person
--    adds and deletes only their own, so nobody overrides another's "no AI". The row belongs to the person's place in the conversation: when
--    they leave it (or the company), their choice goes with them.
-- 2. The conversation's lines of those changes ("Marek turned off AI in this conversation", "Marek turned AI back on") are rows of
--    `dm_messages` like the line "used AI here": `kind` `ai_off` and `ai_on`, no message to read, search, notify or count as unread (every
--    reader of messages already keeps to `kind = 'text'`).
-- 3. The optional local embedder is an index like BM25, not an AI company ("Embeddingi to u nas lokalnie, a nie zewnętrzna firma, więc
--    powinno trafiać — po prostu modele AI z tego nie powinny korzystać"): a space or a conversation with AI off is embedded like any other
--    place, and agents are kept out of it by the access check of each search. This replaces 0068's rule that a space whose AI is off has no
--    vectors: the switch's trigger goes, and while embeddings are on the rows of spaces whose AI is off are queued (the worker embeds the queue
--    in its usual batches).
--
-- v0.2.1 data: the table is new and empty, so no conversation is off after the upgrade; the kind and body checks only widen; the vector change
-- writes nothing on an installation that never turned embeddings on (no `search_vector_state` row).
-- It waits at most 5 s for a table's lock (C-68 (4)): API and worker are stopped during an upgrade, so a wait means another session holds it.
SET LOCAL lock_timeout = '5s';

CREATE TABLE public.dm_ai_off (
    workspace_id uuid NOT NULL,
    dm_id uuid NOT NULL,
    user_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT dm_ai_off_pkey PRIMARY KEY (dm_id, user_id),
    CONSTRAINT dm_ai_off_participant_fkey FOREIGN KEY (dm_id, user_id) REFERENCES public.dm_participants(dm_id, user_id) ON DELETE CASCADE
);

-- A change's line names who still keeps AI off in its body, which is empty once AI is on again.
ALTER TABLE public.dm_messages DROP CONSTRAINT dm_messages_kind_check, DROP CONSTRAINT dm_messages_body_check;
ALTER TABLE public.dm_messages ADD CONSTRAINT dm_messages_kind_check CHECK (kind = ANY (ARRAY['text', 'ai_used', 'ai_off', 'ai_on'])),
  ADD CONSTRAINT dm_messages_body_check CHECK (
    public.flux_is_sealed(body) OR (length(btrim(body)) <= 100000 AND (length(btrim(body)) >= 1 OR attachment_count > 0 OR kind IN ('ai_off', 'ai_on'))));

CREATE OR REPLACE FUNCTION public.search_vector_eligible(p_kind text, p_sealed boolean, p_title text, p_body text, p_project uuid) RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
  SELECT NOT p_sealed AND p_kind <> 'person' AND (btrim(p_title) <> '' OR btrim(p_body) <> '')
$$;

DROP TRIGGER search_vector_space_ai ON public.project_ai_policies;
DROP FUNCTION public.search_vector_space_ai();

INSERT INTO search_vector_queue (document_id)
SELECT d.id FROM search_documents d
WHERE EXISTS (SELECT 1 FROM search_vector_state)
  AND d.project_id IN (SELECT a.project_id FROM project_ai_policies a WHERE a.state <> 'allowed')
  AND search_vector_eligible(d.kind, d.sealed, d.title, d.body, d.project_id)
  AND NOT EXISTS (SELECT 1 FROM search_vectors v WHERE v.document_id = d.id)
ON CONFLICT DO NOTHING;
SELECT pg_notify('flux_search_vectors', '');
