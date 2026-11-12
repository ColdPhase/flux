-- The retrieval bench's schema (#1242): the parts of Flux's schema that decide what a search may return (people and their company
-- role, spaces and their visibility, grants, a space's AI switch, agents and their owners, conversations and messages with
-- `removed_at`), plus one structure per option. Access is decided at query time by `readable_spaces`, which follows
-- packages/db/src/repositories/access.ts (`memberFilter` for search: a guest reads only spaces they were added to; an agent reads
-- where its owner belongs and the space's AI is on). Bench only: it is not a Flux migration.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_search CASCADE;  -- also installs `vector` (pgvector)

CREATE TABLE people (id text PRIMARY KEY, key text UNIQUE NOT NULL, name text NOT NULL, role text NOT NULL, active boolean NOT NULL DEFAULT true);
CREATE TABLE agents (id uuid PRIMARY KEY, key text UNIQUE NOT NULL, owner text NOT NULL REFERENCES people, revoked boolean NOT NULL DEFAULT false);
CREATE TABLE spaces (id uuid PRIMARY KEY, key text UNIQUE NOT NULL, name text NOT NULL, visibility text NOT NULL, ai_allowed boolean NOT NULL DEFAULT true);
CREATE TABLE grants (space_id uuid REFERENCES spaces, person_id text REFERENCES people, role text NOT NULL, PRIMARY KEY (space_id, person_id));
CREATE TABLE conversations (id uuid PRIMARY KEY, key text UNIQUE NOT NULL, space_id uuid NOT NULL REFERENCES spaces);

CREATE FUNCTION readable_spaces(p_kind text, p_id text) RETURNS SETOF uuid LANGUAGE sql STABLE AS $$
  WITH who AS (
    SELECT p.id, p.role, p_kind = 'agent' AS is_agent FROM people p
    WHERE p.active AND ((p_kind = 'human' AND p.id = p_id)
      OR (p_kind = 'agent' AND p.id = (SELECT a.owner FROM agents a WHERE a.id::text = p_id AND NOT a.revoked))))
  SELECT s.id FROM spaces s, who
  WHERE ((s.visibility = 'workspace' AND who.role <> 'guest')
      OR EXISTS (SELECT 1 FROM grants g WHERE g.space_id = s.id AND g.person_id = who.id AND g.role <> 'denied'))
    AND (NOT who.is_agent OR s.ai_allowed)
$$;

-- Text search configurations. `simple_unaccent`: today's `simple` with diacritics folded. `pl_en`: Polish Hunspell (sjp.pl) lemmas,
-- then English stems for what Polish does not know, with stop words of both.
CREATE TEXT SEARCH CONFIGURATION simple_unaccent (COPY = simple);
ALTER TEXT SEARCH CONFIGURATION simple_unaccent ALTER MAPPING FOR hword, hword_part, word WITH unaccent, simple;
CREATE TEXT SEARCH DICTIONARY polish_ispell (TEMPLATE = ispell, DictFile = polish, AffFile = polish, StopWords = polish);
CREATE TEXT SEARCH CONFIGURATION pl_en (COPY = simple);
ALTER TEXT SEARCH CONFIGURATION pl_en ALTER MAPPING FOR asciiword, asciihword, hword_asciipart, word, hword, hword_part WITH polish_ispell, english_stem;

CREATE FUNCTION f_unaccent(text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT public.unaccent('public.unaccent', lower($1)) $$;

CREATE TABLE messages (
  id uuid PRIMARY KEY, space_id uuid NOT NULL REFERENCES spaces, conversation_id uuid NOT NULL REFERENCES conversations,
  sequence integer NOT NULL, author text NOT NULL, created_at timestamptz NOT NULL, body text NOT NULL, lang text,
  removed_at timestamptz, edited_at timestamptz,
  UNIQUE (conversation_id, sequence)
);

-- (0) Today: search_documents and its functions as in migration 0001 (audience-keyed GIN over 3-letter prefixes, `simple` tsvector),
-- kept by a trigger in the writer's transaction like `search_index_message` (0029).
CREATE FUNCTION search_key(p_audience text, p_term text) RETURNS bigint LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT hashtextextended(p_audience || '|' || p_term, 0) $$;
CREATE FUNCTION search_term(p_lexeme text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT least(length(p_lexeme), 3)::text || ':' || left(p_lexeme, 3) $$;
CREATE FUNCTION search_keys(p_audience text, p_title text, p_body text) RETURNS bigint[] LANGUAGE sql IMMUTABLE PARALLEL SAFE
  SET search_path TO 'public', 'pg_catalog' AS $$
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
