-- Direct-message sketches and their promotion go (#947, follow-up to #866). A direct message has no maps; a map is a
-- space's map or the person's one private map. There is no existing data to keep.

-- A thought no longer starts from a direct message. Its columns, with their keys and checks, go; a project message
-- source keeps its rule that it names a time and exactly one author.
ALTER TABLE public.sketch_thoughts DROP COLUMN source_dm_id, DROP COLUMN source_message_id;
ALTER TABLE public.sketch_thoughts ADD CONSTRAINT sketch_thoughts_source_project_message_check
  CHECK (source_project_message_id IS NULL OR (source_sent_at IS NOT NULL AND num_nonnulls(source_author_id, source_author_agent_id) = 1));

-- The search index no longer files a map or a thought under a direct message.
CREATE OR REPLACE FUNCTION public.search_index_sketch() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM search_documents WHERE doc_key = 'sketch:' || OLD.id;
    RETURN OLD;
  END IF;
  PERFORM search_put('sketch:' || NEW.id, 'sketch', NEW.workspace_id, 'sketch:' || NEW.id, NEW.project_id, NEW.id::text, NULL, NULL,
    NEW.scope, NEW.title, '', CASE WHEN NEW.created_by_user_id IS NOT NULL THEN 'human' WHEN NEW.created_by_agent_id IS NOT NULL THEN 'agent' END,
    coalesce(NEW.created_by_user_id, NEW.created_by_agent_id::text), NEW.updated_at);
  IF TG_OP = 'UPDATE' AND NEW.project_id IS DISTINCT FROM OLD.project_id THEN
    UPDATE search_documents SET project_id = NEW.project_id WHERE parent_id = NEW.id AND kind = 'thought';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.search_index_thought() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN DELETE FROM search_documents WHERE doc_key = 'thought:' || OLD.id; RETURN OLD; END IF;
  -- Moving a thought on the map changes nothing that can be searched.
  IF TG_OP = 'UPDATE' AND NEW.text IS NOT DISTINCT FROM OLD.text THEN RETURN NEW; END IF;
  PERFORM search_put('thought:' || NEW.id, 'thought', NEW.workspace_id, 'sketch:' || NEW.sketch_id,
    (SELECT s.project_id FROM sketches s WHERE s.id = NEW.sketch_id), NEW.id::text, NEW.sketch_id, NULL, NULL, NEW.text, '',
    CASE WHEN NEW.created_by_user_id IS NOT NULL THEN 'human' WHEN NEW.created_by_agent_id IS NOT NULL THEN 'agent' END,
    coalesce(NEW.created_by_user_id, NEW.created_by_agent_id::text), NEW.updated_at);
  RETURN NEW;
END $$;

DROP INDEX public.search_documents_dm_idx;
ALTER TABLE public.search_documents DROP COLUMN dm_id;

-- A map is a space's or private. The copy of a direct-message map into a space, and the direct message it belonged to, go.
-- The columns' own checks, keys and indexes go with them.
ALTER TABLE public.sketches DROP CONSTRAINT sketches_scope_check;
ALTER TABLE public.sketches DROP COLUMN dm_id, DROP COLUMN copied_from_sketch_id, DROP COLUMN copied_by_user_id, DROP COLUMN copied_at;
ALTER TABLE public.sketches ADD CONSTRAINT sketches_scope_check CHECK (scope IN ('project', 'private'));

-- One private map for each person in a company ("My map"). A second one is refused here, whatever asks.
CREATE UNIQUE INDEX sketches_one_private_map_idx ON public.sketches USING btree (workspace_id, created_by_user_id) WHERE (scope = 'private');

-- The words the event record had for the copy.
DELETE FROM public.event_data_tokens WHERE token IN ('copied_from_dm', 'copied_to_project');
