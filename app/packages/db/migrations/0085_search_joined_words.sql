-- A hyphenated word is one word to search (v0.2.1 personas round: "mockup" did not find "mock-up"; docs/development/search.md).
--
-- The BM25 index (migration 0065) gains one field for the title and one for the body with the hyphens between two letters or digits
-- taken out, so "mock-up", "e-mail" and "well-known" are also indexed as "mockup", "email" and "wellknown". The query joins its own
-- words the same way (`joinHyphenatedWords` in @flux/contracts), so "mockup" and "mock-up" find each other. The other fields are as in
-- 0065. The index is built again from the rows already there: it works on the data of any release from v0.2.0 on and changes no row.
CREATE FUNCTION public.flux_joined_words(text) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    RETURN regexp_replace($1, '([[:alnum:]])[-‐‑]+(?=[[:alnum:]])', '\1', 'g');

DROP INDEX public.search_documents_bm25_idx;

CREATE INDEX search_documents_bm25_idx ON public.search_documents USING bm25 (
  id,
  (title::pdb.simple('ascii_folding=true', 'stemmer=polish', 'alias=title_pl')),
  (title::pdb.simple('ascii_folding=true', 'stemmer=english', 'alias=title_en')),
  (public.flux_joined_words(title)::pdb.simple('ascii_folding=true', 'stemmer=english', 'alias=title_joined')),
  (body::pdb.simple('ascii_folding=true', 'stemmer=polish', 'alias=body_pl')),
  (body::pdb.simple('ascii_folding=true', 'stemmer=english', 'alias=body_en')),
  (public.flux_joined_words(body)::pdb.simple('ascii_folding=true', 'stemmer=english', 'alias=body_joined')),
  (kind::pdb.literal),
  (audience_key::pdb.literal),
  (author_kind::pdb.literal),
  (author_id::pdb.literal),
  workspace_id,
  project_id,
  parent_id,
  at
) WHERE NOT sealed;
