-- Optional local embeddings: a vector per searchable row, for hybrid ranking next to BM25 (F-042, #1242, #1294).
--
-- Off by default and empty while off. Nothing here costs anything until the worker finds FLUX_EMBEDDINGS_URL (the optional
-- compose.embeddings.yaml overlay: a local text-embeddings-inference container running bge-m3): it then writes the one
-- `search_vector_state` row, which switches the triggers below on, queues every eligible row and embeds the queue. Without
-- that row every trigger returns at once, so a stack that never turns embeddings on writes no row to any of these tables and
-- sends no NOTIFY. Turning them off again deletes the row and empties both tables.
--
-- A vector follows its row in the writer's own transaction: an edit of the title or body drops the vector (and queues the new
-- words), a delete takes it with it (the foreign key), a row that becomes sealed (an encrypted space) loses it, and turning a
-- space's AI off drops its vectors. Rows that may not be embedded are never queued: sealed placeholders (encrypted spaces, no
-- text), a space whose AI is off (AG-10: its content reaches no model, search included), people's names, and rows without text.
-- The embedder is the operator's own container, so nothing is ever embedded through a person's own connection.
--
-- Works on the data of any release from v0.2.0 on: it adds tables and triggers, and rewrites nothing.
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;

-- One row while embeddings are on: the model that made the vectors (a vector of another model is no neighbour of these).
CREATE TABLE public.search_vector_state (
    only_row boolean DEFAULT true NOT NULL,
    model text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT search_vector_state_pkey PRIMARY KEY (only_row),
    CONSTRAINT search_vector_state_only_row CHECK (only_row)
);

-- bge-m3's 1,024 dimensions, cosine distance (the model's vectors are normalised), at half precision and kept in the row (2 KiB, not
-- TOASTed): ranked search computes the exact distance of every row the caller may see (no approximate index, whose graph would hold the
-- rows they may not; F-042), and a row read whole is about four times faster than a full-precision vector read from TOAST.
CREATE TABLE public.search_vectors (
    document_id bigint NOT NULL REFERENCES public.search_documents(id) ON DELETE CASCADE,
    embedding public.halfvec(1024) STORAGE PLAIN NOT NULL,
    CONSTRAINT search_vectors_pkey PRIMARY KEY (document_id)
);

-- Rows waiting for a vector. The worker wakes on the NOTIFY below and polls nothing.
CREATE TABLE public.search_vector_queue (
    document_id bigint NOT NULL REFERENCES public.search_documents(id) ON DELETE CASCADE,
    queued_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT search_vector_queue_pkey PRIMARY KEY (document_id)
);
CREATE INDEX search_vector_queue_order_idx ON public.search_vector_queue (queued_at, document_id);

-- Whether a row may have a vector now. The one rule for the triggers, the backfill and the worker's claim.
CREATE FUNCTION public.search_vector_eligible(p_kind text, p_sealed boolean, p_title text, p_body text, p_project uuid) RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
  SELECT NOT p_sealed AND p_kind <> 'person' AND (btrim(p_title) <> '' OR btrim(p_body) <> '')
    AND (p_project IS NULL OR EXISTS (SELECT 1 FROM project_ai_policies a WHERE a.project_id = p_project AND a.state = 'allowed'))
$$;

-- A row is inserted or its words change: the old vector goes, the row is queued when it may be embedded.
CREATE FUNCTION public.search_vector_sync() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM search_vector_state) THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' THEN
    DELETE FROM search_vectors WHERE document_id = NEW.id;
    DELETE FROM search_vector_queue WHERE document_id = NEW.id;
  END IF;
  IF search_vector_eligible(NEW.kind, NEW.sealed, NEW.title, NEW.body, NEW.project_id) THEN
    INSERT INTO search_vector_queue (document_id) VALUES (NEW.id) ON CONFLICT DO NOTHING;
    PERFORM pg_notify('flux_search_vectors', '');
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER search_vector_insert AFTER INSERT ON public.search_documents FOR EACH ROW EXECUTE FUNCTION public.search_vector_sync();
CREATE TRIGGER search_vector_update AFTER UPDATE ON public.search_documents FOR EACH ROW
  WHEN (OLD.title IS DISTINCT FROM NEW.title OR OLD.body IS DISTINCT FROM NEW.body OR OLD.sealed IS DISTINCT FROM NEW.sealed
    OR OLD.project_id IS DISTINCT FROM NEW.project_id OR OLD.kind IS DISTINCT FROM NEW.kind)
  EXECUTE FUNCTION public.search_vector_sync();

-- A space's AI is turned off: its vectors go in the same transaction. Turned on: its rows are queued.
CREATE FUNCTION public.search_vector_space_ai() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM search_vector_state) THEN RETURN NULL; END IF;
  IF NEW.state = 'allowed' THEN
    INSERT INTO search_vector_queue (document_id)
      SELECT d.id FROM search_documents d
      WHERE d.project_id = NEW.project_id AND search_vector_eligible(d.kind, d.sealed, d.title, d.body, d.project_id)
      ON CONFLICT DO NOTHING;
    PERFORM pg_notify('flux_search_vectors', '');
  ELSE
    DELETE FROM search_vectors WHERE document_id IN (SELECT d.id FROM search_documents d WHERE d.project_id = NEW.project_id);
    DELETE FROM search_vector_queue WHERE document_id IN (SELECT d.id FROM search_documents d WHERE d.project_id = NEW.project_id);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER search_vector_space_ai AFTER UPDATE OF state ON public.project_ai_policies FOR EACH ROW
  WHEN (OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION public.search_vector_space_ai();
