-- Sketches bound to a direct message (issue #96). A `dm` sketch references its DM through a
-- composite foreign key (never a copied participant list), so its audience is exactly the DM's
-- current participants, decided by the access policy (packages/core/src/access/policy.ts).
-- Deleting the DM deletes its sketches. Thoughts may carry the message they were started from.
-- A project copy of a DM sketch keeps the author and time of each source message but no
-- reference into the DM, so nothing in the DM syncs into it. See docs/development/sketches.md.

ALTER TABLE sketches DROP CONSTRAINT sketches_scope_check;
ALTER TABLE sketches ADD CONSTRAINT sketches_scope_check CHECK (scope IN ('project', 'private', 'dm'));
ALTER TABLE sketches ADD COLUMN dm_id uuid;
ALTER TABLE sketches ADD CONSTRAINT sketches_dm_scope_check CHECK ((scope = 'dm') = (dm_id IS NOT NULL));
-- A DM sketch belongs to its people; agents take no part in DMs in this slice.
ALTER TABLE sketches ADD CONSTRAINT sketches_dm_person_check CHECK (scope <> 'dm' OR created_by_user_id IS NOT NULL);
ALTER TABLE sketches ADD CONSTRAINT sketches_dm_fk FOREIGN KEY (workspace_id, dm_id) REFERENCES dms(workspace_id, id) ON DELETE CASCADE;
ALTER TABLE sketches ADD CONSTRAINT sketches_id_dm_key UNIQUE (id, dm_id);
CREATE INDEX sketches_dm_idx ON sketches(dm_id) WHERE dm_id IS NOT NULL;

-- Provenance of a project copy: who copied it and when, and (for the DM side) which sketch it
-- came from. The copy never exposes the DM id; the DM sketch lists copies its readers can open.
ALTER TABLE sketches ADD COLUMN copied_from_sketch_id uuid REFERENCES sketches(id) ON DELETE SET NULL;
ALTER TABLE sketches ADD COLUMN copied_by_user_id text REFERENCES auth_users(id);
ALTER TABLE sketches ADD COLUMN copied_at timestamptz;
ALTER TABLE sketches ADD CONSTRAINT sketches_copy_check CHECK ((copied_by_user_id IS NULL) = (copied_at IS NULL));
ALTER TABLE sketches ADD CONSTRAINT sketches_copy_scope_check CHECK (copied_at IS NULL OR scope = 'project');
CREATE INDEX sketches_copied_from_idx ON sketches(copied_from_sketch_id) WHERE copied_from_sketch_id IS NOT NULL;

-- A thought's source message: its author and time as they were, and, inside the DM only, the
-- message itself. The message must belong to the sketch's own DM (both composite keys).
ALTER TABLE dm_messages ADD CONSTRAINT dm_messages_dm_id_id_key UNIQUE (dm_id, id);
ALTER TABLE sketch_thoughts ADD COLUMN source_author_id text REFERENCES auth_users(id);
ALTER TABLE sketch_thoughts ADD COLUMN source_author_name text;
ALTER TABLE sketch_thoughts ADD COLUMN source_sent_at timestamptz;
ALTER TABLE sketch_thoughts ADD COLUMN source_dm_id uuid;
ALTER TABLE sketch_thoughts ADD COLUMN source_message_id uuid;
ALTER TABLE sketch_thoughts ADD CONSTRAINT sketch_thoughts_source_check
  CHECK ((source_author_id IS NULL) = (source_sent_at IS NULL) AND (source_author_id IS NULL) = (source_author_name IS NULL));
ALTER TABLE sketch_thoughts ADD CONSTRAINT sketch_thoughts_source_message_check
  CHECK ((source_dm_id IS NULL) = (source_message_id IS NULL) AND (source_message_id IS NULL OR source_author_id IS NOT NULL));
ALTER TABLE sketch_thoughts ADD CONSTRAINT sketch_thoughts_source_message_fk
  FOREIGN KEY (source_dm_id, source_message_id) REFERENCES dm_messages(dm_id, id);
ALTER TABLE sketch_thoughts ADD CONSTRAINT sketch_thoughts_source_dm_fk
  FOREIGN KEY (sketch_id, source_dm_id) REFERENCES sketches(id, dm_id);

-- Search (#114): a DM sketch and its thoughts keep their own audience (`sketch:<id>`, checked by
-- the sketch policy), and also name their DM, so `place = dm:<id>` finds them and results open
-- inside the DM. Project and private sketches have no DM (NULL), so the private place excludes these.
ALTER TABLE search_documents ADD COLUMN dm_id uuid;
CREATE INDEX search_documents_dm_idx ON search_documents (dm_id) WHERE dm_id IS NOT NULL;

CREATE OR REPLACE FUNCTION search_index_sketch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM search_documents WHERE doc_key = 'sketch:' || OLD.id;
    RETURN OLD;
  END IF;
  PERFORM search_put('sketch:' || NEW.id, 'sketch', NEW.workspace_id, 'sketch:' || NEW.id, NEW.project_id, NEW.id::text, NULL, NULL,
    NEW.scope, NEW.title, '', CASE WHEN NEW.created_by_user_id IS NOT NULL THEN 'human' WHEN NEW.created_by_agent_id IS NOT NULL THEN 'agent' END,
    coalesce(NEW.created_by_user_id, NEW.created_by_agent_id::text), NEW.updated_at);
  UPDATE search_documents SET dm_id = NEW.dm_id WHERE doc_key = 'sketch:' || NEW.id AND dm_id IS DISTINCT FROM NEW.dm_id;
  IF TG_OP = 'UPDATE' AND (NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.dm_id IS DISTINCT FROM OLD.dm_id) THEN
    UPDATE search_documents SET project_id = NEW.project_id, dm_id = NEW.dm_id WHERE parent_id = NEW.id AND kind = 'thought';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION search_index_thought() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN DELETE FROM search_documents WHERE doc_key = 'thought:' || OLD.id; RETURN OLD; END IF;
  -- Moving a thought on the map changes nothing that can be searched.
  IF TG_OP = 'UPDATE' AND NEW.text IS NOT DISTINCT FROM OLD.text THEN RETURN NEW; END IF;
  PERFORM search_put('thought:' || NEW.id, 'thought', NEW.workspace_id, 'sketch:' || NEW.sketch_id,
    (SELECT s.project_id FROM sketches s WHERE s.id = NEW.sketch_id), NEW.id::text, NEW.sketch_id, NULL, NULL, NEW.text, '',
    CASE WHEN NEW.created_by_user_id IS NOT NULL THEN 'human' WHEN NEW.created_by_agent_id IS NOT NULL THEN 'agent' END,
    coalesce(NEW.created_by_user_id, NEW.created_by_agent_id::text), NEW.updated_at);
  UPDATE search_documents SET dm_id = (SELECT s.dm_id FROM sketches s WHERE s.id = NEW.sketch_id) WHERE doc_key = 'thought:' || NEW.id;
  RETURN NEW;
END $$;
