-- Search across Flux (#114, foundation 8.12). One PostgreSQL index, no search server (O-002).
--
-- Every searchable object keeps one row in search_documents, written by the triggers below in
-- the same transaction as the object itself, so a committed edit is searchable at once and a
-- deleted object disappears with it. Rows hold content only: who may read a row is decided at
-- query time by the access policy (`visibleFilter`) through `audience_key`, the object that
-- carries the permission (docs, as project materials, use `project:<id>`; `dm:<id>`, `sketch:<id>`, `draft:<id>`, `members:<workspace>`).
--
-- The one text index is keyed by audience: every key is `<audience_key>|<word prefix>`, so the
-- posting list of a key holds only rows of that audience. A search looks up the keys of the
-- audiences the reader may see and never touches another audience's postings: hidden matches
-- are never fetched, ranked, counted or even read from the index. The exact match (full-text,
-- prefix, trigram similarity) is then checked on those candidate rows.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- The audience-scoped keys of a row, each one `<audience_key>|<term>`:
-- - for every word (lexeme of the `simple` configuration), its first character (`1:a`), first two
--   (`2:ab`) and first three (`3:abc`) as far as it is long, for full-text and prefix matching. A
--   query word looks up the key of its own length up to three (`search_term`), so any row that
--   contains the word, or a word it is a prefix of, is a candidate;
-- - every trigram of the title (`t:<trigram>`, as `show_trgm` gives them), for trigram similarity:
--   a title similar to the query shares at least one trigram with it, wherever the typo is.
CREATE FUNCTION search_term(p_lexeme text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT least(length(p_lexeme), 3)::text || ':' || left(p_lexeme, 3) $$;

-- Keys are stored as 64-bit hashes (`search_key`): short index entries keep the shared GIN entry
-- tree shallow. A collision only adds a candidate, which the audience and match checks drop.
CREATE FUNCTION search_key(p_audience text, p_term text) RETURNS bigint
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT hashtextextended(p_audience || '|' || p_term, 0) $$;

CREATE FUNCTION search_keys(p_audience text, p_title text, p_body text) RETURNS bigint[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(array_agg(DISTINCT search_key(p_audience, k)), '{}')
  FROM (
    SELECT prefixes.k
    FROM (SELECT lexeme FROM unnest(to_tsvector('simple', coalesce(p_title, '') || ' ' || left(coalesce(p_body, ''), 100000)))) words,
    LATERAL (VALUES ('1:' || left(words.lexeme, 1)), (CASE WHEN length(words.lexeme) >= 2 THEN '2:' || left(words.lexeme, 2) END),
      (CASE WHEN length(words.lexeme) >= 3 THEN '3:' || left(words.lexeme, 3) END)) AS prefixes(k)
    UNION ALL
    SELECT 't:' || trigram FROM unnest(show_trgm(left(coalesce(p_title, ''), 1000))) AS trigram
  ) keys
  WHERE k IS NOT NULL
$$;

CREATE TABLE search_documents (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  doc_key text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('message', 'dm_message', 'material', 'doc', 'work', 'decision', 'result', 'sketch', 'thought', 'draft', 'person')),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  audience_key text NOT NULL,
  -- The place: the object's project, or NULL for private drafts, private sketches and people.
  project_id uuid,
  object_id text NOT NULL,
  -- The conversation of a message, the DM of a DM message, the sketch of a thought.
  parent_id uuid,
  -- The version of a material; every version keeps its own row so old citations still resolve.
  version integer,
  status text,
  title text NOT NULL DEFAULT '',
  body text NOT NULL DEFAULT '',
  author_kind text CHECK (author_kind IN ('human', 'agent')),
  author_id text,
  at timestamptz NOT NULL,
  tsv tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', title), 'A') || setweight(to_tsvector('simple', left(body, 100000)), 'B')
  ) STORED,
  keys bigint[] GENERATED ALWAYS AS (search_keys(audience_key, title, body)) STORED
);
-- fastupdate off: a GIN pending list holds recent inserts of every audience and each search would
-- scan all of it, so a reader's work would grow with other people's writes. Without it, inserts go
-- straight into the index and a search reads only the postings of its own keys.
CREATE INDEX search_documents_keys_idx ON search_documents USING gin (keys) WITH (fastupdate = off);
CREATE INDEX search_documents_parent_idx ON search_documents (parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX search_documents_person_idx ON search_documents (object_id) WHERE kind = 'person';

CREATE FUNCTION search_put(
  p_key text, p_kind text, p_workspace uuid, p_audience text, p_project uuid, p_object text, p_parent uuid,
  p_version integer, p_status text, p_title text, p_body text, p_author_kind text, p_author text, p_at timestamptz
) RETURNS void LANGUAGE sql AS $$
  INSERT INTO search_documents(doc_key, kind, workspace_id, audience_key, project_id, object_id, parent_id, version, status, title, body, author_kind, author_id, at)
  VALUES (p_key, p_kind, p_workspace, p_audience, p_project, p_object, p_parent, p_version, p_status,
    coalesce(p_title, ''), coalesce(p_body, ''), p_author_kind, p_author, p_at)
  ON CONFLICT (doc_key) DO UPDATE SET
    workspace_id = EXCLUDED.workspace_id, audience_key = EXCLUDED.audience_key, project_id = EXCLUDED.project_id,
    parent_id = EXCLUDED.parent_id, version = EXCLUDED.version, status = EXCLUDED.status, title = EXCLUDED.title,
    body = EXCLUDED.body, author_kind = EXCLUDED.author_kind, author_id = EXCLUDED.author_id, at = EXCLUDED.at;
$$;

-- Project messages (#36).
CREATE FUNCTION search_index_message() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN DELETE FROM search_documents WHERE doc_key = 'message:' || OLD.id; RETURN OLD; END IF;
  PERFORM search_put('message:' || NEW.id, 'message', NEW.workspace_id, 'project:' || NEW.project_id, NEW.project_id, NEW.id::text,
    NEW.conversation_id, NULL, NULL, '', NEW.body, 'human', NEW.author_id, NEW.created_at);
  RETURN NEW;
END $$;
CREATE TRIGGER search_index AFTER INSERT OR UPDATE OR DELETE ON project_messages FOR EACH ROW EXECUTE FUNCTION search_index_message();

-- Direct messages (#107). The audience is the DM, so only its current participants find them.
CREATE FUNCTION search_index_dm_message() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN DELETE FROM search_documents WHERE doc_key = 'dm_message:' || OLD.id; RETURN OLD; END IF;
  PERFORM search_put('dm_message:' || NEW.id, 'dm_message', NEW.workspace_id, 'dm:' || NEW.dm_id, NULL, NEW.id::text,
    NEW.dm_id, NULL, NULL, '', NEW.body, 'human', NEW.author_id, NEW.created_at);
  RETURN NEW;
END $$;
CREATE TRIGGER search_index AFTER INSERT OR UPDATE OR DELETE ON dm_messages FOR EACH ROW EXECUTE FUNCTION search_index_dm_message();

-- Material and doc versions (#36, #112) are immutable; each one is its own row. A doc is a
-- material of kind 'doc' whose version also has a state (draft or published).
CREATE FUNCTION search_index_material_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  material_kind text;
BEGIN
  IF TG_OP = 'DELETE' THEN DELETE FROM search_documents WHERE doc_key = 'material:' || OLD.material_id || ':' || OLD.version; RETURN OLD; END IF;
  SELECT pm.kind INTO material_kind FROM project_materials pm WHERE pm.id = NEW.material_id;
  PERFORM search_put('material:' || NEW.material_id || ':' || NEW.version, coalesce(material_kind, 'material'), NEW.workspace_id, 'project:' || NEW.project_id,
    NEW.project_id, NEW.material_id::text, NULL, NEW.version, NEW.state, NEW.title, concat_ws(E'\n', NEW.body, NEW.url), 'human', NEW.author_id, NEW.created_at);
  RETURN NEW;
END $$;
CREATE TRIGGER search_index AFTER INSERT OR UPDATE OR DELETE ON project_material_versions FOR EACH ROW EXECUTE FUNCTION search_index_material_version();

-- Work items, decisions and results (#101).
CREATE FUNCTION search_index_work() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN DELETE FROM search_documents WHERE doc_key = 'work:' || OLD.id; RETURN OLD; END IF;
  PERFORM search_put('work:' || NEW.id, 'work', NEW.workspace_id, 'project:' || NEW.project_id, NEW.project_id, NEW.id::text, NULL, NULL,
    CASE WHEN NEW.parked_by_decision_id IS NOT NULL THEN 'parked' ELSE NEW.status END,
    NEW.title, concat_ws(E'\n', nullif(NEW.outcome, ''), NEW.blocker), NEW.created_by_kind, NEW.created_by_id, NEW.updated_at);
  RETURN NEW;
END $$;
CREATE TRIGGER search_index AFTER INSERT OR UPDATE OR DELETE ON project_work_items FOR EACH ROW EXECUTE FUNCTION search_index_work();

CREATE FUNCTION search_index_decision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN DELETE FROM search_documents WHERE doc_key = 'decision:' || OLD.id; RETURN OLD; END IF;
  PERFORM search_put('decision:' || NEW.id, 'decision', NEW.workspace_id, 'project:' || NEW.project_id, NEW.project_id, NEW.id::text, NULL, NULL,
    NEW.status, NEW.title, NEW.rationale, NEW.proposed_by_kind, NEW.proposed_by_id, NEW.updated_at);
  RETURN NEW;
END $$;
CREATE TRIGGER search_index AFTER INSERT OR UPDATE OR DELETE ON project_decisions FOR EACH ROW EXECUTE FUNCTION search_index_decision();

CREATE FUNCTION search_index_result() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN DELETE FROM search_documents WHERE doc_key = 'result:' || OLD.id; RETURN OLD; END IF;
  PERFORM search_put('result:' || NEW.id, 'result', NEW.workspace_id, 'project:' || NEW.project_id, NEW.project_id, NEW.id::text, NULL, NULL,
    NEW.finding, NEW.title, NEW.evidence, NEW.created_by_kind, NEW.created_by_id, NEW.created_at);
  RETURN NEW;
END $$;
CREATE TRIGGER search_index AFTER INSERT OR UPDATE OR DELETE ON project_results FOR EACH ROW EXECUTE FUNCTION search_index_result();

-- Sketches and their thoughts (#69). A thought's audience is its sketch, so a private sketch
-- keeps every thought private; moving a sketch moves the place of its thoughts too.
CREATE FUNCTION search_index_sketch() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER search_index AFTER INSERT OR UPDATE OR DELETE ON sketches FOR EACH ROW EXECUTE FUNCTION search_index_sketch();

CREATE FUNCTION search_index_thought() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER search_index AFTER INSERT OR UPDATE OR DELETE ON sketch_thoughts FOR EACH ROW EXECUTE FUNCTION search_index_thought();

-- Drafts (#29). The audience is the draft itself, so its visibility (private, project,
-- workspace) is decided by the draft rule of the policy on every query.
CREATE FUNCTION search_index_draft() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN DELETE FROM search_documents WHERE doc_key = 'draft:' || OLD.id; RETURN OLD; END IF;
  PERFORM search_put('draft:' || NEW.id, 'draft', NEW.workspace_id, 'draft:' || NEW.id, NEW.project_id, NEW.id::text, NULL, NEW.version,
    NEW.visibility, NEW.title, NEW.body, CASE WHEN NEW.owner_user_id IS NOT NULL THEN 'human' ELSE 'agent' END,
    coalesce(NEW.owner_user_id, NEW.owner_agent_id::text), NEW.updated_at);
  RETURN NEW;
END $$;
CREATE TRIGGER search_index AFTER INSERT OR UPDATE OR DELETE ON drafts FOR EACH ROW EXECUTE FUNCTION search_index_draft();

-- People: one row per membership, readable by whoever may read the workspace's members.
CREATE FUNCTION search_index_member() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN DELETE FROM search_documents WHERE doc_key = 'person:' || OLD.workspace_id || ':' || OLD.user_id; RETURN OLD; END IF;
  PERFORM search_put('person:' || NEW.workspace_id || ':' || NEW.user_id, 'person', NEW.workspace_id, 'members:' || NEW.workspace_id, NULL,
    NEW.user_id, NULL, NULL, NEW.role, (SELECT u.name FROM auth_users u WHERE u.id = NEW.user_id), '', NULL, NULL, NEW.created_at);
  RETURN NEW;
END $$;
CREATE TRIGGER search_index AFTER INSERT OR UPDATE OR DELETE ON workspace_members FOR EACH ROW EXECUTE FUNCTION search_index_member();

CREATE FUNCTION search_index_user_name() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE search_documents SET title = NEW.name WHERE kind = 'person' AND object_id = NEW.id;
  RETURN NEW;
END $$;
CREATE TRIGGER search_index AFTER UPDATE OF name ON auth_users FOR EACH ROW WHEN (NEW.name IS DISTINCT FROM OLD.name) EXECUTE FUNCTION search_index_user_name();

-- Index what already exists.
SELECT search_put('message:' || m.id, 'message', m.workspace_id, 'project:' || m.project_id, m.project_id, m.id::text, m.conversation_id,
  NULL, NULL, '', m.body, 'human', m.author_id, m.created_at) FROM project_messages m;
SELECT search_put('dm_message:' || m.id, 'dm_message', m.workspace_id, 'dm:' || m.dm_id, NULL, m.id::text, m.dm_id,
  NULL, NULL, '', m.body, 'human', m.author_id, m.created_at) FROM dm_messages m;
SELECT search_put('material:' || v.material_id || ':' || v.version, pm.kind, v.workspace_id, 'project:' || v.project_id, v.project_id,
  v.material_id::text, NULL, v.version, v.state, v.title, concat_ws(E'\n', v.body, v.url), 'human', v.author_id, v.created_at)
FROM project_material_versions v JOIN project_materials pm ON pm.id = v.material_id;
SELECT search_put('work:' || w.id, 'work', w.workspace_id, 'project:' || w.project_id, w.project_id, w.id::text, NULL, NULL,
  CASE WHEN w.parked_by_decision_id IS NOT NULL THEN 'parked' ELSE w.status END, w.title, concat_ws(E'\n', nullif(w.outcome, ''), w.blocker),
  w.created_by_kind, w.created_by_id, w.updated_at) FROM project_work_items w;
SELECT search_put('decision:' || d.id, 'decision', d.workspace_id, 'project:' || d.project_id, d.project_id, d.id::text, NULL, NULL,
  d.status, d.title, d.rationale, d.proposed_by_kind, d.proposed_by_id, d.updated_at) FROM project_decisions d;
SELECT search_put('result:' || r.id, 'result', r.workspace_id, 'project:' || r.project_id, r.project_id, r.id::text, NULL, NULL,
  r.finding, r.title, r.evidence, r.created_by_kind, r.created_by_id, r.created_at) FROM project_results r;
SELECT search_put('sketch:' || s.id, 'sketch', s.workspace_id, 'sketch:' || s.id, s.project_id, s.id::text, NULL, NULL, s.scope, s.title, '',
  CASE WHEN s.created_by_user_id IS NOT NULL THEN 'human' WHEN s.created_by_agent_id IS NOT NULL THEN 'agent' END,
  coalesce(s.created_by_user_id, s.created_by_agent_id::text), s.updated_at) FROM sketches s;
SELECT search_put('thought:' || t.id, 'thought', t.workspace_id, 'sketch:' || t.sketch_id, s.project_id, t.id::text, t.sketch_id, NULL, NULL, t.text, '',
  CASE WHEN t.created_by_user_id IS NOT NULL THEN 'human' WHEN t.created_by_agent_id IS NOT NULL THEN 'agent' END,
  coalesce(t.created_by_user_id, t.created_by_agent_id::text), t.updated_at) FROM sketch_thoughts t JOIN sketches s ON s.id = t.sketch_id;
SELECT search_put('draft:' || d.id, 'draft', d.workspace_id, 'draft:' || d.id, d.project_id, d.id::text, NULL, d.version, d.visibility, d.title, d.body,
  CASE WHEN d.owner_user_id IS NOT NULL THEN 'human' ELSE 'agent' END, coalesce(d.owner_user_id, d.owner_agent_id::text), d.updated_at) FROM drafts d;
SELECT search_put('person:' || wm.workspace_id || ':' || wm.user_id, 'person', wm.workspace_id, 'members:' || wm.workspace_id, NULL, wm.user_id,
  NULL, NULL, wm.role, u.name, '', NULL, NULL, wm.created_at) FROM workspace_members wm JOIN auth_users u ON u.id = wm.user_id;

INSERT INTO flux_schema_version(version) VALUES (14) ON CONFLICT DO NOTHING;
